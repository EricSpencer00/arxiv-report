import { fetchPage } from "./arxiv";
import { getUnembedded, markEmbedded, purgeOlderThan, upsertArticles } from "./db";
import { EmbedUnavailableError, embedTexts, pruneVectors, upsertArticleVectors } from "./vectors";
import type { Env } from "./types";

const STATE_KEY = "ingest:state";
const PAGE_SIZE = 100;
const LOOKBACK_SECONDS = 2 * 86400;
const PURGE_AGE_SECONDS = 30 * 86400;
const MAINTENANCE_EMBED_BATCH = 100;

interface IngestState {
  date: string;
  start: number;
  sinceTs: number;
  done: boolean;
  total: number | null;
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

  const { articles, totalResults } = await fetchPage(state.start, PAGE_SIZE, state.sinceTs, env.CONTACT, fetchFn);

  await upsertArticles(env.DB, articles);

  if (articles.length > 0) {
    try {
      const texts = articles.map((a) => `${a.title}\n\n${a.abstract}`);
      const embeddings = await embedTexts(env.AI, texts);
      await upsertArticleVectors(env.VECTORS, articles, embeddings);
      await markEmbedded(
        env.DB,
        articles.map((a) => a.id)
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
