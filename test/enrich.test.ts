import { env } from "cloudflare:test";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { budgetRemaining, consumeBudget, enrichPapers, GEN_MODEL } from "../src/enrich";
import { applySchema, upsertArticles, getByIds } from "../src/db";
import type { Article, Env, RankedPaper } from "../src/types";

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

function makeRankedPaper(overrides: Partial<RankedPaper> = {}): RankedPaper {
  return {
    ...makeArticle(),
    score: 0.9,
    relevance_blurb: null,
    ...overrides,
  };
}

function buildEnv(overrides: Partial<Env>): Env {
  return { ...(env as unknown as Env), ...overrides };
}

function fakeAi(runImpl: (model: string, input: unknown) => Promise<unknown>) {
  return { run: vi.fn(runImpl) } as unknown as Ai;
}

function todayBudgetKey(): string {
  return `genbudget:${new Date().toISOString().slice(0, 10)}`;
}

describe("budgetRemaining / consumeBudget", () => {
  beforeEach(async () => {
    await env.CACHE.delete(todayBudgetKey());
  });

  it("returns full cap when nothing consumed", async () => {
    expect(await budgetRemaining(env.CACHE, 5)).toBe(5);
  });

  it("decrements across calls and floors at 0", async () => {
    await consumeBudget(env.CACHE, 1);
    expect(await budgetRemaining(env.CACHE, 5)).toBe(4);
    await consumeBudget(env.CACHE, 1);
    await consumeBudget(env.CACHE, 1);
    await consumeBudget(env.CACHE, 1);
    expect(await budgetRemaining(env.CACHE, 5)).toBe(1);
    await consumeBudget(env.CACHE, 5);
    expect(await budgetRemaining(env.CACHE, 5)).toBe(0);
  });
});

