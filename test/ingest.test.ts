import { env } from "cloudflare:test";
import { beforeEach, describe, it, expect, vi } from "vitest";
import { ingestTick } from "../src/ingest";
import { applySchema, getByIds } from "../src/db";
import type { Env } from "../src/types";

const STATE_KEY = "ingest:state";

interface AtomEntrySpec {
  id: string;
  title?: string;
  summary?: string;
  published?: string;
  author?: string;
  category?: string;
}

function makeAtomXml(entries: AtomEntrySpec[], totalResults: number): string {
  const entryXml = entries
    .map(
      (e, i) => `
  <entry>
    <id>http://arxiv.org/abs/${e.id}v1</id>
    <updated>${e.published ?? "2026-07-01T00:00:00Z"}</updated>
    <published>${e.published ?? "2026-07-01T00:00:00Z"}</published>
    <title>${e.title ?? `Paper ${i}`}</title>
    <summary>${e.summary ?? `Abstract for paper ${i}`}</summary>
    <author><name>${e.author ?? "Test Author"}</name></author>
    <link href="http://arxiv.org/abs/${e.id}v1" rel="alternate" type="text/html"/>
    <link title="pdf" href="http://arxiv.org/pdf/${e.id}v1" rel="related" type="application/pdf"/>
    <arxiv:primary_category xmlns:arxiv="http://arxiv.org/schemas/atom" term="${e.category ?? "cs.LO"}" scheme="http://arxiv.org/schemas/atom"/>
    <category term="${e.category ?? "cs.LO"}" scheme="http://arxiv.org/schemas/atom"/>
  </entry>`
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:opensearch="http://a9.com/-/spec/opensearch/1.1/" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <opensearch:totalResults>${totalResults}</opensearch:totalResults>
  <opensearch:startIndex>0</opensearch:startIndex>
  <opensearch:itemsPerPage>100</opensearch:itemsPerPage>
${entryXml}
</feed>`;
}

function makePageEntries(count: number, prefix: string, publishedTs: number): AtomEntrySpec[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}.${String(i).padStart(5, "0")}`,
    title: `Paper ${prefix}-${i}`,
    published: new Date(publishedTs * 1000).toISOString(),
  }));
}

function buildEnv(overrides: Partial<Env>): Env {
  return { ...(env as unknown as Env), ...overrides };
}

function fakeAi() {
  return {
    run: vi.fn(async (_m: string, input: { text: string[] }) => ({
      data: input.text.map(() => new Array(384).fill(0)),
    })),
  } as unknown as Ai;
}

function failingAi() {
  return {
    run: vi.fn(async () => {
      throw new Error("AI unavailable");
    }),
  } as unknown as Ai;
}

function fakeVectors() {
  return {
    upsert: vi.fn(async () => ({ mutationId: "x" })),
    query: vi.fn(async () => ({ matches: [] })),
    deleteByIds: vi.fn(async () => ({ mutationId: "x" })),
  } as unknown as VectorizeIndex;
}

const NOW_MS = 1782950400000; // 2026-07-02T00:00:00Z (some fixed "today")
const NOW_SEC = Math.floor(NOW_MS / 1000);

