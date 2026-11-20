# 项目入口路由实施记录（2026-11-19）

## 目标

解决「发布后用户如何打开生成的项目页面」。此前运行库已经提供 `/p/<项目编码>/...` 页面和 `/api/<项目编码>/...` 接口，节点也把容器跑了起来，但端口没有发布，也没有从门户到容器的访问路径。

本轮打通：浏览器 → 接入区 → 控制面 → 正式节点网关 → 项目容器。

## 决策

- **节点内置 HTTP 网关，而不是让控制面直连容器端口**：控制面不加入正式区网络，也不接触 Docker 发布端口；节点自己知道容器发布到本机哪个端口。
- **容器端口只发布到节点回环地址**：`docker run -p 127.0.0.1::8080`，由 Docker 分配随机宿主端口，再用 `docker port` 读取。节点网关转发到 `127.0.0.1:<端口>`，容器端口不对节点网段直接开放。
- **控制面做身份与发布校验**：`/p/<编码>` 和 `/p/<编码>/*` 由控制面处理。未登录的页面请求跳回门户首页，写请求返回 401；非项目成员 403；项目没有已发布版本、没有目标节点或容器未就绪时返回 409/503。
- **身份头由控制面注入**：只信任控制面写入的 `x-platform-user` 和 `x-platform-roles`。客户端自带的同名头和逐跳头在转发前删除；中文用户名和角色按 `encodeURIComponent` 编码。
- **只放行已发布版本**：要求 `published_versions` 存在，且目标节点回报的 `running` 容器镜像摘要与已发布摘要一致。部署新版本期间旧的已发布摘要可能短暂不可访问，这是有意避免把未完成健康确认的版本暴露给用户。
- **节点地址随健康上报**：`node_reports` 新增 `gateway` 列。节点默认上报 `http://<主机名或 PLATFORM_NODE_ADDRESS>:8081`，可用 `PLATFORM_NODE_GATEWAY_URL` 覆盖。
- **接入区继续只发布 443**：Caddy 增加 `/p/*` 到控制面的路由，对互联网仍然只有一个入口。

## 链路

```
浏览器
  → Caddy /p/<编码>/...
  → 控制面 GET/POST /p/<编码>/...
      - 校验平台会话
      - 校验项目成员
      - 读取已发布版本与目标节点网关
      - 注入 x-platform-user / x-platform-roles
  → 节点网关 http://<节点>:8081/p/<编码>/...
      - 按项目编码查容器本机端口
  → 容器 127.0.0.1:<随机端口>/p/<编码>/...
      - 运行库按身份头校验菜单授权
```

## 代码

- `node-agent-template.mjs`
  - `startGateway()`：默认监听 `8081`，可用 `PLATFORM_NODE_GATEWAY_PORT` 调整。
  - `gatewayUrl()`：健康上报地址，优先 `PLATFORM_NODE_GATEWAY_URL`，其次 `PLATFORM_NODE_ADDRESS`，再取本机第一个非回环 IPv4，最后退回主机名。
  - `parseDockerPort()`：解析 `docker port` 输出。
  - `proxyToProject()`：按 `/p/<编码>` 查 `accessPorts`，只转发 `content-type`、`accept`、`accept-language` 和身份头，支持 GET/POST 与查询串。
  - `reconcileProject()`：启动容器时发布 `127.0.0.1::8080`，把解析出的端口记入 `accessPorts`。
  - `main()`：非测试任务模式先启动网关，再进入协调循环。
- `entry-proxy.ts`：控制面的头过滤、身份注入和请求体还原；纯函数，便于测试。
- `server.ts`
  - 注册 `application/x-www-form-urlencoded` 解析器，保留表单原文。
  - `app.all("/p/:code")`、`app.all("/p/*")` 代理到节点网关；网关超时或不可达返回 502。
  - `buildServer({ entryFetch, database })` 可注入 fetch 与连接，用于测试。
- `releases.ts`：`readProjectEntry()` 解析入口目标；`acceptHealthReport()` 保存节点网关地址。
- `schema.sql`：`node_reports.gateway text not null default ''`。
- `drafts.ts`：`projectRoles()` 读取用户在项目里的角色名。
- `deploy/Caddyfile`、`Caddyfile.server`、`Caddyfile.host`：增加 `handle /p/*` 到控制面。
- `apps/portal/src/App.tsx`：项目页增加「打开项目」，新标签打开 `/p/<编码>`。

## 边界与偏差

- **没有接入 mTLS**：节点仍然用 Bearer 令牌访问控制面，`client.crt` / `client.key` / `ca.crt` 只是落盘材料。入口链路依赖网络分区，节点网关的 `8081` 必须只允许系统运行区访问，不能暴露到互联网或用户网段。
- **没有多副本与负载均衡**：一个项目选第一个上报健康的目标节点，多副本只启动一个容器（`replicas` 仍未落实）。
- **没有 WebSocket/SSE 支持**：当前只转发普通 HTTP 请求与响应。
- **没有流式响应**：控制面把上游响应完整读入内存再返回，适合当前管理页面，不适合大文件下载。
- **响应头只保留少量字段**：`content-type`、`location`、`cache-control`、`set-cookie`；`content-encoding` 不复制，因此转发时丢弃 `accept-encoding`，由上游返回未压缩内容。
- **入口要求已发布版本**：候选版本在发布确认前不能通过 `/p/...` 打开，门户只能看到草稿和测试结果。

## 验证

- `pnpm exec tsc -p tsconfig.json --noEmit`：通过。
- `pnpm exec vitest run --project runtime`：24 个用例通过。
  - 运行库 5 个。
  - 测试节点与白盒 11 个（含端口解析、网关地址、入口转发、404/502、项目健康上报）。
  - 入口代理与入口路由 8 个：头过滤与身份编码、表单原文与 JSON 还原、系统库未配置时 503、未登录 302/401、非成员 403、未发布 409、运行摘要与已发布不一致 503、页面与表单转发并注入身份、网关不可达 502。
- `pnpm exec vitest run --project portal`：20 个用例通过，包含「打开项目」链接。
- `stage4-finish.test.ts` 的安装脚本用例通过；同一文件的数据库用例因本机没有 PostgreSQL 未执行。
- 入口路由测试使用注入的假 `SystemDatabase` 与 `entryFetch`，不需要 PostgreSQL。
- 未执行：局域网 Ubuntu 上的真实 `/p/<编码>` 访问。需要重新部署控制面、重新生成并安装节点脚本后验证。

## 下一步

1. 重新部署控制面，重新安装正式节点，确认健康上报带 `gateway`。
2. 在局域网用浏览器登录门户，打开已发布项目的「打开项目」，走通菜单、创建记录和流程。
3. 给节点网关加分区防火墙规则或双向证书，替代当前仅靠网络边界。
4. 落实多副本、负载均衡与入口故障切换。
