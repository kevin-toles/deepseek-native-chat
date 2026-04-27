// ========================================================================
// Model capability registry — pure logic, no vscode dependency
//
// Note on reasoning_content: The extension handles reasoning_content
// generically via LanguageModelDataPart in extension.ts. Any model that
// returns reasoning_content in streaming delta chunks is automatically
// supported — no per-model registration needed. New DeepSeek model IDs
// (v5, etc.) will work without changes to this file.
// ========================================================================

export type ParserMode = 'none' | 'json' | 'xml' | 'both';

export interface ModelCapabilities {
  nativeToolCalling: boolean;
  fallbackParser: ParserMode;
}

const KNOWN_MODEL_CAPABILITIES: Record<string, ModelCapabilities> = {
  // DeepSeek — native OpenAI-compatible tool calling (V3.2+)
  'deepseek-chat':      { nativeToolCalling: true,  fallbackParser: 'both' },
  'deepseek-reasoner':  { nativeToolCalling: true,  fallbackParser: 'both' },
  'deepseek-v4-pro':    { nativeToolCalling: true,  fallbackParser: 'both' },
  'deepseek-v4-flash':  { nativeToolCalling: true,  fallbackParser: 'both' },
  // deepseek-chat and deepseek-reasoner are deprecated (map to v4-flash internally)
  // deepseek-v4 was never a valid API model — removed Apr 2026
  'qwen-turbo':         { nativeToolCalling: true,  fallbackParser: 'json' },
  'qwen-plus':          { nativeToolCalling: true,  fallbackParser: 'json' },
  'qwen-max':           { nativeToolCalling: true,  fallbackParser: 'json' },
  'glm-5':              { nativeToolCalling: true,  fallbackParser: 'json' },
  'glm-5.1':            { nativeToolCalling: true,  fallbackParser: 'json' },
  'kimi-k2.5':          { nativeToolCalling: true,  fallbackParser: 'json' },
  'kimi-k2.6':          { nativeToolCalling: true,  fallbackParser: 'json' },
};

// API routing: deepseek-chat currently routes to deepseek-v4-flash by default
// To force deepseek-v4-pro, use the model ID directly: 'deepseek-v4-pro'
export function getModelCapabilities(modelId: string): ModelCapabilities {
  return KNOWN_MODEL_CAPABILITIES[modelId] || {
    nativeToolCalling: false,
    fallbackParser: 'json',
  };
}
