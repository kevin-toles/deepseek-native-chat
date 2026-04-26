// ========================================================================
// Tool Call Parser — pure logic, no vscode dependency
// Agnostic parser: detects tool calls without pre-validating tool names.
// Supports multiple common formats across LLM providers.
// ========================================================================

export interface ParsedToolCall {
  name: string;
  args: Record<string, unknown>;
  raw: string;
}

export type ParserMode = 'none' | 'json' | 'xml' | 'both';

export interface ToolInfo {
  name: string;
  description: string;
  inputSchema?: object;
}

export class ToolCallParser {
  /** Build a system prompt that tells the model about available tools */
  buildToolPrompt(tools: ToolInfo[], parserType: ParserMode): string {
    if (tools.length === 0) return '';

    const toolDescriptions = tools
      .map((t) => {
        let desc = `- **${t.name}**: ${t.description}`;
        if (t.inputSchema) {
          desc += `\n  Input schema: \`\`\`json\n${JSON.stringify(t.inputSchema, null, 2)}\n\`\`\``;
        }
        return desc;
      })
      .join('\n\n');

    const formatInstructions: string[] = [];
    if (parserType === 'json' || parserType === 'both') {
      formatInstructions.push(
        '**JSON format**: `{"command": "<tool_name>", "args": {<param1>: <value1>, ...}}`'
      );
    }
    if (parserType === 'xml' || parserType === 'both') {
      formatInstructions.push(
        '**XML format**: `<tool_call><invoke name="<tool_name>"><param1>value1</param1></invoke></tool_call>`'
      );
    }

    return [
      'You have access to the following tools:',
      '',
      toolDescriptions,
      '',
      '**How to use tools:**',
      'When you need to use a tool, respond with ONLY the tool call in one of these formats:',
      ...formatInstructions,
      '',
      '**Important rules:**',
      '- Use only ONE tool call per response',
      '- After receiving the tool result, continue the conversation naturally',
      '- If you need to use multiple tools, use them one at a time',
      '- Do NOT explain what you are doing — just output the tool call',
      '',
      'When done with tools, respond normally.',
    ].join('\n');
  }

  /**
   * Parse a tool call from text. Agnostic — does NOT validate tool names.
   * Returns the first valid-looking tool call found.
   */
  parseToolCall(text: string, parserType: ParserMode, _tools?: ToolInfo[]): ParsedToolCall | null {
    // Try XML patterns first
    if (parserType === 'xml' || parserType === 'both') {
      const parsed = this.parseXml(text);
      if (parsed) return parsed;
    }

    // Try JSON patterns
    if (parserType === 'json' || parserType === 'both') {
      const parsed = this.parseJson(text);
      if (parsed) return parsed;
    }

    return null;
  }

  /** Extract clean display text by stripping tool call markup */
  stripToolCall(text: string, parsed: ParsedToolCall): string {
    return text.replace(parsed.raw, '').replace(/\s{2,}/g, ' ').trim();
  }

  // ================================================================
  // XML Parsing Strategies
  // Each strategy is tried in order until one matches.
  // ================================================================

  private parseXml(text: string): ParsedToolCall | null {
    // Strategy 1: <tool_call> wrapper (any inner pattern)
    const s1 = this.tryToolCallWrapper(text);
    if (s1) return s1;

    // Strategy 2: <function=name>...</function> (Anthropic)
    const s2 = this.tryFunctionPattern(text);
    if (s2) return s2;

    // Strategy 3: Bare XML tag where tag name is tool name
    // e.g. <manage_todo_list>{...}</manage_todo_list>
    const s3 = this.tryBareToolTag(text);
    if (s3) return s3;

    // Strategy 4: Bare <invoke name="...">...</invoke> without <tool_call> wrapper
    // e.g. <invoke name="list_dir"><parameter name="path" string="true">/foo</parameter></invoke>
    const s4 = this.tryBareInvoke(text);
    if (s4) return s4;

    return null;
  }

  /** Matches <tool_call>...any tool body...</tool_call> */
  private tryToolCallWrapper(text: string): ParsedToolCall | null {
    // Sub-strategy A: <invoke name="...">...</invoke> or </{name}>
    const invokeMatch = text.match(/<tool_call>\s*<invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/(invoke|\1)>\s*<\/tool_call>/);
    if (invokeMatch) {
      return {
        name: invokeMatch[1],
        args: this.parseXmlParams(invokeMatch[2]),
        raw: invokeMatch[0],
      };
    }

    // Sub-strategy B: <tool_call><Name>...</Name></tool_call> (generic inner tag)
    const simpleMatch = text.match(/<tool_call>\s*<([a-zA-Z0-9_\.:-]+)>([\s\S]*?)<\/\1>\s*<\/tool_call>/);
    if (simpleMatch) {
      const body = simpleMatch[2].trim();
      try {
        return { name: simpleMatch[1], args: JSON.parse(body), raw: simpleMatch[0] };
      } catch {
        return { name: simpleMatch[1], args: { value: body }, raw: simpleMatch[0] };
      }
    }

    // Sub-strategy C: Ollama-style <tool_name> + <parameters>
    const ollamaMatch = text.match(/<tool_call>\s*<tool_name>\s*([a-zA-Z0-9_\.:-]+)\s*<\/tool_name>([\s\S]*?)<\/tool_call>/);
    if (ollamaMatch) {
      const body = ollamaMatch[2].replace(/<\/?parameters>\s*/g, '');
      return { name: ollamaMatch[1], args: this.parseXmlParams(body), raw: ollamaMatch[0] };
    }

    return null;
  }

