import * as vscode from 'vscode';
import { ToolCallParser, ToolInfo, ParserMode } from './lib/parser';
import { getModelCapabilities } from './lib/capabilities';

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

function mapMessage(msg: vscode.LanguageModelChatMessage): any | any[] {
  const role = mapRole(msg.role);
  const parts = msg.content;

  const textParts: string[] = [];
  let toolCalls: any[] | undefined;
  const toolResults: any[] = [];

  for (const part of parts) {
    if (part instanceof vscode.LanguageModelTextPart) {
      textParts.push(part.value);
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
    } else if (typeof part === 'string') {
      textParts.push(part);
    }
  }

  // If there are tool results, return them (may be multiple for parallel calls)
  if (toolResults.length > 0) {
    return toolResults.length === 1 ? toolResults[0] : toolResults;
  }

  const content = textParts.join('\n');

  if (toolCalls && role === 'assistant') {
    return { role, content: null, tool_calls: toolCalls };
  }

  return { role, content };
}

// ========================================================================
// Schema Normalization
// ========================================================================

/**
 * Normalize a JSON schema for DeepSeek/OpenAI compliance.
 * Ensures type:"object", properties object, required array, and
 * additionalProperties:false are always present.
 */
function normalizeSchema(schema: any): object {
  if (!schema || typeof schema !== 'object') {
    return { type: 'object', properties: {}, required: [] };
  }
  return {
    ...schema,
    type: 'object',
    properties: schema.properties ?? {},
    required: schema.required ?? [],
    additionalProperties: schema.additionalProperties ?? false,
  };
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
      const mapped = mapMessage(msg);
      return Array.isArray(mapped) ? mapped : [mapped];
    });

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
