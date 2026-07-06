# arxiv-report — Interest-Matched arXiv Digest API on Cloudflare

**Date:** 2026-07-06
**Status:** Approved by Eric (free-tier hosting required; AI inference minimal; keyword fallback mandatory)

## Purpose

A public, zero-friction API that AI agents (OpenClaw instances, news aggregators, personal assistants) call daily to get the ~10 most relevant new arXiv papers for a stated interest (e.g. "formal methods + LLMs"), from the past week. Relevance over noise: papers below a similarity threshold are dropped, honestly.

## Hard Constraints

1. **$0 hosting.** Everything must fit Cloudflare's free plan (Workers, D1, KV, Vectorize, Workers AI, Cron Triggers). No paid plan, no external paid APIs.
2. **Minimal AI inference.** Embeddings use the small 384-dim model; generative calls (TL;DR, blurbs) happen lazily — only for papers actually served — and are hard-capped per day.
3. **Keyword fallback.** If Workers AI or Vectorize is unavailable or over quota, matching degrades to deterministic keyword + category scoring. The API never 500s because AI quota ran out.
4. **arXiv ToS compliance.** Official API (`export.arxiv.org/api/query`) only; serial requests ≥3s apart; descriptive User-Agent; metadata + abstracts only; all links point to arxiv.org; no PDF rehosting; site displays "Thank you to arXiv for use of its open access interoperability."
5. **Account:** deployed via wrangler to the espencer2@luc.edu Cloudflare account (ID 27b63de7643a2b3fdbefe3c7bdbbc610), on the workers.dev subdomain, worker name `arxiv-report`.

## Architecture

One TypeScript Worker (Hono router) with bindings:

| Binding | Role | Free-tier budget |
|---|---|---|
| D1 `DB` | Article table, 30-day retention (~60k rows max) | 5GB / 100k writes/day — trivial usage |
| Vectorize `VECTORS` | 384-dim abstract embeddings, ~7-day rolling window (~12k vectors ≈ 4.6M of the 5M free stored dims) | Prune oldest-first to stay ≤ 12,500 vectors |
| Workers AI `AI` | `@cf/baai/bge-small-en-v1.5` embeddings; small instruct model for lazy TL;DR/blurbs | 10k neurons/day; generative calls capped (default 50/day, KV counter) |
| KV `CACHE` | Rendered response cache + quota counters + ingest cursor | 1k writes/day limit — cache writes bounded |
| Rate limiter binding | Per-IP limiting on /api routes (~60 req/min) | free |

## Components

### 1. Ingest (Cron Trigger, daily 06:30 UTC)

- Query arXiv API for all submissions since the last ingest cursor (all categories, `sortBy=submittedDate`), paginated 200/page, one request per ≥3s, User-Agent `arxiv-report/1.0 (https://<worker-url>; mailto:ericspencer1450@gmail.com)`.
- Parse Atom XML → upsert D1 rows: `id (arxiv id), title, abstract, authors (JSON), categories (JSON), primary_category, published, updated, abs_url, pdf_url, tldr (nullable), author_notes (nullable JSON), ingested_at`.
- Embed `title + "\n" + abstract` (batched) → Vectorize upsert with metadata `{published_date, primary_category}`.
- If embedding quota is exhausted mid-run: remaining articles are stored in D1 without vectors and flagged; keyword fallback covers them. Next cron retries missing vectors first.
- Purge: D1 rows > 30 days; Vectorize vectors beyond the newest ~12,500 (≈ 7 days).
- Cron budget: ~2000 articles/day ≈ 10 arXiv pages ≈ 30s of polite delays — within Worker cron limits (15 min wall clock).

### 2. Matching engine

`rankArticles(interests: string[], days, max, minScore)`:

