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

# 私有镜像库证书：自签 CA 加域名证书。Docker 守护进程按目录信任 CA，不需要重启守护进程。
mkdir -p deploy/registry/certs
chmod 700 deploy/registry/certs
if [[ ! -f deploy/registry/certs/domain.crt ]]; then
  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
    -keyout deploy/registry/certs/ca.key -out deploy/registry/certs/ca.crt \
    -subj "/CN=platform-registry-ca" >/dev/null 2>&1
  openssl req -newkey rsa:2048 -nodes \
    -keyout deploy/registry/certs/domain.key -out deploy/registry/certs/domain.csr \
    -subj "/CN=registry.internal" >/dev/null 2>&1
  printf 'subjectAltName=DNS:registry.internal,DNS:%s,IP:127.0.0.1\n' "$DEPLOY_HOST" > deploy/registry/certs/openssl.cnf
  printf 'basicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n' >> deploy/registry/certs/openssl.cnf
  openssl x509 -req -in deploy/registry/certs/domain.csr \
    -CA deploy/registry/certs/ca.crt -CAkey deploy/registry/certs/ca.key -CAcreateserial \
    -out deploy/registry/certs/domain.crt -days 3650 \
    -extfile deploy/registry/certs/openssl.cnf >/dev/null 2>&1
fi
chmod 600 deploy/registry/certs/*.key
sudo -n mkdir -p /etc/docker/certs.d/registry.internal:5000
sudo -n cp deploy/registry/certs/ca.crt /etc/docker/certs.d/registry.internal:5000/ca.crt
grep -qs 'registry.internal' /etc/hosts || printf '127.0.0.1 registry.internal\n' | sudo -n tee -a /etc/hosts >/dev/null

compose=(sudo -n docker compose -p enterprise-platform -f deploy/compose.yaml -f deploy/compose.server.yaml)
"${compose[@]}" up -d --build --wait system-db
"${compose[@]}" run --rm -T --build control-plane pnpm exec tsx apps/control-plane/src/install.ts </dev/null
"${compose[@]}" up -d --build
REMOTE
