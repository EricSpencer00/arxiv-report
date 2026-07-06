# arxiv-report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A free-tier Cloudflare Worker that ingests all new arXiv papers daily, semantically matches them to caller-supplied interests (keyword fallback when AI quota is out), and serves top-≤10 results as JSON/Markdown plus a self-serve docs page.

**Architecture:** One TypeScript Worker (Hono). Incremental cron ingest (one arXiv API page per invocation, KV cursor) → D1 rows + Vectorize 384-dim embeddings. Request path: normalize query → Cache API → semantic rank (embed interests, Vectorize query, threshold) with deterministic keyword fallback → lazy enrichment (TL;DR, blurbs, OpenAlex author notes, daily-capped) → cached response.

**Tech Stack:** TypeScript, Hono, fast-xml-parser, Cloudflare Workers + D1 + Vectorize + Workers AI (`@cf/baai/bge-small-en-v1.5`, `@cf/meta/llama-3.1-8b-instruct`) + KV + Cron Triggers, Vitest with `@cloudflare/vitest-pool-workers`.

**Spec:** `docs/superpowers/specs/2026-07-06-arxiv-report-design.md` — read it first. Hard constraints: $0 hosting, minimal inference, keyword fallback mandatory, arXiv ToS compliance (official API only, ≥3s between requests, attribution, no PDF rehosting).

---

## File structure

```
package.json, tsconfig.json, wrangler.jsonc, vitest.config.ts, schema.sql
src/types.ts        — Env bindings, Article, RankedPaper, ApiResponse types
src/arxiv.ts        — arXiv API URL builder + Atom XML → Article[] parser
src/db.ts           — all D1 SQL (upsert, window select, purge, enrichment writes)
src/keywords.ts     — deterministic keyword scorer + category affinity map
src/vectors.ts      — Workers AI embed + Vectorize upsert/query/prune wrappers
src/rank.ts         — orchestrates semantic path, fallback decision, threshold, merge
src/enrich.ts       — lazy TL;DR / blurb / OpenAlex notes with KV daily cap
src/ingest.ts       — incremental cron pipeline (KV cursor state machine)
src/cache.ts        — query normalization + Cache API get/put
src/digest.ts       — Markdown digest renderer
src/openapi.ts      — OpenAPI 3.1 document (plain object)
src/page.ts         — landing page HTML as exported template string
src/api.ts          — Hono routes wiring everything together
src/index.ts        — export default { fetch, scheduled }
test/*.test.ts      — per-module tests; test/fixtures/atom-sample.xml
```

Rules for every task: TDD (failing test → run → implement → pass → commit). Run tests with `npx vitest run <file>`. Commit after each task minimum. All timestamps in epoch **seconds**. arXiv IDs are the bare id (`2507.01234v1` → store base id `2507.01234`, keep version in `abs_url`).

---

### Task 1: Scaffold

**Files:** Create `package.json`, `tsconfig.json`, `vitest.config.ts`, `wrangler.jsonc`, `schema.sql`, `src/index.ts`, `src/types.ts`, `test/smoke.test.ts`, `.gitignore`

- [ ] **Step 1:** `npm init -y` then install: `npm i hono fast-xml-parser && npm i -D typescript wrangler @cloudflare/workers-types @cloudflare/vitest-pool-workers vitest` (pin whatever versions npm resolves; vitest must be a version supported by the installed vitest-pool-workers — check its peerDependencies and align, e.g. `npm i -D vitest@<supported>`).
- [ ] **Step 2:** Write `wrangler.jsonc`:

```jsonc
{
  "name": "arxiv-report",
  "main": "src/index.ts",
  "compatibility_date": "2026-06-01",
  "account_id": "27b63de7643a2b3fdbefe3c7bdbbc610",
  "triggers": { "crons": ["*/2 6-11 * * *"] },
  "observability": { "enabled": true },
  "ai": { "binding": "AI" },
  "d1_databases": [{ "binding": "DB", "database_name": "arxiv-report", "database_id": "PLACEHOLDER_SET_IN_TASK_12" }],
  "kv_namespaces": [{ "binding": "CACHE", "id": "PLACEHOLDER_SET_IN_TASK_12" }],
  "vectorize": [{ "binding": "VECTORS", "index_name": "arxiv-report" }],
  "vars": { "MIN_SCORE": "0.42", "DAILY_GEN_CAP": "50", "CONTACT": "mailto:ericspencer1450@gmail.com" }
}
```

