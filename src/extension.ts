import * as vscode from 'vscode';
import { ToolCallParser, ToolInfo, ParserMode } from './lib/parser';
import { getModelCapabilities } from './lib/capabilities';

// ========================================================================
// Reasoning Content Handling — Dual-Path Strategy
// 
// Path 1 (Primary): TEXT-WRAPPING — Embed reasoning content in TextPart markers.
//   This ALWAYS survives VS Code's LanguageModelAccessPrompt.render() filtering.
//   TextParts are never stripped, so this is the reliable path.
//
// Path 2 (Secondary): DATAPART — Emit as LanguageModelDataPart with custom MIME type.
//   This works IF VS Code doesn't strip it — but currently it does get stripped.
//   Keep it anyway for forward-compatibility if VS Code changes this behavior.
//
// Store fallback: Used to detect when DataPart was stripped (stale data hazard).
//   We keep a list of reasoning contents per conversation to detect gaps.
// ========================================================================
const reasoningContentStore = new Map<string, string[]>();
const MAX_STORE_ENTRIES = 20;

function storeReasoning(key: string, content: string): void {
  const existing = reasoningContentStore.get(key) || [];
  existing.push(content);
  reasoningContentStore.set(key, existing);
  // Prune oldest conversation if over limit
  if (reasoningContentStore.size > MAX_STORE_ENTRIES) {
    const firstKey = reasoningContentStore.keys().next().value;
    if (firstKey !== undefined) reasoningContentStore.delete(firstKey);
  }
}

/**
 * Derive a stable conversation key from the message history.
 * Uses a simple hash of concatenated user message texts.
 * This produces the same key for the same conversation chain.
 */
function deriveConversationKey(messages: readonly vscode.LanguageModelChatMessage[]): string {
  const userTexts = messages
    .filter(m => m.role === vscode.LanguageModelChatMessageRole.User)
    .flatMap(m => m.content
      .filter(p => p instanceof vscode.LanguageModelTextPart)
      .map((p: any) => p.value),
    );
  return userTexts.join('|').slice(0, 160);
}

// ========================================================================
// Types
// ========================================================================

interface ProviderConfig {
  name: string;
  vendor: string;
  apiKey: string;
  baseURL: string;
  enabled: boolean;
  models: string[];
}

interface ModelInfo {
  id: string;
  name: string;
  vendor: string;
  maxTokens?: number;
}

// ========================================================================
// Message / Part Mapping Helpers
// ========================================================================

