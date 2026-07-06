import { Hono } from "hono";
import { cors } from "hono/cors";
import { normalizeQuery, cacheKeyFor, secondsUntilNextIngest, getCached, putCached } from "./cache";
import type { NormalizedQuery } from "./cache";
import { rank } from "./rank";
import { enrichPapers, budgetRemaining } from "./enrich";
import { renderDigest } from "./digest";
import { buildOpenApiDocument } from "./openapi";
import { ingestTick } from "./ingest";
import type { Env, PapersResponse, RankedPaper } from "./types";

const ATTRIBUTION = "Thank you to arXiv for use of its open access interoperability.";
const STATE_KEY = "ingest:state";

const app = new Hono<{ Bindings: Env }>();

app.use("/api/*", cors());

app.get("/api/health", async (c) => {
  const rawState = await c.env.CACHE.get(STATE_KEY);
  const last_ingest = rawState ? JSON.parse(rawState) : null;

  let article_count = 0;
  try {
    const countRow = await c.env.DB.prepare("SELECT COUNT(*) as c FROM articles").first<{ c: number }>();
    article_count = countRow?.c ?? 0;
  } catch {
    // Schema not yet applied (e.g. before first ingest); report zero rather than erroring.
    article_count = 0;
  }

  const gen_budget_remaining = await budgetRemaining(c.env.CACHE, Number(c.env.DAILY_GEN_CAP));

  return c.json({
    ok: true,
    last_ingest,
    article_count,
    gen_budget_remaining,
  });
});

app.get("/api/openapi.json", (c) => {
  const origin = new URL(c.req.url).origin;
  return c.json(buildOpenApiDocument(origin));
});

async function buildPapersResponse(env: Env, q: NormalizedQuery): Promise<PapersResponse> {
  const rankResult = await rank(env, q);
  const papers: RankedPaper[] = rankResult.papers.map((paper) => ({
    ...paper,
    relevance_blurb: null,
  }));

  const enriched = await enrichPapers(env, papers, q.interests);

  const response: PapersResponse = {
    query: {
      interests: q.interests,
      days: q.days,
      max: q.max,
      min_score: q.min_score,
      categories: q.categories,
    },
    ranking: rankResult.mode,
    generated_at: new Date().toISOString(),
    papers: enriched,
    attribution: ATTRIBUTION,
  };

  if (rankResult.note) {
    response.note = rankResult.note;
  }

  return response;
}

app.get("/api/papers", async (c) => {
  const params = new URL(c.req.url).searchParams;
  const result = normalizeQuery(params, Number(c.env.MIN_SCORE));

  if ("error" in result) {
    return c.json({ error: result.error }, 400);
  }

  const cacheKey = cacheKeyFor(result, "/api/papers");
  const cached = await getCached(cacheKey);
  if (cached) {
    const headers = new Headers(cached.headers);
    headers.set("X-Cache", "HIT");
    return new Response(cached.body, { status: cached.status, headers });
  }

  const response = await buildPapersResponse(c.env, result);
  const body = JSON.stringify(response);
  const headers = new Headers({
    "Content-Type": "application/json",
    "X-Cache": "MISS",
    "Access-Control-Allow-Origin": "*",
  });

  const toCache = new Response(body, { status: 200, headers });
  await putCached(cacheKey, toCache.clone(), secondsUntilNextIngest(new Date()));

  return toCache;
});

app.get("/api/digest", async (c) => {
  const url = new URL(c.req.url);
  const params = url.searchParams;
  const result = normalizeQuery(params, Number(c.env.MIN_SCORE));

  if ("error" in result) {
    return c.json({ error: result.error }, 400);
  }

  const forced: NormalizedQuery = { ...result, format: "md" };

  const cacheKey = cacheKeyFor(forced, "/api/digest");
  const cached = await getCached(cacheKey);
  if (cached) {
    const headers = new Headers(cached.headers);
    headers.set("X-Cache", "HIT");
    return new Response(cached.body, { status: cached.status, headers });
  }

  const response = await buildPapersResponse(c.env, forced);
  const markdown = renderDigest(response, c.req.url);

  const headers = new Headers({
    "Content-Type": "text/markdown;charset=utf-8",
    "X-Cache": "MISS",
    "Access-Control-Allow-Origin": "*",
  });

  const toCache = new Response(markdown, { status: 200, headers });
  await putCached(cacheKey, toCache.clone(), secondsUntilNextIngest(new Date()));

  return toCache;
});

app.post("/api/admin/ingest", async (c) => {
  const secret = c.env.ADMIN_SECRET;
  const authHeader = c.req.header("Authorization");
  if (!secret || authHeader !== `Bearer ${secret}`) {
    return c.json({ error: "unauthorized" }, 401);
  }

  try {
    const result = await ingestTick(c.env);
    return c.json(result);
  } catch (e) {
    return c.json({ error: String(e) }, 500);
  }
});

export default app;
