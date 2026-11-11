import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "../src/passwords.js";

const options = { memoryKiB: 19456, iterations: 2, parallelism: 1 };

describe("passwords", () => {
  it("verifies the same password and rejects another", async () => {
    const hash = await hashPassword("correct horse", options);
    expect(hash).not.toContain("correct horse");
    expect(await verifyPassword(hash, "correct horse")).toBe(true);
    expect(await verifyPassword(hash, "wrong horse")).toBe(false);
  });
});
