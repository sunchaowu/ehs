#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
pnpm exec tsx apps/control-plane/src/install.ts
