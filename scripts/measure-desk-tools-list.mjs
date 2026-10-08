// Offline: only temporary fixture homes, memberships and a private UDS.
// No live daemon, configuration, or SDK/provider process is contacted.
import { readFileSync } from 'node:fs';
import { DESK_TOOL_CATALOG } from '../plugin/server/desk-bridge.ts';
import { sha256Hex } from '../plugin/server/config-view.ts';
import {
  BIN_SOURCE, bridgeFixture, startBridge, gitRepo, repoOf, memberRow,
  seedStore, seedMemberships, handshake, hello, rpc,
} from '../tests/helpers/desk-bridge-fixture.mjs';

const cleanup = [];
const t = { after: fn => cleanup.push(fn) };
const pin = sha256Hex(readFileSync(BIN_SOURCE));
const at = '2026-01-01T00:00:00.000Z';
const sizes = tools => {
  const result = JSON.stringify({ tools });
  const context = JSON.stringify(tools.map(({ description, inputSchema }) => ({ description, inputSchema })));
  return { tools: tools.length, resultBytes: Buffer.byteLength(result), resultCharacters: result.length,
    descriptionSchemaBytes: Buffer.byteLength(context), descriptionSchemaCharacters: context.length };
};
try {
  const f = await startBridge(t, bridgeFixture(t, 'slp-measure-tools-', pin));
  if (f.outcome !== 'listening') throw new Error(JSON.stringify(f.bridge.state()));
  const git = gitRepo(t, 'slp-measure-tools-repo-');
  const roles = ['supervisor', 'lead', 'peer'];
  await seedMemberships(seedStore(f), repoOf(git), roles.map(role => memberRow(role,
    { provider: `slp-codex-${role}`, at }, { role, agentId: role, createCwd: git.dir })));
  const lists = {};
  let id = 0;
  for (const role of roles) {
    const channel = await handshake(f.paths.socketPath, hello(pin, role));
    t.after(() => channel.conn.destroy());
    if (!channel.ack.ok) throw new Error(JSON.stringify(channel.ack));
    const reply = await rpc(channel.reader, channel.conn, { jsonrpc: '2.0', id: ++id, method: 'tools/list' });
    lists[role] = reply.result.tools;
  }
  // Lead can use every public tool. Reconstruct the old visible-only list
  // in catalog order, independent of the new role declarations.
  const full = DESK_TOOL_CATALOG.filter(entry => entry.visible).map(entry => {
    const tool = lists.lead.find(tool => tool.name === entry.name);
    if (!tool) throw new Error(`Lead list omitted ${entry.name}`);
    return tool;
  });
  process.stdout.write(JSON.stringify({ encoding: 'UTF-8', characters: 'JavaScript UTF-16 code units',
    measurement: 'compact JSON; result excludes the JSON-RPC envelope; descriptionSchema includes only descriptions and input schemas',
    roles: Object.fromEntries(roles.map(role => [role, { before: sizes(full), after: sizes(lists[role]) }])) }, null, 2) + '\n');
} finally {
  // Close clients/server before removing the temporary fixture trees.
  for (const fn of cleanup.reverse()) await fn();
}
