#!/usr/bin/env bash
# Build both render backends, then start the Bun shell.
#
#   ./run.sh                    WebKitGTK, in-process
#   BUNSEN_ENGINE=blitz ./run.sh   Blitz, out-of-process (no chrome UI yet)
set -euo pipefail
cd "$(dirname "$0")"
cargo build
exec bun run packages/shell/src/main.ts "$@"
