import { Hono } from "hono";
import api from "./api";
import { ingestTick } from "./ingest";
import type { Env } from "./types";

const app = new Hono<{ Bindings: Env }>();

app.route("/", api);

export default {
  fetch: app.fetch,
  scheduled: async (_controller, env, ctx) => {
    ctx.waitUntil(ingestTick(env).catch((e) => console.error("ingest tick failed", e)));
  },
} satisfies ExportedHandler<Env>;
