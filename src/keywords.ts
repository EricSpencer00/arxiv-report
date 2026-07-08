const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "of",
  "for",
  "with",
  "in",
  "on",
  "to",
  "using",
  "via",
  "based",
]);

// Small static affinity map: interest term -> arXiv categories it implies
export const CATEGORY_AFFINITY: Record<string, string[]> = {
  "formal methods": ["cs.LO", "cs.PL", "cs.SE"],
  verification: ["cs.LO", "cs.PL", "cs.SE"],
  "theorem proving": ["cs.LO"],
  "model checking": ["cs.LO"],
  "type theory": ["cs.LO", "cs.PL"],
  llm: ["cs.CL", "cs.AI", "cs.LG"],
  "language model": ["cs.CL", "cs.AI", "cs.LG"],
  "machine learning": ["cs.LG", "stat.ML"],
  "reinforcement learning": ["cs.LG", "cs.AI"],
  "computer vision": ["cs.CV"],
  nlp: ["cs.CL"],
  robotics: ["cs.RO"],
  security: ["cs.CR"],
  cryptography: ["cs.CR"],
  systems: ["cs.OS", "cs.DC"],
  databases: ["cs.DB"],
  quantum: ["quant-ph"],
  compilers: ["cs.PL"],
};

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((tok) => tok.length >= 3 && !STOPWORDS.has(tok));
}

interface ScoredArticle {
  title: string;
  abstract: string;
  categories: string[];
}

function affinityCategoriesFor(phrase: string): Set<string> {
  const lowerPhrase = phrase.toLowerCase();
  const categories = new Set<string>();
  for (const [key, cats] of Object.entries(CATEGORY_AFFINITY)) {
    if (lowerPhrase === key || lowerPhrase.includes(key)) {
      for (const c of cats) categories.add(c);
    }
  }
  return categories;
}

function scoreForPhrase(phrase: string, article: ScoredArticle): number {
  const lowerTitle = article.title.toLowerCase();
  const lowerAbstract = article.abstract.toLowerCase();
  const lowerPhrase = phrase.toLowerCase();

  let base: number;
  if (lowerTitle.includes(lowerPhrase)) {
    base = 1.0;
  } else if (lowerAbstract.includes(lowerPhrase)) {
    base = 0.6;
  } else {
    const tokens = Array.from(new Set(tokenize(phrase)));
    if (tokens.length === 0) {
      base = 0;
    } else {
      const titleTokens = new Set(tokenize(article.title));
      const abstractTokens = new Set(tokenize(article.abstract));
      const titleHits = tokens.filter((t) => titleTokens.has(t)).length;
      const abstractHits = tokens.filter((t) => abstractTokens.has(t)).length;
      base = (3 * titleHits + abstractHits) / (4 * tokens.length);
    }
  }

  const affinityCategories = affinityCategoriesFor(phrase);
  const hasAffinityMatch = article.categories.some((c) => affinityCategories.has(c));
  const bonus = hasAffinityMatch ? 0.15 : 0;

  return base + bonus;
}

export function keywordScore(interests: string[], article: ScoredArticle): number {
  let max = 0;
  for (const phrase of interests) {
    const score = scoreForPhrase(phrase, article);
    if (score > max) max = score;
  }
  return Math.max(0, Math.min(1, max));
}
