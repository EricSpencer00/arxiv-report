import { describe, it, expect } from "vitest";
import {
  normalizeQuery,
  cacheKeyFor,
  secondsUntilNextIngest,
  getCached,
  putCached,
  type NormalizedQuery,
} from "../src/cache";

function paramsOf(query: string): URLSearchParams {
  return new URLSearchParams(query);
}

describe("normalizeQuery", () => {
  it("produces identical normalized interests regardless of spacing/order/case", () => {
    const a = normalizeQuery(paramsOf("interests=LLM, formal methods"), 0.42);
    const b = normalizeQuery(paramsOf("interests=formal+methods,llm"), 0.42);
    expect("error" in a).toBe(false);
    expect("error" in b).toBe(false);
    expect((a as NormalizedQuery).interests).toEqual((b as NormalizedQuery).interests);
  });

  it("errors when interests is missing", () => {
    const result = normalizeQuery(paramsOf("days=7"), 0.42);
    expect("error" in result).toBe(true);
  });

  it("errors when interests is empty after trimming", () => {
    const result = normalizeQuery(paramsOf("interests=,, ,"), 0.42);
    expect("error" in result).toBe(true);
  });

  it("errors when more than 5 interest phrases are given", () => {
    const result = normalizeQuery(paramsOf("interests=a,b,c,d,e,f"), 0.42);
    expect("error" in result).toBe(true);
  });

  it("clamps days: 90 -> 30, 0 -> 1, default 7", () => {
    const hi = normalizeQuery(paramsOf("interests=llm&days=90"), 0.42) as NormalizedQuery;
    const lo = normalizeQuery(paramsOf("interests=llm&days=0"), 0.42) as NormalizedQuery;
    const def = normalizeQuery(paramsOf("interests=llm"), 0.42) as NormalizedQuery;
    expect(hi.days).toBe(30);
    expect(lo.days).toBe(1);
    expect(def.days).toBe(7);
  });

  it("clamps max: 25 -> 10, default 10", () => {
    const hi = normalizeQuery(paramsOf("interests=llm&max=25"), 0.42) as NormalizedQuery;
    const def = normalizeQuery(paramsOf("interests=llm"), 0.42) as NormalizedQuery;
    expect(hi.max).toBe(10);
    expect(def.max).toBe(10);
  });

  it("clamps min_score to [0,1] and defaults to the caller-provided default", () => {
    const def = normalizeQuery(paramsOf("interests=llm"), 0.42) as NormalizedQuery;
    const hi = normalizeQuery(paramsOf("interests=llm&min_score=5"), 0.42) as NormalizedQuery;
    const lo = normalizeQuery(paramsOf("interests=llm&min_score=-1"), 0.42) as NormalizedQuery;
    expect(def.min_score).toBe(0.42);
    expect(hi.min_score).toBe(1);
    expect(lo.min_score).toBe(0);
  });

  it("normalizes categories case-insensitively, sorted and deduped", () => {
    const result = normalizeQuery(paramsOf("interests=llm&categories=cs.LO, cs.lo, cs.PL"), 0.42) as NormalizedQuery;
    expect(result.categories).toHaveLength(2);
  });

  it("defaults format to json and allows md", () => {
    const def = normalizeQuery(paramsOf("interests=llm"), 0.42) as NormalizedQuery;
    const md = normalizeQuery(paramsOf("interests=llm&format=md"), 0.42) as NormalizedQuery;
    expect(def.format).toBe("json");
    expect(md.format).toBe("md");
  });
});

describe("cacheKeyFor", () => {
  it("produces identical cache key URLs for equivalent queries", () => {
    const a = normalizeQuery(paramsOf("interests=LLM, formal methods"), 0.42) as NormalizedQuery;
    const b = normalizeQuery(paramsOf("interests=formal+methods,llm"), 0.42) as NormalizedQuery;
    const keyA = cacheKeyFor(a, "/api/papers");
    const keyB = cacheKeyFor(b, "/api/papers");
    expect(keyA.url).toBe(keyB.url);
  });

  it("uses the given path in the synthetic URL", () => {
    const q = normalizeQuery(paramsOf("interests=llm"), 0.42) as NormalizedQuery;
    const key = cacheKeyFor(q, "/api/digest");
    expect(key.url).toContain("/api/digest?");
    expect(key.url.startsWith("https://cache.arxiv-report")).toBe(true);
  });
});

describe("secondsUntilNextIngest", () => {
  it("returns seconds until the next 06:00 UTC, clamped to [300, 86400]", () => {
    const before6 = new Date("2026-07-06T03:00:00Z");
    const result = secondsUntilNextIngest(before6);
    expect(result).toBe(3 * 3600);
  });

  it("wraps to the next day when past 06:00 UTC", () => {
    const after6 = new Date("2026-07-06T23:00:00Z");
    const result = secondsUntilNextIngest(after6);
    expect(result).toBe(7 * 3600);
  });

  it("clamps to a minimum of 300 seconds", () => {
    const almostThere = new Date("2026-07-06T05:59:00Z");
    const result = secondsUntilNextIngest(almostThere);
    expect(result).toBeGreaterThanOrEqual(300);
  });

  it("clamps to a maximum of 86400 seconds", () => {
    const exactly6 = new Date("2026-07-06T06:00:00Z");
    const result = secondsUntilNextIngest(exactly6);
    expect(result).toBeLessThanOrEqual(86400);
  });
});

describe("getCached/putCached", () => {
  it("round-trips a response through the cache", async () => {
    const q = normalizeQuery(paramsOf("interests=llm"), 0.42) as NormalizedQuery;
    const key = cacheKeyFor(q, "/api/papers-cache-test-unique");
    const response = new Response(JSON.stringify({ hello: "world" }), {
      headers: { "Content-Type": "application/json" },
    });
    await putCached(key, response, 60);
    const cached = await getCached(key);
    expect(cached).not.toBeNull();
    const body = await cached!.json();
    expect(body).toEqual({ hello: "world" });
  });

  it("returns null on cache miss", async () => {
    const q = normalizeQuery(paramsOf("interests=llm"), 0.42) as NormalizedQuery;
    const key = cacheKeyFor(q, "/api/papers-never-cached-unique-path");
    const cached = await getCached(key);
    expect(cached).toBeNull();
  });
});
