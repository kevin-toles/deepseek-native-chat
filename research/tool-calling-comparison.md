# Tool Calling Flow Comparison

## Overview

This document compares three approaches to tool calling in VS Code:

1. **VSCode Native Flow** — How the `LanguageModelChatProvider` API interacts with provider APIs
2. **OpenClaude/Claude Code Flow** — How OpenClaude's `openaiShim.ts` converts messages between Anthropic and OpenAI formats
3. **Universal LLM Provider (Our Extension)** — Current implementation

---

## 1. VSCode Native Flow (OpenRouter, GitHub Copilot, etc.)

### Architecture

```
User Message
  │
  ▼
VSCode Chat UI
  │
  ├── MCP Servers (provide tool definitions)
  │
  ▼
VSCode calls LanguageModelChatProvider.provideLanguageModelChatResponse({
  model,
  messages: [LanguageModelChatMessage[]],
  options: {
    tools: [{ name, description, inputSchema }],   // ← from MCP servers
    toolMode: 'required' | 'optional'
  }
})
  │
  ▼
Provider sends POST /v1/chat/completions to LLM API:
{
  model: "deepseek-chat",
  messages: [
    { role: "system", content: "..." },
    { role: "user", content: "list the files" },
    { role: "assistant", content: null, tool_calls: [...] },  ← after first call
    { role: "tool", tool_call_id: "tc_xxx", content: "..." }  ← after tool result
  ],
  tools: [ ... ],          ← passed EVERY request
  stream: true
}
  │
  ▼
Provider receives SSE stream:
data: {"choices":[{"delta":{"content":"text"}}]}
data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"list_dir","arguments":"{\"path\":\"...\"}"}}]}}]}
data: [DONE]
  │
  ├── delta.content → progress.report(LanguageModelTextPart)
  ├── delta.tool_calls → progress.report(LanguageModelToolCallPart)
  │
  ▼
VSCode receives ToolCallPart → executes MCP tool
  │
  ▼
VSCode calls provideLanguageModelChatResponse() AGAIN with:
  messages: [..., assistant_tool_call_message, tool_result_message]
  options.tools: [same tools]           ← STILL includes tools!
  │
  ▼
...repeat until model responds with text (no tool_calls)
```

### Key Characteristics

- **`options.tools` is passed on every invocation** — both initial and tool-result callbacks
- **Tool calls arrive across multiple SSE chunks** — `id` + `name` in one chunk, `arguments` in separate chunks
- **`content: null` for assistant messages with `tool_calls`** — standard OpenAI format
- **`finish_reason: 'tool_calls'`** — signals the model wants to call tools
- **MCP tool execution is handled by VSCode** — provider only emits `LanguageModelToolCallPart`

---

## 2. OpenClaude / Claude Code Flow (openaiShim.ts)

### Architecture

```
Claude Code (Anthropic SDK)
  │
  ├── calls client.messages.create({ system, messages: [{role, content: [blocks]}] })
  │
  ▼
openaiShim.ts converts Anthropic → OpenAI:
{
  messages: [
    { role: "system", content: "..." },
    { role: "user", content: "text" or [{type:"text",text:"..."},{type:"image_url",...}] },
    { role: "assistant",
      content: "text response",
      tool_calls: [{ id, type: "function", function: { name, arguments } }]
    },
    { role: "tool", tool_call_id: "...", content: "result" }
  ],
  tools: [{ type: "function", function: { name, description, parameters } }],
  tool_choice: "auto" | "required"
}
  │
  ▼
POST to provider API (OpenAI-compatible)
  │
  ▼
Receive SSE stream → convert back to Anthropic events:
  delta.content → content_block_start/delta (text)
  delta.tool_calls → content_block_start/delta (tool_use with input_json_delta)
  finish_reason: "tool_calls" → stop_reason: "tool_use"
  │
  ▼
Claude Code processes Anthropic events:
  - text → display to user
  - tool_use → execute tool, get result
  - Append tool_result to messages
  - Call client.messages.create() again
```