- **Semantic path (primary):** embed each interest phrase → Vectorize query topK=50 per interest, filter by date window → merge by max score → apply threshold (default cosine ≥ 0.42, tunable via env var, exposed as `min_score` param) → take top `max`.
- **Keyword path (fallback, and for `days` beyond the vector window):** tokenize interest phrases; score = weighted term hits in title (×3) and abstract (×1) + arXiv category affinity boost (small static map from common interest terms → categories, e.g. "formal methods" → cs.LO/cs.PL/cs.SE); normalize; same threshold semantics. Runs as a D1 query (`LIKE` prefilter) + in-Worker scoring.
- Fallback triggers: Workers AI embed error/quota, Vectorize error, or requested window not covered by vectors. Response always includes `"ranking": "semantic" | "keyword"` and per-paper `score`.
- **Threshold wins over count:** if only 3 papers clear the bar, return 3 with `"note"` explaining it. No padding.

### 3. Lazy enrichment (only for papers being served, cached back into D1)

- **TL;DR:** 2–3 sentence plain-English summary via Workers AI instruct model. Generated once per paper, stored in `tldr`.
- **Relevance blurb:** one sentence on why the paper matches the query. Cached per (paper, normalized-interest) in KV with the response, not in D1.
- **Author backgrounds:** OpenAlex author lookup (free, CC0, polite pool with `mailto`), best-effort: affiliation + works count. Stored in `author_notes`. Skipped silently on error.
- All generative enrichment respects a daily cap (KV counter). Over cap → fields returned as `null`; API still works.

### 4. HTTP API

- `GET /api/papers?interests=formal+methods,LLM+verification&days=7&max=10&min_score=0.42&categories=cs.LO,cs.PL&format=json`
  - `interests` (required, comma-separated phrases), `days` (default 7, clamp 1–30), `max` (default 10, clamp 1–10), `categories` (optional filter), `min_score` optional.
  - Response: `{ query, ranking, generated_at, note?, papers: [{ id, title, authors, author_notes, abstract, tldr, relevance_blurb, score, categories, published, abs_url, pdf_url }], attribution }`.
- `GET /api/digest?interests=...` — same matching, rendered as Markdown (agent/aggregator-friendly daily digest).
- `GET /api/openapi.json` — OpenAPI 3.1 spec.
- `GET /api/health` — ingest freshness, row/vector counts, quota state.
- **Caching:** cache key = normalized (sorted, lowercased) query params; stored via Cache API with TTL until next scheduled ingest. Identical agent queries after the first are pure cache hits.
- CORS: open (`*`). Rate limit: ~60 req/min/IP on /api.

### 5. Web page (`GET /`)

Single static HTML page (embedded in the Worker, no build step beyond bundling):
- What it is, how ranking works (semantic + honest threshold + keyword fallback).
- Live "try it" box hitting `/api/papers`.
- **Agent integration block:** copy-paste prompt ("Paste this into your agent…") that teaches an agent the endpoint, params, and digest format; plus curl / JS / Python snippets and the OpenAPI link.
- arXiv attribution line and link to this repo.

## Error handling

- arXiv API failure mid-ingest: keep what succeeded, persist cursor at last complete page, cron retries next day (or via manual `POST /api/admin/ingest` guarded by a secret).
- Workers AI / Vectorize failure at request time: keyword fallback, never a 5xx for quota reasons.
- OpenAlex failure: `author_notes: null`.
- Empty results: 200 with empty `papers` and explanatory `note`.

## Testing

Vitest + `@cloudflare/vitest-pool-workers` (real workerd runtime):
- Atom XML parsing fixtures (multi-author, cross-listed categories, weird unicode).
- Ranking: threshold enforcement, merge of multi-interest scores, keyword scorer determinism, fallback trigger paths.
- API contract: param clamping, cache-key normalization, CORS, error shapes.
- Ingest: cursor advancement, purge logic (mock D1/Vectorize via vitest-pool-workers bindings).

## Deployment

- `wrangler.jsonc` with account_id pinned; resources created via wrangler (`d1 create`, `vectorize create --dimensions=384 --metric=cosine`, KV namespace).
- Deploy: `npm run deploy` → `https://arxiv-report.<subdomain>.workers.dev`.
- Post-deploy smoke: trigger one manual ingest (admin endpoint), then a real query for "formal methods LLM".

## Out of scope (YAGNI)

Registered user profiles / API keys, webhooks/push, email delivery, PDF/full-text analysis, custom domain, paid-tier anything.
