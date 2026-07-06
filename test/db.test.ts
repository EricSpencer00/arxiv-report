import { env } from "cloudflare:test";
import { beforeEach, describe, it, expect } from "vitest";
import {
  applySchema,
  upsertArticles,
  getByWindow,
  getByIds,
  markEmbedded,
  saveTldr,
  saveAuthorNotes,
  getUnembedded,
  purgeOlderThan,
} from "../src/db";
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

describe("db", () => {
  beforeEach(async () => {
    await applySchema(env.DB);
    // ensure a clean slate between tests since miniflare D1 storage can persist
    await env.DB.prepare("DELETE FROM articles").run();
  });

  it("applySchema creates the articles table idempotently", async () => {
    await applySchema(env.DB); // calling twice should not throw
    const result = await env.DB.prepare("SELECT COUNT(*) as c FROM articles").first<{ c: number }>();
    expect(result?.c).toBe(0);
  });

  it("upserts two articles and reads them back", async () => {
    const a1 = makeArticle({ id: "2507.00001", title: "First Paper" });
    const a2 = makeArticle({ id: "2507.00002", title: "Second Paper", categories: ["cs.CL"], primary_category: "cs.CL" });

    await upsertArticles(env.DB, [a1, a2]);

    const rows = await getByIds(env.DB, ["2507.00001", "2507.00002"]);
    expect(rows).toHaveLength(2);
    expect(rows[0].title).toBe("First Paper");
    expect(rows[1].title).toBe("Second Paper");
    expect(rows[1].categories).toEqual(["cs.CL"]);
  });

  it("re-upserting an existing id updates core fields but never overwrites tldr/author_notes/embedded", async () => {
    const original = makeArticle({ id: "2507.00003", title: "Original Title" });
    await upsertArticles(env.DB, [original]);

    // Manually set enrichment fields that upsert must never clobber.
    await saveTldr(env.DB, "2507.00003", "A short summary.");
    await saveAuthorNotes(env.DB, "2507.00003", { "Alice Author": "MIT — 12 works" });
    await markEmbedded(env.DB, ["2507.00003"]);

    const updated = makeArticle({ id: "2507.00003", title: "Updated Title" });
    await upsertArticles(env.DB, [updated]);

    const [row] = await getByIds(env.DB, ["2507.00003"]);
    expect(row.title).toBe("Updated Title");
    expect(row.tldr).toBe("A short summary.");
    expect(row.author_notes).toEqual({ "Alice Author": "MIT — 12 works" });

    const unembedded = await getUnembedded(env.DB, 10);
    expect(unembedded.find((r) => r.id === "2507.00003")).toBeUndefined();
  });

  it("getByWindow excludes rows older than sinceTs and orders newest first", async () => {
    const old = makeArticle({ id: "2507.00010", published_ts: 1000, title: "Old" });
    const mid = makeArticle({ id: "2507.00011", published_ts: 2000, title: "Mid" });
    const recent = makeArticle({ id: "2507.00012", published_ts: 3000, title: "Recent" });
    await upsertArticles(env.DB, [old, mid, recent]);

    const rows = await getByWindow(env.DB, 2000, []);
    expect(rows.map((r) => r.id)).toEqual(["2507.00012", "2507.00011"]);
  });

  it("getByWindow post-filters by category intersection", async () => {
    const a = makeArticle({ id: "2507.00020", published_ts: 5000, categories: ["cs.LO", "cs.PL"] });
    const b = makeArticle({ id: "2507.00021", published_ts: 5000, categories: ["cs.CV"] });
    await upsertArticles(env.DB, [a, b]);

    const rows = await getByWindow(env.DB, 0, ["cs.PL"]);
    expect(rows.map((r) => r.id)).toEqual(["2507.00020"]);
  });

  it("getByIds preserves input id order", async () => {
    const a = makeArticle({ id: "2507.00030" });
    const b = makeArticle({ id: "2507.00031" });
    const c = makeArticle({ id: "2507.00032" });
    await upsertArticles(env.DB, [a, b, c]);

    const rows = await getByIds(env.DB, ["2507.00032", "2507.00030", "2507.00031"]);
    expect(rows.map((r) => r.id)).toEqual(["2507.00032", "2507.00030", "2507.00031"]);
  });

  it("purgeOlderThan deletes rows before the given timestamp", async () => {
    const old = makeArticle({ id: "2507.00040", published_ts: 100 });
    const recent = makeArticle({ id: "2507.00041", published_ts: 9999 });
    await upsertArticles(env.DB, [old, recent]);

    await purgeOlderThan(env.DB, 5000);

    const rows = await getByIds(env.DB, ["2507.00040", "2507.00041"]);
    expect(rows.map((r) => r.id)).toEqual(["2507.00041"]);
  });

  it("getUnembedded returns only embedded=0 rows, newest first, and markEmbedded flips them", async () => {
    const a = makeArticle({ id: "2507.00050", published_ts: 100 });
    const b = makeArticle({ id: "2507.00051", published_ts: 200 });
    await upsertArticles(env.DB, [a, b]);

    let unembedded = await getUnembedded(env.DB, 10);
    expect(unembedded.map((r) => r.id)).toEqual(["2507.00051", "2507.00050"]);

    await markEmbedded(env.DB, ["2507.00051"]);

    unembedded = await getUnembedded(env.DB, 10);
    expect(unembedded.map((r) => r.id)).toEqual(["2507.00050"]);
  });
});