### Key Characteristics

- **Accumulates tool calls across chunks** — Uses `activeToolCalls` Map (keyed by `tc.index`)
- **Handles partial JSON** — Accumulates `arguments` across chunks and auto-completes malformed JSON at end
- **Normalizes schemas** — Ensures all `properties` keys are in `required[]`, sets `additionalProperties: false`
- **Handles image content** — Converts `image_url` for multimodal models
- **Handles thinking blocks** — Wraps in `<thinking>` tags as text
- **Separates tool_use from text** — Text content and tool calls can exist in the same assistant message
- **Supports multiple parallel tool calls** — Multiple `tool_use` blocks → multiple `tool_calls`

### Critical Code Pattern (Streaming Accumulation)

```typescript
// From openaiShim.ts
const activeToolCalls = new Map<number, {
  id: string;
  name: string;
  index: number;
  jsonBuffer: string;
}>();

// On each chunk:
if (delta.tool_calls) {
  for (const tc of delta.tool_calls) {
    if (tc.id && tc.function?.name) {
      // New tool call: create entry
      activeToolCalls.set(tc.index, { id: tc.id, name: tc.function.name, ... });
      // Emit content_block_start
    } else if (tc.function?.arguments) {
      // Continuation: append to buffer
      active = activeToolCalls.get(tc.index);
      active.jsonBuffer += tc.function.arguments;
      // Emit content_block_delta (input_json_delta)
    }
  }
}
```

---

## 3. Universal LLM Provider (Our Extension)

### Architecture

```
VS Code Chat
  │
  ▼
VSCode calls provideLanguageModelChatResponse()
  │
  ▼
mapMessage() converts VSCode parts:
  TextPart → { role, content: "text" }
  ToolCallPart → { role: "assistant", content: null, tool_calls: [...] }
  ToolResultPart → { role: "tool", content: "...", tool_call_id: "..." }
  │
  ▼
POST /v1/chat/completions with:
{
  messages: [...],
  tools: [...]  ← only if caps.nativeToolCalling && hasTools
}
  │
  ▼
Stream loop processes chunks:
  delta.content → LanguageModelTextPart
  delta.tool_calls → LanguageModelToolCallPart  (if name AND arguments in same chunk)
  │
  ▼
After stream: fallback parser (for non-native models only)
  - Parses accumulated text for XML/JSON tool call syntax
```

### Key Characteristics

- **No accumulator for streaming tool calls** — Requires `name` AND `arguments` in same SSE chunk
- **Early return for tool results** — First `ToolResultPart` triggers immediate return (losing subsequent results)
- **No schema normalization** — Passes raw `inputSchema` directly
- **Fallback parser** — For models that don't support native tool calling
- **System prompt injection** — For non-native models, injects tool definitions as text in system prompt

---

## Critical Differences & Bugs

### BUG #1: Streaming Tool Call Accumulation (HIGH)

**Location**: `src/extension.ts` — streaming loop

**Our code**:
```typescript
if (caps.nativeToolCalling && delta.tool_calls) {
  for (const tc of delta.tool_calls) {
    if (tc.function?.name && tc.function?.arguments) {  // ← BUG
      const args = JSON.parse(tc.function.arguments);
      progress.report(new vscode.LanguageModelToolCallPart(...));
    }
  }
}
```

**What DeepSeek actually sends** (across multiple SSE chunks):
```
Chunk 1: { delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "list_dir", arguments: "" } }] } }
Chunk 2: { delta: { tool_calls: [{ index: 0, function: { arguments: "{\"path\":" } }] } }
Chunk 3: { delta: { tool_calls: [{ index: 0, function: { arguments: "\"/tmp\"" } }] } }
Chunk 4: { delta: { tool_calls: [{ index: 0, function: { arguments: "}" } }] } }
```

