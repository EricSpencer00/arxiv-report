import { saveAuthorNotes, saveTldr } from "./db";
import type { Env, RankedPaper } from "./types";

export const GEN_MODEL = "@cf/meta/llama-3.1-8b-instruct";

const BUDGET_TTL_SECONDS = 172800; // 2 days
const OPENALEX_TIMEOUT_MS = 3000;

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function budgetKey(): string {
  return `genbudget:${todayUtc()}`;
}

export async function budgetRemaining(kv: KVNamespace, cap: number): Promise<number> {
  const raw = await kv.get(budgetKey());
  const consumed = raw ? Number(raw) || 0 : 0;
  return Math.max(0, cap - consumed);
}

export async function consumeBudget(kv: KVNamespace, n: number): Promise<void> {
  const key = budgetKey();
  const raw = await kv.get(key);
  const consumed = raw ? Number(raw) || 0 : 0;
  await kv.put(key, String(consumed + n), { expirationTtl: BUDGET_TTL_SECONDS });
}

function extractJsonBlock(text: string): unknown | null {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function extractResponseText(raw: unknown): string {
  if (typeof raw === "string") return raw;
  const response = (raw as { response?: unknown })?.response;
  if (typeof response === "string") return response;
  return "";
}

async function generateTldrAndBlurb(
  env: Env,
  paper: RankedPaper,
  interests: string[]
): Promise<{ tldr: string | null; blurb: string | null }> {
  const prompt = `Given this paper for a reader interested in "${interests.join(", ")}", return JSON {"tldr": "<2-3 plain-English sentences>", "why": "<one sentence on why it matches the interests>"}. Title: ${paper.title} Abstract: ${paper.abstract}`;
  try {
    const raw = await env.AI.run(GEN_MODEL as never, { prompt } as never);
    const text = extractResponseText(raw);
    const parsed = extractJsonBlock(text) as { tldr?: unknown; why?: unknown } | null;
    if (!parsed) return { tldr: null, blurb: null };
    const tldr = typeof parsed.tldr === "string" ? parsed.tldr : null;
    const blurb = typeof parsed.why === "string" ? parsed.why : null;
    return { tldr, blurb };
  } catch {
    return { tldr: null, blurb: null };
  }
}

async function generateBlurbOnly(
  env: Env,
  paper: RankedPaper,
  interests: string[]
): Promise<string | null> {
  const prompt = `Given this paper for a reader interested in "${interests.join(", ")}", return JSON {"why": "<one sentence on why it matches the interests>"}. Title: ${paper.title} Abstract: ${paper.abstract}`;
  try {
    const raw = await env.AI.run(GEN_MODEL as never, { prompt } as never);
    const text = extractResponseText(raw);
    const parsed = extractJsonBlock(text) as { why?: unknown } | null;
    if (!parsed) return null;
    return typeof parsed.why === "string" ? parsed.why : null;
  } catch {
    return null;
  }
}

async function fetchAuthorNotes(
  env: Env,
  firstAuthor: string,
  fetchFn: typeof fetch
): Promise<Record<string, string> | null> {
  const mailto = (env.CONTACT ?? "").replace(/^mailto:/, "");
  const url = `https://api.openalex.org/authors?search=${encodeURIComponent(firstAuthor)}&per-page=1&mailto=${encodeURIComponent(mailto)}`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENALEX_TIMEOUT_MS);
  try {
    const res = await fetchFn(url, { signal: controller.signal });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      results?: {
        display_name?: string;
        works_count?: number;
        last_known_institutions?: { display_name?: string }[];
      }[];
    };
    const first = data.results?.[0];
    if (!first) return null;
    const affiliation = first.last_known_institutions?.[0]?.display_name ?? "unknown affiliation";
    const worksCount = first.works_count ?? 0;
    return { [firstAuthor]: `${affiliation} — ${worksCount} works` };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function enrichPapers(
  env: Env,
  papers: RankedPaper[],
  interests: string[],
  fetchFn: typeof fetch = fetch
): Promise<RankedPaper[]> {
  const cap = Number(env.DAILY_GEN_CAP) || 0;

  for (const paper of papers) {
    if (paper.tldr === null) {
      const remaining = await budgetRemaining(env.CACHE, cap);
      if (remaining > 0) {
        const { tldr, blurb } = await generateTldrAndBlurb(env, paper, interests);
        if (tldr !== null) {
          paper.tldr = tldr;
          paper.relevance_blurb = blurb;
          await saveTldr(env.DB, paper.id, tldr);
          await consumeBudget(env.CACHE, 1);
        } else {
          paper.tldr = null;
          paper.relevance_blurb = null;
        }
      } else {
        paper.relevance_blurb = null;
      }
    } else {
      const remaining = await budgetRemaining(env.CACHE, cap);
      if (remaining > 0) {
        const blurb = await generateBlurbOnly(env, paper, interests);
        paper.relevance_blurb = blurb;
        if (blurb !== null) {
          await consumeBudget(env.CACHE, 1);
        }
      } else {
        paper.relevance_blurb = null;
      }
    }

    if (paper.author_notes === null) {
      const firstAuthor = paper.authors[0];
      if (firstAuthor) {
        const notes = await fetchAuthorNotes(env, firstAuthor, fetchFn);
        if (notes) {
          paper.author_notes = notes;
          await saveAuthorNotes(env.DB, paper.id, notes);
        }
      }
    }
  }

  return papers;
}
