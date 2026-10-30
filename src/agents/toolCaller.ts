// Minimal MCP JSON-RPC client over fetch-like handler. Used by the in-Worker simulator so it speaks real MCP
// to the real server without pulling the full client SDK into the Worker bundle.
export type ToolResult = { ok: true; data: any } | { ok: false; error: string; message: string };
export type ToolCaller = (name: string, args: Record<string, unknown>) => Promise<ToolResult>;

let rpcId = 0;
export function mcpToolCaller(handler: (req: Request) => Promise<Response>, url: string, headers: Record<string, string>): ToolCaller {
  return async (name, args) => {
    const res = await handler(new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }),
    }));
    const body = (await res.json()) as any;
    if (body.error) return { ok: false, error: 'rpc_error', message: body.error.message };
    const text = body.result?.content?.[0]?.text ?? '{}';
    const data = JSON.parse(text);
    return body.result?.isError ? { ok: false, error: data.error, message: data.message } : { ok: true, data };
  };
}
