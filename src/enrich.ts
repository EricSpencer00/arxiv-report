import { saveAuthorNotes, saveTldr } from "./db";
import type { Env, RankedPaper } from "./types";

// llama-3.1-8b was deprecated by Workers AI on 2026-05-30
export const GEN_MODEL = "@cf/meta/llama-3.2-3b-instruct";

const BUDGET_TTL_SECONDS = 172800; // 2 days
const AUTHOR_LOOKUP_TIMEOUT_MS = 3000;

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
  const obj = raw as {
    response?: unknown;
    choices?: { text?: unknown; message?: { content?: unknown } }[];
  };
  if (typeof obj?.response === "string") return obj.response;
  const choice = obj?.choices?.[0];
  if (typeof choice?.message?.content === "string") return choice.message.content;
  if (typeof choice?.text === "string") return choice.text;
  return "";
}

const JSON_SYSTEM_PROMPT = "You reply with a single valid JSON object and nothing else.";

function genInput(prompt: string): { messages: { role: string; content: string }[]; max_tokens: number } {
  return {
    messages: [
      { role: "system", content: JSON_SYSTEM_PROMPT },
      { role: "user", content: prompt },
    ],
    max_tokens: 300,
  };
}

async function generateTldrAndBlurb(
  env: Env,
  paper: RankedPaper,
  interests: string[]
): Promise<{ tldr: string | null; blurb: string | null }> {
  const prompt = `Given this paper for a reader interested in "${interests.join(", ")}", return JSON {"tldr": "<2-3 plain-English sentences>", "why": "<one sentence on why it matches the interests>"}. Title: ${paper.title} Abstract: ${paper.abstract}`;
  try {
    const raw = await env.AI.run(GEN_MODEL as never, genInput(prompt) as never);
    const text = extractResponseText(raw);
    const parsed = extractJsonBlock(text) as { tldr?: unknown; why?: unknown } | null;
    if (!parsed) return { tldr: null, blurb: null };
    const tldr = typeof parsed.tldr === "string" ? parsed.tldr : null;
    const blurb = typeof parsed.why === "string" ? parsed.why : null;
    return { tldr, blurb };
  } catch (err) {
    console.error("tldr generation failed", err instanceof Error ? err.message : String(err));
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
    const raw = await env.AI.run(GEN_MODEL as never, genInput(prompt) as never);
    const text = extractResponseText(raw);
    const parsed = extractJsonBlock(text) as { why?: unknown } | null;
    if (!parsed) return null;
    return typeof parsed.why === "string" ? parsed.why : null;
  } catch (err) {
    console.error("blurb generation failed", err instanceof Error ? err.message : String(err));
    return null;
  }
}

async function fetchAuthorNotes(
  env: Env,
  firstAuthor: string,
  fetchFn: typeof fetch
): Promise<Record<string, string> | null> {
  // Semantic Scholar Graph API (free, no key). OpenAlex switched to paid credits in 2026.
  const url = `https://api.semanticscholar.org/graph/v1/author/search?query=${encodeURIComponent(firstAuthor)}&fields=name,affiliations,paperCount&limit=1`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AUTHOR_LOOKUP_TIMEOUT_MS);
  try {
    const res = await fetchFn(url, { signal: controller.signal });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      data?: { name?: string; affiliations?: string[]; paperCount?: number }[];
    };
    const first = data.data?.[0];
    if (!first) return null;
    const affiliation = first.affiliations?.[0] ?? "unknown affiliation";
    const worksCount = first.paperCount ?? 0;
    return { [firstAuthor]: `${affiliation} — ${worksCount} papers` };
  } catch (err) {
    console.error("openalex lookup failed", err instanceof Error ? err.message : String(err));
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
