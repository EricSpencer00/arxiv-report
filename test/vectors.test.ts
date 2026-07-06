import { env } from "cloudflare:test";
import { beforeEach, describe, it, expect, vi } from "vitest";
import {
  embedTexts,
  upsertArticleVectors,
  querySimilar,
  pruneVectors,
  EmbedUnavailableError,
  EMBED_MODEL,
} from "../src/vectors";
import { applySchema, upsertArticles, markEmbedded, getByIds } from "../src/db";
import type { Article } from "../src/types";

function makeArticle(overrides: Partial<Article> = {}): Article {
  return {
    id: "2507.00001",
    title: "A Paper About Things",
    abstract: "This is an abstract about things.",
    authors: ["Alice Author"],
    categories: ["cs.LO"],
    primary_category: "cs.LO",
    published: "2026-07-01T00:00:00Z",
    published_ts: 1782864000,
    abs_url: "https://arxiv.org/abs/2507.00001v1",
    pdf_url: "https://arxiv.org/pdf/2507.00001v1",
    tldr: null,
    author_notes: null,
    ...overrides,
  };
}

function fakeVectorIndex() {
  return {
    upsert: vi.fn(async (_vectors: unknown[]) => ({ mutationId: "x" })),
    query: vi.fn(async (_vector: number[], _opts?: unknown) => ({
      matches: [] as { id: string; score: number }[],
    })),
    deleteByIds: vi.fn(async (_ids: string[]) => ({ mutationId: "x" })),
  };
}

describe("embedTexts", () => {
  it("batches requests into groups of <=50 and returns flattened embeddings", async () => {
    const texts = Array.from({ length: 120 }, (_, i) => `text ${i}`);
    const run = vi.fn(async (_model: string, input: { text: string[] }) => ({
      data: input.text.map(() => new Array(384).fill(0)),
    }));
    const fakeAi = { run } as unknown as Ai;

    const result = await embedTexts(fakeAi, texts);

    expect(run).toHaveBeenCalledTimes(3);
    expect(run.mock.calls[0][1]).toEqual({ text: texts.slice(0, 50) });
    expect(run.mock.calls[1][1]).toEqual({ text: texts.slice(50, 100) });
    expect(run.mock.calls[2][1]).toEqual({ text: texts.slice(100, 120) });
    expect(run.mock.calls[0][0]).toBe(EMBED_MODEL);
    expect(result).toHaveLength(120);
    expect(result[0]).toHaveLength(384);
  });

  it("wraps ai.run rejection in EmbedUnavailableError", async () => {
    const fakeAi = { run: vi.fn(async () => { throw new Error("boom"); }) } as unknown as Ai;
    await expect(embedTexts(fakeAi, ["a"])).rejects.toBeInstanceOf(EmbedUnavailableError);
  });

  it("wraps malformed response (missing data) in EmbedUnavailableError", async () => {
    const fakeAi = { run: vi.fn(async () => ({})) } as unknown as Ai;
    await expect(embedTexts(fakeAi, ["a"])).rejects.toBeInstanceOf(EmbedUnavailableError);
  });
});

describe("upsertArticleVectors", () => {
  it("builds one vector per article with expected id/values/metadata and batches at 500", async () => {
    const articles = Array.from({ length: 3 }, (_, i) =>
      makeArticle({ id: `2507.0000${i}`, published_ts: 1000 + i, primary_category: "cs.LO" })
    );
    const embeddings = articles.map(() => new Array(384).fill(0.1));
    const vectors = fakeVectorIndex();

    await upsertArticleVectors(vectors as unknown as VectorizeIndex, articles, embeddings);

    expect(vectors.upsert).toHaveBeenCalledTimes(1);
    const batch = vectors.upsert.mock.calls[0][0];
    expect(batch).toHaveLength(3);
    expect(batch[0]).toEqual({
      id: "2507.00000",
      values: embeddings[0],
      metadata: { published_ts: 1000, primary_category: "cs.LO" },
    });
  });

  it("splits into multiple upsert calls when more than 500 vectors", async () => {
    const articles = Array.from({ length: 1200 }, (_, i) => makeArticle({ id: `id-${i}`, published_ts: i }));
    const embeddings = articles.map(() => [0]);
    const vectors = fakeVectorIndex();

    await upsertArticleVectors(vectors as unknown as VectorizeIndex, articles, embeddings);

    expect(vectors.upsert).toHaveBeenCalledTimes(3);
    expect(vectors.upsert.mock.calls[0][0]).toHaveLength(500);
    expect(vectors.upsert.mock.calls[1][0]).toHaveLength(500);
    expect(vectors.upsert.mock.calls[2][0]).toHaveLength(200);
  });
});