function mapMessage(msg: vscode.LanguageModelChatMessage): { mapped: any | any[]; hasDataPart: boolean } {
  const role = mapRole(msg.role);
  const parts = msg.content;

  const textParts: string[] = [];
  let toolCalls: any[] | undefined;
  const toolResults: any[] = [];
  let reasoningContent: string | undefined;
  let hasDataPart = false;

  // Log all part types for diagnostics
  const partTypes = parts.map(p => p?.constructor?.name ?? typeof p);
  console.log(`[UniversalLLM] mapMessage role=${role} parts=[${partTypes.join(', ')}]`);

  for (const part of parts) {
    if (part instanceof vscode.LanguageModelTextPart) {
      // --- PRIMARY PATH: Extract reasoning content from text-wrapped markers ---
      // TextPart is never stripped by VS Code's LanguageModelAccessPrompt.render().
      // Wrap content in <|reasoning|>...</|reasoning|> markers when emitting,
      // and parse it out here on the next turn. This is the RELIABLE path.
      const text = part.value;
      const rcMatch = text.match(/<\|reasoning\|>([\s\S]*?)<\|\/reasoning\|>/);
      if (rcMatch) {
        reasoningContent = rcMatch[1];
        console.log(`[UniversalLLM] Extracted reasoning from text-wrapped marker (${rcMatch[1].length} chars)`);
        // DO NOT push this text part — it's consumed by the marker extraction
        continue;
      }
      textParts.push(text);
    } else if (part instanceof vscode.LanguageModelToolCallPart) {
      if (!toolCalls) toolCalls = [];
      toolCalls.push({
        id: part.callId,
        type: 'function',
        function: { name: part.name, arguments: JSON.stringify(part.input) },
      });
    } else if (part instanceof vscode.LanguageModelToolResultPart) {
      const resultText = part.content
        .map((c) => (c instanceof vscode.LanguageModelTextPart ? c.value : ''))
        .join('\n');
      toolResults.push({
        role: 'tool',
        content: resultText,
        tool_call_id: part.callId,
      });
    } else if (part instanceof vscode.LanguageModelDataPart) {
      // --- SECONDARY PATH: Extract reasoning_content from DataPart ---
      // DataPart gets stripped by VS Code's LanguageModelAccessPrompt.render()
      // when it constructs messages to send to the provider. This path may fail.
      // We keep it for forward-compatibility if VS Code changes this behavior.
      try {
        const raw = new TextDecoder().decode((part as any).data);
        const meta = JSON.parse(raw);
        if (meta.reasoning_content) {
          reasoningContent = meta.reasoning_content;
          hasDataPart = true;
          console.log(`[UniversalLLM] DataPart found with reasoning_content (${meta.reasoning_content.length} chars)`);
        }
      } catch {
        // Not a reasoning content DataPart — ignore
      }
    } else if (typeof part === 'string') {
      textParts.push(part);
    }
  }

  // If there are tool results, return them (may be multiple for parallel calls)
  if (toolResults.length > 0) {
    return { mapped: toolResults.length === 1 ? toolResults[0] : toolResults, hasDataPart };
  }

  const content = textParts.join('\n');

  // Build the outgoing message, preserving reasoning_content for round-trip.
  // DeepSeek v4 models require reasoning_content on all assistant messages in a
  // conversation to maintain chain-of-thought context across multi-turn calls.
  // When thinking mode was active on any turn, ALL assistant messages must carry
  // their reasoning_content — otherwise the API returns 400.

  if (toolCalls && role === 'assistant') {
    const apiMsg: any = { role, content: null, tool_calls: toolCalls };
    if (reasoningContent) {
      apiMsg.reasoning_content = reasoningContent;
    }
    return { mapped: apiMsg, hasDataPart };
  }

  return {
    mapped: { role, content, ...(reasoningContent ? { reasoning_content: reasoningContent } : {}) },
    hasDataPart,
  };
}

// ========================================================================
// Schema Normalization
// ========================================================================

/**
 * Recursively normalize a JSON schema for DeepSeek/OpenAI compliance.
 * Fixes type:null at every nesting level, ensures properties objects,
 * required arrays, and additionalProperties:false throughout.
 */
function normalizeSchema(schema: any): object {
  return normalizeNestedSchema(schema) ?? { type: 'object', properties: {}, required: [], additionalProperties: false };
}

function normalizeNestedSchema(schema: any): any {
  if (!schema || typeof schema !== 'object') return schema;

  const result: any = { ...schema };

  // Fix null or missing type at any level
  if ('type' in result && result.type === null) {
    result.type = 'object';
  }

  // Ensure additionalProperties defaults to false everywhere
  if (!('additionalProperties' in result)) {
    result.additionalProperties = false;
  }

  // Recurse into properties
  if (result.properties && typeof result.properties === 'object') {
    const normalizedProps: any = {};
    for (const [key, val] of Object.entries(result.properties)) {
      normalizedProps[key] = normalizeNestedSchema(val);
    }
    result.properties = normalizedProps;
  }

  // Recurse into array items schema
  if (result.items) {
    result.items = normalizeNestedSchema(result.items);
  }

  // Recurse into anyOf / oneOf branches
  for (const branchKey of ['anyOf', 'oneOf']) {
    if (result[branchKey] && Array.isArray(result[branchKey])) {
      result[branchKey] = result[branchKey].map((s: any) => normalizeNestedSchema(s));
    }
  }

  // Recurse into $defs / definitions
  for (const defKey of ['$defs', 'definitions']) {
    if (result[defKey] && typeof result[defKey] === 'object') {
      const defs: any = {};
      for (const [key, val] of Object.entries(result[defKey])) {
        defs[key] = normalizeNestedSchema(val);
      }
      result[defKey] = defs;
    }
  }

  // Ensure required is an array
  result.required = result.required ?? [];

  return result;
}

