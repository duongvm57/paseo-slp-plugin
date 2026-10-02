#!/usr/bin/env bash
# In-container acceptance suite for the paseo-slp install mechanism.
# Runs entirely against a disposable fake HOME/PASEO_HOME; the repository is
# mounted read-only at /src. Prints CONTAINER_ACCEPTANCE_OK only when every
# check passes; any failure exits 1 after printing CONTAINER_ACCEPTANCE_FAIL.
set -euo pipefail

readonly SRC=/src
readonly HARNESS=/opt/slp-container
readonly ROOT=/acceptance
readonly WORK="$ROOT/work"
readonly DEST="$ROOT/slp-cli-install"
export HOME="$ROOT/home"
export PASEO_HOME="$HOME/.paseo"
export XDG_CONFIG_HOME="$HOME/.config"
export XDG_DATA_HOME="$HOME/.local/share"
export npm_config_audit=false npm_config_fund=false npm_config_update_notifier=false

fail() { printf 'CONTAINER_ACCEPTANCE_FAIL: %s\n' "$*" >&2; exit 1; }
step() { printf '\n== %s\n' "$*"; }
# A command that must fail (isolation probes).
rejects() { "$@" >/dev/null 2>&1 && fail "command unexpectedly succeeded: $*"; return 0; }

step "environment"
[[ "$(node --version)" == v24.* ]] || fail "container must provide Node 24, found $(node --version)"
paseo_version=$(paseo --version | tr -d '[:space:]')
[[ "$paseo_version" == "$SLP_PASEO_CLI_VERSION" ]] || fail "paseo CLI $paseo_version != pinned $SLP_PASEO_CLI_VERSION"
# The pinned daemon must satisfy the plugin manifest's requirements.paseo
# range — evaluate the declared expression, not a hardcoded mirror of it.
# Supported syntax: space-separated conjunction of >=,<=,>,<,= X.Y.Z clauses
# (covers the current '>=0.8.0 <0.10.0' shape; anything else fails clearly).
node - "$paseo_version" <<'EOF' || fail "paseo version violates plugin requirements.paseo"
const version = process.argv[2];
const range = JSON.parse(require('node:fs').readFileSync('/src/plugin/paseo-plugin.json', 'utf8')).requirements.paseo;
if (!/^\d+\.\d+\.\d+$/.test(version)) { console.error(`unparseable paseo version "${version}"`); process.exit(1); }
const cmp = (a, b) => {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) { const d = pa[i] - pb[i]; if (d !== 0) return d < 0 ? -1 : 1; }
  return 0;
};
const clauses = String(range).trim().split(/\s+/);
const results = clauses.map(clause => {
  const m = clause.match(/^(>=|<=|>|<|=)?(\d+\.\d+\.\d+)$/);
  if (!m) return { clause, supported: false };
  const c = cmp(version, m[2]);
  const op = m[1] ?? '=';
  const pass = op === '>=' ? c >= 0 : op === '<=' ? c <= 0 : op === '>' ? c > 0 : op === '<' ? c < 0 : c === 0;
  return { clause, supported: true, pass };
});
if (results.some(r => !r.supported)) {
  console.error(`unsupported requirements.paseo syntax in "${range}" — extend the harness evaluator`);
  process.exit(1);
}
const ok = results.every(r => r.pass);
console.log(`paseo ${version} vs manifest "${range}": ${ok ? 'in range' : 'OUT OF RANGE'}`);
process.exit(ok ? 0 : 1);
EOF

step "isolation"
rejects touch "$SRC/.container-write-probe"    # read-only checkout mount
[ ! -e /var/run/docker.sock ] || fail "docker socket leaked into container"
[ "$HOME" = "$ROOT/home" ] || fail "HOME is not the disposable root"
leaked=$(env | cut -d= -f1 | grep -icE '(token|secret|password|credential|api_?key|auth_)' || true)
[ "$leaked" = "0" ] || fail "host credential-shaped env vars leaked into container"

step "fixture home"
mkdir -p "$PASEO_HOME" "$WORK" "$XDG_CONFIG_HOME" "$XDG_DATA_HOME"
cp "$HARNESS/fixtures/config.json" "$PASEO_HOME/config.json"
chmod 0640 "$PASEO_HOME/config.json"           # non-default mode must survive writeConfig
printf 'human-owned sentinel\n' >"$PASEO_HOME/human-owned.txt"
pre_config_sha=$(sha256sum "$PASEO_HOME/config.json" | cut -d' ' -f1)
pre_marker_sha=$(sha256sum "$PASEO_HOME/human-owned.txt" | cut -d' ' -f1)

