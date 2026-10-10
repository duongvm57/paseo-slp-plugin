// Post-install invariant assertions for the integrated install
// (`slp.mjs install --paseo-home --apply`) inside the container harness.
// Reads only env-named roots; fails the whole suite on the first mismatch.
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

let checks = 0;
const fail = message => { console.error(`CHECK_FAIL ${message}`); process.exit(1); };
const ok = name => { checks += 1; console.log(`CHECK_OK ${name}`); };
const eq = (actual, expected, name) =>
  JSON.stringify(actual) === JSON.stringify(expected) ? ok(name)
    : fail(`${name}: actual ${JSON.stringify(actual)} != expected ${JSON.stringify(expected)}`);

const env = key => process.env[key] ?? fail(`missing env ${key}`);
const DEST = env('SLP_DEST');          // install destination
const SRC = env('SLP_SRC');            // mounted checkout
const HOME_DIR = env('PASEO_HOME');    // fake daemon home
const FIXTURE = env('SLP_FIXTURE');    // seeded config.json fixture

const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const installed = readJson(join(DEST, 'installed.json'));
const binding = readJson(join(DEST, 'paseo-binding.json'));
const config = readJson(join(HOME_DIR, 'config.json'));
const fixture = readJson(FIXTURE);
const candidate = installed.candidate ?? fail('installed.json lacks candidate');

eq(installed.source, SRC, 'installed.json source records the mounted checkout');
if (!/^[0-9a-f]{64}$/.test(candidate.sha256 ?? '')) fail('candidate.sha256 is not a sha256 hex');
ok('candidate sha256 well-formed');
eq(lstatSync(join(DEST, 'paseo-binding.json')).mode & 0o777, 0o600, 'paseo-binding.json mode 0600');
eq(binding.configPath, join(HOME_DIR, 'config.json'), 'binding configPath names the fake home config');

const roles = ['supervisor', 'lead', 'peer'];
const families = ['codex', 'pi', 'devin', 'claude', 'opencode'];
const transports = { codex: 'codex', pi: 'pi', devin: 'acp', claude: 'claude', opencode: 'acp' };
const expectedIds = roles.flatMap(role => families.map(family => `slp-${family}-${role}`));

eq(Object.keys(binding.providers ?? {}).sort(), [...expectedIds].sort(), 'binding records exactly 15 slp-* providers');
eq((binding.profiles ?? []).map(p => p.id).sort(), ['slp-lead', 'slp-supervisor'], 'binding records the two role profiles');
eq(binding.mcpBefore, { enabled: false, injectIntoAgents: false }, 'mcpBefore restores fixture values');

const providers = config.agents?.providers ?? {};
for (const role of roles) for (const family of families) {
  const id = `slp-${family}-${role}`;
  const provider = providers[id] ?? fail(`config missing provider ${id}`);
  eq(provider.extends, transports[family], `${id} extends the ${family} transport`);
  eq(provider.label, `SLP ${family} ${role}`, `${id} label`);
  eq(provider.command?.[1], join(DEST, 'bin', `${family}-role.mjs`), `${id} command targets installed ${family}-role.mjs`);
  eq(provider.command?.[2], role, `${id} command role argument`);
  if (role === 'peer') {
    const tools = provider.paseoTools?.disabledTools;
    if (!Array.isArray(tools) || tools.length !== 10 || !tools.includes('create_agent') || !tools.includes('delete_heartbeat'))
      fail(`${id} lacks the peer paseoTools.disabledTools policy`);
    ok(`${id} peer paseoTools policy`);
  } else if (provider.paseoTools !== undefined) fail(`${id} unexpectedly carries paseoTools`);
}
eq(providers.legacy, fixture.agents.providers.legacy, 'pre-existing provider preserved verbatim');
eq(config.privateSetting, fixture.privateSetting, 'unrelated private config preserved');
eq(config.daemon?.mcp, { enabled: true, injectIntoAgents: true }, 'daemon.mcp flags enabled by install');

const profiles = config.daemon?.agentProfiles ?? fail('config lacks daemon.agentProfiles');
eq(profiles.length, 3, 'profiles = fixture profile + 2 role profiles');
eq(profiles[0], fixture.daemon.agentProfiles[0], 'fixture profile preserved verbatim');
eq(profiles.find(p => p.id === 'slp-lead')?.provider, 'slp-codex-lead', 'slp-lead profile bound to codex family (fixture enables none)');
eq(profiles.find(p => p.id === 'slp-supervisor')?.provider, 'slp-codex-supervisor', 'slp-supervisor profile bound to codex family');

const walk = (dir, prefix = '') => readdirSync(join(dir, prefix)).sort().flatMap(name => {
  const rel = join(prefix, name);
  return lstatSync(join(dir, rel)).isDirectory() ? walk(dir, rel) : [rel];
});
eq(walk(DEST).sort(),
  [...candidate.files.map(f => f.path), 'installed.json', 'paseo-binding.json'].sort(),
  'installed tree = exactly candidate files + receipts');
for (const family of families) {
  if (!existsSync(join(DEST, 'bin', `${family}-role.mjs`))) fail(`installed tree lacks bin/${family}-role.mjs`);
}
ok('role shim binaries present');

console.log(`CHECKS_PASSED ${checks}`);
