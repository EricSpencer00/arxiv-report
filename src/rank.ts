import type { Env, Article, RankingMode } from "./types";
import type { NormalizedQuery } from "./cache";
import { getByIds, getByWindow } from "./db";
import { keywordScore } from "./keywords";
import { embedTexts, querySimilar } from "./vectors";

export interface RankResult {
  mode: RankingMode;
  papers: (Article & { score: number })[];
  note?: string;
}

export function mergeScores(perInterest: { id: string; score: number }[][]): Map<string, number> {
  const merged = new Map<string, number>();
  for (const matches of perInterest) {
    for (const { id, score } of matches) {
      const current = merged.get(id);
      if (current === undefined || score > current) {
        merged.set(id, score);
      }
    }
  }
  return merged;
}

function stableSortByScoreThenPublished<T extends { score: number; published_ts: number }>(items: T[]): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      if (b.item.score !== a.item.score) return b.item.score - a.item.score;
      if (b.item.published_ts !== a.item.published_ts) return b.item.published_ts - a.item.published_ts;
      return a.index - b.index;
    })
    .map(({ item }) => item);
}

function applyCategoryFilter<T extends { categories: string[] }>(articles: T[], categories: string[]): T[] {
  if (categories.length === 0) return articles;
  const wanted = new Set(categories);
  return articles.filter((a) => a.categories.some((c) => wanted.has(c)));
}

async function hasCoverageGap(db: Env["DB"], sinceTs: number): Promise<boolean> {
  const row = await db
    .prepare("SELECT COUNT(*) as c FROM articles WHERE published_ts >= ? AND embedded = 0")
    .bind(sinceTs)
    .first<{ c: number }>();
  return (row?.c ?? 0) >= 1;
}

// Keyword scores live on a different scale than bge-small cosine similarity
// (unrelated abstracts already score ~0.55 semantically, so the semantic default
// is 0.62; a strong keyword match can legitimately score 0.45). When the caller
// left min_score at the server default, use the keyword-appropriate threshold.
const KEYWORD_MIN_SCORE = 0.42;

async function keywordRank(env: Env, q: NormalizedQuery, sinceTs: number): Promise<(Article & { score: number })[]> {
  const usingServerDefault = q.min_score === Number(env.MIN_SCORE);
  const threshold = usingServerDefault ? KEYWORD_MIN_SCORE : q.min_score;
  const articles = await getByWindow(env.DB, sinceTs, q.categories);
  const scored = articles.map((article) => ({ ...article, score: keywordScore(q.interests, article) }));
  const filtered = scored.filter((a) => a.score >= threshold);
  return stableSortByScoreThenPublished(filtered).slice(0, q.max);
}

export async function rank(env: Env, q: NormalizedQuery, now?: number): Promise<RankResult> {
  const nowTs = now ?? Math.floor(Date.now() / 1000);
  const sinceTs = nowTs - q.days * 86400;

  let semanticPapers: (Article & { score: number })[] | null = null;
  let fallbackReason: string | null = null;

  try {
    const embeddings = await embedTexts(env.AI, q.interests);
    const perInterest = await Promise.all(
      embeddings.map((embedding) => querySimilar(env.VECTORS, embedding, sinceTs, 50))
    );
    const merged = mergeScores(perInterest);
    const idsAboveThreshold = Array.from(merged.entries())
      .filter(([, score]) => score >= q.min_score)
      .sort((a, b) => b[1] - a[1])
      .map(([id]) => id);

    const articles = await getByIds(env.DB, idsAboveThreshold);
    const scoreById = merged;
    const scored = articles.map((article) => ({ ...article, score: scoreById.get(article.id) ?? 0 }));
    const filtered = applyCategoryFilter(scored, q.categories);
    const sorted = stableSortByScoreThenPublished(filtered).slice(0, q.max);

    if (sorted.length === 0 && (await hasCoverageGap(env.DB, sinceTs))) {
      fallbackReason = "semantic ranking unavailable; used keyword matching";
    } else {
      semanticPapers = sorted;
    }
  } catch {
    // EmbedUnavailableError or any Vectorize query failure both fall back to keyword matching.
    fallbackReason = "semantic ranking unavailable; used keyword matching";
  }

  let mode: RankingMode;
  let papers: (Article & { score: number })[];

  if (semanticPapers !== null) {
    mode = "semantic";
    papers = semanticPapers;
  } else {
    mode = "keyword";
    papers = await keywordRank(env, q, sinceTs);
  }

  const notes: string[] = [];
  if (fallbackReason) {
    notes.push(fallbackReason);
  }
  if (papers.length < q.max) {
    notes.push(`only ${papers.length} papers cleared your relevance bar in the last ${q.days} days`);
  }

  const result: RankResult = { mode, papers };
  if (notes.length > 0) {
    result.note = notes.join("; ");
  }
  return result;
}
