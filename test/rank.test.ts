import { env } from "cloudflare:test";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { rank, mergeScores } from "../src/rank";
import { applySchema, upsertArticles, markEmbedded } from "../src/db";
import type { Article, Env } from "../src/types";
import type { NormalizedQuery } from "../src/cache";

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

function makeQuery(overrides: Partial<NormalizedQuery> = {}): NormalizedQuery {
  return {
    interests: ["formal methods"],
    days: 7,
    max: 10,
    min_score: 0.42,
    categories: [],
    format: "json",
    ...overrides,
  };
}

function fakeAi(runImpl?: (model: string, input: { text: string[] }) => Promise<unknown>) {
  return {
    run: vi.fn(runImpl ?? (async (_m: string, input: { text: string[] }) => ({
      data: input.text.map(() => new Array(384).fill(0)),
    }))),
  } as unknown as Ai;
}

function fakeVectors(matchesByCallIndex: { id: string; score: number }[][]) {
  let call = 0;
  return {
    query: vi.fn(async () => {
      const matches = matchesByCallIndex[call] ?? [];
      call += 1;
      return { matches };
    }),
    upsert: vi.fn(async () => ({ mutationId: "x" })),
    deleteByIds: vi.fn(async () => ({ mutationId: "x" })),
  } as unknown as VectorizeIndex;
}

function buildEnv(overrides: Partial<Env>): Env {
  return { ...(env as unknown as Env), ...overrides };
}

const NOW = 2000000;

describe("mergeScores", () => {
  it("takes the max score per id across interests, not the sum", () => {
    const merged = mergeScores([
      [{ id: "a", score: 0.5 }, { id: "b", score: 0.9 }],
      [{ id: "a", score: 0.8 }, { id: "c", score: 0.3 }],
    ]);
    expect(merged.get("a")).toBe(0.8);
    expect(merged.get("b")).toBe(0.9);
    expect(merged.get("c")).toBe(0.3);
  });

  it("returns an empty map for empty input", () => {
    expect(mergeScores([]).size).toBe(0);
  });
});

describe("rank", () => {
  beforeEach(async () => {
    await applySchema(env.DB);
    await env.DB.prepare("DELETE FROM articles").run();
  });

  it("semantic happy path: returns threshold-filtered, sorted papers with mode semantic", async () => {
    const a = makeArticle({ id: "a", title: "Formal Methods Paper", published_ts: NOW - 100 });
    const b = makeArticle({ id: "b", title: "Another Paper", published_ts: NOW - 200 });
    const c = makeArticle({ id: "c", title: "Below Threshold Paper", published_ts: NOW - 300 });
    await upsertArticles(env.DB, [a, b, c]);
    await markEmbedded(env.DB, ["a", "b", "c"]);

    const testEnv = buildEnv({
      AI: fakeAi(),
      VECTORS: fakeVectors([
        [
          { id: "a", score: 0.9 },
          { id: "b", score: 0.5 },
          { id: "c", score: 0.1 },
        ],
      ]),
    });

    const result = await rank(testEnv, makeQuery({ min_score: 0.42 }), NOW);

    expect(result.mode).toBe("semantic");
    expect(result.papers.map((p) => p.id)).toEqual(["a", "b"]);
    expect(result.papers[0].score).toBe(0.9);
    expect(result.papers[1].score).toBe(0.5);
  });

  it("falls back to keyword mode when embedding fails, with an explanatory note", async () => {
    const a = makeArticle({
      id: "a",
      title: "Formal Methods LLM Verification",
      abstract: "combines formal methods and llm techniques",
      published_ts: NOW - 100,
      categories: ["cs.LO"],
    });
    await upsertArticles(env.DB, [a]);

    const testEnv = buildEnv({
      AI: fakeAi(async () => { throw new Error("no ai quota"); }),
      VECTORS: fakeVectors([]),
    });

    const result = await rank(testEnv, makeQuery({ interests: ["formal methods llm"], min_score: 0.42 }), NOW);

    expect(result.mode).toBe("keyword");
    expect(result.note).toContain("keyword matching");
    expect(result.papers.map((p) => p.id)).toContain("a");
  });

  it("merges multi-interest matches by max score, not sum, in the semantic path", async () => {
    const a = makeArticle({ id: "a", published_ts: NOW - 100 });
    await upsertArticles(env.DB, [a]);
    await markEmbedded(env.DB, ["a"]);

    const testEnv = buildEnv({
      AI: fakeAi(),
      VECTORS: fakeVectors([
        [{ id: "a", score: 0.6 }],
        [{ id: "a", score: 0.95 }],
      ]),
    });

    const result = await rank(
      testEnv,
      makeQuery({ interests: ["formal methods", "llm"], min_score: 0.42 }),
      NOW
    );

    expect(result.mode).toBe("semantic");
    expect(result.papers).toHaveLength(1);
    expect(result.papers[0].score).toBe(0.95);
  });

  it("drops below-threshold papers and notes when fewer than max cleared the bar", async () => {
    const a = makeArticle({ id: "a", published_ts: NOW - 100 });
    const b = makeArticle({ id: "b", published_ts: NOW - 200 });
    await upsertArticles(env.DB, [a, b]);
    await markEmbedded(env.DB, ["a", "b"]);

    const testEnv = buildEnv({
      AI: fakeAi(),
      VECTORS: fakeVectors([
        [
          { id: "a", score: 0.5 },
          { id: "b", score: 0.1 },
        ],
      ]),
    });

    const result = await rank(testEnv, makeQuery({ min_score: 0.42, max: 10, days: 7 }), NOW);

    expect(result.mode).toBe("semantic");
    expect(result.papers.map((p) => p.id)).toEqual(["a"]);
    expect(result.note).toContain("only 1 papers cleared your relevance bar in the last 7 days");
  });

  it("respects the max clamp", async () => {
    const articles = Array.from({ length: 5 }, (_, i) =>
      makeArticle({ id: `p${i}`, published_ts: NOW - i * 10 })
    );
    await upsertArticles(env.DB, articles);
    await markEmbedded(env.DB, articles.map((a) => a.id));

    const matches = articles.map((a) => ({ id: a.id, score: 0.9 - articles.indexOf(a) * 0.01 }));

    const testEnv = buildEnv({
      AI: fakeAi(),
      VECTORS: fakeVectors([matches]),
    });

    const result = await rank(testEnv, makeQuery({ min_score: 0.4, max: 2 }), NOW);

    expect(result.papers).toHaveLength(2);
  });

  it("applies category filter to semantic results", async () => {
    const a = makeArticle({ id: "a", published_ts: NOW - 100, categories: ["cs.LO"] });
    const b = makeArticle({ id: "b", published_ts: NOW - 200, categories: ["cs.CV"] });
    await upsertArticles(env.DB, [a, b]);
    await markEmbedded(env.DB, ["a", "b"]);

    const testEnv = buildEnv({
      AI: fakeAi(),
      VECTORS: fakeVectors([
        [
          { id: "a", score: 0.9 },
          { id: "b", score: 0.8 },
        ],
      ]),
    });

    const result = await rank(testEnv, makeQuery({ min_score: 0.4, categories: ["cs.LO"] }), NOW);

    expect(result.papers.map((p) => p.id)).toEqual(["a"]);
  });
});
