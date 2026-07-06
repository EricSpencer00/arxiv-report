import { describe, it, expect } from "vitest";
import { buildQueryUrl, parseAtom, fetchPage } from "../src/arxiv";
// @ts-expect-error - vite ?raw import, typed via test/env.d.ts
import FIXTURE_XML from "./fixtures/atom-sample.xml?raw";

describe("buildQueryUrl", () => {
  it("builds the exact expected query URL", () => {
    // sinceTs = 2025-07-01T00:00:00Z = 1751328000; untilTs one day later
    const url = buildQueryUrl(0, 100, 1751328000, 1751328000 + 86400);
    expect(url).toBe(
      "https://export.arxiv.org/api/query?search_query=submittedDate:[202507010000+TO+202507020000]&start=0&max_results=100&sortBy=submittedDate&sortOrder=ascending"
    );
  });

  it("reflects start and pageSize in the URL", () => {
    const url = buildQueryUrl(100, 50, 1751328000);
    expect(url).toContain("&start=100&max_results=50&");
  });
});

describe("parseAtom", () => {
  const { articles, totalResults } = parseAtom(FIXTURE_XML);

  it("returns totalResults from opensearch:totalResults", () => {
    expect(totalResults).toBe(3);
  });

  it("returns 3 articles", () => {
    expect(articles).toHaveLength(3);
  });

  it("parses the multi-author multi-category entry", () => {
    const a = articles[0];
    expect(a.id).toBe("2507.01234");
    expect(a.title).toBe("LLM-Guided Formal Verification of Smart Contracts");
    expect(a.abstract).toBe(
      "We present a novel approach that combines large language models with formal methods to verify smart contracts. Our technique reduces manual annotation effort significantly."
    );
    expect(a.authors).toEqual(["Alice Smith", "Bob Jones", "Carol White"]);
    expect(a.categories).toEqual(["cs.LO", "cs.PL", "cs.AI"]);
    expect(a.primary_category).toBe("cs.LO");
    expect(a.abs_url).toBe("http://arxiv.org/abs/2507.01234v1");
    expect(a.pdf_url).toBe("http://arxiv.org/pdf/2507.01234v1");
    expect(a.published).toBe("2025-07-01T12:00:00.000Z");
    expect(a.published_ts).toBe(Math.floor(Date.parse("2025-07-01T12:00:00Z") / 1000));
    expect(a.tldr).toBeNull();
    expect(a.author_notes).toBeNull();
  });

  it("parses the single-author single-category entry", () => {
    const a = articles[1];
    expect(a.id).toBe("2507.05678");
    expect(a.title).toBe("Stellar dynamics in globular clusters");
    expect(a.authors).toEqual(["Dana Lee"]);
    expect(a.categories).toEqual(["astro-ph.GA"]);
    expect(a.primary_category).toBe("astro-ph.GA");
    expect(a.abs_url).toBe("http://arxiv.org/abs/2507.05678v2");
    // no explicit pdf link -> fallback from abs_url
    expect(a.pdf_url).toBe("http://arxiv.org/pdf/2507.05678v2");
  });

  it("collapses whitespace/newlines in LaTeX/unicode title and abstract", () => {
    const a = articles[2];
    expect(a.id).toBe("2507.09999");
    expect(a.title).toBe(
      "On the $\\ell_1$-Norm Minimization Problem for Sparse Recovery in Über-Complete Dictionaries"
    );
    expect(a.abstract).toBe(
      "This paper studies the $\\ell_1$-norm minimization problem for sparse recovery. We show that über-complete dictionaries with unicode characters like café and naïve can still be handled robustly."
    );
    expect(a.authors).toEqual(["Erik Müller"]);
    expect(a.pdf_url).toBe("http://arxiv.org/pdf/2507.09999v1");
  });
});

describe("fetchPage", () => {
  it("sets the User-Agent header and parses the response", async () => {
    let capturedUrl = "";
    let capturedHeaders: HeadersInit | undefined;
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedHeaders = init?.headers;
      return new Response(FIXTURE_XML, { status: 200 });
    }) as typeof fetch;

    const result = await fetchPage(0, 100, 1751328000, "mailto:test@example.com", fakeFetch);

    expect(result.totalResults).toBe(3);
    expect(result.articles).toHaveLength(3);
    expect(capturedUrl).toContain("export.arxiv.org/api/query");
    expect((capturedHeaders as Record<string, string>)["User-Agent"]).toBe(
      "arxiv-report/1.0 (mailto:test@example.com)"
    );
  });

  it("throws on non-200 response", async () => {
    const fakeFetch = (async () => new Response("error", { status: 500 })) as typeof fetch;
    await expect(fetchPage(0, 100, 1751328000, "mailto:test@example.com", fakeFetch)).rejects.toThrow();
  });
});