(The two PLACEHOLDER ids are intentionally invalid until Task 12 provisions real resources; local tests use vitest-pool-workers' miniflare bindings and don't need them.)

- [ ] **Step 3:** `src/types.ts`:

```ts
export interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  VECTORS: VectorizeIndex;
  AI: Ai;
  MIN_SCORE: string;
  DAILY_GEN_CAP: string;
  CONTACT: string;
  ADMIN_SECRET?: string;
}

export interface Article {
  id: string;                // "2507.01234"
  title: string;
  abstract: string;
  authors: string[];
  categories: string[];
  primary_category: string;
  published: string;         // ISO 8601
  published_ts: number;      // epoch seconds
  abs_url: string;
  pdf_url: string;
  tldr: string | null;
  author_notes: Record<string, string> | null;
}

export interface RankedPaper extends Article {
  score: number;
  relevance_blurb: string | null;
}

export type RankingMode = "semantic" | "keyword";

export interface PapersResponse {
  query: { interests: string[]; days: number; max: number; min_score: number; categories: string[] };
  ranking: RankingMode;
  generated_at: string;
  note?: string;
  papers: RankedPaper[];
  attribution: string; // "Thank you to arXiv for use of its open access interoperability."
}
```

- [ ] **Step 4:** `schema.sql` (also used by tests):

```sql
CREATE TABLE IF NOT EXISTS articles (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, abstract TEXT NOT NULL,
  authors TEXT NOT NULL, categories TEXT NOT NULL, primary_category TEXT NOT NULL,
  published TEXT NOT NULL, published_ts INTEGER NOT NULL,
  abs_url TEXT NOT NULL, pdf_url TEXT NOT NULL,
  tldr TEXT, author_notes TEXT,
  embedded INTEGER NOT NULL DEFAULT 0, ingested_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_articles_published ON articles(published_ts);
CREATE INDEX IF NOT EXISTS idx_articles_embedded ON articles(embedded, published_ts);
```

- [ ] **Step 5:** Minimal `src/index.ts` (Hono app returning 200 `{ok:true}` on `/api/health`; `export default { fetch: app.fetch, scheduled }` with a no-op scheduled). `vitest.config.ts` per vitest-pool-workers docs, pointing at `wrangler.jsonc`, with `miniflare` d1/kv/vectorize test bindings if the pool requires explicit ids. Smoke test:

```ts
// test/smoke.test.ts
import { SELF } from "cloudflare:test";
import { it, expect } from "vitest";
it("health returns ok", async () => {
  const res = await SELF.fetch("https://x/api/health");
  expect(res.status).toBe(200);
});
```

Note: Vectorize has no local simulator in some vitest-pool-workers versions. If binding fails locally, remove `VECTORS` from the test environment config and inject it as a mocked object in unit tests (Tasks 6–7 already mock it); only D1/KV/AI-mock need to be real-ish in tests.

- [ ] **Step 6:** Run `npx vitest run` → PASS. Also `npx tsc --noEmit` → clean.
- [ ] **Step 7:** Commit: `chore: scaffold worker, bindings, schema`.

### Task 2: D1 layer (`src/db.ts`)

**Files:** Create `src/db.ts`, `test/db.test.ts`

Functions (all take `db: D1Database`):
- `applySchema(db)` — exec `schema.sql` contents (export the SQL as a string constant from `db.ts` so tests can apply it).
- `upsertArticles(db, articles: Article[])` — `INSERT ... ON CONFLICT(id) DO UPDATE SET title/abstract/... (never overwrite tldr/author_notes/embedded)`. Batch with `db.batch()`.
- `getByWindow(db, sinceTs: number, categories: string[])` — rows with `published_ts >= sinceTs`, optional category filter (`categories` JSON stored as text; filter in SQL with `EXISTS` over `json_each(categories)` or post-filter in JS — post-filter is fine at these sizes).
- `getByIds(db, ids: string[])` — preserve input order in JS.
- `markEmbedded(db, ids: string[])`, `saveTldr(db, id, tldr)`, `saveAuthorNotes(db, id, notes)`.
- `getUnembedded(db, limit)` — for embedding retry.
- `purgeOlderThan(db, ts)`.
- Row↔Article mapping helpers (JSON.parse/stringify for authors/categories/author_notes).

