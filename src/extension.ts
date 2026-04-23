import * as vscode from 'vscode';

// ============================================================================
// Types and Interfaces
// ============================================================================

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

// ============================================================================
// Configuration Management
// ============================================================================

function loadProviderConfigs(): ProviderConfig[] {
  const config = vscode.workspace.getConfiguration('universal-llm');
  return config.get<ProviderConfig[]>('providers', []);
}

function saveProviderConfigs(providers: ProviderConfig[]) {
  const config = vscode.workspace.getConfiguration('universal-llm');
  config.update('providers', providers, vscode.ConfigurationTarget.Global);
}

function getEnabledModels(providers: ProviderConfig[]): ModelInfo[] {
  const models: ModelInfo[] = [];
  for (const provider of providers) {
    if (!provider.enabled || !provider.apiKey) continue;
    for (const modelId of provider.models) {
      models.push({
        id: modelId,
        name: modelId,
        vendor: provider.vendor,
      });
    }
  }
  return models;
}

// ============================================================================
// API Helpers
// ============================================================================

function flattenParts(parts: readonly unknown[]): string {
  return parts
    .map((part) => {
      if (part instanceof vscode.LanguageModelTextPart) {
        return part.value;
      }
      return typeof part === 'string' ? part : '';
    })
    .join('');
}

function mapRole(role: vscode.LanguageModelChatMessageRole): 'user' | 'assistant' | 'system' {
  if (role === vscode.LanguageModelChatMessageRole.Assistant) return 'assistant';
  // Check for System role
  const roleAny = role as any;
  if (roleAny === 3 || roleAny === 'system') return 'system';
  return 'user';
}

// ============================================================================
// Main Provider Implementation
// ============================================================================

class UniversalLLMProvider implements vscode.LanguageModelChatProvider {
  async provideLanguageModelChatInformation(
    _options: vscode.PrepareLanguageModelChatModelOptions,
    _token: vscode.CancellationToken
  ): Promise<vscode.LanguageModelChatInformation[]> {
    const providers = loadProviderConfigs();
    const models = getEnabledModels(providers);

    console.log(`[UniversalLLM] Providing ${models.length} models`);

    return models.map((model) => ({
      id: model.id,
      name: model.name,
      family: model.vendor,
      version: '1.0',
      maxInputTokens: model.maxTokens || 128000,
      maxOutputTokens: 4096,
      capabilities: {
        toolCalling: false, // Start simple, no tools initially
      },
    }));
  }