describe("enrichPapers", () => {
  beforeEach(async () => {
    await applySchema(env.DB);
    await env.DB.prepare("DELETE FROM articles").run();
    await env.CACHE.delete(todayBudgetKey());
  });

  it("generates tldr + blurb and persists tldr to D1 when budget available", async () => {
    const article = makeArticle({ id: "gen1" });
    await upsertArticles(env.DB, [article]);
    const paper = makeRankedPaper({ id: "gen1", tldr: null, relevance_blurb: null });

    const run = vi.fn(async (_model: string, _input: unknown) => ({
      response: JSON.stringify({ tldr: "This paper does X.", why: "It matches your interests." }),
    }));
    const testEnv = buildEnv({ AI: fakeAi(run), DAILY_GEN_CAP: "5" });

    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ results: [] }), { status: 200 }));

    const result = await enrichPapers(testEnv, [paper], ["formal methods"], fetchFn);

    expect(result[0].tldr).toBe("This paper does X.");
    expect(result[0].relevance_blurb).toBe("It matches your interests.");
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0]).toBe(GEN_MODEL);

    const [stored] = await getByIds(env.DB, ["gen1"]);
    expect(stored.tldr).toBe("This paper does X.");

    expect(await budgetRemaining(testEnv.CACHE, 5)).toBe(4);
  });

  it("blocks generation once budget is exhausted, leaving tldr/blurb null", async () => {
    const article = makeArticle({ id: "gen2" });
    await upsertArticles(env.DB, [article]);
    const paper = makeRankedPaper({ id: "gen2", tldr: null, relevance_blurb: null });

    const run = vi.fn(async () => ({
      response: JSON.stringify({ tldr: "nope", why: "nope" }),
    }));
    const testEnv = buildEnv({ AI: fakeAi(run), DAILY_GEN_CAP: "1" });
    await consumeBudget(testEnv.CACHE, 1); // exhaust budget

    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ results: [] }), { status: 200 }));
    const result = await enrichPapers(testEnv, [paper], ["formal methods"], fetchFn);

    expect(result[0].tldr).toBeNull();
    expect(result[0].relevance_blurb).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });

  it("malformed AI JSON output leaves tldr/blurb null and does not throw", async () => {
    const article = makeArticle({ id: "gen3" });
    await upsertArticles(env.DB, [article]);
    const paper = makeRankedPaper({ id: "gen3", tldr: null, relevance_blurb: null });

    const run = vi.fn(async () => ({ response: "not json at all {{{" }));
    const testEnv = buildEnv({ AI: fakeAi(run), DAILY_GEN_CAP: "5" });

    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ results: [] }), { status: 200 }));
    await expect(enrichPapers(testEnv, [paper], ["formal methods"], fetchFn)).resolves.toBeDefined();

    const result = await enrichPapers(testEnv, [paper], ["formal methods"], fetchFn);
    expect(result[0].tldr).toBeNull();
    expect(result[0].relevance_blurb).toBeNull();
  });

  it("extracts JSON from a noisy AI response via regex fallback", async () => {
    const article = makeArticle({ id: "gen4" });
    await upsertArticles(env.DB, [article]);
    const paper = makeRankedPaper({ id: "gen4", tldr: null, relevance_blurb: null });

    const run = vi.fn(async () => ({
      response: `Sure! Here you go: {"tldr": "Extracted tldr.", "why": "Extracted why."} Hope that helps.`,
    }));
    const testEnv = buildEnv({ AI: fakeAi(run), DAILY_GEN_CAP: "5" });
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ results: [] }), { status: 200 }));

    const result = await enrichPapers(testEnv, [paper], ["formal methods"], fetchFn);
    expect(result[0].tldr).toBe("Extracted tldr.");
    expect(result[0].relevance_blurb).toBe("Extracted why.");
  });

  it("existing tldr + budget available generates blurb only, without overwriting tldr", async () => {
    const article = makeArticle({ id: "gen5", tldr: "Existing tldr from before." });
    await upsertArticles(env.DB, [article]);
    await env.DB.prepare("UPDATE articles SET tldr = ? WHERE id = ?")
      .bind("Existing tldr from before.", "gen5")
      .run();
    const paper = makeRankedPaper({ id: "gen5", tldr: "Existing tldr from before.", relevance_blurb: null });

    const run = vi.fn(async () => ({ response: JSON.stringify({ why: "Matches because X." }) }));
    const testEnv = buildEnv({ AI: fakeAi(run), DAILY_GEN_CAP: "5" });
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ results: [] }), { status: 200 }));

    const result = await enrichPapers(testEnv, [paper], ["formal methods"], fetchFn);
    expect(result[0].tldr).toBe("Existing tldr from before.");
    expect(result[0].relevance_blurb).toBe("Matches because X.");
    expect(await budgetRemaining(testEnv.CACHE, 5)).toBe(4);
  });

  it("existing tldr but no budget leaves relevance_blurb null and does not call AI", async () => {
    const article = makeArticle({ id: "gen6", tldr: "Existing tldr." });
    await upsertArticles(env.DB, [article]);
    await env.DB.prepare("UPDATE articles SET tldr = ? WHERE id = ?").bind("Existing tldr.", "gen6").run();
    const paper = makeRankedPaper({ id: "gen6", tldr: "Existing tldr.", relevance_blurb: null });

    const run = vi.fn(async () => ({ response: JSON.stringify({ why: "should not be called" }) }));
    const testEnv = buildEnv({ AI: fakeAi(run), DAILY_GEN_CAP: "1" });
    await consumeBudget(testEnv.CACHE, 1);
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ results: [] }), { status: 200 }));

    const result = await enrichPapers(testEnv, [paper], ["formal methods"], fetchFn);
    expect(result[0].tldr).toBe("Existing tldr.");
    expect(result[0].relevance_blurb).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });

  it("fetches and persists OpenAlex author notes on success", async () => {
    const article = makeArticle({ id: "auth1", authors: ["Jane Researcher"], author_notes: null });
    await upsertArticles(env.DB, [article]);
    const paper = makeRankedPaper({ id: "auth1", authors: ["Jane Researcher"], tldr: "x", relevance_blurb: null });
    // persist tldr so we isolate to author_notes path (still budget-limited but irrelevant since tldr set)
    await env.DB.prepare("UPDATE articles SET tldr = ? WHERE id = ?").bind("x", "auth1").run();

    const run = vi.fn(async () => ({ response: JSON.stringify({ why: "matches" }) }));
    const testEnv = buildEnv({ AI: fakeAi(run), DAILY_GEN_CAP: "5", CONTACT: "mailto:test@example.com" });

    const fetchFn = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toContain("api.openalex.org/authors");
      expect(String(url)).toContain("mailto=test%40example.com");
      return new Response(
        JSON.stringify({
          results: [
            {
              display_name: "Jane Researcher",
              works_count: 42,
              last_known_institutions: [{ display_name: "Example University" }],
            },
          ],
        }),
        { status: 200 }
      );
    });

    const result = await enrichPapers(testEnv, [paper], ["formal methods"], fetchFn);
    expect(result[0].author_notes).toEqual({
      "Jane Researcher": "Example University — 42 works",
    });

    const [stored] = await getByIds(env.DB, ["auth1"]);
    expect(stored.author_notes).toEqual({ "Jane Researcher": "Example University — 42 works" });
  });

  it("OpenAlex timeout leaves author_notes null and does not throw", async () => {
    const article = makeArticle({ id: "auth2", authors: ["Slow Author"], author_notes: null });
    await upsertArticles(env.DB, [article]);
    const paper = makeRankedPaper({ id: "auth2", authors: ["Slow Author"], tldr: "x", relevance_blurb: null });
    await env.DB.prepare("UPDATE articles SET tldr = ? WHERE id = ?").bind("x", "auth2").run();

    const run = vi.fn(async () => ({ response: JSON.stringify({ why: "matches" }) }));
    const testEnv = buildEnv({ AI: fakeAi(run), DAILY_GEN_CAP: "5" });

    const fetchFn = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
    });

    const result = await enrichPapers(testEnv, [paper], ["formal methods"], fetchFn as unknown as typeof fetch);
    expect(result[0].author_notes).toBeNull();

    const [stored] = await getByIds(env.DB, ["auth2"]);
    expect(stored.author_notes).toBeNull();
  }, 10000);

  it("OpenAlex empty results leaves author_notes null", async () => {
    const article = makeArticle({ id: "auth3", authors: ["Nobody Found"], author_notes: null });
    await upsertArticles(env.DB, [article]);
    const paper = makeRankedPaper({ id: "auth3", authors: ["Nobody Found"], tldr: "x", relevance_blurb: null });
    await env.DB.prepare("UPDATE articles SET tldr = ? WHERE id = ?").bind("x", "auth3").run();

    const testEnv = buildEnv({ AI: fakeAi(async () => ({ response: "{}" })), DAILY_GEN_CAP: "5" });
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ results: [] }), { status: 200 }));

    const result = await enrichPapers(testEnv, [paper], ["formal methods"], fetchFn);
    expect(result[0].author_notes).toBeNull();
  });
});
