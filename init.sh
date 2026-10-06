#!/bin/bash
set -e

echo "=== Harness Initialization ==="

echo "=== npm ci ==="
npm ci

echo "=== npm run typecheck ==="
npm run typecheck

echo "=== npm run check ==="
npm run check

echo "=== npm run check:plugin-payload ==="
npm run check:plugin-payload

echo "=== npm test ==="
# Match CI: tests must not touch the real ~/.paseo home.
temp_paseo_home="$(mktemp -d)"
trap 'rm -rf "$temp_paseo_home"' EXIT
PASEO_HOME="$temp_paseo_home" npm test

echo "=== Verification Complete ==="
echo ""
echo "Next steps:"
echo "1. Read feature_list.json to see current feature state"
echo "2. Pick ONE unfinished feature to work on"
echo "3. Implement only that feature"
echo "4. Re-run verification before claiming done"
