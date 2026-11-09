export type Slot = { id: string; stage: string; component: string; attached: boolean };

export function listSlots(): Slot[] {
  return [
    { id: "openspec", stage: "solution", component: "OpenSpec", attached: false },
    { id: "caddy", stage: "edge", component: "Caddy", attached: false },
    { id: "antd", stage: "ui", component: "Ant Design", attached: false },
    { id: "midscene", stage: "test", component: "Midscene.js", attached: false },
    { id: "playwright", stage: "test", component: "Playwright", attached: false },
    { id: "vitest", stage: "test", component: "Vitest", attached: false },
    { id: "otel", stage: "ops", component: "OpenTelemetry Collector", attached: false },
    { id: "prometheus", stage: "ops", component: "Prometheus", attached: false },
    { id: "victoria-logs", stage: "ops", component: "VictoriaLogs", attached: false },
    { id: "holmes", stage: "ops", component: "HolmesGPT", attached: false },
    { id: "vllm", stage: "model", component: "vLLM", attached: false },
  ];
}
