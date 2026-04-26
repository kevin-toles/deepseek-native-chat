# Codex MCP Tooling Issues Observed

Created: 2026-04-25

Purpose: document the Codex-specific friction encountered while trying to use the local MCP KB tools, so behavior can be normalized across VS Code, Cursor, Codex, Claude Code, and similar clients.

## Summary

The services were not initially reachable on their expected ports. After restarting `unified-search-service` and `mcp-gateway`, the MCP tools were available through the gateway, but Codex did not expose those tools as native first-class tool calls in this session. I had to call the MCP gateway manually from a shell command using the Python FastMCP client.

Working connection:

```python
from fastmcp import Client
from fastmcp.client.transports import SSETransport

async with Client(SSETransport("http://localhost:8087/mcp/sse")) as client:
    tools = await client.list_tools()
```

## Observed Issues

### 1. Codex MCP Resource Tools Did Not Discover Runtime Gateway Tools

Codex exposed these generic MCP helpers:

```text
list_mcp_resources
list_mcp_resource_templates
read_mcp_resource
```

But both resource listings returned empty results. They did not surface the runtime FastMCP tools from `mcp-gateway`, such as:

```text
search_in
knowledge_refine
diagram_search
knowledge_search
hybrid_search
semantic_search
```

Impact: from Codex, there was no direct native tool button/function named `search_in` or `diagram_search`, even after the gateway was healthy.

Normalization recommendation: each platform should expose a consistent MCP discovery layer that lists runtime tools, not only static resources/templates. At minimum, clients should provide a standard "list tools" action for the configured MCP server.

### 2. The Expected Gateway URL Was Ambiguous

The repository README says:

```python
Client("http://localhost:8087/mcp")
```

In this Codex session, that failed with:

```text
McpError: Session terminated
```

The working connection was:

```python
Client(SSETransport("http://localhost:8087/mcp/sse"))
```

The FastAPI app mounts:

```text
app.mount("/mcp", mcp_server.http_app(transport="sse"))
```

Impact: a client that assumes streamable HTTP at `/mcp` may fail against this gateway, while a client that explicitly uses SSE at `/mcp/sse` succeeds.

Normalization recommendation: publish the transport-specific endpoint in machine-readable config:

```json
{
  "mcpServers": {
    "ai-platform-kb": {
      "transport": "sse",
      "url": "http://localhost:8087/mcp/sse",
      "health": "http://localhost:8087/health"
    }
  }
}
```

### 3. Sandbox Networking Blocked Localhost Verification Without Escalation

Sandboxed `curl` calls to local service ports failed:

```text
curl: (7) Failed to connect to localhost port 8081
```

The same health check succeeded when run with elevated permissions:

```json
{
  "status": "healthy",
  "service": "unified-search",
  "services": {
    "vector": "healthy",
    "graph": "healthy"
  }
}
```

Impact: Codex could incorrectly conclude a service is down unless it accounts for sandbox restrictions.

Normalization recommendation: client adapters should distinguish:

- service down
- sandbox denied network
- host reachable only outside sandbox
- port bound but health unhealthy

### 4. Starting Services Required Escalation Because They Live Outside the Writable Root

This Codex session's writable root was:

```text
/Users/kevintoles/POC/inference-service-cpp
```

The relevant services were outside that root:

```text
/Users/kevintoles/POC/unified-search-service
/Users/kevintoles/POC/mcp-gateway
```

Starting them required escalated execution. Long-running service processes then remained attached to Codex exec sessions.

Impact: service management is possible, but it is not transparent. A platform may need user approval even for local-only dev service startup.

Normalization recommendation: provide a platform-neutral service bootstrap command, for example:

```text
ai-platform services up unified-search mcp-gateway
ai-platform services health
ai-platform mcp tools list
```

Then each client can call the same wrapper and report the same statuses.

### 5. Tool Schemas Were Too Loose for Source Names

The MCP schema for `search_in` exposed `source` as a plain string:

```json
{
  "source": {
    "default": "textbooks",
    "type": "string"
  }
}
```

The actual valid values were only visible by reading gateway code:

```text
textbooks -> chapters
code      -> code_chunks
patterns  -> code_good_patterns
diagrams  -> ascii_diagrams
```

Impact: clients cannot reliably render dropdowns, validate source names, or recover from invalid collection names using the schema alone.

Normalization recommendation: expose enums in MCP input schemas:

