import { buildServer } from "./server.js";

const app = await buildServer();
await app.listen({
  host: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? "3000"),
});