**Problem**:
- Chunk 1: `tc.function.arguments` is `""` (falsy) → **SKIPPED**
- Chunks 2-4: `tc.function.name` is undefined → **SKIPPED**
- **Result**: Tool call is NEVER emitted to VSCode

**Fix**: Use `activeToolCalls` Map like OpenClaude does, accumulating across chunks.

### BUG #2: Early Return for Tool Results (MEDIUM)

**Location**: `src/extension.ts` — `mapMessage()`

**Our code**:
```typescript
else if (part instanceof vscode.LanguageModelToolResultPart) {
  return { role: 'tool', content: resultText, tool_call_id: part.callId };  // ← BUG
}
```

**Problem**: Returns immediately on the FIRST `ToolResultPart`. If a VSCode message contains multiple tool results (from parallel tool calls), only the first one is mapped. The rest are lost.

**Fix**: Collect all tool results in an array, return them all (or as individual messages).

### BUG #3: Schema Not Normalized (LOW)

**Location**: `src/extension.ts` — `requestBody.tools` construction

**Our code**:
```typescript
requestBody.tools = options.tools!.map((t) => ({
  type: 'function',
  function: {
    name: t.name,
    description: t.description,
    parameters: t.inputSchema || {},
  },
}));
```

**Problem**: DeepSeek/OpenAI require `additionalProperties: false` and all properties in `required[]` for strict mode. Raw schemas from MCP may not comply.

**Fix**: Normalize schemas like OpenClaude does.

### BUG #4: `content: null` for Assistant Messages (MEDIUM)

**Location**: `src/extension.ts` — `mapMessage()`

**Our code**:
```typescript
if (toolCalls && role === 'assistant') {
  return { role, content: null, tool_calls: toolCalls };  // ← was content: ''
}
```

**Status**: Already fixed. VSCode expects `null` for assistant messages with tool_calls, matching the standard OpenAI format.

---

## Three-Column Comparison

| Aspect | VSCode Native | OpenClaude | Our Extension |
|--------|--------------|------------|---------------|
| **Message format** | VSCode `LanguageModelChatMessage` parts | Anthropic content blocks | VSCode parts (mapped) |
| **Tool definitions** | `options.tools` from MCP | `tools` param converted from Anthropic format | `options.tools` from MCP |
| **Tools on every call** | Yes (VSCode passes on every invocation) | Yes (Claude Code sends tools every request) | Yes (re-reads from each call) |
| **Streaming accumulation** | N/A (VSCode emits parts per-chunk) | `activeToolCalls` Map by index | ❌ **None** — requires name+args in one chunk |
| **Parallel tool calls** | Handled by VSCode | Multiple `tool_use` blocks → multiple `tool_calls` | ❌ **Early return** — only first tool result |
| **Schema normalization** | N/A (provider's job) | `normalizeSchemaForOpenAI()` | ❌ **Raw pass-through** |
| **Content for tool msgs** | `null` for assistant, string for tool | `null` for assistant, string for tool | ✅ Now `null` for assistant |
| **Fallback parser** | N/A | N/A (always uses native) | ✅ Available for non-native models |
| **Error handling** | VSCode handles retry | Retry logic, rate limiting | ❌ Basic error logging only |
| **Image/thinking** | Via appropriate part types | Handled via content blocks | ❌ Not handled |

---

## Summary

The single most impactful fix is **BUG #1**: implementing streaming tool call accumulation. Without it, DeepSeek tool calls are never emitted to VSCode, making the entire tool calling system non-functional for the model that needs it most.

The second most impactful fix is **BUG #2**: supporting multiple tool results in a single `mapMessage` call, which is required for parallel tool execution.

Once these two bugs are fixed, the extension should work identically to how OpenRouter/GitHub Copilot work with the VS Code `LanguageModelChatProvider` API, since DeepSeek supports the same standard OpenAI-compatible tool calling format.