- [ ] **Step 1:** Write tests against the real miniflare D1 binding (`env.DB` from `cloudflare:test`): apply schema, upsert 2 articles, upsert same id with changed title + pre-set tldr → title updated, tldr preserved; window query excludes old rows; purge removes them. Run → FAIL.
- [ ] **Step 2:** Implement, run → PASS, `npx tsc --noEmit`, commit `feat: d1 article store`.

### Task 3: arXiv fetch + Atom parsing (`src/arxiv.ts`)

**Files:** Create `src/arxiv.ts`, `test/arxiv.test.ts`, `test/fixtures/atom-sample.xml`

- `buildQueryUrl(start: number, pageSize: number, sinceTs: number): string` → `http://export.arxiv.org/api/query?search_query=submittedDate:[YYYYMMDDHHMM+TO+*]&start=..&max_results=..&sortBy=submittedDate&sortOrder=ascending` (format sinceTs as arXiv's `YYYYMMDDHHMM`).
- `parseAtom(xml: string): { articles: Article[]; totalResults: number }` using `fast-xml-parser` (XMLParser with `ignoreAttributes: false`). Per entry: id from `<id>` URL → strip `http://arxiv.org/abs/` and version suffix; title/summary whitespace-collapsed; authors from `<author><name>`; categories from `<category term=...>`; primary from `<arxiv:primary_category>`; `abs_url` = the versioned abs link; `pdf_url` = `<link title="pdf">` href or abs_url with `/abs/`→`/pdf/`; published → ISO + epoch seconds. Handle single-entry and single-author cases (fast-xml-parser returns object, not array — normalize with a `toArray` helper). `tldr`/`author_notes` = null.
- `fetchPage(start, pageSize, sinceTs, contact)` — fetch with `User-Agent: arxiv-report/1.0 (${contact})`; throw on non-200; parse.
- Fixture: hand-write a realistic 3-entry Atom feed (one multi-author multi-category entry, one single-author single-category entry, one entry with LaTeX/unicode + newlines in title/abstract) with real Atom/opensearch/arxiv namespaces copied from arXiv API docs format.

- [ ] **Step 1:** Tests: parse fixture → 3 articles with exact expected fields (assert id stripping, category arrays, whitespace collapse, totalResults). `buildQueryUrl` exact string match. Run → FAIL.
- [ ] **Step 2:** Implement, PASS, commit `feat: arxiv atom client`.

### Task 4: Keyword scorer (`src/keywords.ts`)

**Files:** Create `src/keywords.ts`, `test/keywords.test.ts`

```ts
const STOPWORDS = new Set(["a","an","the","and","or","of","for","with","in","on","to","using","via","based"]);

// Small static affinity map: interest term → arXiv categories it implies
export const CATEGORY_AFFINITY: Record<string, string[]> = {
  "formal methods": ["cs.LO", "cs.PL", "cs.SE"], "verification": ["cs.LO", "cs.PL", "cs.SE"],
  "theorem proving": ["cs.LO"], "model checking": ["cs.LO"], "type theory": ["cs.LO", "cs.PL"],
  "llm": ["cs.CL", "cs.AI", "cs.LG"], "language model": ["cs.CL", "cs.AI", "cs.LG"],
  "machine learning": ["cs.LG", "stat.ML"], "reinforcement learning": ["cs.LG", "cs.AI"],
  "computer vision": ["cs.CV"], "nlp": ["cs.CL"], "robotics": ["cs.RO"],
  "security": ["cs.CR"], "cryptography": ["cs.CR"], "systems": ["cs.OS", "cs.DC"],
  "databases": ["cs.DB"], "quantum": ["quant-ph"], "compilers": ["cs.PL"],
};

export function tokenize(text: string): string[]; // lowercase, split non-alphanum, drop stopwords & len<3
export function keywordScore(interests: string[], article: {title: string; abstract: string; categories: string[]}): number;
```

Scoring: for each interest phrase — exact phrase hit in title = 1.0, in abstract = 0.6; else token overlap: `(3*titleHits + abstractHits) / (4 * tokens.length)` where hits are unique interest-tokens found; category affinity: +0.15 if any affinity category for the phrase intersects article categories. Article score = **max** over interest phrases, clamped to [0,1]. Must be pure and deterministic.

- [ ] **Step 1:** Tests: phrase-in-title beats token overlap; "formal methods LLM" scores a cs.LO paper titled "LLM-Guided Formal Verification of Smart Contracts" above 0.42 and scores an unrelated astro-ph paper ("Stellar dynamics in globular clusters") below 0.1; stopwords ignored; deterministic (same input twice → identical). Run → FAIL.
- [ ] **Step 2:** Implement, PASS, commit `feat: keyword fallback scorer`.

### Task 5: Cache layer (`src/cache.ts`)

**Files:** Create `src/cache.ts`, `test/cache.test.ts`

- `normalizeQuery(params: URLSearchParams): { interests: string[]; days: number; max: number; min_score: number; categories: string[]; format: string } | { error: string }` — `interests` required non-empty (comma-split, trim, lowercase, sort, dedupe, each ≤100 chars, ≤5 interests); `days` int clamp 1–30 default 7; `max` int clamp 1–10 default 10; `min_score` float clamp 0–1 default from caller; `categories` uppercase-normalized sort.
- `cacheKeyFor(normalized, path): Request` — synthetic `https://cache.arxiv-report/{path}?canonical-sorted-params`.
- `secondsUntilNextIngest(now: Date): number` — TTL until 06:00 UTC next day (min 300, max 86400).
- `getCached(key)/putCached(key, response, ttl)` via `caches.default` with `Cache-Control: public, max-age=<ttl>`.

- [ ] **Step 1:** Tests: `interests=LLM, formal methods` and `interests=formal+methods,llm` produce identical cache keys; clamping (`days=90`→30, `max=25`→10, `days=0`→1); missing interests → error. Run → FAIL.
- [ ] **Step 2:** Implement, PASS, commit `feat: query normalization and response cache`.

### Task 6: Embeddings + Vectorize wrappers (`src/vectors.ts`)

**Files:** Create `src/vectors.ts`, `test/vectors.test.ts`

```ts
export const EMBED_MODEL = "@cf/baai/bge-small-en-v1.5"; // 384 dims
export const MAX_VECTORS = 12500;

export async function embedTexts(ai: Ai, texts: string[]): Promise<number[][]>;
// batches of ≤50; response shape { data: number[][] }; throws EmbedUnavailableError on any failure

export async function upsertArticleVectors(vectors: VectorizeIndex, articles: Article[], embeddings: number[][]): Promise<void>;
// id = article.id, metadata = { published_ts, primary_category }

export async function querySimilar(vectors: VectorizeIndex, embedding: number[], sinceTs: number, topK: number):
  Promise<{ id: string; score: number }[]>;
// query with { topK, filter: { published_ts: { $gte: sinceTs } }, returnValues: false, returnMetadata: "none" }

export async function pruneVectors(vectors: VectorizeIndex, db: D1Database): Promise<void>;
// select ids from D1 older than 8 days that are embedded, deleteByIds in batches of 1000, mark embedded=2 ("pruned") in D1
export class EmbedUnavailableError extends Error {}
```

- [ ] **Step 1:** Tests use hand-rolled fakes (`const fakeAi = { run: async () => ({ data: [[...384 zeros]] }) }` and a fake VectorizeIndex recording calls): batching splits 120 texts into 3 calls; AI rejection → EmbedUnavailableError; query passes the $gte filter through. Run → FAIL.
- [ ] **Step 2:** Implement, PASS, commit `feat: embedding + vectorize wrappers`.

### Task 7: Ranking engine (`src/rank.ts`)

**Files:** Create `src/rank.ts`, `test/rank.test.ts`

```ts
export interface RankResult { mode: RankingMode; papers: (Article & { score: number })[]; note?: string }

export async function rank(env: Env, q: NormalizedQuery): Promise<RankResult>;
```

Logic:
1. `sinceTs = now - q.days * 86400`.
2. **Semantic attempt:** `embedTexts(env.AI, q.interests)` → for each interest `querySimilar(topK=50)` → merge maps id→max(score) → drop below `q.min_score` → `getByIds` from D1 → apply category filter if given → sort desc, take `q.max`.
3. **Fallback to keyword** when: embed throws `EmbedUnavailableError`, Vectorize query throws, OR semantic returned 0 papers *and* D1 has ≥1 unembedded article in window (coverage gap). Keyword path: `getByWindow(db, sinceTs, q.categories)` → `keywordScore` each → same threshold (use `q.min_score`, keyword scores share the 0–1 scale) → sort/take.
4. `note` set when: fallback used ("semantic ranking unavailable; used keyword matching"), or results < q.max ("only N papers cleared your relevance bar in the last D days").
5. Separate exported pure function `mergeScores(perInterest: {id:string;score:number}[][]): Map<string, number>` for testability.

- [ ] **Step 1:** Tests with fake env pieces (real miniflare D1 seeded via Task-2 helpers; fake AI/Vectorize): semantic happy path returns threshold-filtered sorted papers; embed failure → keyword mode + note; multi-interest max-merge (paper matching both interests gets the higher score, not sum); threshold-drop leaves note; max clamp respected. Run → FAIL.
- [ ] **Step 2:** Implement, PASS, commit `feat: ranking engine with keyword fallback`.

### Task 8: Lazy enrichment (`src/enrich.ts`)

**Files:** Create `src/enrich.ts`, `test/enrich.test.ts`

```ts
export const GEN_MODEL = "@cf/meta/llama-3.1-8b-instruct";

export async function budgetRemaining(kv: KVNamespace, cap: number): Promise<number>;
export async function consumeBudget(kv: KVNamespace, n: number): Promise<void>;
// KV key `genbudget:YYYY-MM-DD` (UTC), counter as string, TTL 2 days. NOT atomic — acceptable race, cap is soft.

export async function enrichPapers(env: Env, papers: RankedPaper[], interests: string[]): Promise<RankedPaper[]>;
```

`enrichPapers`: for each paper (serially, max 10): if `tldr` null and budget > 0 → one AI.run generating BOTH tldr and blurb in a single JSON-mode prompt: `Given this paper for a reader interested in "${interests.join(", ")}", return JSON {"tldr": "<2-3 plain-English sentences>", "why": "<one sentence on why it matches the interest>"}. Title: ... Abstract: ...` — parse defensively (try/catch, extract first `{...}` block); save tldr to D1; blurb only goes in the response (cached with it). If paper already has tldr but no blurb needed budget too — actually: blurb requires generation, so papers with existing tldr but budget 0 get `relevance_blurb: null`. Any AI failure → both null, continue.
`author_notes`: if null, fetch `https://api.openalex.org/authors?search=<first author>&per-page=1&mailto=<contact>` with 3s timeout via AbortController; store `{ [name]: "affiliation — N works" }` for first author only (keep it cheap); errors → skip silently, don't write.

- [ ] **Step 1:** Tests with fake AI (returns canned JSON), fake fetch for OpenAlex (inject `fetchFn` parameter defaulting to global fetch), real KV binding: budget decrements and blocks at 0; malformed AI JSON → nulls, no throw; tldr persisted to D1; OpenAlex timeout → author_notes stays null. Run → FAIL.
- [ ] **Step 2:** Implement, PASS, commit `feat: lazy capped enrichment`.

### Task 9: Incremental ingest (`src/ingest.ts`)

**Files:** Create `src/ingest.ts`, `test/ingest.test.ts`; Modify `src/index.ts` (wire `scheduled`)

State in KV key `ingest:state`: `{ date: "YYYY-MM-DD", start: number, sinceTs: number, done: boolean, total: number | null }`.

`export async function ingestTick(env: Env, fetchFn = fetch): Promise<{action: string}>`:
1. Load state. If `state.date !== todayUTC`: reset `{date: today, start: 0, sinceTs: now - 2*86400, done: false, total: null}` (48h lookback window; upserts dedupe overlap).
2. If `done`: run maintenance instead — (a) embed retry: `getUnembedded(db, 100)` → embed → upsert vectors → markEmbedded (skip silently on EmbedUnavailableError); (b) `purgeOlderThan(db, now - 30*86400)`; (c) `pruneVectors`. Return `{action:"maintenance"}`.
3. Else fetch ONE page: `fetchPage(state.start, 100, state.sinceTs, env.CONTACT)` → upsert articles → try embed+upsert vectors+markEmbedded (on EmbedUnavailableError leave `embedded=0`) → advance `start += articles.length`; if `start >= totalResults` or page empty → `done = true`. Save state. Return `{action:"page", count}`.
4. Any thrown error: save state unchanged (cursor not advanced) and rethrow — next cron retries the same page.

`scheduled` handler in `index.ts`: `ctx.waitUntil(ingestTick(env))`. Also `POST /api/admin/ingest` (added in Task 10) calls `ingestTick` when `Authorization: Bearer ${env.ADMIN_SECRET}` matches.

- [ ] **Step 1:** Tests (fake fetchFn serving fixture XML with totalResults=250 → 3 ticks: 100, 100, 50+done; 4th tick → maintenance; error on fetch → state.start unchanged; date rollover resets state). Fake AI/Vectorize as in Task 6. Run → FAIL.
- [ ] **Step 2:** Implement + wire scheduled, PASS, commit `feat: incremental cron ingest`.

### Task 10: API routes (`src/api.ts`, `src/digest.ts`, `src/openapi.ts`)

**Files:** Create `src/api.ts`, `src/digest.ts`, `src/openapi.ts`, `test/api.test.ts`; Modify `src/index.ts` (mount routes)

Routes (Hono, CORS `*` on `/api/*`):
- `GET /api/papers`: normalize (400 with `{error}` on bad params, including missing interests) → cache lookup → on miss: `rank` → `enrichPapers` → build `PapersResponse` (attribution string exactly `"Thank you to arXiv for use of its open access interoperability."`) → cache with TTL `secondsUntilNextIngest` → return. Header `X-Cache: HIT|MISS`.
- `GET /api/digest`: same pipeline, `format` forced to markdown; `Content-Type: text/markdown`. `digest.ts` renders: `# arXiv digest — {date}` / `_Interests: ..._` / per paper: `## N. [title](abs_url)` + authors line + score + blurb (italic, if present) + tldr-or-abstract (truncated 500 chars) + categories; footer with attribution + API URL. Digest shares the same cache namespace but distinct path key.
- `GET /api/health`: `{ ok, last_ingest: state.date/done/start, article_count (D1 COUNT), gen_budget_remaining }`.
- `GET /api/openapi.json`: full OpenAPI 3.1 object describing /api/papers, /api/digest, /api/health with all params, enums, response schema matching `PapersResponse` — write it out completely in `openapi.ts`.
- `POST /api/admin/ingest`: 401 unless bearer matches `ADMIN_SECRET`; runs `ingestTick`, returns its result.
- Rate limiting: skip the unsafe ratelimit binding (not needed for launch; caching absorbs load). Note this in the landing page FAQ as "be reasonable".

- [ ] **Step 1:** Contract tests via `SELF.fetch` with seeded D1 + fake-friendly paths: missing interests → 400; bad `days` clamps (assert echoed `query.days === 30` for `days=99`); response shape has all `PapersResponse` keys; second identical request → `X-Cache: HIT`; digest returns markdown containing the attribution; admin without secret → 401; openapi.json parses and lists 3 GET paths. (For AI/Vectorize in integration tests: rank falls back to keyword mode when bindings are absent/failing — assert `ranking: "keyword"` works end-to-end with seeded D1 data. That exercises the fallback guarantee for real.) Run → FAIL.
- [ ] **Step 2:** Implement, PASS, commit `feat: public API routes, digest, openapi`.

### Task 11: Landing page (`src/page.ts`)

**Files:** Create `src/page.ts`, `test/page.test.ts`; Modify `src/api.ts` (route `GET /`)

Single self-contained HTML string (inline CSS, no external assets, dark-friendly, readable typography — this page is the product's front door, make it look deliberately designed, not bootstrap-default). Required sections, in order:
1. **Hero:** name + one-liner ("Interest-matched arXiv papers for your AI agent. Free, cached, honest about relevance.").
2. **How it works:** 3 short steps (daily ingest of all arXiv → semantic matching with similarity threshold → keyword fallback so it never breaks). State plainly: max 10 papers, past 30 days, below-threshold papers are dropped not padded.
3. **Try it:** form (interests text input, days select 1/3/7/14/30, max select) that fetches `/api/papers` client-side with a small inline `<script>` and pretty-prints results (title linked to arxiv.org, score, tldr/blurb when present).
4. **For your agent** — the key section. A `<pre>` copy-paste block (with a copy button) containing exactly this prompt text (interpolate the real deployed origin at render time from the request URL):

```
You now have access to the arxiv-report API for fresh research papers.
Base URL: {ORIGIN}
To get papers: GET {ORIGIN}/api/papers?interests=<comma-separated interest phrases>&days=7&max=10
- interests: required. Plain-English phrases, e.g. "formal methods,LLM verification"
- days: 1-30 lookback window (default 7). max: 1-10 results (default 10)
Response is JSON: papers[] with title, authors, abstract, tldr, relevance_blurb, score (0-1), abs_url.
For a ready-made Markdown digest instead: GET {ORIGIN}/api/digest?interests=...
Papers below the relevance threshold are omitted — an empty list means nothing relevant appeared, not an error.
When the user asks for their research digest, call this API with their stated interests and present the results with links.
```

5. **Snippets:** curl, JS `fetch`, Python `requests` — three tabs or stacked `<pre>` blocks, each hitting `/api/papers` with a formal-methods example.
6. **FAQ/fair use:** free service, aggressively cached (one identical query per day is free for us — please don't bust the cache), data from the official arXiv API, links go to arxiv.org.
7. **Footer:** exact attribution line + link to `/api/openapi.json` + GitHub repo link placeholder text "source" pointing to `https://github.com/EricSpencer00/arxiv-report`.

- [ ] **Step 1:** Test: `GET /` returns 200 HTML containing the attribution string, the string `/api/papers?interests=`, and the agent prompt marker `You now have access to the arxiv-report API`. Run → FAIL.
- [ ] **Step 2:** Implement, PASS, `npx tsc --noEmit`, full `npx vitest run` green, commit `feat: landing page with agent integration block`.

### Task 12: Provision + deploy + smoke (orchestrator-run, needs real Cloudflare account)

**Files:** Modify `wrangler.jsonc` (real ids), Create `README.md`

- [ ] **Step 1:** Provision:

```bash
npx wrangler d1 create arxiv-report                      # → paste database_id into wrangler.jsonc
npx wrangler kv namespace create CACHE                   # → paste id into wrangler.jsonc
npx wrangler vectorize create arxiv-report --dimensions=384 --metric=cosine
npx wrangler vectorize create-metadata-index arxiv-report --property-name=published_ts --type=number
npx wrangler d1 execute arxiv-report --remote --file=schema.sql
npx wrangler secret put ADMIN_SECRET                     # generate: openssl rand -hex 24 (save it)
```

- [ ] **Step 2:** `npx wrangler deploy` → note the workers.dev URL.
- [ ] **Step 3:** Smoke: `curl -X POST -H "Authorization: Bearer $ADMIN_SECRET" https://<url>/api/admin/ingest` repeatedly (≥5s apart, ~10–20 times or until `{action:"maintenance"}`) to backfill the last 48h; then `curl "https://<url>/api/papers?interests=formal+methods+and+large+language+models&days=2"` → expect ≥1 paper with `ranking:"semantic"` and score ≥ 0.42; `curl /api/health` → article_count > 0. Verify `/` renders in a browser.
- [ ] **Step 4:** `README.md`: what it is, the deployed URL, API examples, local dev (`npx wrangler dev`), test (`npx vitest run`), deploy commands, arXiv attribution + ToS notes, free-tier budget table from the spec.
- [ ] **Step 5:** Commit `chore: provision and deploy to espencer2 account`, and note the live URL in the commit body.

---

## Self-review notes

- Spec coverage: ingest (T3/T9), matching+threshold+fallback (T4/T6/T7), lazy capped enrichment + OpenAlex (T8), API+digest+openapi+health+admin (T10), caching (T5/T10), landing page + agent block (T11), ToS (T3 UA + ≥3s-by-design cron spacing + attribution in T10/T11), free-tier fits (incremental ingest, 384 dims, 12.5k vector cap, gen cap 50/day), deploy to espencer2 (T12). Rate-limit binding consciously dropped (T10) — deviation from spec, justified: caching + free-tier request cap make it unnecessary at launch; revisit if abused.
- Types referenced across tasks come from `src/types.ts` (T1) and error class from `src/vectors.ts` (T6). `NormalizedQuery` is the return type of `normalizeQuery` (T5) — export it from `cache.ts`.
