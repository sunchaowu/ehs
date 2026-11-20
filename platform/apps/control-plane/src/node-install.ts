import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type CommandResult = { code: number; stderr: string; stdout: string };
type CommandRunner = (args: string[]) => Promise<CommandResult>;

export type NodeCertificate = { certificate: string; privateKey: string; caCertificate: string };

export async function issueNodeCertificate(
  runner: CommandRunner,
  nodeName: string,
): Promise<NodeCertificate | { reason: string }> {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(nodeName)) {
    return { reason: "节点名称无效" };
  }
  const result = await runner(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-subj", `/CN=${nodeName}`]);
  if (result.code !== 0) {
    return { reason: result.stderr.trim() || result.stdout.trim() || "节点证书签发失败" };
  }
  const certificate = pem(result.stdout, "CERTIFICATE");
  const privateKey = pem(result.stdout, "PRIVATE KEY");
  const caCertificate = pem(result.stdout, "CA CERTIFICATE") || certificate;
  if (!certificate || !privateKey || !caCertificate) {
    return { reason: "节点证书签发失败" };
  }
  return { certificate, privateKey, caCertificate };
}

export function nodeInstallScript(input: {
  nodeName: string;
  controlPlaneUrl: string;
  token: string;
  certificate: string;
  privateKey: string;
  caCertificate: string;
}): string {
  const agentSource = readFileSync(new URL("./node-agent-template.mjs", import.meta.url), "utf8");
  const runnerSource = readFileSync(new URL("./test-runner.mjs", import.meta.url), "utf8");
  return `#!/bin/sh
set -eu
node_name='${input.nodeName}'
base='${input.controlPlaneUrl}'
token='${input.token}'
dir="$HOME/.platform-node"
mkdir -p "$dir"
cat > "$dir/client.crt" <<'CERT'
${input.certificate}
CERT
cat > "$dir/client.key" <<'KEY'
${input.privateKey}
KEY
cat > "$dir/ca.crt" <<'CA'
${input.caCertificate}
CA
cat > "$dir/agent.mjs" <<'AGENT'
${agentSource}
AGENT
cat > "$dir/test-runner.mjs" <<'RUNNER'
${runnerSource}
RUNNER
export PLATFORM_NODE_NAME="$node_name"
export PLATFORM_CONTROL_PLANE_URL="$base"
export PLATFORM_NODE_TOKEN="$token"
export PLATFORM_NODE_DIR="$dir"
# mTLS material: client.crt client.key ca.crt
# 项目数据库连接串放在本机 $dir/database.url，用 {database} 占位数据库名；
# 也可以用 PLATFORM_DATABASE_URL_TEMPLATE 覆盖。安装脚本不写数据库地址。
# 测试任务由控制面通过 /desired 下发，代理在测试容器内运行白盒入口并回报步骤。
# 入口网关默认监听 8081，并上报本机非回环 IPv4；
# 可用 PLATFORM_NODE_GATEWAY_PORT、PLATFORM_NODE_ADDRESS、PLATFORM_NODE_GATEWAY_URL 覆盖。
exec node "$dir/agent.mjs"
`;
}

export async function opensslCertificateIssuer(nodeName: string): Promise<NodeCertificate | { reason: string }> {
  const directory = await mkdtemp(join(tmpdir(), "platform-node-cert-"));
  try {
    return await issueNodeCertificate(async (args) => {
      const result = await run("openssl", [
        ...args.slice(0, 5),
        "-keyout",
        join(directory, "key.pem"),
        "-out",
        join(directory, "cert.pem"),
        "-days",
        "365",
        ...args.slice(5),
      ]);
      if (result.code !== 0) {
        return result;
      }
      const certificate = await readFile(join(directory, "cert.pem"), "utf8");
      const privateKey = await readFile(join(directory, "key.pem"), "utf8");
      return { code: 0, stderr: "", stdout: `${certificate}\n${privateKey}\n` };
    }, nodeName);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function pem(source: string, label: string): string {
  const match = source.match(new RegExp(`-----BEGIN ${label}-----[\\s\\S]*?-----END ${label}-----`));
  return match?.[0] ?? "";
}

function run(command: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => resolve({ code: 1, stderr: error.message, stdout }));
    child.on("close", (code) => resolve({ code: code ?? 1, stderr, stdout }));
  });
}
