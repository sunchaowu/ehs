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

start_ts=$SECONDS

step() {
  local name="$1"
  shift
  local from=$SECONDS
  printf '==> %s\n' "$name" >&2
  "$@"
  printf '<== %s 完成（%d 秒）\n' "$name" "$((SECONDS - from))" >&2
}

ssh_cmd() {
  ssh "${ssh_opts[@]}" "$DEPLOY_USER@$DEPLOY_HOST" "$@"
}

step "打包并上传 platform/" tar -C "$root" -czf - \
  --exclude node_modules \
  --exclude dist \
  --exclude .git \
  --exclude ./deploy/.env \
  . | ssh_cmd "mkdir -p \"\$HOME/enterprise-platform\" && tar -C \"\$HOME/enterprise-platform\" -xzf -"

step "服务器构建与启动" ssh_cmd bash -s << 'REMOTE'
set -euo pipefail
cd "$HOME/enterprise-platform"
if [[ ! -f deploy/.env ]]; then
  echo "服务器缺少 deploy/.env（部署包不再覆盖服务器专用配置），请先创建后再部署" >&2
  exit 1
fi
chmod 600 deploy/.env
# 上传完整性校验：缺任何一个关键文件都说明 tar 上传不完整，立即失败。
for required_file in \
  package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json \
  apps/control-plane/Dockerfile \
  apps/portal/Dockerfile apps/portal/package.json apps/portal/pnpm-workspace.yaml \
  scripts/deploy.sh deploy/compose.yaml deploy/compose.server.yaml; do
  if [[ ! -f "$required_file" ]]; then
    echo "上传不完整：缺少 $required_file" >&2
    exit 1
  fi
done
set -a
source deploy/.env
set +a
printf '%s\n' "$DEPLOY_PASSWORD" | sudo -S -p "" -v
sudo -n docker compose version >/dev/null 2>&1 || { echo "缺少 docker compose" >&2; exit 1; }
compose=(sudo -n docker compose -p enterprise-platform -f deploy/compose.yaml -f deploy/compose.server.yaml)

# 配置 Docker 镜像加速（幂等）：可用 DOCKER_REGISTRY_MIRRORS 覆盖，空格分隔。
mirror_config=$(
  printf '%s\n' "${DOCKER_REGISTRY_MIRRORS:-https://docker.1ms.run https://docker.m.daocloud.io https://docker.xuanyuan.me}" \
    | tr ' ' '\n' | sed '/^$/d' | sed 's/^/    "/; s/$/",/' | sed '$ s/,$//'
)
mirror_json=$(printf '{\n  "registry-mirrors": [\n%s\n  ]\n}\n' "$mirror_config")
mirror_current=$(sudo -n cat /etc/docker/daemon.json 2>/dev/null || true)
if [[ "$mirror_current" == "$mirror_json" ]]; then
  printf '==> Docker 镜像加速已配置，跳过\n' >&2
else
  from=$SECONDS
  printf '==> 配置 Docker 镜像加速\n' >&2
  printf '%s\n' "$mirror_json" | sudo -n tee /etc/docker/daemon.json >/dev/null
  sudo -n systemctl restart docker
  printf '<== 镜像加速配置完成（%d 秒）\n' "$((SECONDS - from))" >&2
fi

from=$SECONDS
printf '==> 拉起 system-db\n' >&2
"${compose[@]}" up -d --build --wait system-db
printf '<== system-db 完成（%d 秒）\n' "$((SECONDS - from))" >&2
from=$SECONDS
printf '==> 安装初始管理员\n' >&2
"${compose[@]}" run --rm -T control-plane pnpm exec tsx apps/control-plane/src/install.ts </dev/null
printf '<== 安装完成（%d 秒）\n' "$((SECONDS - from))" >&2
from=$SECONDS
printf '==> 构建并启动全量服务\n' >&2
"${compose[@]}" up -d --build
printf '<== 全量服务完成（%d 秒）\n' "$((SECONDS - from))" >&2
printf '服务器阶段耗时 %d 秒\n' "$SECONDS" >&2
REMOTE
