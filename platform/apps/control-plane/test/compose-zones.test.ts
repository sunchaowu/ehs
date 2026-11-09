import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { readZonePolicy } from "../src/compose-zones.js";

describe("zone policy", () => {
  it("publishes only 443 and keeps test away from prod and the edge", () => {
    const policy = readZonePolicy(readFileSync(new URL("../../../deploy/compose.yaml", import.meta.url), "utf8"));
    expect(policy.publishedPorts).toEqual(["443:443"]);
    expect(policy.isolatedPairs).toBe(true);
  });
});
