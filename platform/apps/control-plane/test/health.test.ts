import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "../src/server.js";

describe("GET /health", () => {
  let app: Awaited<ReturnType<typeof buildServer>>;

  afterEach(async () => {
    await app.close();
  });

  it("returns ok", async () => {
    app = await buildServer();
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });
});