```json
{
  "source": {
    "type": "string",
    "enum": ["textbooks", "code", "patterns", "diagrams"],
    "default": "textbooks"
  }
}
```

### 6. Raw Collections Were Not Available Through `knowledge_refine`

The user requested textbook code blocks and CRE code chunks. The live Qdrant instance contains collections such as:

```text
textbook_code
code_textbook_bridge
ascii_diagrams
code_chunks
```

But the MCP `knowledge_refine` input model rejected raw collection names like `textbook_code` and `code_textbook_bridge`:

```text
String should match pattern
'^(chapters|textbooks|code_chunks|code|pattern_instances|patterns|code_good_patterns|repo_concepts|concepts)$'
```

Impact: Codex could access textbook chapter payloads containing embedded code blocks, but not directly query the `textbook_code` collection through the public MCP tool.

Normalization recommendation: either:

1. Add MCP aliases for raw-but-supported shelves:

   ```text
   textbook_code
   code_textbook_bridge
   ascii_diagrams
   ```

2. Or add a separate expert tool with explicit collection access:

   ```text
   search_collection(collection, query, limit)
   ```

### 7. Diagram Search Was Operational But Semantically Weak

`diagram_search` and `search_in(source="diagrams")` returned results, proving the diagram shelf was reachable. However, the returned matches for parser/tool-call workflow queries were mostly unrelated histograms, code snippets, or database output tables.

Impact: a client may mark the diagram tool as working, while the search quality is not strong enough for the requested task.

Normalization recommendation: report both transport health and retrieval quality. For example:

```json
{
  "tool": "diagram_search",
  "status": "reachable",
  "result_quality": "weak",
  "reason": "top hits did not match parser/tool-call workflow intent"
}
```

### 8. `ask` Returned Search Results, Not a Synthesized Answer

The `ask` tool returned a JSON list of search results, including code chunks, rather than a direct synthesized answer.

Impact: platform clients should not assume a tool named `ask` returns prose. They need to inspect the schema/contract or tool metadata.

Normalization recommendation: tool metadata should distinguish:

```text
returns: search_results
returns: synthesized_answer
returns: graph_records
returns: code_analysis
```

### 9. Service Health and Tool Health Are Different

The gateway health endpoint returned healthy:

```json
{
  "service": "mcp-gateway",
  "status": "healthy"
}
```

But a tool call can still fail due to:

- wrong transport path
- invalid schema value
- backend service unavailable
- collection alias not exposed
- weak retrieval quality

Normalization recommendation: add a diagnostic command that exercises the whole path:

```text
health -> list_tools -> call search_in(code) -> call search_in(textbooks) -> call diagram_search
```

## Suggested Cross-Platform MCP Normalization Contract

Each platform adapter should implement the same checklist:

1. Read configured MCP server entries.
2. Verify health URL.
3. Verify transport URL and transport type.
4. List tools through the protocol.
5. Cache tool names, descriptions, input schemas, and return contracts.
6. Render enum values from schemas where possible.
7. Run a smoke call per critical tool.
8. Distinguish sandbox/network failure from service failure.
9. Report raw tool errors without collapsing them into generic "request failed."
10. Provide a normalized local debug bundle:

    ```json
    {
      "server": "ai-platform-kb",
      "transport": "sse",
      "url": "http://localhost:8087/mcp/sse",
      "health": "healthy",
      "tools": ["search_in", "knowledge_refine", "diagram_search"],
      "smoke_tests": {
        "search_in.code": "ok",
        "search_in.textbooks": "ok",
        "diagram_search": "ok_weak_results"
      }
    }
    ```

## Codex-Specific Workaround Used

Because Codex did not expose the gateway tools directly, I used the local Python client from the `mcp-gateway` virtual environment:

```bash
cd /Users/kevintoles/POC/mcp-gateway
.venv/bin/python -c '... FastMCP client script ...'
```

The essential connection code was:

```python
import asyncio
from fastmcp import Client
from fastmcp.client.transports import SSETransport

async def main():
    async with Client(SSETransport("http://localhost:8087/mcp/sse")) as client:
        tools = await client.list_tools()
        result = await client.call_tool("search_in", {
            "source": "code",
            "query": "tool call parser JSON XML fallback parser",
            "max_results": 5
        })

asyncio.run(main())
```

This is the current reliable Codex path for these local MCP KB tools.

