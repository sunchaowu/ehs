#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
env_file="${DEPLOY_ENV_FILE:-$root/deploy/.env}"

if [[ ! -f "$env_file" ]]; then
  echo "缺少 ${env_file}" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$env_file"
set +a

required=(
  DEPLOY_HOST
  DEPLOY_USER
  DEPLOY_PASSWORD
  POSTGRES_PASSWORD
  DATABASE_SYSTEM_URL
  PLATFORM_TITLE
  DATABASE_PROD_ADMIN_URL
  DATABASE_TEST_ADMIN_URL
  REGISTRY_ADDRESS
)

missing=()
for name in "${required[@]}"; do
  if ! grep -Eq "^${name}=.+" "$env_file"; then
    missing+=("$name")
  fi
done
if ((${#missing[@]} > 0)); then
  {
    printf '缺少 %s' "${missing[0]}"
    for name in "${missing[@]:1}"; do
      printf '、%s' "$name"
    done
    printf '\n'
  } >&2
  exit 1
fi

askpass="$(mktemp)"
cat > "$askpass" << 'EOF'
#!/usr/bin/env bash
printf '%s\n' "$DEPLOY_PASSWORD"
EOF
chmod 700 "$askpass"
trap 'rm -f "$askpass"' EXIT
export SSH_ASKPASS="$askpass"
export SSH_ASKPASS_REQUIRE=force
export DISPLAY="${DISPLAY:-:0}"
ssh_opts=(
  -o StrictHostKeyChecking=accept-new
  -o PreferredAuthentications=password
  -o PubkeyAuthentication=no
  -o NumberOfPasswordPrompts=1
  -o ConnectTimeout=15
)

ssh_cmd() {
  ssh "${ssh_opts[@]}" "$DEPLOY_USER@$DEPLOY_HOST" "$@"
}

tar -C "$root" -czf - \
  --exclude node_modules \
  --exclude dist \
  --exclude .git \
  . | ssh_cmd "mkdir -p \"\$HOME/enterprise-platform\" && tar -C \"\$HOME/enterprise-platform\" -xzf -"

ssh_cmd bash -s << 'REMOTE'
set -euo pipefail
cd "$HOME/enterprise-platform"
chmod 600 deploy/.env
set -a
source deploy/.env
set +a
printf '%s\n' "$DEPLOY_PASSWORD" | sudo -S -p "" -v
sudo -n docker compose version >/dev/null 2>&1 || { echo "缺少 docker compose" >&2; exit 1; }
compose=(sudo -n docker compose -p enterprise-platform -f deploy/compose.yaml -f deploy/compose.server.yaml)
"${compose[@]}" up -d --build --wait system-db
"${compose[@]}" run --rm -T control-plane pnpm exec tsx apps/control-plane/src/install.ts </dev/null
"${compose[@]}" up -d --build
REMOTE
