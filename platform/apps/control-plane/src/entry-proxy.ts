/**
 * 控制面转发项目页面时的纯函数：头过滤、身份注入、请求体还原。
 * 与数据库和网络解耦，便于单元测试。
 */

type HeaderValue = string | string[] | undefined;

const skippedRequestHeaders = new Set([
  "host",
  "connection",
  "content-length",
  "transfer-encoding",
  "accept-encoding",
  "x-platform-user",
  "x-platform-roles",
]);

/** 只保留可安全转发的头，并用控制面校验过的身份覆盖客户端自带的身份头。 */
export function forwardHeaders(
  source: Record<string, HeaderValue>,
  username: string,
  roles: string[],
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || skippedRequestHeaders.has(name.toLowerCase())) {
      continue;
    }
    headers[name.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  }
  headers["x-platform-user"] = encodeURIComponent(username);
  headers["x-platform-roles"] = roles.map((role) => encodeURIComponent(role)).join(",");
  return headers;
}

/** Fastify 已解析的请求体还原成上游可接收的形式；urlencoded 保持原始文本。 */
export function forwardBody(method: string, body: unknown): string | undefined {
  if (method === "GET" || method === "HEAD" || body === undefined || body === null) {
    return undefined;
  }
  if (typeof body === "string") {
    return body;
  }
  if (Buffer.isBuffer(body)) {
    return body.toString("utf8");
  }
  return JSON.stringify(body);
}
