# Universal LLM Provider — Tool Calling Fix Spec
**Date:** 2026-04-25  
**File:** `src/extension.ts`  
**Status:** 3 bugs confirmed against source code. 1 previously reported bug already fixed.

---

## Context

DeepSeek supports native OpenAI-compatible tool calling: `tools[]` array in the request, `tool_calls` on the assistant response, and `role: "tool"` messages for results. The protocol is identical to OpenAI. No fallback XML parser or system prompt injection is needed for DeepSeek.

The extension's `mapMessage()` and tool result handling are structurally correct. The three bugs below are the complete set of issues preventing tool calling from working end to end.

---

## Bug #1 — CRITICAL: No streaming tool call accumulation

**Location:** `src/extension.ts` lines 273–289, inside the streaming loop.

**Current code:**
```typescript
if (caps.nativeToolCalling && delta.tool_calls) {
  for (const tc of delta.tool_calls) {
    if (tc.function?.name && tc.function?.arguments) {
      try {
        const args = JSON.parse(tc.function.arguments);
        progress.report(new vscode.LanguageModelToolCallPart(
          tc.id || `tc_${Date.now()}`,
          tc.function.name,
          args
        ));
      } catch {
        // partial JSON during streaming
      }
    }
  }
}
```

**Why it fails:**

DeepSeek (and all OpenAI-compatible APIs) spread tool calls across multiple SSE chunks. The chunks arrive in this sequence:

```
Chunk 1: { index:0, id:"call_abc", function:{ name:"list_dir", arguments:"" } }
Chunk 2: { index:0, function:{ arguments:"{\"pa" } }
Chunk 3: { index:0, function:{ arguments:"th\":\"/src\"}" } }
Chunk N: finish_reason: "tool_calls"
```

The current check `tc.function?.name && tc.function?.arguments` requires both to be truthy in the **same chunk**. On chunk 1, `arguments` is `""` (falsy). On chunks 2–N, `name` is `undefined` (falsy). The condition never passes. Tool calls are silently dropped on every response.

**Required fix:**

Replace the per-chunk emit with an accumulator map keyed by `tc.index`, exactly as OpenClaude's `openaiShim.ts` does. Initialize the entry when `id` and `name` arrive, append to `jsonBuffer` on subsequent chunks, then emit all completed tool calls after the stream ends by checking `finish_reason`.

**Implementation spec:**

Declare the accumulator **before** the streaming loop:
```typescript
const activeToolCalls = new Map<number, { id: string; name: string; jsonBuffer: string }>();
```

Inside the streaming loop, replace the current tool_calls block with:
```typescript
if (caps.nativeToolCalling && delta.tool_calls) {
  for (const tc of delta.tool_calls) {
    const idx = tc.index ?? 0;
    if (tc.id && tc.function?.name) {
      // First chunk for this tool call — initialize entry
      activeToolCalls.set(idx, { id: tc.id, name: tc.function.name, jsonBuffer: '' });
    }
    if (tc.function?.arguments) {
      // Subsequent chunks — append to buffer
      const entry = activeToolCalls.get(idx);
      if (entry) entry.jsonBuffer += tc.function.arguments;
    }
  }
}

// Capture finish_reason to know when tool calls are complete
const finishReason = parsed?.choices?.[0]?.finish_reason;
if (finishReason === 'tool_calls') {
  // finish_reason signals all tool call chunks have arrived
  // Emission happens after the loop (see below)
}
```

After the streaming loop (after `reader.releaseLock()`), emit all accumulated tool calls:
```typescript
if (caps.nativeToolCalling && activeToolCalls.size > 0) {
  for (const [, entry] of activeToolCalls) {
    try {
      const args = JSON.parse(entry.jsonBuffer);
      progress.report(new vscode.LanguageModelToolCallPart(entry.id, entry.name, args));
      console.log(`[UniversalLLM] Native tool call emitted: ${entry.name}`);
    } catch (e) {
      console.error(`[UniversalLLM] Failed to parse tool call args for ${entry.name}:`, entry.jsonBuffer);
    }
  }
}
```

**Note:** Emit after the loop, not inside it. This guarantees the complete JSON is assembled before attempting `JSON.parse`. The `finish_reason: "tool_calls"` check inside the loop is informational for logging only — the map itself is the source of truth.

---

## Bug #2 — ACTIVE BLOCKER: Schema normalization missing

**Location:** `src/extension.ts` lines 203–215, `requestBody.tools` construction.

**Current code:**
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

**Why it fails:**

MCP tool schemas do not guarantee `type: "object"` is present at the top level. When it is absent or null, DeepSeek returns:

```
HTTP 400: {"error":{"message":"Invalid schema for function 'terminal_last_command': 
schema must be a JSON Schema of 'type: \"object\"', got 'type: null'."}}
```

