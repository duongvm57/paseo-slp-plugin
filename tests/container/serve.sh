#!/usr/bin/env bash
# Disposable serve mode: run the real paseo daemon + bundled web UI headless
# inside this container, install the paseo-slp plugin from a writable copy of
# the mounted checkout, and verify over HTTP. Everything lives under /serve —
# no host home, auth, relay or daemon registration is touched. The container's
# listen port must be published to host loopback only (see ./serve).
set -euo pipefail

readonly SRC=/src
readonly ROOT=/serve
readonly LISTEN=0.0.0.0:6767
readonly HEALTH=http://127.0.0.1:6767/api/health

export HOME="$ROOT/home"
export PASEO_HOME="$HOME/.paseo"
export XDG_CONFIG_HOME="$HOME/.config"
export XDG_DATA_HOME="$HOME/.local/share"
# Deployment-mode daemon configuration (honored by `paseo daemon run`):
# listen on every container interface (docker publish restricts to loopback
# on the host), no relay uplink, bundled web UI on, no password = local-only.
export PASEO_LISTEN="$LISTEN"
export PASEO_RELAY_ENABLED=false
export PASEO_WEB_UI_ENABLED=true
export npm_config_audit=false npm_config_fund=false npm_config_update_notifier=false

fail() { printf 'CONTAINER_SERVE_FAIL: %s\n' "$*" >&2; exit 1; }
step() { printf '\n== %s\n' "$*"; }

step "environment"
[[ "$(node --version)" == v24.* ]] || fail "container must provide Node 24, found $(node --version)"
paseo --version || fail "paseo CLI missing"
rejects() { "$@" >/dev/null 2>&1 && fail "command unexpectedly succeeded: $*"; return 0; }
rejects touch "$SRC/.container-write-probe"
[ ! -e /var/run/docker.sock ] || fail "docker socket leaked into container"

step "writable plugin copy"
mkdir -p "$PASEO_HOME"
# Directory installs point the daemon at the checkout itself and run the
# manifest build step inside it — copy so the read-only mount stays untouched.
cp -a --no-preserve=ownership "$SRC/plugin" "$ROOT/plugin-src"

step "daemon home config (fake home only)"
# pluginsEnabled defaults to false; this writes the fixture home's own
# config.json — a local config operation, never a host file.
paseo daemon config set pluginsEnabled true --home "$PASEO_HOME"

step "manifest build commands in the writable plugin copy"
# Directory-source installs compile the plugin in place; the manifest `build`
# commands run only for managed (git/npm) sources, so the harness runs them
# itself here — the same commands, verbatim from plugin/paseo-plugin.json.
node - "$ROOT/plugin-src" <<'EOF' || fail "manifest build commands failed"
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

step "daemon run (foreground, deployment env overrides)"
paseo daemon run --home "$PASEO_HOME" >"$ROOT/daemon.log" 2>&1 &
daemon_pid=$!
on_exit() {
  kill -TERM "$daemon_pid" 2>/dev/null || true
  wait "$daemon_pid" 2>/dev/null || true
}
trap 'on_exit; exit 0' TERM INT
trap 'on_exit' EXIT

deadline=$((SECONDS + 120))
until curl -fsS "$HEALTH" >/dev/null 2>&1; do
  if ! kill -0 "$daemon_pid" 2>/dev/null; then
    echo "--- daemon.log ---" >&2; cat "$ROOT/daemon.log" >&2
    fail "daemon exited before becoming ready"
  fi
  if (( SECONDS >= deadline )); then
    echo "--- daemon.log ---" >&2; cat "$ROOT/daemon.log" >&2
    fail "daemon did not answer /api/health within 120s"
  fi
  sleep 1
done
printf 'SERVE_DAEMON_READY listen=%s\n' "$LISTEN"
curl -fsS "$HEALTH" | tee "$ROOT/api-health.json"; echo

step "plugin install from checkout copy (daemon RPC)"
paseo plugin install "$ROOT/plugin-src" --home "$PASEO_HOME" --json | tee "$ROOT/plugin-install.json" \
  || { echo "--- daemon.log tail ---" >&2; tail -40 "$ROOT/daemon.log" >&2; fail "plugin install RPC failed"; }

step "plugin status"
deadline=$((SECONDS + 300))
while true; do
  plugin_ls=$(paseo plugin ls --home "$PASEO_HOME" --json 2>/dev/null || true)
  state=$(printf '%s' "$plugin_ls" | node -e "
    let rows = []; try { rows = JSON.parse(require('fs').readFileSync(0, 'utf8')); } catch {}
    const row = (Array.isArray(rows) ? rows : []).find(r => r && r.id === 'paseo-slp');
    if (!row) { console.log('absent'); }
    else if (row.error) { console.log('failed'); }
    else console.log(row.status ?? 'unknown');
  ")
  case "$state" in
    running) break ;;
    failed|disabled) paseo plugin logs paseo-slp --home "$PASEO_HOME" 2>/dev/null | tail -30 >&2 || true
           printf '%s\n' "$plugin_ls" >&2
           fail "plugin reached state=$state" ;;
    *) if (( SECONDS >= deadline )); then
         printf '%s\n' "$plugin_ls" >&2; fail "plugin did not reach running within 300s (state=$state)"
       fi; sleep 2 ;;
  esac
done
printf '%s\n' "$plugin_ls" | tee "$ROOT/plugin-ls.json"
printf 'SERVE_PLUGIN_RUNNING id=paseo-slp\n'

step "web UI + API over container listen port"
curl -fsS "http://127.0.0.1:6767/" -o "$ROOT/web-index.html" || fail "web UI root did not answer"
grep -qi '<html' "$ROOT/web-index.html" || fail "web UI root did not return HTML"
printf 'SERVE_WEB_UI_OK bytes=%s\n' "$(wc -c <"$ROOT/web-index.html")"
paseo status --home "$PASEO_HOME" --json | tee "$ROOT/daemon-status.json" >/dev/null \
  || fail "paseo status failed against the running daemon"
printf 'SERVE_STATUS_OK\n'

printf '\nCONTAINER_SERVE_READY listen=%s web_ui=/ api_health=/api/health\n' "$LISTEN"
printf 'daemon is running (pid %s); waiting until stopped\n' "$daemon_pid"
wait "$daemon_pid"
