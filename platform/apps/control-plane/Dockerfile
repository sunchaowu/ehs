FROM node:24-bookworm-slim
WORKDIR /app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@10.22.0 --activate
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY apps/control-plane apps/control-plane
COPY tsconfig.json ./
# 生成器需要调用系统运行区的 Docker 构建候选镜像。客户端由 compose 挂载宿主机的 docker 可执行文件，
# 守护进程通过 /var/run/docker.sock 访问，容器里不装守护进程。
ENV HOST=0.0.0.0
ENV PORT=3000
EXPOSE 3000
CMD ["pnpm", "exec", "tsx", "watch", "apps/control-plane/src/dev.ts"]
