import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";
import { listSlots, type Slot } from "../src/slots.js";

describe("listSlots", () => {
  it("lists every stage component and leaves them unattached", () => {
    const slots = listSlots();
    expect(slots.map((slot) => slot.component)).toEqual([
      "OpenSpec",
      "Caddy",
      "Ant Design",
      "Midscene.js",
      "Playwright",
      "Vitest",
      "OpenTelemetry Collector",
      "Prometheus",
      "VictoriaLogs",
      "HolmesGPT",
      "vLLM",
    ]);
    expect(slots.every((slot) => slot.attached === false)).toBe(true);
  });
});

describe("GET /slots", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;

  afterEach(async () => {
    await app.close();
  });

  it("returns the stage component slots", async () => {
    app = await buildServer();
    const response = await app.inject({ method: "GET", url: "/slots" });
    const body = response.json() as { slots: Slot[] };

    expect(response.statusCode).toBe(200);
    expect(body).toEqual({ slots: listSlots() });
    expect(body.slots.map((slot) => `${slot.id}/${slot.stage}`)).toEqual([
      "openspec/solution",
      "caddy/edge",
      "antd/ui",
      "midscene/test",
      "playwright/test",
      "vitest/test",
      "otel/ops",
      "prometheus/ops",
      "victoria-logs/ops",
      "holmes/ops",
      "vllm/model",
    ]);
  });
});