step "integrated install (slp.mjs install --paseo-home --apply)"
install_json=$(node "$SRC/bin/slp.mjs" install "$DEST" --paseo-home "$PASEO_HOME" --apply)
printf '%s\n' "$install_json" | node -e "const r=JSON.parse(require('fs').readFileSync(0,'utf8')); if(r.applied!==true) throw new Error('install did not apply'); console.log('install applied, candidate', r.candidate.sha256)"
src_sha=$(node "$SRC/bin/slp.mjs" identity | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).sha256)")

step "verify / identity / instructions / uninstall dry-run from the INSTALLED copy"
node "$DEST/bin/slp.mjs" verify "$DEST"
installed_sha=$(node "$DEST/bin/slp.mjs" identity | node -e "console.log(JSON.parse(require('fs').readFileSync(0,'utf8')).sha256)")
[ "$installed_sha" = "$src_sha" ] || fail "installed runtime identity $installed_sha != checkout identity $src_sha"
for role in supervisor lead peer; do
  node "$DEST/bin/slp.mjs" instructions "$role" 2>/dev/null | grep -q "SLP role=$role" \
    || fail "installed runtime produced no '$role' role instructions"
done
uninstall_json=$(node "$DEST/bin/slp.mjs" uninstall "$DEST")
printf '%s\n' "$uninstall_json" | node -e "const r=JSON.parse(require('fs').readFileSync(0,'utf8')); if(r.applied!==false) throw new Error('uninstall dry-run mutated'); console.log('uninstall dry-run recognized ownership (applied=false)')"

step "invariant assertions"
SLP_DEST="$DEST" SLP_SRC="$SRC" SLP_FIXTURE="$HARNESS/fixtures/config.json" \
  node "$HARNESS/lib/checks.mjs"

[ "$(sha256sum "$PASEO_HOME/human-owned.txt" | cut -d' ' -f1)" = "$pre_marker_sha" ] \
  || fail "human-owned file in the paseo home changed"
# config.json is legitimately patched by install — assert only its mode survived.
[ "$(stat -c '%a' "$PASEO_HOME/config.json")" = "640" ] || fail "config.json mode not preserved"

step "plugin build step (manifest paseo-plugin.json build commands, verbatim)"
cp -a --no-preserve=ownership "$SRC/plugin" "$WORK/plugin"
# Execute the manifest's declared `build` commands rather than a hardcoded
# copy — directory-source installs leave this step to the caller.
node - "$WORK/plugin" <<'EOF' || fail "manifest build commands failed"
const { execFileSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const dir = process.argv[2];
const manifest = JSON.parse(readFileSync(`${dir}/paseo-plugin.json`, 'utf8'));
const build = manifest.build ?? [];
if (!Array.isArray(build)) { console.error('manifest build is not an array'); process.exit(1); }
for (const cmd of build) {
  if (!Array.isArray(cmd) || typeof cmd[0] !== 'string' || cmd.some(a => typeof a !== 'string')) {
    console.error(`unsupported manifest build entry ${JSON.stringify(cmd)} — argv arrays only`);
    process.exit(1);
  }
  console.log(`plugin build: ${cmd.join(' ')}`);
  execFileSync(cmd[0], cmd.slice(1), { cwd: dir, stdio: 'inherit' });
}
EOF
[ -d "$WORK/plugin/node_modules/@getpaseo/protocol" ] || fail "manifest build step did not produce plugin deps"

# Host-provided plugin SDK: production resolves @getpaseo/plugin from the
# daemon's own module scope; mirror that one directory above the plugin copy.
# The version is the repo-pinned devDependency this checkout tests against.
host_sdk_version=$(node -p "require('$SRC/package.json').devDependencies['@getpaseo/plugin']")
printf '{ "private": true }\n' >"$WORK/package.json"
npm --prefix "$WORK" install --no-audit --no-fund "@getpaseo/plugin@${host_sdk_version}"

step "plugin load (contribute + embedded payload materialize/verify)"
SLP_SRC="$SRC" SLP_DEST="$DEST" node "$HARNESS/lib/plugin-load.mjs" "$WORK/plugin"

printf '\nCONTAINER_ACCEPTANCE_OK node=%s paseo=%s candidate=%s\n' \
  "$(node --version)" "$paseo_version" "$src_sha"
