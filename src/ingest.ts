import { fetchPage } from "./arxiv";
import { getUnembedded, markEmbedded, purgeOlderThan, upsertArticles } from "./db";
import { EmbedUnavailableError, embedTexts, pruneVectors, upsertArticleVectors } from "./vectors";
import type { Env } from "./types";

const STATE_KEY = "ingest:state";
const PAGE_SIZE = 100;
// arXiv's search index can lag several days behind (announcement cycles, holidays),
// so a short lookback finds nothing. Upserts dedupe the overlap; only never-embedded
// articles are (re)embedded, so the wider window costs no extra AI quota.
const LOOKBACK_SECONDS = 5 * 86400;
const PURGE_AGE_SECONDS = 30 * 86400;
const MAINTENANCE_EMBED_BATCH = 100;

interface IngestState {
  date: string;
  start: number;
  sinceTs: number;
  done: boolean;
  total: number | null;
  // Optional upper bound on submittedDate, used for manually-driven historical
  // backfills chunked by day (arXiv's search API errors past start~10000, so a
  // wide-open date range can't be paged through in one go). Regular daily
  // ingest never sets this and keeps the default open-ended upper bound.
  untilTs?: number;
}

function todayUtc(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

async function loadState(env: Env, nowMs: number): Promise<IngestState> {
  const raw = await env.CACHE.get(STATE_KEY);
  const today = todayUtc(nowMs);
  if (raw) {
    const parsed = JSON.parse(raw) as IngestState;
    if (parsed.date === today) return parsed;
  }
  const nowSec = Math.floor(nowMs / 1000);
  return { date: today, start: 0, sinceTs: nowSec - LOOKBACK_SECONDS, done: false, total: null };
}

async function saveState(env: Env, state: IngestState): Promise<void> {
  await env.CACHE.put(STATE_KEY, JSON.stringify(state));
}

/** The lookback window overlaps prior days; skip articles that already have vectors. */
async function filterUnembedded<T extends { id: string }>(env: Env, articles: T[]): Promise<T[]> {
  if (articles.length === 0) return [];
  const placeholders = articles.map(() => "?").join(",");
  const { results } = await env.DB.prepare(
    `SELECT id FROM articles WHERE id IN (${placeholders}) AND embedded = 0`
  )
    .bind(...articles.map((a) => a.id))
    .all<{ id: string }>();
  const pendingIds = new Set((results ?? []).map((r) => r.id));
  return articles.filter((a) => pendingIds.has(a.id));
}

export async function ingestTick(
  env: Env,
  fetchFn: typeof fetch = fetch,
  now?: number
): Promise<{ action: string; count?: number }> {
  const nowMs = now ?? Date.now();
  const nowSec = Math.floor(nowMs / 1000);
  const state = await loadState(env, nowMs);

  if (state.done) {
    const unembedded = await getUnembedded(env.DB, MAINTENANCE_EMBED_BATCH);
    if (unembedded.length > 0) {
      try {
        const texts = unembedded.map((a) => `${a.title}\n\n${a.abstract}`);
        const embeddings = await embedTexts(env.AI, texts);
        await upsertArticleVectors(env.VECTORS, unembedded, embeddings);
        await markEmbedded(
          env.DB,
          unembedded.map((a) => a.id)
        );
      } catch (err) {
        if (!(err instanceof EmbedUnavailableError)) throw err;
      }
    }

    await purgeOlderThan(env.DB, nowSec - PURGE_AGE_SECONDS);
    await pruneVectors(env.VECTORS, env.DB);

    return { action: "maintenance" };
  }

  const { articles, totalResults } = await fetchPage(
    state.start,
    PAGE_SIZE,
    state.sinceTs,
    env.CONTACT,
    fetchFn,
    state.untilTs
  );

  await upsertArticles(env.DB, articles);

  const pending = await filterUnembedded(env, articles);
  if (pending.length > 0) {
    try {
      const texts = pending.map((a) => `${a.title}\n\n${a.abstract}`);
      const embeddings = await embedTexts(env.AI, texts);
      await upsertArticleVectors(env.VECTORS, pending, embeddings);
      await markEmbedded(
        env.DB,
        pending.map((a) => a.id)
      );
    } catch (err) {
      if (!(err instanceof EmbedUnavailableError)) throw err;
      // leave embedded=0; will be retried in maintenance mode
    }
  }

  const newStart = state.start + articles.length;
  const done = newStart >= totalResults || articles.length === 0;

  await saveState(env, { ...state, start: newStart, done, total: totalResults });

  return { action: "page", count: articles.length };
}
