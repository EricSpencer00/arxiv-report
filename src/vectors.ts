import type { Article } from "./types";

export const EMBED_MODEL = "@cf/baai/bge-small-en-v1.5"; // 384 dims
export const MAX_VECTORS = 12500;

const EMBED_BATCH_SIZE = 50;
const UPSERT_BATCH_SIZE = 500;
const DELETE_BATCH_SIZE = 1000;
const PRUNE_AGE_SECONDS = 8 * 86400;

export class EmbedUnavailableError extends Error {}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

export async function embedTexts(ai: Ai, texts: string[]): Promise<number[][]> {
  const batches = chunk(texts, EMBED_BATCH_SIZE);
  const results: number[][] = [];
  for (const batch of batches) {
    let response: unknown;
    try {
      response = await ai.run(EMBED_MODEL as never, { text: batch } as never);
    } catch (err) {
      throw new EmbedUnavailableError(
        `embedding request failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    const data = (response as { data?: unknown })?.data;
    if (!Array.isArray(data)) {
      throw new EmbedUnavailableError("embedding response missing data array");
    }
    for (const vec of data) {
      results.push(vec as number[]);
    }
  }
  return results;
}

export async function upsertArticleVectors(
  vectors: VectorizeIndex,
  articles: Article[],
  embeddings: number[][]
): Promise<void> {
  const items = articles.map((article, i) => ({
    id: article.id,
    values: embeddings[i],
    metadata: {
      published_ts: article.published_ts,
      primary_category: article.primary_category,
    },
  }));

  for (const batch of chunk(items, UPSERT_BATCH_SIZE)) {
    await vectors.upsert(batch as never);
  }
}

export async function querySimilar(
  vectors: VectorizeIndex,
  embedding: number[],
  sinceTs: number,
  topK: number
): Promise<{ id: string; score: number }[]> {
  const result = await vectors.query(embedding, {
    topK,
    filter: { published_ts: { $gte: sinceTs } },
    returnValues: false,
    returnMetadata: "none",
  } as never);

  const matches = (result as { matches?: { id: string; score: number }[] })?.matches ?? [];
  return matches.map((m) => ({ id: m.id, score: m.score }));
}

export async function pruneVectors(vectors: VectorizeIndex, db: D1Database): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - PRUNE_AGE_SECONDS;

  const { results } = await db
    .prepare("SELECT id FROM articles WHERE embedded = 1 AND published_ts < ?")
    .bind(cutoff)
    .all<{ id: string }>();

  const ids = (results ?? []).map((r) => r.id);
  if (ids.length === 0) return;

  for (const batch of chunk(ids, DELETE_BATCH_SIZE)) {
    await vectors.deleteByIds(batch);
  }

  const placeholders = ids.map(() => "?").join(",");
  await db
    .prepare(`UPDATE articles SET embedded = 2 WHERE id IN (${placeholders})`)
    .bind(...ids)
    .run();
}
