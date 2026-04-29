# Changelog — 2025-07-13

## Commit: `775217d`

**Message:** `fix: tool calling support for DeepSeek and other models`

If you need to revert all changes: `git revert 775217d`

---

## Files Modified

### `src/extension.ts` — Major rewrite

**What changed:**
- Added `mapMessage()` function — converts VSCode `LanguageModelChatMessage` parts to OpenAI API format. Handles `TextPart`, `ToolCallPart`, `ToolResultPart`. Supports parallel tool results (returns array).
- Added `normalizeSchema()` function — prevents "type: null" 400 errors from DeepSeek by ensuring every tool schema has `type: "object"`, `properties: {}`, `required: []`, `additionalProperties: false`.
- Added `mapRole()` function — VSCode role → API role mapping (handles assistant, user, system, tool roles).
- Added `findProviderForModel()` — replaces the inline loop to find the matching provider config.
- Changed `getEnabledModels()` → `getAllModels()` — removed the `apiKey` filter so all configured models are registered regardless of key status.
- Changed `flattenParts()` — removed in favor of `mapMessage()`. Now properly maps tool call and tool result parts instead of flattening everything to text.
- Changed `_options` → `options` in `provideLanguageModelChatResponse()` — now reads `options.tools` and `options.toolMode`.
- Added tool capabilities — `capabilities: { toolCalling: true }` in model info.
- Added tool injection — for native models, sends `tools[]` array in API request body.
- Added tool prompt injection — for non-native models, injects tool definitions as a system prompt.
- Changed `messages.map(mapMessage)` → `messages.flatMap(...)` — flatMap prevents nested arrays from parallel tool results.
- Changed streaming loop — added `activeToolCalls` Map to accumulate tool calls across SSE chunks (id+name in one chunk, arguments in later chunks). Emits `LanguageModelToolCallPart` after stream ends.
- Added fallback parser — parses XML/JSON tool calls from accumulated text for non-native models.
- Added API key prompt — if no API key is configured, prompts user to enter one when first used.
- Changed role mapping (`mapRole`) — now returns `'tool'` and `'system'` roles.
- Removed `install:dev` and `install:local` npm scripts.

### `src/lib/capabilities.ts` — **New file**

Model capability registry with per-model configuration:

| Model | nativeToolCalling | fallbackParser |
|-------|:-:|:-:|
| `deepseek-chat` | ✅ true | both |
| `deepseek-reasoner` | ✅ true | both |
| `deepseek-v4-pro` | ✅ true | both |
| `deepseek-v4-flash` | ✅ true | both |
| `qwen-turbo` | ✅ true | json |
| `qwen-plus` | ✅ true | json |
| `qwen-max` | ✅ true | json |
| `glm-5` | ✅ true | json |
| `glm-5.1` | ✅ true | json |
| `kimi-k2.5` | ✅ true | json |
| `kimi-k2.6` | ✅ true | json |

Unrecognized models default to `{ nativeToolCalling: false, fallbackParser: 'json' }`.

### `src/lib/parser.ts` — **New file**

Tool call parser with three modes:
- **XML** — parses `<invoke>` blocks with `<tool_name>` and `<parameters>` tags
- **JSON** — parses single JSON tool declarations
- **both** — tries JSON first, falls back to XML

Also provides `buildToolPrompt()` for non-native models, generates a system prompt describing available tools.

### `package.json`

- Version `0.1.0` → `0.3.1`
- Description updated
- Command `universal-llm.addProvider` → `universal-llm.setApiKey`
- Default providers: all enabled, expanded model lists
- Added `deepseek-reasoner`, `deepseek-v4-pro`, `deepseek-v4-flash`
- Removed `deepseek-v4` (doesn't exist as a model ID)
- Removed `deepseek-coder` (deprecated)
- Scripts: `test` changed to `mocha`, removed `install:dev` and `install:local`
- Dependencies: added `@types/mocha`, `mocha`

### `tsconfig.json`, `tsconfig.test.json`, `test-settings.json`

Build config updates for test support.

---

## Files Created (New)

| File | Purpose |
|------|---------|
| `src/lib/capabilities.ts` | Model capability registry |
| `src/lib/parser.ts` | ToolCallParser — XML/JSON fallback parser |
| `src/test/parser.test.ts` | Unit tests for ToolCallParser |
| `research/universal-llm-fixes.md` | Bug spec document |
| `research/tool-calling-comparison.md` | Three-way flow comparison |
| `research/tool-calling-comparison.json` | Structured comparison data |
| `research/deepseek-tool-normalization-mcp-research.md` | Initial research |
| `research/deepseek-tool-normalization-mcp-research.json` | Research data |
| `research/codex-mcp-tooling-issues.md` | Research notes |
| `research/session-2-complete.md` | Session summary |
| `test-settings.json` | VSCode test settings |
| `tsconfig.test.json` | TypeScript test config |

---

## Key Decisions

1. **Tool calls emitted post-stream** — not during streaming. This guarantees complete JSON before parsing.
2. **Schema normalization is shallow** — only normalizes the top-level schema. DeepSeek doesn't require recursive normalization yet.
3. **flatMap for message arrays** — prevents nested arrays from parallel tool results without complex type checks.
4. **Fallback parser is agnostic** — doesn't validate tool names against available tools. VSCode validates when receiving `ToolCallPart`.
5. **`deepseek-reasoner` set to nativeToolCalling:true** — verified via API that it returns tool_calls natively (routes to deepseek-v4-flash internally).
