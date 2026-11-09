import Fastify, { type FastifyInstance } from "fastify";
import { listSlots } from "./slots.js";

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.get("/health", async () => ({ status: "ok" }));
  app.get("/slots", async () => ({ slots: listSlots() }));
  return app;
}
