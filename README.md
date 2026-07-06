# arxiv-report

Interest-matched arXiv papers for your AI agent. Free, cached, honest about relevance.

**Live:** https://arxiv-report.stockgenie.workers.dev

A Cloudflare Worker that ingests every new arXiv submission daily (via the official arXiv API), embeds abstracts with a 384-dim model, and serves the top ≤10 papers matching plain-English interests — with a deterministic keyword fallback whenever AI quota is exhausted, so the API never breaks.

## API

```bash
# JSON
curl "https://arxiv-report.stockgenie.workers.dev/api/papers?interests=formal+methods,llm+verification&days=7&max=10"

# Markdown digest (agent/aggregator friendly)
curl "https://arxiv-report.stockgenie.workers.dev/api/digest?interests=formal+methods,llm+verification"
```

| Param | Meaning | Range / default |
|---|---|---|
| `interests` | comma-separated plain-English phrases (required) | ≤5 phrases, ≤100 chars each |
| `days` | lookback window | 1–30, default 7 |
| `max` | max papers returned | 1–10, default 10 |
| `min_score` | relevance threshold | 0–1, default 0.42 |
| `categories` | arXiv category filter, e.g. `cs.LO,cs.PL` | optional |

Responses include per-paper `score`, `tldr`, `relevance_blurb`, `author_notes`, and a `ranking` field (`semantic` or `keyword`) telling you which engine ranked them. Papers below the threshold are **dropped, not padded** — an empty list means nothing relevant appeared, not an error. Full schema: [/api/openapi.json](https://arxiv-report.stockgenie.workers.dev/api/openapi.json). Health: `/api/health`.

Agent integration: the landing page has a copy-paste prompt block that teaches any agent the API in one paste.

## Architecture

- **Ingest:** cron every 2 min (06:00–11:58 UTC); each tick fetches one 100-article page from `export.arxiv.org/api/query` (well under arXiv's 1 req/3s limit), stores rows in D1, embeds with Workers AI `bge-small-en-v1.5` into Vectorize. After the day's pages are done, ticks run maintenance (embed retries, 30-day D1 purge, ~7-day vector prune to stay in the free 5M-dimension budget).
- **Query:** normalize → edge cache (TTL until next ingest) → embed interests → Vectorize top-K per interest → max-merge → threshold → D1 join → lazy enrichment (TL;DR + relevance blurb via Workers AI, capped 50 generations/day; author affiliation via Semantic Scholar) → cache.
- **Fallback:** any Workers AI/Vectorize failure or quota exhaustion → weighted keyword + arXiv-category-affinity scoring over D1. Deterministic, zero inference.

Everything fits Cloudflare's free plan. Bindings: D1 (`DB`), KV (`CACHE`), Vectorize (`VECTORS`, 384 dims cosine + `published_ts` number metadata index), Workers AI (`AI`).

## Development

```bash
npm install
npx vitest run        # 89 tests (vitest-pool-workers, real D1/KV in miniflare)
npx tsc --noEmit
npx wrangler dev
npx wrangler deploy
```

Provisioning (already done for the live instance): `wrangler d1 create arxiv-report`, `wrangler kv namespace create CACHE`, `wrangler vectorize create arxiv-report --dimensions=384 --metric=cosine`, `wrangler vectorize create-metadata-index arxiv-report --property-name=published_ts --type=number`, `wrangler d1 execute arxiv-report --remote --file=schema.sql`, `wrangler secret put ADMIN_SECRET`. Manual ingest tick: `POST /api/admin/ingest` with `Authorization: Bearer $ADMIN_SECRET`.

## arXiv terms of service

Data comes exclusively from the official arXiv API: serial requests spaced minutes apart, descriptive User-Agent, metadata + abstracts only, every link points back to arxiv.org, no PDF rehosting, and responses are aggressively cached so identical queries cost arXiv nothing.

Thank you to arXiv for use of its open access interoperability.

Design docs: [spec](docs/superpowers/specs/2026-07-06-arxiv-report-design.md) · [plan](docs/superpowers/plans/2026-07-06-arxiv-report.md)
