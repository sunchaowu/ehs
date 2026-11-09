import { describe, expect, it } from "vitest";
import { listSlots } from "../src/slots.js";

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
