import { spawn } from "node:child_process";
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
import { spawn } from "node:child_process";
const nodeName = process.env.PLATFORM_NODE_NAME;
const base = process.env.PLATFORM_CONTROL_PLANE_URL;
const token = process.env.PLATFORM_NODE_TOKEN;
async function request(path, init = {}) {
  const response = await fetch(base + path, {
    ...init,
    headers: { authorization: "Bearer " + token, ...(init.headers || {}) },
  });
  if (!response.ok) {
    throw new Error(await response.text());
  }
  return response.headers.get("content-type")?.includes("json") ? response.json() : response.text();
}
function docker(args) {
  return new Promise((resolve) => {
    const child = spawn("docker", args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => resolve({ code: 1, stderr: error.message, stdout }));
    child.on("close", (code) => resolve({ code: code ?? 1, stderr, stdout }));
  });
}
async function cycle() {
  const desired = await request("/api/nodes/" + nodeName + "/desired");
  const projects = [];
  for (const item of desired.projects || []) {
    const pulled = await docker(["pull", item.imageDigest]);
    if (pulled.code !== 0) {
      projects.push({ code: item.code, running: false, databaseConnected: false, imageDigest: "", reason: (pulled.stderr || pulled.stdout || "镜像拉取失败").trim() });
      continue;
    }
    await docker(["rm", "-f", "platform-" + item.code]);
    const started = await docker(["run", "-d", "--name", "platform-" + item.code, "-e", "DATABASE_NAME=" + item.databaseName, "-e", "runtime.mode=prod", item.imageDigest]);
    if (started.code !== 0) {
      projects.push({ code: item.code, running: false, databaseConnected: false, imageDigest: item.imageDigest, reason: (started.stderr || started.stdout || "容器启动失败").trim() });
      continue;
    }
    projects.push({ code: item.code, running: true, databaseConnected: true, imageDigest: item.imageDigest });
  }
  await request("/api/nodes/" + nodeName + "/health", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projects }) });
}
while (true) {
  try { await cycle(); } catch (_) {}
  await new Promise((resolve) => setTimeout(resolve, 30000));
}
AGENT
export PLATFORM_NODE_NAME="$node_name"
export PLATFORM_CONTROL_PLANE_URL="$base"
export PLATFORM_NODE_TOKEN="$token"
export PLATFORM_NODE_DIR="$dir"
# mTLS material: client.crt client.key ca.crt
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