  /** <function=name>...</function> (Anthropic) */
  private tryFunctionPattern(text: string): ParsedToolCall | null {
    const match = text.match(/<function=([a-zA-Z0-9_]+)>([\s\S]*?)<\/function>/);
    if (!match) return null;
    const body = match[2].trim();
    try {
      return { name: match[1], args: JSON.parse(body), raw: match[0] };
    } catch {
      return { name: match[1], args: { value: body }, raw: match[0] };
    }
  }

  /**
   * Bare XML tag where the tag name IS the tool name.
   * Pattern: <tool_name>{json_args}</tool_name>
   * e.g. <manage_todo_list>{ "todoList": [...] }</manage_todo_list>
   */
  private tryBareToolTag(text: string): ParsedToolCall | null {
    const match = text.match(/<([a-zA-Z0-9_\.:-]+)>\s*(\{[\s\S]*?\})\s*<\/\1>/);
    if (!match) return null;
    try {
      const args = JSON.parse(match[2]);
      return { name: match[1], args: args, raw: match[0] };
    } catch {
      return null;
    }
  }

  /**
   * Bare <invoke name="...">...</invoke> without <tool_call> wrapper.
   * Pattern: <invoke name="tool_name"><paramName>value</paramName></invoke>
   * Handles attributes like string="true" on inner tags.
   * Also handles <invoke name="tool_name"><parameter name="key">value</parameter></invoke>
   */
  private tryBareInvoke(text: string): ParsedToolCall | null {
    const match = text.match(/<invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/invoke>/);
    if (!match) return null;
    return {
      name: match[1],
      args: this.parseXmlParams(match[2]),
      raw: match[0],
    };
  }

  /** Parse XML child tags to an args object */
  private parseXmlParams(body: string): Record<string, unknown> {
    const args: Record<string, unknown> = {};
    // Pattern A: <tagName>value</tagName>
    const re = /<([a-zA-Z0-9_:-]+)(?:\s+[^>]*)?>([\s\S]*?)<\/\1>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) {
      const v = m[2].trim();
      // If <parameter name="key">value</parameter>, use the name attribute as the key
      const nameAttr = m[0].match(/name\s*=\s*"([^"]+)"/);
      const key = nameAttr ? nameAttr[1] : m[1];
      if (v === 'true')       args[key] = true;
      else if (v === 'false') args[key] = false;
      else if (v === 'null')  args[key] = null;
      else if (/^\d+$/.test(v))         args[key] = parseInt(v, 10);
      else if (/^\d+\.\d+$/.test(v))    args[key] = parseFloat(v);
      else                              args[key] = v;
    }
    return args;
  }

  // ================================================================
  // JSON Parsing
  // ================================================================

  private parseJson(text: string): ParsedToolCall | null {
    const startIndices: number[] = [];
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '{') startIndices.push(i);
    }

    for (const start of startIndices) {
      const end = this.findJsonEnd(text, start);
      const jsonStr = text.slice(start, end);
      if (!jsonStr) continue;

      try {
        const obj = JSON.parse(jsonStr);
        if (typeof obj !== 'object' || obj === null) continue;

        // {"command": "...", "args": {...}}
        const command = obj.command;
        if (typeof command === 'string') {
          const args: Record<string, unknown> = {};
          if (obj.args && typeof obj.args === 'object') Object.assign(args, obj.args);
          for (const key of ['path', 'file_path', 'query', 'pattern', 'content', 'text']) {
            if (obj[key] !== undefined) args[key] = obj[key];
          }
          return { name: command, args, raw: jsonStr };
        }

        // {"name": "...", "arguments": {...}} (OpenAI)
        const name = obj.name;
        if (typeof name === 'string' && obj.arguments) {
          return {
            name,
            args: typeof obj.arguments === 'object' ? obj.arguments : {},
            raw: jsonStr,
          };
        }
      } catch {
        continue;
      }
    }

    return null;
  }

  private findJsonEnd(text: string, start: number): number {
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (!inString) {
        if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) return i + 1;
        }
      }
    }
    return text.length;
  }
}