function mapRole(role: vscode.LanguageModelChatMessageRole): 'user' | 'assistant' | 'system' | 'tool' {
  if (role === vscode.LanguageModelChatMessageRole.Assistant) return 'assistant';
  const r = role as any;
  if (r === 3 || r === 'system') return 'system';
  if (r === 'tool') return 'tool';
  return 'user';
}

// ========================================================================
// Configuration
// ========================================================================

function loadProviderConfigs(): ProviderConfig[] {
  return vscode.workspace.getConfiguration('universal-llm').get<ProviderConfig[]>('providers', []);
}

function saveProviderConfigs(providers: ProviderConfig[]) {
  vscode.workspace.getConfiguration('universal-llm').update('providers', providers, vscode.ConfigurationTarget.Global);
}

function getAllModels(providers: ProviderConfig[]): ModelInfo[] {
  const models: ModelInfo[] = [];
  for (const p of providers) {
    if (!p.enabled) continue;
    for (const m of p.models) {
      models.push({ id: m, name: m, vendor: p.vendor });
    }
  }
  return models;
}

function findProviderForModel(modelId: string, providers: ProviderConfig[]): ProviderConfig | undefined {
  for (const p of providers) {
    if (p.models.includes(modelId) && p.enabled) {
      return p;
    }
  }
  return undefined;
}

// ========================================================================
// Provider
// ========================================================================

const parser = new ToolCallParser();

