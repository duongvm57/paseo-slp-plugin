// This program is passed literally to Node. Native conversations retain it;
// no plugin path, endpoint or credential is embedded in their MCP declaration.
export const MCP_ENV = "SLP_ANTIGRAVITY_MCP_V1";
export const MCP_CHILD = String.raw`
(async () => {
  const bundle = JSON.parse(process.env.SLP_ANTIGRAVITY_MCP_V1 || "null");
  const server = bundle && Object.hasOwn(bundle.servers, process.argv[1]) && bundle.servers[process.argv[1]];
  if (!server) throw new Error("MCP server absent from current session");
  const env = { ...process.env, ...server.env };
  delete env.SLP_ANTIGRAVITY_MCP_V1;
  if (server.type === "stdio") {
    const { spawn } = await import("node:child_process");
    const child = spawn(server.command, server.args || [], { cwd: bundle.cwd, env, stdio: "inherit", windowsHide: true });
    child.on("error", () => { process.stderr.write("SLP Antigravity MCP child could not start\n"); process.exitCode = 1; });
    child.on("exit", (code) => { process.exitCode = code === 0 ? 0 : 1; });
    for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
    return;
  }
  if (server.type !== "http") throw new Error("Unsupported MCP transport");
  const { once } = await import("node:events");
  const controller = new AbortController();
  const pending = new Set();
  const cap = 8 * 1024 * 1024;
  let sessionId, protocolVersion, input = "";
  async function emit(frame) {
    const line = JSON.stringify(frame) + "\n";
    if (Buffer.byteLength(line) > cap) throw new Error("MCP frame too large");
    if (!process.stdout.write(line)) await once(process.stdout, "drain");
  }
  function headers() {
    const out = new Headers(server.headers || {});
    out.set("Content-Type", "application/json");
    out.set("Accept", "application/json, text/event-stream");
    if (sessionId) out.set("Mcp-Session-Id", sessionId);
    if (protocolVersion) out.set("MCP-Protocol-Version", protocolVersion);
    return out;
  }
  async function post(message) {
    const isRequest = typeof message.method === "string" && Object.hasOwn(message, "id");
    try {
      // This relay implements standard MCP initialization, not the CLI's
      // optional pre-initialize discovery extension.
      if (message.method === "server/discover") {
        await emit({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
        return;
      }
      const response = await fetch(server.url, { method: "POST", headers: headers(), body: JSON.stringify(message), redirect: "error", signal: controller.signal });
      if (!response.ok) throw new Error("HTTP " + response.status);
      sessionId = response.headers.get("mcp-session-id") || sessionId;
      if (response.status === 202 || response.status === 204 || !response.body) {
        if (isRequest) throw new Error("MCP request has no response");
        return;
      }
      const sse = (response.headers.get("content-type") || "").includes("text/event-stream");
      const reader = response.body.getReader(), decoder = new TextDecoder();
      let buffer = "", size = 0, done = false;
      async function accept(text) {
        const frame = JSON.parse(text);
        if (message.method === "initialize" && frame.result) protocolVersion = frame.result.protocolVersion;
        await emit(frame);
        if (isRequest && frame.id === message.id && (Object.hasOwn(frame, "result") || Object.hasOwn(frame, "error"))) done = true;
      }
      try {
        while (!done) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > cap) throw new Error("MCP response too large");
          buffer += decoder.decode(chunk.value, { stream: true });
          if (sse) {
            buffer = buffer.replace(/\r\n/g, "\n");
            let end;
            while (!done && (end = buffer.indexOf("\n\n")) >= 0) {
              const event = buffer.slice(0, end); buffer = buffer.slice(end + 2);
              const data = event.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
              if (data) await accept(data);
            }
          }
        }
        if (!sse && buffer.trim()) await accept(buffer);
        if (isRequest && !done) throw new Error("MCP response omitted request result");
      } finally { await reader.cancel().catch(() => undefined); }
    } catch {
      if (!controller.signal.aborted && isRequest) await emit({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: "SLP Antigravity MCP transport failed; outcome uncertain; request was not retried" } });
    }
  }
  async function dispatch(line) {
    const message = JSON.parse(line);
    if (pending.size >= 32) {
      if (typeof message.method === "string" && Object.hasOwn(message, "id")) await emit({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "MCP transport busy" } });
      return;
    }
    const job = post(message); pending.add(job); void job.finally(() => pending.delete(job));
    if (message.method === "notifications/initialized") await job;
  }
  process.stdin.setEncoding("utf8");
  try {
    for await (const chunk of process.stdin) {
      input += chunk;
      if (Buffer.byteLength(input) > cap) throw new Error("MCP input too large");
      let end;
      while ((end = input.indexOf("\n")) >= 0) {
        const line = input.slice(0, end); input = input.slice(end + 1);
        if (line.trim()) await dispatch(line);
      }
    }
  } finally {
    controller.abort(); await Promise.allSettled([...pending]);
    if (sessionId) await fetch(server.url, { method: "DELETE", headers: headers(), redirect: "error", signal: AbortSignal.timeout(2000) }).catch(() => undefined);
  }
})().catch(() => { process.stderr.write("SLP Antigravity MCP transport unavailable\n"); process.exitCode = 1; });
`;
