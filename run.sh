#!/usr/bin/env bash
# Build the phase-0 backend, then start the Bun shell.
set -euo pipefail
cd "$(dirname "$0")"
cargo build --manifest-path packages/render-webkit/Cargo.toml
exec bun run packages/shell/src/main.ts "$@"
