import * as assert from 'assert';
import { ToolCallParser, ParserMode, ToolInfo, ParsedToolCall } from '../lib/parser';
import { getModelCapabilities } from '../lib/capabilities';

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

const tools: ToolInfo[] = [
  { name: 'read_file', description: 'Read file contents', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
  { name: 'write_file', description: 'Write content to file', inputSchema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } } },
  { name: 'search', description: 'Search codebase', inputSchema: { type: 'object', properties: { query: { type: 'string' } } } },
  { name: 'execute_command', description: 'Run terminal command', inputSchema: { type: 'object', properties: { cmd: { type: 'string' } } } },
];

const parser = new ToolCallParser();

function expectToolCall(parsed: ParsedToolCall | null, name: string, args?: Record<string, unknown>) {
  assert.ok(parsed, `Expected tool call "${name}" but got null`);
  assert.strictEqual(parsed!.name, name, `Expected name "${name}" got "${parsed!.name}"`);
  if (args) assert.deepStrictEqual(parsed!.args, args);
}

function expectNull(parsed: ParsedToolCall | null) {
  assert.strictEqual(parsed, null, `Expected null but got ${JSON.stringify(parsed)}`);
}

// -----------------------------------------------------------------------
// JSON parser tests
// -----------------------------------------------------------------------

describe('ToolCallParser — JSON mode', () => {
  const mode: ParserMode = 'json';

  it('extracts {"command": "...", "args": {...}} pattern', () => {
    const text = 'Some text {"command": "read_file", "args": {"path": "/foo"}} more text';
    expectToolCall(parser.parseToolCall(text, mode), 'read_file', { path: '/foo' });
  });

  it('extracts {"name": "...", "arguments": {...}} (OpenAI style)', () => {
    const text = '{"name": "search", "arguments": {"query": "hello"}}';
    expectToolCall(parser.parseToolCall(text, mode), 'search', { query: 'hello' });
  });

  it('extracts command with args spread at top level', () => {
    const text = '{"command": "write_file", "path": "/tmp/f", "content": "hi"}';
    expectToolCall(parser.parseToolCall(text, mode), 'write_file', { path: '/tmp/f', content: 'hi' });
  });

  it('accepts unknown tool name (agnostic parser)', () => {
    const text = '{"command": "unknown_tool", "args": {"x": 1}}';
    expectToolCall(parser.parseToolCall(text, mode), 'unknown_tool', { x: 1 });
  });

  it('returns null for empty text', () => {
    expectNull(parser.parseToolCall('', mode));
  });

  it('returns null for plain text without tool calls', () => {
    expectNull(parser.parseToolCall('Hello, how can I help you today?', mode));
  });

  it('handles nested JSON in args', () => {
    const text = '{"command": "execute_command", "args": {"cmd": "ls -la", "timeout": 30}}';
    expectToolCall(parser.parseToolCall(text, mode), 'execute_command', { cmd: 'ls -la', timeout: 30 });
  });
});

// -----------------------------------------------------------------------
// XML parser tests
// -----------------------------------------------------------------------

describe('ToolCallParser — XML mode', () => {
  const mode: ParserMode = 'xml';

  it('extracts <tool_call><invoke name="...">...</invoke></tool_call>', () => {
    const text = '<tool_call><invoke name="read_file"><path>/foo/bar</path></invoke></tool_call>';
    expectToolCall(parser.parseToolCall(text, mode), 'read_file', { path: '/foo/bar' });
  });

  it('extracts <function=name>{"arg":"val"}</function> (Anthropic style)', () => {
    const text = '<function=search>{"query":"hello world"}</function>';
    expectToolCall(parser.parseToolCall(text, mode), 'search', { query: 'hello world' });
  });

  it('extracts <tool_call><ToolName>...</ToolName></tool_call> (simple)', () => {
    const text = '<tool_call><write_file>{"path":"/tmp/x","content":"data"}</write_file></tool_call>';
    expectToolCall(parser.parseToolCall(text, mode), 'write_file', { path: '/tmp/x', content: 'data' });
  });

  it('handles MCP-style tool names with dots and hyphens', () => {
    const text = '<tool_call> <invoke name="mcp_ai-kitchen-br_llm_complete"> <prompt>hello</prompt> </invoke> </tool_call>';
    expectToolCall(parser.parseToolCall(text, mode), 'mcp_ai-kitchen-br_llm_complete', { prompt: 'hello' });
  });

  it('handles MCP variant: <invoke name="..."> closed with </{name}> instead of </invoke>', () => {
    const text = '<tool_call> <invoke name="mcp_ai-kitchen-br_llm_complete"> <prompt>Say "Hello! MCP tools are working."</prompt> <system_prompt>You are helpful.</system_prompt> <temperature>0</temperature> <max_tokens>50</max_tokens> </mcp_ai-kitchen-br_llm_complete> </tool_call>';
    const parsed = parser.parseToolCall(text, mode);
    expectToolCall(parsed, 'mcp_ai-kitchen-br_llm_complete');
    assert.ok(parsed!.args.prompt);
    assert.strictEqual((parsed!.args as any).temperature, 0);
    assert.strictEqual((parsed!.args as any).max_tokens, 50);
  });

  it('coerces numeric and boolean values in XML params', () => {
    const text = '<tool_call><invoke name="execute_command"><cmd>ls</cmd><timeout>30</timeout><recursive>true</recursive></invoke></tool_call>';
    const parsed = parser.parseToolCall(text, mode);
    expectToolCall(parsed, 'execute_command');
    assert.strictEqual((parsed!.args as Record<string, unknown>)['timeout'], 30);
    assert.strictEqual((parsed!.args as Record<string, unknown>)['recursive'], true);
  });

  it('accepts unknown tool name (agnostic parser)', () => {
    const text = '<tool_call><invoke name="some_random_tool"><x>1</x></invoke></tool_call>';
    expectToolCall(parser.parseToolCall(text, mode), 'some_random_tool', { x: 1 });
  });

  it('handles Ollama-style: <tool_call><tool_name>...</tool_name><parameters>...</parameters></tool_call>', () => {
    const text = '<tool_call>\n  <tool_name>read_file</tool_name>\n  <parameters>\n    <path>/foo</path>\n  </parameters>\n</tool_call>';
    expectToolCall(parser.parseToolCall(text, mode), 'read_file', { path: '/foo' });
  });

  it('handles bare XML tag: <manage_todo_list>{...}</manage_todo_list>', () => {
    const text = '<manage_todo_list> { "items": ["a", "b"] } </manage_todo_list>';
    expectToolCall(parser.parseToolCall(text, mode), 'manage_todo_list', { items: ['a', 'b'] });
  });

  it('handles bare <invoke name="...">...</invoke> without <tool_call> wrapper', () => {
    const text = '<invoke name="list_dir"> <parameter name="path" string="true">/Users/test/foo</parameter> </invoke>';
    expectToolCall(parser.parseToolCall(text, mode), 'list_dir', { path: '/Users/test/foo' });
  });

  it('handles bare <invoke> with name attribute params and text before', () => {
    const text = 'Let me run it correctly now:\n<invoke name="list_dir"> <parameter name="path" string="true">/foo</parameter> </invoke>';
    expectToolCall(parser.parseToolCall(text, mode), 'list_dir', { path: '/foo' });
  });

  it('returns null for malformed XML', () => {
    expectNull(parser.parseToolCall('<tool_call>broken stuff here</tool_call>', mode));
  });
});