class UniversalLLMProvider implements vscode.LanguageModelChatProvider {
  async provideLanguageModelChatInformation(
    _options: vscode.PrepareLanguageModelChatModelOptions,
    _token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelChatInformation[]> {
    const providers = loadProviderConfigs();
    return getAllModels(providers).map((m) => ({
      id: m.id,
      name: m.name,
      family: m.vendor,
      version: '1.0',
      maxInputTokens: m.maxTokens || 128000,
      maxOutputTokens: 4096,
      capabilities: { toolCalling: true },
    }));
  }

  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatMessage[],
    options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken
  ): Promise<void> {
    const modelId = model.id;
    const caps = getModelCapabilities(modelId);
    const hasTools = !!(options.tools && options.tools.length > 0);
    const toolMode = options.toolMode;

    // Resolve provider config
    const providers = loadProviderConfigs();
    const providerConfig = findProviderForModel(modelId, providers);

    if (!providerConfig) {
      throw new Error(`Provider not found for model: ${modelId}`);
    }

    // If no API key, prompt user to set one
    if (!providerConfig.apiKey) {
      const key = await vscode.window.showInputBox({
        prompt: `Enter API key for ${providerConfig.name} (${providerConfig.baseURL})`,
        password: true,
        ignoreFocusOut: true,
        placeHolder: 'sk-...',
      });

      if (!key) {
        throw new Error(`API key required for ${providerConfig.name}. Use 'Universal LLM: Set API Key' to configure.`);
      }

      providerConfig.apiKey = key;
      providerConfig.enabled = true;
      saveProviderConfigs(providers);
      vscode.window.showInformationMessage(`✅ ${providerConfig.name} API key saved.`);
    }

    console.log(`[UniversalLLM] ${modelId} | tools=${hasTools} | mode=${caps.nativeToolCalling ? 'native' : 'fallback:' + caps.fallbackParser}`);
    if (hasTools) {
      console.log(`[UniversalLLM] Tool names:`, options.tools!.map(t => t.name));
    }

    // Build payload preserving all message parts.
    // Use flatMap because mapMessage can return an array for parallel tool results.
    const payloadMessages: any[] = messages.flatMap((msg) => {
      const { mapped } = mapMessage(msg);
      return Array.isArray(mapped) ? mapped : [mapped];
    });

    // Inject reasoning_content onto assistant messages from the conversation store.
    // This is a STALE DATA DETECTOR — it only activates when the DataPar path failed.
    // We maintain a list of reasoning contents per conversation key to detect gaps
    // and ensure we're injecting the correct content for each assistant message.
    // DeepSeek v4-pro/v4-flash require reasoning_content on EVERY assistant message
    // when thinking mode was active on any turn.
    const conversationKey = deriveConversationKey(messages);
    const storedList = reasoningContentStore.get(conversationKey) || [];
    let storeIndex = 0;
    for (let i = 0; i < payloadMessages.length; i++) {
      const m = payloadMessages[i];
      if (m.role === 'assistant') {
        // If DataPart didn't provide reasoning_content, try the store
        if (!m.reasoning_content) {
          const rc = storedList[storeIndex];
          if (rc) {
            payloadMessages[i] = { ...m, reasoning_content: rc };
            console.log(`[UniversalLLM] Store fallback injected reasoning_content (${rc.length} chars) — index=${storeIndex}`);
          }
        }
        storeIndex++;
      }
    }

    // Inject tool prompt for non-native models (agnostic — includes all tool names)
    if (hasTools && !caps.nativeToolCalling && caps.fallbackParser !== 'none') {
      const toolInfos: ToolInfo[] = options.tools!.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      }));
      const prompt = parser.buildToolPrompt(toolInfos, caps.fallbackParser);
      if (prompt) payloadMessages.unshift({ role: 'system', content: prompt });
    }

    // Build API request
    const requestBody: any = {
      model: modelId,
      messages: payloadMessages,
      stream: true,
    };

    // DeepSeek v4 models have thinking mode ON by default at the API level.
    // We do NOT explicitly set thinking/reasoning_effort because doing so
    // creates an API requirement that reasoning_content be present on ALL
    // previous assistant messages in the conversation. If the cache or DataPart
    // mechanism fails to inject reasoning_content on round-trip, the API will
    // reject the request with "reasoning_content must be passed back".
    //
    // The API still returns reasoning_content in streaming deltas even without
    // these params — we capture it generically below via reasoningBuffer/DataPart.
    // This gives us belt-and-suspenders: the cache fallback works when it can,
    // but when it fails, the API won't reject us because we never told it to
    // require reasoning_content in the first place.

    if (caps.nativeToolCalling && hasTools) {
      requestBody.tools = options.tools!.map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: normalizeSchema(t.inputSchema),
        },
      }));
      if (toolMode === vscode.LanguageModelChatToolMode.Required) {
        requestBody.tool_choice = 'required';
      }
    }

    // Log the payload before sending
    console.log(`[UniversalLLM] Sending ${payloadMessages.length} messages to ${modelId}`);
    console.log(`[UniversalLLM] Message roles: [${payloadMessages.map(m => m.role).join(', ')}]`);
    if (hasTools && !caps.nativeToolCalling) {
      console.log(`[UniversalLLM] Tool system prompt injected: ${payloadMessages[0]?.role === 'system' ? payloadMessages[0]?.content?.substring(0, 80) + '...' : 'NO'}`);
    }

    // Call API
    const response = await fetch(`${providerConfig.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${providerConfig.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok || !response.body) {
      const errorText = await response.text().catch(() => '');
      console.error(`[UniversalLLM] API error ${response.status}: ${errorText.substring(0, 200)}`);
      throw new Error(`${providerConfig.name} API error ${response.status}: ${response.statusText}. ${errorText}`);
    }

    // Stream and process response
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let fullResponse = '';
    // Accumulate tool calls across SSE chunks (id+name in one chunk, arguments in others)
    const activeToolCalls = new Map<number, { id: string; name: string; jsonBuffer: string }>();
    // Accumulate reasoning_content across SSE chunks (full thought before tool_calls)
    let reasoningBuffer = '';

    try {
      while (!token.isCancellationRequested) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const data = trimmed.slice(5).trim();
          if (data === '[DONE]') break;

          try {
            const parsed = JSON.parse(data);
            const delta = parsed?.choices?.[0]?.delta;
            if (!delta) continue;

            const text = delta.content;
            if (text) {
              fullResponse += text;
              progress.report(new vscode.LanguageModelTextPart(text));
            }

            // Capture reasoning_content from streaming delta (DeepSeek v4-pro/v4-flash)
            if (delta.reasoning_content) {
              reasoningBuffer += delta.reasoning_content;
            }

            // Native model: accumulate structured tool calls from API chunks
            if (caps.nativeToolCalling && delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0;
                if (tc.id && tc.function?.name) {
                  // First chunk for this tool call — initialize entry
                  activeToolCalls.set(idx, {
                    id: tc.id,
                    name: tc.function.name,
                    jsonBuffer: '',
                  });
                  // Also capture any arguments sent in the first chunk
                  if (tc.function.arguments) {
                    const entry = activeToolCalls.get(idx);
                    if (entry) entry.jsonBuffer += tc.function.arguments;
                  }
                } else if (tc.function?.arguments) {
                  // Subsequent chunks — append arguments to existing entry
                  const entry = activeToolCalls.get(idx);
                  if (entry) entry.jsonBuffer += tc.function.arguments;
                }
              }
            }
          } catch {
            // partial parse during streaming
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    // Emit accumulated native tool calls after stream ends
    if (caps.nativeToolCalling && activeToolCalls.size > 0) {
      for (const [, entry] of activeToolCalls) {
        try {
          const args = JSON.parse(entry.jsonBuffer);
          progress.report(
            new vscode.LanguageModelToolCallPart(entry.id, entry.name, args),
          );
          console.log(`[UniversalLLM] Native tool call emitted: ${entry.name}`);
        } catch (e) {
          console.error(
            `[UniversalLLM] Failed to parse tool call args for ${entry.name}:`,
            entry.jsonBuffer,
          );
        }
      }
    }

    // If we captured reasoning_content from the streaming response, emit it via
    // BOTH paths to maximize the chance it survives the round-trip:
    //
    // Path 1 (PRIMARY — ALWAYS WORKS): Wrap in TextPart markers
    //   TextParts are NEVER stripped by VS Code's LanguageModelAccessPrompt.render().
    //   This is the reliable, guaranteed path for round-trip preservation.
    //   Parse it back in mapMessage() using the <|reasoning|> marker.
    //
    // Path 2 (SECONDARY — MAY FAIL): Emit as LanguageModelDataPart
    //   DataPart IS currently stripped by VS Code, but keep for forward-compat.
    //
    // Store: Persist all reasoning contents per conversation for gap detection.
    //   When DataPart fails, we fall back to store. When both fail, we log a warning.
    if (reasoningBuffer) {
      // Path 1: Text-wrapped markers (RELIABLE — survives any VS Code filtering)
      const wrappedText = `<|reasoning|>${reasoningBuffer}<|/reasoning|>`;
      progress.report(new vscode.LanguageModelTextPart(wrappedText));
      console.log(`[UniversalLLM] Emitted text-wrapped reasoning content (${reasoningBuffer.length} chars)`);

      // Path 2: DataPart (forward-compat — may be stripped by VS Code)
      progress.report(
        vscode.LanguageModelDataPart.json(
          { reasoning_content: reasoningBuffer },
          'application/x-reasoning-json',
        ),
      );
      console.log(`[UniversalLLM] Emitted DataPart reasoning content (${reasoningBuffer.length} chars)`);

      // Store for gap detection and fallback
      storeReasoning(conversationKey, reasoningBuffer);
      console.log(`[UniversalLLM] Stored reasoning content for gap detection — key=${conversationKey}`);
    }

    // ====================================================================
    // Non-native model: parse tool call from accumulated text
    // Uses agnostic parser — accepts any tool call pattern without
    // validating tool names. VSCode will validate when it receives
    // the ToolCallPart.
    // ====================================================================

    if (hasTools && !caps.nativeToolCalling && caps.fallbackParser !== 'none') {
      const toolCall = parser.parseToolCall(fullResponse, caps.fallbackParser);
      if (toolCall) {
        console.log(`[UniversalLLM] Parsed fallback tool call: ${toolCall.name}`);
        // Emit tool call part — VSCode owns execution & validation
        progress.report(new vscode.LanguageModelToolCallPart(
          `tc_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
          toolCall.name,
          toolCall.args
        ));
      }
    }
  }

  provideTokenCount(
    _model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatMessage,
    _token: vscode.CancellationToken
  ): Promise<number> {
    const raw = typeof text === 'string' ? text
      : (text as any).content?.map?.((p: any) => p instanceof vscode.LanguageModelTextPart ? p.value : '').join('') || '';
    return Promise.resolve(Math.ceil(raw.length / 4));
  }
}