This is the error currently being seen. It fires on the **first** API call, before any tool call accumulation is relevant.

**Required fix:**

Add a `normalizeSchema` function and apply it to every tool before sending:

```typescript
function normalizeSchema(schema: any): object {
  if (!schema || typeof schema !== 'object') {
    return { type: 'object', properties: {}, required: [] };
  }
  return {
    ...schema,
    type: 'object',                                          // always enforce
    properties: schema.properties ?? {},
    required: schema.required ?? [],
    additionalProperties: schema.additionalProperties ?? false,
  };
}
```

Apply in `requestBody.tools` construction:
```typescript
requestBody.tools = options.tools!.map((t) => ({
  type: 'function',
  function: {
    name: t.name,
    description: t.description,
    parameters: normalizeSchema(t.inputSchema),              // was: t.inputSchema || {}
  },
}));
```

`normalizeSchema` should be a standalone function at module level, not inlined, so it can be unit tested independently.

---

## Bug #3 — SILENT DATA LOSS: Nested array in payload messages

**Location:** `src/extension.ts` line 183.

**Current code:**
```typescript
const payloadMessages: any[] = messages.map(mapMessage);
```

**Why it fails:**

`mapMessage` returns either a single object or an array of objects (for parallel tool results — already handled correctly in `mapMessage` itself). Using `.map()` preserves the array-within-array structure. When `mapMessage` returns `[toolResult1, toolResult2]` for a message with parallel results, the payload becomes:

```
[ {role:"user"}, [ {role:"tool",...}, {role:"tool",...} ], {role:"assistant"} ]
```

DeepSeek receives a nested array in the `messages` field and returns a 400. This fails silently in the current code because parallel tool calls are not yet reachable (blocked by Bug #1), but will surface immediately once Bug #1 is fixed.

**Required fix:**

Replace `.map()` with `.flatMap()`:
```typescript
const payloadMessages: any[] = messages.flatMap((msg) => {
  const mapped = mapMessage(msg);
  return Array.isArray(mapped) ? mapped : [mapped];
});
```

This flattens parallel tool results into the top-level array correctly, producing:
```
[ {role:"user"}, {role:"tool",...}, {role:"tool",...}, {role:"assistant"} ]
```

---

## What is already correct — do not change

**`mapMessage()` tool result handling (lines 47–64):** Correctly collects all `LanguageModelToolResultPart` instances into an array and returns them all. The prior write-up described an early-return bug here that does not exist in the current source.

**`content: null` for assistant tool call messages (line 69):** Correctly set. DeepSeek requires `null`, not `""`, for assistant messages that contain `tool_calls`.

**`role: "tool"` with `tool_call_id` (lines 51–55):** Correct format. DeepSeek accepts the standard OpenAI tool result message shape.

**`mapRole()` function:** Correct for all cases currently needed.

**`capabilities.ts` registry:** Correctly marks `deepseek-chat`, `deepseek-v4`, `deepseek-v4-pro`, `deepseek-v4-flash` as `nativeToolCalling: true`. No changes needed.

**Fallback XML parser (`parser.ts`):** Correct and complete for non-native models. No changes needed for DeepSeek but retain for other providers.

---

## Implementation order

Fix in this order. Each is independently deployable and testable.

**Step 1 — Bug #2 (schema normalization):** Add `normalizeSchema()` function, apply to `requestBody.tools`. Resolves the current HTTP 400 immediately. Verify by checking that the first API call succeeds and DeepSeek returns a `tool_calls` delta.

**Step 2 — Bug #1 (streaming accumulation):** Add `activeToolCalls` Map before the streaming loop. Replace the per-chunk emit block. Add post-loop emission. Verify by checking that `[UniversalLLM] Native tool call emitted: list_dir` (or equivalent) appears in the Developer Console after the stream ends.

**Step 3 — Bug #3 (flatMap):** Replace `messages.map(mapMessage)` with the `flatMap` version. This is low-risk and can be applied alongside Step 1 or 2, but should not be skipped — it will cause a silent 400 on the first parallel tool call.

---

## Expected conversation flow after all fixes

```
Turn 1 — Request
  messages: [system, user]
  tools: [normalizeSchema(list_dir), normalizeSchema(read_file), ...]
  → DeepSeek returns: finish_reason:"tool_calls", delta.tool_calls:[{id, name, args chunks...}]

Turn 1 — Post-stream emission
  activeToolCalls Map → progress.report(LanguageModelToolCallPart("call_abc", "list_dir", {path:"/src"}))
  VSCode executes list_dir via MCP

Turn 2 — Request (VSCode calls provideLanguageModelChatResponse again)
  messages: [system, user, assistant(tool_calls), tool(result)]
  → flatMap correctly flattens tool result into top-level array
  → DeepSeek returns natural language response
  → progress.report(LanguageModelTextPart(...))

Done.
```