// -----------------------------------------------------------------------
// Both mode tests
// -----------------------------------------------------------------------

describe('ToolCallParser — both mode', () => {
  const mode: ParserMode = 'both';

  it('parses JSON format', () => {
    expectToolCall(parser.parseToolCall('{"command": "search", "args": {"query": "x"}}', mode), 'search');
  });

  it('parses XML format', () => {
    expectToolCall(parser.parseToolCall('<tool_call><invoke name="read_file"><path>x</path></invoke></tool_call>', mode), 'read_file');
  });

  it('prefers XML when both are present', () => {
    const text = '<tool_call><invoke name="read_file"><path>x</path></invoke></tool_call> and then {"command": "search", "args": {"query": "y"}}';
    const parsed = parser.parseToolCall(text, mode);
    assert.ok(parsed);
    assert.strictEqual(parsed!.name, 'read_file'); // XML is tried first
  });
});

// -----------------------------------------------------------------------
// Tool prompt tests
// -----------------------------------------------------------------------

describe('ToolCallParser — buildToolPrompt', () => {
  it('includes all tool names and descriptions', () => {
    const prompt = parser.buildToolPrompt(tools, 'json');
    assert.ok(prompt.includes('read_file'));
    assert.ok(prompt.includes('Read file contents'));
    assert.ok(prompt.includes('write_file'));
    assert.ok(prompt.includes('search'));
  });

  it('includes JSON format instructions', () => {
    const prompt = parser.buildToolPrompt(tools, 'json');
    assert.ok(prompt.includes('"command"'));
    assert.ok(prompt.includes('"args"'));
  });

  it('includes XML format instructions when mode is xml', () => {
    const prompt = parser.buildToolPrompt(tools, 'xml');
    assert.ok(prompt.includes('<tool_call>'));
    assert.ok(prompt.includes('<invoke name='));
  });

  it('includes both format instructions when mode is both', () => {
    const prompt = parser.buildToolPrompt(tools, 'both');
    assert.ok(prompt.includes('"command"'));
    assert.ok(prompt.includes('<tool_call>'));
  });

  it('returns empty string when no tools', () => {
    assert.strictEqual(parser.buildToolPrompt([], 'json'), '');
  });
});

// -----------------------------------------------------------------------
// stripToolCall tests
// -----------------------------------------------------------------------

describe('ToolCallParser — stripToolCall', () => {
  it('removes raw tool call markup from text', () => {
    const text = 'Let me check that file for you. {"command": "read_file", "args": {"path": "/foo"}} Here is the result.';
    const parsed = parser.parseToolCall(text, 'json');
    assert.ok(parsed);
    const cleaned = parser.stripToolCall(text, parsed!);
    assert.strictEqual(cleaned, 'Let me check that file for you. Here is the result.');
  });

  it('handles XML tool calls', () => {
    const text = 'I will look that up. <tool_call><invoke name="search"><query>hello</query></invoke></tool_call>';
    const parsed = parser.parseToolCall(text, 'xml');
    assert.ok(parsed);
    const cleaned = parser.stripToolCall(text, parsed!);
    assert.strictEqual(cleaned, 'I will look that up.');
  });
});

// -----------------------------------------------------------------------
// Model capability tests
// -----------------------------------------------------------------------

describe('Model capabilities', () => {
  it('deepseek-chat uses native tool calling', () => {
    const caps = getModelCapabilities('deepseek-chat');
    assert.strictEqual(caps.nativeToolCalling, true);
    assert.strictEqual(caps.fallbackParser, 'both');
  });

  it('qwen-max uses native tool calling', () => {
    const caps = getModelCapabilities('qwen-max');
    assert.strictEqual(caps.nativeToolCalling, true);
  });

  it('unknown model defaults to fallback', () => {
    const caps = getModelCapabilities('unknown-model');
    assert.strictEqual(caps.nativeToolCalling, false);
    assert.strictEqual(caps.fallbackParser, 'json');
  });
});