  async provideLanguageModelChatResponse(
    model: vscode.LanguageModelChatInformation,
    messages: readonly vscode.LanguageModelChatMessage[],
    _options: vscode.ProvideLanguageModelChatResponseOptions,
    progress: vscode.Progress<vscode.LanguageModelResponsePart>,
    token: vscode.CancellationToken
  ): Promise<void> {
    const providers = loadProviderConfigs();
    const modelId = model.id;
    
    // Find provider for this model
    let providerConfig: ProviderConfig | undefined;
    for (const provider of providers) {
      if (provider.models.includes(modelId) && provider.enabled && provider.apiKey) {
        providerConfig = provider;
        break;
      }
    }

    if (!providerConfig) {
      throw new Error(
        `No enabled provider found for model: ${modelId}. Configure API key in settings.`
      );
    }

    console.log(`[UniversalLLM] Calling ${providerConfig.name} API for model: ${modelId}`);

    // Prepare messages for API
    const payloadMessages = messages.map((msg) => ({
      role: mapRole(msg.role),
      content: flattenParts(msg.content),
    }));

    // Call API
    const response = await fetch(`${providerConfig.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${providerConfig.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: modelId,
        messages: payloadMessages,
        stream: true,
      }),
    });

    if (!response.ok || !response.body) {
      const errorText = await response.text().catch(() => '');
      throw new Error(
        `${providerConfig.name} API error ${response.status}: ${response.statusText}. ${errorText}`
      );
    }

    // Stream response
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

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
          if (data === '[DONE]') {
            console.log(`[UniversalLLM] Stream complete for ${modelId}`);
            return;
          }

          try {
            const parsed = JSON.parse(data);
            const text = parsed?.choices?.[0]?.delta?.content;
            if (text) {
              // Report text part - CORRECT: LanguageModelTextPart is a LanguageModelResponsePart
              progress.report(new vscode.LanguageModelTextPart(text));
            }
          } catch {
            // Ignore parsing errors for partial data
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  provideTokenCount(
    _model: vscode.LanguageModelChatInformation,
    text: string | vscode.LanguageModelChatMessage,
    _token: vscode.CancellationToken
  ): Promise<number> {
    const raw = typeof text === 'string' ? text : flattenParts(text.content);
    return Promise.resolve(Math.ceil(raw.length / 4));
  }
}

// ============================================================================
// Extension Activation
// ============================================================================

export function activate(context: vscode.ExtensionContext) {
  console.log('[UniversalLLM] Starting activation...');

  try {
    // Create provider instance
    const provider = new UniversalLLMProvider();
    
    // Register language model provider
    const registration = vscode.lm.registerLanguageModelChatProvider('universal-llm', provider);
    context.subscriptions.push(registration);
    
    console.log('[UniversalLLM] Provider registered successfully');

    // Register configuration command
    const configureCommand = vscode.commands.registerCommand('universal-llm.configure', async () => {
      const providers = loadProviderConfigs();
      
      // Create quick pick items
      const items = providers.map((p) => ({
        label: `${p.enabled ? '$(check)' : '$(circle)'} ${p.name}`,
        description: p.apiKey ? 'API key configured' : 'No API key',
        detail: `${p.baseURL}`,
        provider: p,
      }));

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a provider to configure',
      });

      if (!selected) return;

      const provider = selected.provider;

      // Get API key
      const apiKey = await vscode.window.showInputBox({
        prompt: `Enter API key for ${provider.name}`,
        password: true,
        value: provider.apiKey,
        ignoreFocusOut: true,
      });

      if (apiKey === undefined) return;

      // Update provider
      provider.apiKey = apiKey;
      provider.enabled = apiKey.length > 0;
      
      // Save configuration
      saveProviderConfigs(providers);
      
      vscode.window.showInformationMessage(
        `${provider.name} API key saved. Restart chat to see changes.`
      );
    });

    context.subscriptions.push(configureCommand);

    // Register add provider command
    const addProviderCommand = vscode.commands.registerCommand('universal-llm.addProvider', async () => {
      const name = await vscode.window.showInputBox({
        prompt: 'Provider name (e.g., My Custom LLM)',
        ignoreFocusOut: true,
      });
      if (!name) return;

      const baseURL = await vscode.window.showInputBox({
        prompt: 'API Base URL (e.g., https://api.example.com/v1)',
        value: 'https://',
        ignoreFocusOut: true,
      });
      if (!baseURL) return;

      const apiKey = await vscode.window.showInputBox({
        prompt: 'API Key',
        password: true,
        ignoreFocusOut: true,
      });
      if (!apiKey) return;

      const vendor = name.toLowerCase().replace(/\s+/g, '-');

      const providers = loadProviderConfigs();
      providers.push({
        name,
        vendor,
        apiKey,
        baseURL,
        enabled: true,
        models: [], // Will be discovered or manually added
      });

      saveProviderConfigs(providers);

      vscode.window.showInformationMessage(
        `Provider "${name}" added. You may need to manually add model IDs.`
      );
    });

    context.subscriptions.push(addProviderCommand);

    // Register status command
    const statusCommand = vscode.commands.registerCommand('universal-llm.showStatus', async () => {
      const providers = loadProviderConfigs();
      const enabledModels = getEnabledModels(providers);

      const lines = providers.map((p) => {
        const status = p.enabled && p.apiKey ? 'Enabled' : 'Disabled';
        return `${p.name}: ${status} (${p.models.length} models)`;
      });

      vscode.window.showInformationMessage(
        `Universal LLM Status:\n${lines.join('\n')}\n\nTotal models available: ${enabledModels.length}`
      );
    });

    context.subscriptions.push(statusCommand);

    console.log('[UniversalLLM] Activation complete');

  } catch (error: any) {
    console.error('[UniversalLLM] Activation error:', error);
    vscode.window.showErrorMessage(
      `Universal LLM failed to activate: ${error.message}`
    );
  }
}

export function deactivate() {
  console.log('[UniversalLLM] Deactivating...');
}
