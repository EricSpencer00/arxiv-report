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
  attribution: string;
}
