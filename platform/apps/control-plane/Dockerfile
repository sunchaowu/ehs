FROM node:24-bookworm-slim
WORKDIR /app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN --mount=type=cache,id=corepack,target=/root/.cache/node/corepack \
    corepack enable && corepack prepare pnpm@10.22.0 --activate
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile
COPY apps/control-plane apps/control-plane
COPY tsconfig.json ./
ENV HOST=0.0.0.0
ENV PORT=3000
EXPOSE 3000
CMD ["pnpm", "exec", "tsx", "watch", "apps/control-plane/src/dev.ts"]
