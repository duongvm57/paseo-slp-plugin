import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { MCP_CHILD, MCP_ENV } from '../plugin/server/antigravity/internal/mcp-child.ts';
import { McpFiles, mcpEnvironment, mcpBinding, mcpMapping } from '../plugin/server/antigravity/internal/mcp.ts';

const config = (servers) => ({ cwd: process.cwd(), mcpServers: servers, env: {} });
function relay(t, cfg, name = 'paseo') {
  const child = spawn(process.execPath, ['--eval', MCP_CHILD, name], { env: { ...process.env, ...mcpEnvironment(cfg) }, stdio: 'pipe' });
  let stderr = ''; child.stderr.on('data', b => { stderr += b; });
  const lines = createInterface({ input: child.stdout });
  const frames = [], pending = new Map();
  lines.on('line', line => {
    const frame = JSON.parse(line); frames.push(frame);
    const reply = pending.get(frame.id); if (reply) { pending.delete(frame.id); reply(frame); }
  });
  const exited = new Promise(resolve => child.on('exit', code => resolve(code)));
  t.after(() => { child.stdin.end(); child.kill(); });
  return { child, exited, stderr: () => stderr, frames, send(frame) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(frame.id); reject(new Error('MCP relay timeout')); }, 4000);
      pending.set(frame.id, result => { clearTimeout(timer); resolve(result); });
      child.stdin.write(JSON.stringify(frame) + '\n');
    });
  } };
}

test('native MCP declarations contain no credentials; each open has a private removable carrier', async () => {
  const namespace = "a".repeat(32);
  const files = new McpFiles(namespace);
  const cfg = config({ slp_desk: { type: 'stdio', command: '/absolute/node', args: ['desk.mjs'], env: { TOKEN: 'private-desk-handle' } } });
  const opened = await files.open(cfg);
  try {
    assert.equal(statSync(opened.directory).mode & 0o777, 0o700);
    const path = join(opened.directory, '.agents', 'agents', opened.name + '.md');
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const text = readFileSync(path, 'utf8');
    assert.ok(!text.includes('private-desk-handle'));
    const definition = JSON.parse(text.split('---\n')[1]);
    assert.deepEqual(definition.mcpServers.map(s => s.name), [`slp-${namespace}-0`]);
    assert.equal(definition.mcpServers[0].args[2], 'slp_desk');
    assert.notDeepEqual(mcpMapping(cfg, namespace), mcpMapping(cfg, 'b'.repeat(32)));
    assert.notEqual(mcpBinding(cfg, namespace), mcpBinding(cfg, 'b'.repeat(32)));
    assert.equal(mcpBinding(cfg, namespace), mcpBinding(config({ slp_desk: { type: 'http', url: 'http://fresh' } }), namespace));
    assert.equal(definition.mcpServers[0].env, undefined);
    assert.equal(definition.mcpServers[0].args[1], MCP_CHILD);
    assert.equal(mcpBinding(cfg), mcpBinding(config({ slp_desk: { type: 'http', url: 'http://new-endpoint', headers: { Authorization: 'new' } } })));
    assert.notEqual(mcpBinding(cfg), mcpBinding(config({ paseo: { type: 'http', url: 'http://new' } })));
    assert.equal((await files.open(cfg)).directory, opened.directory);
  } finally { await files.close(); }
  assert.equal(existsSync(opened.directory), false);
});

test('stdio relays inherit current open credentials and cwd without passing the other server bundle downstream', async t => {
  for (const token of ['first-open', 'resumed-open']) {
    const cfg = config({ paseo: { type: 'stdio', command: process.execPath, args: ['--eval', `
      const {createInterface}=require('node:readline');
      createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{token:process.env.TEST_TOKEN,cwd:process.cwd(),bundle:process.env.${MCP_ENV}??null}}))});
    `], env: { TEST_TOKEN: token } } });
    const client = relay(t, cfg);
    const frame = await client.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    assert.deepEqual(frame.result, { token, cwd: cfg.cwd, bundle: null });
    client.child.stdin.end(); assert.equal(await client.exited, 0);
  }
});

test('Streamable HTTP relays preserve headers/session, decode SSE, and never retry uncertain mutations', async t => {
  const requests = []; let mutations = 0, redirected = 0;
  const target = createServer((req, res) => { redirected++; res.end('{}'); });
  await new Promise(resolve => target.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => target.close(resolve)));
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const m = body ? JSON.parse(body) : null;
    requests.push({ method: req.method, message: m, headers: req.headers });
    if (req.method === 'DELETE') { res.writeHead(204); res.end(); return; }
    if (m.method === 'initialize') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'fixture-session' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'fake', version: '1' } } }));
    } else if (m.method === 'tools/list') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const data = JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { tools: [] } });
      res.write(': comment\r\ndata: ' + data.slice(0, 20)); res.end(data.slice(20) + '\r\n\r\n');
    } else if (m.method === 'tools/call') { mutations++; req.socket.destroy(); }
    else if (m.method === 'empty202') { res.writeHead(202); res.end(); }
    else if (m.method === 'empty204') { res.writeHead(204); res.end(); }
    else if (m.method === 'empty200') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(); }
    else if (m.method === 'redirect') { res.writeHead(307, { Location: `http://127.0.0.1:${target.address().port}/leak` }); res.end(); }
    else { res.writeHead(202); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const client = relay(t, config({ paseo: { type: 'http', url: `http://127.0.0.1:${server.address().port}/mcp`, headers: { Authorization: 'only-this-open' } } }));
  await client.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
  assert.deepEqual((await client.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).result, { tools: [] });
  assert.equal(requests[1].headers.authorization, 'only-this-open');
  assert.equal(requests[1].headers['mcp-session-id'], 'fixture-session');
  assert.equal(requests[1].headers['mcp-protocol-version'], '2025-03-26');
  assert.match((await client.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: {} })).error.message, /not retried/);
  assert.equal(mutations, 1);
  assert.ok((await client.send({ jsonrpc: '2.0', id: 4, method: 'redirect' })).error);
  assert.equal(redirected, 0);
  for (const [index, method] of ['empty202', 'empty204', 'empty200'].entries()) {
    const reply = await client.send({ jsonrpc: '2.0', id: 10 + index, method });
    assert.equal(reply.error.code, -32603);
    assert.match(reply.error.message, /outcome uncertain.*not retried/);
    assert.equal(requests.filter(r => r.message?.method === method).length, 1);
  }
  // A response has an id, but is not a request. No error may be echoed back.
  client.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 99, result: {} }) + '\n');
  client.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  await client.send({ jsonrpc: '2.0', id: 100, method: 'tools/list' });
  assert.equal(client.frames.some(f => f.id === 99), false);
  assert.equal(client.frames.some(f => !Object.hasOwn(f, 'id')), false);
  assert.equal(client.stderr(), '');
  client.child.stdin.end(); assert.equal(await client.exited, 0);
  assert.ok(requests.some(r => r.method === 'DELETE'));
});

test('unsupported legacy SSE and excessive config fail before native spawn', () => {
  assert.throws(() => mcpEnvironment(config({ test: { type: 'sse', url: 'http://example.invalid/sse' } })), /legacy SSE/);
  assert.throws(() => mcpEnvironment(config({ test: { type: 'http', url: 'http://local', headers: { Large: 'x'.repeat(65536) } } })), /64 KiB/);
});