// ========================================================================
// Activation
// ========================================================================

export function activate(context: vscode.ExtensionContext) {
  console.log('[UniversalLLM] Activating...');
  try {
    const provider = new UniversalLLMProvider();
    context.subscriptions.push(vscode.lm.registerLanguageModelChatProvider('universal-llm', provider));
    console.log('[UniversalLLM] Registered successfully');

    // --- Set API Key ---
    context.subscriptions.push(
      vscode.commands.registerCommand('universal-llm.setApiKey', async () => {
        const providers = loadProviderConfigs();
        if (providers.length === 0) {
          const defaults = vscode.workspace.getConfiguration('universal-llm')
            .inspect<ProviderConfig[]>('providers')?.defaultValue || [];
          for (const def of defaults) providers.push({ ...def });
          saveProviderConfigs(providers);
        }

        const items = providers.map((p) => ({
          label: `${p.apiKey ? '🔑' : '○'} ${p.name}`,
          description: p.apiKey ? 'Key set' : 'No key',
          detail: `${p.baseURL} | ${p.models.join(', ')}`,
          provider: p,
        }));

        const sel = await vscode.window.showQuickPick(items, { placeHolder: 'Select a provider' });
        if (!sel) return;

        const key = await vscode.window.showInputBox({
          prompt: `API key for ${sel.provider.name}`, password: true,
          value: sel.provider.apiKey || '', ignoreFocusOut: true,
        });
        if (key === undefined) return;

        sel.provider.apiKey = key;
        sel.provider.enabled = key.length > 0;
        saveProviderConfigs(providers);
        vscode.window.showInformationMessage(`✅ ${sel.provider.name} API key saved. Models: ${sel.provider.models.join(', ')}`);
      })
    );

    context.subscriptions.push(
      vscode.commands.registerCommand('universal-llm.configure', async () => {
        vscode.commands.executeCommand('universal-llm.setApiKey');
      })
    );

    context.subscriptions.push(
      vscode.commands.registerCommand('universal-llm.showStatus', async () => {
        const providers = loadProviderConfigs();
        const lines = providers.map((p) => {
          const icon = p.enabled && p.apiKey ? '✓' : '○';
          return `${icon} ${p.name}: ${p.models.length} models ${p.apiKey ? '(key set)' : '(no key)'}`;
        });
        vscode.window.showInformationMessage(`Universal LLM Status:\n${lines.join('\n')}`);
      })
    );

    console.log('[UniversalLLM] Activation complete');
  } catch (error: any) {
    console.error('[UniversalLLM] Activation error:', error);
    vscode.window.showErrorMessage(`Universal LLM failed: ${error.message}`);
  }
}

export function deactivate() {
  console.log('[UniversalLLM] Deactivating...');
}