describe("querySimilar", () => {
  it("passes the $gte published_ts filter and maps matches to {id, score}", async () => {
    const vectors = fakeVectorIndex();
    vectors.query.mockResolvedValueOnce({
      matches: [
        { id: "a", score: 0.9 },
        { id: "b", score: 0.5 },
      ],
    });

    const embedding = new Array(384).fill(0.2);
    const result = await querySimilar(vectors as unknown as VectorizeIndex, embedding, 1000, 50);

    expect(vectors.query).toHaveBeenCalledWith(embedding, {
      topK: 50,
      filter: { published_ts: { $gte: 1000 } },
      returnValues: false,
      returnMetadata: "none",
    });
    expect(result).toEqual([
      { id: "a", score: 0.9 },
      { id: "b", score: 0.5 },
    ]);
  });
});

describe("pruneVectors", () => {
  beforeEach(async () => {
    await applySchema(env.DB);
    await env.DB.prepare("DELETE FROM articles").run();
  });

  it("deletes old embedded vectors from the index and marks them pruned (embedded=2) in D1", async () => {
    const now = Math.floor(Date.now() / 1000);
    const oldTs = now - 9 * 86400;
    const recentTs = now - 1 * 86400;

    const oldArticle = makeArticle({ id: "old-1", published_ts: oldTs });
    const recentArticle = makeArticle({ id: "recent-1", published_ts: recentTs });
    await upsertArticles(env.DB, [oldArticle, recentArticle]);
    await markEmbedded(env.DB, ["old-1", "recent-1"]);

    const vectors = fakeVectorIndex();
    await pruneVectors(vectors as unknown as VectorizeIndex, env.DB);

    expect(vectors.deleteByIds).toHaveBeenCalledTimes(1);
    expect(vectors.deleteByIds).toHaveBeenCalledWith(["old-1"]);

    const rows = await env.DB.prepare("SELECT id, embedded FROM articles ORDER BY id").all<{
      id: string;
      embedded: number;
    }>();
    const byId = new Map((rows.results ?? []).map((r) => [r.id, r.embedded]));
    expect(byId.get("old-1")).toBe(2);
    expect(byId.get("recent-1")).toBe(1);
  });

  it("does nothing when there are no old embedded rows", async () => {
    const vectors = fakeVectorIndex();
    await pruneVectors(vectors as unknown as VectorizeIndex, env.DB);
    expect(vectors.deleteByIds).not.toHaveBeenCalled();
  });

  it("does not touch unembedded (embedded=0) old rows", async () => {
    const now = Math.floor(Date.now() / 1000);
    const oldTs = now - 9 * 86400;
    const oldUnembedded = makeArticle({ id: "old-unembedded", published_ts: oldTs });
    await upsertArticles(env.DB, [oldUnembedded]);

    const vectors = fakeVectorIndex();
    await pruneVectors(vectors as unknown as VectorizeIndex, env.DB);

    expect(vectors.deleteByIds).not.toHaveBeenCalled();
    const rows = await getByIds(env.DB, ["old-unembedded"]);
    expect(rows).toHaveLength(1);
  });
});