describe("ingestTick", () => {
  beforeEach(async () => {
    await applySchema(env.DB);
    await env.DB.prepare("DELETE FROM articles").run();
    await env.CACHE.delete(STATE_KEY);
  });

  it("pages through totalResults=250 across three ticks, marking done on the last", async () => {
    const testEnv = buildEnv({ AI: fakeAi(), VECTORS: fakeVectors() });

    const fetchFn = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      const startMatch = u.match(/start=(\d+)/);
      const start = startMatch ? Number(startMatch[1]) : 0;
      let count = 100;
      if (start === 200) count = 50;
      const entries = makePageEntries(count, `25${start}`, NOW_SEC - 1000);
      return new Response(makeAtomXml(entries, 250), { status: 200 });
    });

    const r1 = await ingestTick(testEnv, fetchFn, NOW_MS);
    expect(r1).toEqual({ action: "page", count: 100 });
    let state = JSON.parse((await env.CACHE.get(STATE_KEY))!);
    expect(state.start).toBe(100);
    expect(state.done).toBe(false);

    const r2 = await ingestTick(testEnv, fetchFn, NOW_MS);
    expect(r2).toEqual({ action: "page", count: 100 });
    state = JSON.parse((await env.CACHE.get(STATE_KEY))!);
    expect(state.start).toBe(200);
    expect(state.done).toBe(false);

    const r3 = await ingestTick(testEnv, fetchFn, NOW_MS);
    expect(r3).toEqual({ action: "page", count: 50 });
    state = JSON.parse((await env.CACHE.get(STATE_KEY))!);
    expect(state.start).toBe(250);
    expect(state.done).toBe(true);

    const r4 = await ingestTick(testEnv, fetchFn, NOW_MS);
    expect(r4.action).toBe("maintenance");
  });

  it("stores fetched articles in D1", async () => {
    const testEnv = buildEnv({ AI: fakeAi(), VECTORS: fakeVectors() });
    const fetchFn = vi.fn(async () => {
      const entries = makePageEntries(2, "26000", NOW_SEC - 1000);
      return new Response(makeAtomXml(entries, 2), { status: 200 });
    });

    await ingestTick(testEnv, fetchFn, NOW_MS);

    const stored = await getByIds(testEnv.DB, ["26000.00000", "26000.00001"]);
    expect(stored).toHaveLength(2);
  });

  it("on fetch error, leaves KV state unchanged and rethrows", async () => {
    const testEnv = buildEnv({ AI: fakeAi(), VECTORS: fakeVectors() });
    const fetchFn = vi.fn(async () => new Response("boom", { status: 500 }));

    await expect(ingestTick(testEnv, fetchFn, NOW_MS)).rejects.toThrow();
    const state = await env.CACHE.get(STATE_KEY);
    expect(state).toBeNull();
  });

  it("on fetch error mid-run, does not advance an existing cursor", async () => {
    const testEnv = buildEnv({ AI: fakeAi(), VECTORS: fakeVectors() });
    const goodFetch = vi.fn(async () => {
      const entries = makePageEntries(100, "27000", NOW_SEC - 1000);
      return new Response(makeAtomXml(entries, 250), { status: 200 });
    });
    await ingestTick(testEnv, goodFetch, NOW_MS);
    const stateBefore = await env.CACHE.get(STATE_KEY);

    const badFetch = vi.fn(async () => new Response("boom", { status: 500 }));
    await expect(ingestTick(testEnv, badFetch, NOW_MS)).rejects.toThrow();

    const stateAfter = await env.CACHE.get(STATE_KEY);
    expect(stateAfter).toBe(stateBefore);
  });

  it("date rollover resets state and pages again", async () => {
    const testEnv = buildEnv({ AI: fakeAi(), VECTORS: fakeVectors() });
    const fetchFn = vi.fn(async () => {
      const entries = makePageEntries(5, "28000", NOW_SEC - 1000);
      return new Response(makeAtomXml(entries, 5), { status: 200 });
    });

    const r1 = await ingestTick(testEnv, fetchFn, NOW_MS);
    expect(r1).toEqual({ action: "page", count: 5 });
    let state = JSON.parse((await env.CACHE.get(STATE_KEY))!);
    expect(state.done).toBe(true);

    const nextDayMs = NOW_MS + 2 * 86400 * 1000;
    const r2 = await ingestTick(testEnv, fetchFn, nextDayMs);
    expect(r2).toEqual({ action: "page", count: 5 });
    state = JSON.parse((await env.CACHE.get(STATE_KEY))!);
    expect(state.start).toBe(5);
  });

  it("embed failure during a page leaves articles stored with embedded=0 and does not throw", async () => {
    const testEnv = buildEnv({ AI: failingAi(), VECTORS: fakeVectors() });
    const fetchFn = vi.fn(async () => {
      const entries = makePageEntries(2, "29000", NOW_SEC - 1000);
      return new Response(makeAtomXml(entries, 2), { status: 200 });
    });

    const result = await ingestTick(testEnv, fetchFn, NOW_MS);
    expect(result).toEqual({ action: "page", count: 2 });

    const rows = await env.DB.prepare("SELECT embedded FROM articles WHERE id IN (?, ?)")
      .bind("29000.00000", "29000.00001")
      .all<{ embedded: number }>();
    expect(rows.results?.every((r) => r.embedded === 0)).toBe(true);
  });

  it("maintenance mode embeds unembedded rows, purges old rows, and prunes vectors", async () => {
    const testEnv = buildEnv({ AI: fakeAi(), VECTORS: fakeVectors() });
    await env.CACHE.put(
      STATE_KEY,
      JSON.stringify({
        date: new Date(NOW_MS).toISOString().slice(0, 10),
        start: 0,
        sinceTs: NOW_SEC - 2 * 86400,
        done: true,
        total: 0,
      })
    );

    // insert an old unembedded row directly
    await env.DB
      .prepare(
        `INSERT INTO articles (id, title, abstract, authors, categories, primary_category, published, published_ts, abs_url, pdf_url, tldr, author_notes, embedded, ingested_at)
         VALUES ('old1', 't', 'a', '[]', '[]', 'cs.LO', '2020-01-01T00:00:00Z', ?, 'u', 'u', NULL, NULL, 0, ?)`
      )
      .bind(NOW_SEC - 40 * 86400, NOW_SEC)
      .run();

    const result = await ingestTick(testEnv, vi.fn(), NOW_MS);
    expect(result).toEqual({ action: "maintenance" });

    const remaining = await env.DB.prepare("SELECT id FROM articles WHERE id = 'old1'").all();
    expect(remaining.results).toHaveLength(0);
  });
});
