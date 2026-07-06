import { SELF, env } from "cloudflare:test";
import { beforeAll, describe, it, expect } from "vitest";
import { applySchema, upsertArticles } from "../src/db";
import type { Article } from "../src/types";

function daysAgoTs(days: number): number {
  return Math.floor(Date.now() / 1000) - days * 86400;
}

function makeArticle(overrides: Partial<Article>): Article {
  const ts = overrides.published_ts ?? daysAgoTs(1);
  return {
    id: "0000.00000",
    title: "Untitled",
    abstract: "No abstract.",
    authors: ["Author One"],
    categories: ["cs.LO"],
    primary_category: "cs.LO",
    published: new Date(ts * 1000).toISOString(),
    published_ts: ts,
    abs_url: `https://arxiv.org/abs/${overrides.id ?? "0000.00000"}`,
    pdf_url: `https://arxiv.org/pdf/${overrides.id ?? "0000.00000"}`,
    tldr: null,
    author_notes: null,
    ...overrides,
  };
}

describe("api", () => {
  beforeAll(async () => {
    await applySchema(env.DB);
    await env.DB.prepare("DELETE FROM articles").run();

    const articles: Article[] = [
      makeArticle({
        id: "2507.00001",
        title: "Formal Verification of Large Language Models with Theorem Proving",
        abstract:
          "We present a formal methods approach to verification of LLM reasoning chains using model checking and type theory. Our LLM verification framework applies formal methods to language model outputs.",
        authors: ["Alice Author"],
        categories: ["cs.LO", "cs.PL"],
        primary_category: "cs.LO",
        published_ts: daysAgoTs(1),
      }),
      makeArticle({
        id: "2507.00002",
        title: "LLM-Based Formal Methods for Program Verification",
        abstract:
          "This paper studies formal verification techniques for large language model generated code, using automated theorem proving and model checking to verify LLM outputs.",
        authors: ["Bob Builder", "Carol Coder"],
        categories: ["cs.LO"],
        primary_category: "cs.LO",
        published_ts: daysAgoTs(2),
      }),
      makeArticle({
        id: "2507.00003",
        title: "Observations of a Distant Binary Star System",
        abstract:
          "We report photometric observations of a newly discovered binary star system using ground-based telescopes.",
        authors: ["Dave Astronomer"],
        categories: ["astro-ph.SR"],
        primary_category: "astro-ph.SR",
        published_ts: daysAgoTs(1),
      }),
      makeArticle({
        id: "2507.00004",
        title: "Formal Methods for LLM Verification (Old Paper)",
        abstract: "An older paper about formal methods and llm verification, no longer within the default window.",
        authors: ["Eve Elder"],
        categories: ["cs.LO"],
        primary_category: "cs.LO",
        published_ts: daysAgoTs(45),
      }),
    ];

    await upsertArticles(env.DB, articles);
  });

  it("GET /api/papers without interests returns 400 with error", async () => {
    const res = await SELF.fetch("https://x/api/papers");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBeTruthy();
  });

  it("GET /api/papers with interests returns ranked keyword results", async () => {
    const res = await SELF.fetch(
      "https://x/api/papers?interests=formal+methods+llm+verification&days=7"
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;

    expect(body).toHaveProperty("query");
    expect(body).toHaveProperty("ranking");
    expect(body).toHaveProperty("generated_at");
    expect(body).toHaveProperty("papers");
    expect(body).toHaveProperty("attribution");

    expect(body.ranking).toBe("keyword");
    expect(Array.isArray(body.papers)).toBe(true);
    expect(body.papers.length).toBeGreaterThan(0);

    const ids = body.papers.map((p: any) => p.id);
    expect(ids).not.toContain("2507.00003"); // astro paper excluded
    expect(ids).not.toContain("2507.00004"); // too old

    for (const p of body.papers) {
      expect(p.score).toBeGreaterThanOrEqual(body.query.min_score);
    }

    expect(body.attribution).toBe(
      "Thank you to arXiv for use of its open access interoperability."
    );
  });

  it("clamps days=99 to 30 and max=25 to 10 in echoed query", async () => {
    const res = await SELF.fetch(
      "https://x/api/papers?interests=clamp+test+topic&days=99&max=25"
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.query.days).toBe(30);
    expect(body.query.max).toBe(10);
  });

  it("second identical request is served from cache with X-Cache: HIT", async () => {
    const url = "https://x/api/papers?interests=cache+hit+test+topic&days=7";
    const first = await SELF.fetch(url);
    expect(first.status).toBe(200);
    expect(first.headers.get("X-Cache")).toBe("MISS");

    const second = await SELF.fetch(url);
    expect(second.status).toBe(200);
    expect(second.headers.get("X-Cache")).toBe("HIT");
  });

  it("GET /api/digest returns markdown with attribution and a linked title", async () => {
    const res = await SELF.fetch(
      "https://x/api/digest?interests=formal+methods+llm+digest+topic&days=7"
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    const text = await res.text();
    expect(text).toContain("# arXiv digest");
    expect(text).toContain("Thank you to arXiv for use of its open access interoperability.");
    expect(text).toMatch(/## 1\. \[.+\]\(https:\/\/arxiv\.org\/abs\//);
  });

  it("GET /api/health reports ok, article_count, gen_budget_remaining", async () => {
    const res = await SELF.fetch("https://x/api/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.ok).toBe(true);
    expect(typeof body.article_count).toBe("number");
    expect(body.article_count).toBeGreaterThanOrEqual(4);
    expect(typeof body.gen_budget_remaining).toBe("number");
    expect("last_ingest" in body).toBe(true);
  });

  it("GET /api/openapi.json parses and lists the 3 GET routes", async () => {
    const res = await SELF.fetch("https://x/api/openapi.json");
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.openapi.startsWith("3.1")).toBe(true);
    expect(body.paths).toHaveProperty("/api/papers");
    expect(body.paths).toHaveProperty("/api/digest");
    expect(body.paths).toHaveProperty("/api/health");
  });

  it("POST /api/admin/ingest without auth returns 401", async () => {
    const res = await SELF.fetch("https://x/api/admin/ingest", { method: "POST" });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("unauthorized");
  });

  it("CORS: GET response includes access-control-allow-origin: *", async () => {
    const res = await SELF.fetch(
      "https://x/api/papers?interests=cors+test+topic+unique&days=7"
    );
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});
