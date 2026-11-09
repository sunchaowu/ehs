#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
pnpm exec tsx watch apps/control-plane/src/dev.ts &
pnpm --dir apps/portal exec vite --host 127.0.0.1 &
wait
