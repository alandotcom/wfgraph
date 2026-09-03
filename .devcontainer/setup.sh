#!/usr/bin/env bash
set -euo pipefail

sudo corepack enable
corepack install
pnpm install --frozen-lockfile

if [[ ! -f .env.local ]]; then
  (umask 077 && printf 'INTEGRATION_ENCRYPTION_KEY=%s\n' "$(openssl rand -hex 32)" > .env.local)
fi
