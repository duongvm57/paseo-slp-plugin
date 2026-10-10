#!/usr/bin/env bash
# Container entrypoint dispatcher: `accept` (default) runs the install
# acceptance suite; `serve` runs the disposable daemon + web UI mode.
set -euo pipefail
mode=${1:-accept}
case "$mode" in
  accept) exec bash /opt/slp-container/accept.sh ;;
  serve) exec bash /opt/slp-container/serve.sh ;;
  *)
    echo "usage: docker run <image> [accept|serve]" >&2
    exit 2
    ;;
esac
