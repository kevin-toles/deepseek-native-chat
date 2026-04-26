# DeepSeek Tool-Call Normalization MCP Research

Created: 2026-04-25

Target issue: a VS Code extension is trying to normalize non-native LLM tool usage for DeepSeek. The failure case is a DeepSeek API 400:

```text
messages[9]: content should be a string or a list
```

The visible model output also includes a fallback tool call:

```text
<manage_todo_list>{ ... }</manage_todo_list>
```

## Service State

The local services were restarted and verified before research:

- `unified-search-service`: healthy on `http://localhost:8081`
- `mcp-gateway`: healthy on `http://localhost:8087`
- Working MCP transport from Codex: `SSETransport("http://localhost:8087/mcp/sse")`

The gateway exposed the relevant tools:

- `search_in`
- `knowledge_refine`
- `knowledge_search`
- `diagram_search`
- `hybrid_search`
- `semantic_search`

## MCP Queries Run

```json
[
  {
    "tool": "search_in",
    "source": "code",
    "query": "LLM tool call parser normalize JSON XML function-call streaming tool result"
  },
  {
    "tool": "search_in",
    "source": "textbooks",
    "query": "parser state machine streaming parser tool invocation normalize structured output"
  },
  {
    "tool": "knowledge_refine",
    "collection": "code_chunks",
    "query": "tool call parser JSON XML fallback parser malformed model output"
  },
  {
    "tool": "diagram_search",
    "query": "agent tool calling loop parser dispatch tool result flow"
  },
  {
    "tool": "knowledge_search",
    "query": "parser state machine recursive descent parsing structured output validation JSON XML tool calls"
  }
]
```

## CRE Code Chunks

### LangChain JSON Output Parser

Source:

```text
repo_id: langchain
path: ml/rag-agents/langchain/libs/core/langchain_core/output_parsers/json.py
lines: 31-127
score: 0.419273575
```

Relevant pattern: LangChain treats structured output parsing as a dedicated parser concern. It strips model text, supports partial JSON parsing in streaming mode, returns no parsed object while JSON is incomplete, and only raises final parser errors once the output is complete.

Short excerpt:

```text
Parse the output of an LLM call to a JSON object.
```

Application: the extension should not emit or fail on partial DeepSeek fallback text too early. It should buffer possible tool-call spans and only report or dispatch after the parser has enough input.

### LangChain XML Output Parser

Source:

```text
repo_id: langchain
path: ml/rag-agents/langchain/libs/core/langchain_core/output_parsers/xml.py
lines: 151-250
score: 0.39213639499999997
```

Relevant pattern: XML output parsing is treated as best-effort model-output parsing. Expected tags guide the parser but do not replace validation.

Short excerpt:

```text
Parse an output using xml format.
```

Application: `<manage_todo_list>...</manage_todo_list>` should be parsed as a candidate, then validated against the actual registered tool list and schema.

### Ollama Streaming Parser Interface

Source:

```text
repo_id: ollama
path: ml/inference/ollama/model/parsers/parsers.go
lines: 12-24
score: 0.35701784999999997
```

Relevant pattern: the parser interface accepts streamed chunks and returns three separated outputs: user-visible content, thinking text, and tool calls.

Short excerpt:

```text
Add processes streamed content and returns parsed content, thinking, and tool calls
```

Application: streaming support should not directly forward every DeepSeek delta to VS Code. A fallback parser needs first pass control of the stream so it can suppress tool markup.

### Ollama XML Tool-Call Parser

Source:

```text
repo_id: ollama
path: ml/inference/ollama/x/models/glm4_moe_lite/parser.go
lines: 372-439
score: 0.41565201999999996
```

Relevant pattern: the parser wraps raw text in a synthetic XML root, parses it, validates the function name, pairs keys with values, finds the matching tool schema, then coerces argument values by type.

Short excerpt:

```text
Wrap the content in a root element to make it valid XML
```

Application: a bare XML fallback call should be normalized through a root-wrapper parse step:

```text
<root><manage_todo_list>{...}</manage_todo_list></root>
```

Then the extension can produce an internal normalized call:

```json
{
  "name": "manage_todo_list",
  "arguments": {
    "todoList": []
  }
}
```

### llama.cpp XML Tool-Call Parser

Source:

```text
repo_id: llama-cpp
path: cpp/inference/llama-cpp/common/chat-parser-xml-toolcall.cpp
lines: 1-10
score: 0.34577600399999997
```

Relevant pattern: the XML tool-call parser is adjacent to partial JSON and partial regex helpers.

Short excerpt:

```text
json-partial.h
```

Application: fallback tool-call parsing should be designed for incomplete input, especially in streaming.

### OWASP JSON State-Machine Parser

Source:

```text
repo_id: owasp-zap
path: security/owasp-zap/zap/src/main/java/org/parosproxy/paros/core/scanner/JsonParamParser.java
score: 0.39394929
```

Relevant pattern: a small explicit state machine tracks object, field, value, and post-value states while preserving token position.

Short excerpt:

```text
STATE_READ_VALUE
```

Application: the extension parser should use explicit states rather than one regex pass:

```text
outside_text -> possible_tag -> inside_tool_args -> complete_tool
             -> malformed_tool -> outside_text
```

## Textbook Passages

### Engineering a Compiler, 2nd Edition

Source:

```text
collection: chapters
chapter_id: engineering_a_compiler_2nd_edition_25b03be0_ch029
score: 0.74605289
concepts: start symbol, parse tree, recursive descent, terminal symbols, formal grammar
code_block_count: 8
ascii_diagram_count: 2
```

Passage note: the chapter frames parsing as recognizing a stream of tokens against a grammar, then building structure from terminals and nonterminals.

Short passage excerpt:

```text
it sees a stream of words
```

Application: fallback LLM output can be handled as a token stream where text, tag delimiters, tool names, JSON bodies, and closing tags are grammar terminals.

### Compilers: Principles, Techniques, and Tools, 2nd Edition

Source:

```text
collection: chapters
chapter_id: compilers_principles_techniques_and_tools_2nd_edit_6f69e7ad_ch033
score: 0.7200959180874634
concepts: recursive descent, parse tree, syntax error, lookahead, input string
code_block_count: 6
```

Passage note: the chapter connects recursive-descent procedures with lookahead-based decisions and match routines.

Short passage excerpt:

```text
void match (terminal t)
```

Application: the fallback parser needs lookahead. A `<` character should not immediately be emitted as user text until the parser can decide whether it begins a literal fragment or a tool-call tag.

### Compilers: LR Parsing Material

Source:

```text
collection: chapters
chapter_id: compilers_principles_techniques_and_tools_2nd_edit_6f69e7ad_ch130
score: 0.656147
concepts: LR parsing, input buffer, error recovery, shift, reduce
code_block_count: 4
```

Passage note: the LR parser material emphasizes explicit action decisions over an input buffer and stack.

Short passage excerpt:

```text
ACTION[S, a] = shift t
```

Application: treat streaming chunks like an input buffer. Delay user-visible output until the parser can either complete a candidate tool call or reduce the buffered bytes to ordinary text.

### Crafting Interpreters

Source:

```text
collection: chapters
chapter_id: crafting_interpreters_77153850_ch022
score: 0.5671274036656346
concepts: call expression, parser loop, property access, syntax tree
code_block_count: 30
```

Passage note: the parser loops while the next token extends the current expression, then exits when no extension applies.

Short passage excerpt:

```text
if (match(LEFT_PAREN))
```

Application: fallback parsing should continue consuming while a known tool-call continuation is present. It should flush normal text only when no valid continuation exists.

### Writing an Interpreter in Go

Source:

```text
collection: chapters
chapter_id: writing_an_interpreter_in_go_c623f8c9_ch011
code_block_count: 11
```

Passage note: the result emphasized parser tests around concrete sample input.

Short passage excerpt:

```text
TestLetStatements
```

Application: add regression tests that feed exact DeepSeek fallback strings into the parser.

## Textbook Code Blocks

The textbook code extraction is OCR-derived, so these are useful as design references, not copy-paste implementation sources.

### Recursive Descent / Lookahead

Source:

```text
book: Compilers Principles Techniques and Tools 2nd Edition
chapter_id: compilers_principles_techniques_and_tools_2nd_edit_6f69e7ad_ch033
```

Extracted short blocks:

```c
void stmtO {
switch ( lookahead ) { case expr:
void optexprO { if ( lookahead == expr ) match(expr);
void match (terminal t) {
```

Implementation implication: write the fallback parser as a small deterministic dispatcher keyed by known token/tag lookahead.

### Shift / Reduce Action Handling

Source:

```text
book: Compilers Principles Techniques and Tools 2nd Edition
chapter_id: compilers_principles_techniques_and_tools_2nd_edit_6f69e7ad_ch130
```

Extracted short blocks:

```c
if ( ACTION[S, a] = shift t ) {
} else if ( ACTION[S, a] = reduce A -> beta ) {
```

Implementation implication: maintain parser state over streamed chunks and make explicit decisions about whether to keep buffering, dispatch a tool, or flush text.

### Call Parser Loop

Source:

```text
book: Crafting Interpreters
chapter_id: crafting_interpreters_77153850_ch022
```

Extracted short blocks:

```java
while (true) {
if (match(LEFT_PAREN))
expr = finishCall(expr);
```

Implementation implication: parse extension points in a loop. For this extension, an extension point is a known tool-call envelope.

### Grammar Definition

Source:

```text
book: Engineering a Compiler 2nd Edition
chapter_id: engineering_a_compiler_2nd_edition_25b03be0_ch029
```

Extracted short blocks:

```text
context-free grammar G is a quadruple (T, NT, S, P)
stream of words
```

Implementation implication: define the fallback protocol as a grammar:

```ebnf
fallback_output = { text | tool_call }
tool_call       = open_tag json_object close_tag
open_tag        = "<" tool_name ">"
close_tag       = "</" tool_name ">"
tool_name       = registered_tool_name
json_object     = balanced_json_object
```

## Diagrams

Diagram search was operational, but the returned matches were weaker than the code/textbook hits.

### Engineering a Compiler Expression Grammar

Source:

```text
tool: knowledge_search
book: Engineering a Compiler 2nd Edition
chapter_id: engineering_a_compiler_2nd_edition_25b03be0_ch029
diagram_type: ascii
relevance: medium
```

Short diagram note:

```text
expression grammar over variables and operators
```

Application: useful as a reference for explicitly modeling fallback tool syntax as grammar.

### Systems Performance ASCII Histogram

Source:

```text
tool: search_in
source: diagrams
book: Systems Performance Enterprise and the Cloud 2nd Edition
relevance: low
```

Short excerpt:

```text
256 -> 511 : 485 |**********
```

Application: confirms the diagram shelf is queryable, but this hit is not relevant enough to drive the parser fix.

### Go Select-Style Branching

Source:

```text
tool: diagram_search
book: Hands-On System Programming with Go
relevance: low-to-medium
```

Short excerpt:

```go
case ch1 <- b:
```

Application: weakly related to branch selection. The CRE parser and compiler textbook hits are stronger sources for the actual implementation.

## Recommended Resolution

Normalize by model capability before request serialization.

Native tool-calling providers can receive native tool message shapes. DeepSeek fallback mode should receive text-only or provider-valid message content. The extension should parse fallback tool calls from model text and convert them into the extension's internal normalized tool-call representation.

Concrete steps:

1. Add a provider capability gate before building the request payload.
2. For non-native DeepSeek fallback mode, ensure `message.content` is always a string or provider-supported list. Never send `content: null`.
3. Do not serialize VS Code `LanguageModelToolCallPart` into OpenAI `tool_calls` for a non-native provider.
4. Add parser support for bare XML tool tags:

   ```text
   <manage_todo_list>{...}</manage_todo_list>
   ```

5. Validate the parsed tool name against registered tools.
6. Validate parsed JSON args against the target tool schema before dispatch.
7. Buffer streaming chunks around possible tool-call spans so raw fallback markup is not displayed.
8. Add tests for:

   - complete bare XML tool call
   - tool call split across chunks
   - malformed JSON body
   - unknown tool name
   - normal text before and after a tool call
   - provider payload does not contain `content: null`

