import { describe, it, expect } from "vitest";
import { tokenize, keywordScore, CATEGORY_AFFINITY, PRESET_INTERESTS } from "../src/keywords";

describe("CATEGORY_AFFINITY", () => {
  it("is exported with expected entries", () => {
    expect(CATEGORY_AFFINITY["formal methods"]).toEqual(["cs.LO", "cs.PL", "cs.SE"]);
    expect(CATEGORY_AFFINITY["llm"]).toEqual(["cs.CL", "cs.AI", "cs.LG"]);
  });
});

describe("PRESET_INTERESTS", () => {
  it("is a non-empty list of case-insensitively unique phrases", () => {
    expect(Array.isArray(PRESET_INTERESTS)).toBe(true);
    expect(PRESET_INTERESTS.length).toBeGreaterThan(0);
    const lower = PRESET_INTERESTS.map((p) => p.toLowerCase());
    expect(new Set(lower).size).toBe(lower.length);
  });

  it("keeps every preset within the API's 100-char per-interest limit", () => {
    for (const p of PRESET_INTERESTS) {
      expect(p.length).toBeGreaterThan(0);
      expect(p.length).toBeLessThanOrEqual(100);
    }
  });

  it("only suggests topics the keyword engine actually recognizes", () => {
    const keys = Object.keys(CATEGORY_AFFINITY);
    for (const p of PRESET_INTERESTS) {
      const lower = p.toLowerCase();
      const recognized = keys.some((k) => lower.includes(k));
      expect(recognized, `preset "${p}" matches no CATEGORY_AFFINITY key`).toBe(true);
    }
  });
});

describe("tokenize", () => {
  it("lowercases, splits on non-alphanumeric, drops stopwords and short tokens", () => {
    expect(tokenize("The Formal-Methods and LLMs")).toEqual(["formal", "methods", "llms"]);
  });

  it("drops tokens shorter than 3 chars", () => {
    expect(tokenize("a an ok go llm")).toEqual(["llm"]);
  });
});

describe("keywordScore", () => {
  const llmFormalPaper = {
    title: "LLM-Guided Formal Verification of Smart Contracts",
    abstract:
      "We present a novel approach that combines large language models with formal methods to verify smart contracts.",
    categories: ["cs.LO", "cs.PL", "cs.AI"],
  };

  const astroPaper = {
    title: "Stellar dynamics in globular clusters",
    abstract: "A study of stellar dynamics within dense globular clusters using N-body simulations.",
    categories: ["astro-ph.GA"],
  };

  it("scores exact phrase-in-title higher than token overlap alone", () => {
    const phraseHit = keywordScore(["formal verification"], {
      title: "Formal Verification of Systems",
      abstract: "unrelated content about something else entirely",
      categories: [],
    });
    const tokenOverlapOnly = keywordScore(["formal verification"], {
      title: "Unrelated Title About Nothing",
      abstract: "This mentions formal methods and verification loosely spread apart in a long sentence of filler",
      categories: [],
    });
    expect(phraseHit).toBeGreaterThan(tokenOverlapOnly);
    expect(phraseHit).toBe(1.0);
  });

  it("scores a relevant cs.LO LLM/formal-verification paper above 0.42 for 'formal methods LLM'", () => {
    const score = keywordScore(["formal methods LLM"], llmFormalPaper);
    expect(score).toBeGreaterThan(0.42);
  });

  it("scores an unrelated astro-ph paper below 0.1 for 'formal methods LLM'", () => {
    const score = keywordScore(["formal methods LLM"], astroPaper);
    expect(score).toBeLessThan(0.1);
  });

  it("ignores stopwords in scoring", () => {
    const withStopwords = keywordScore(["the formal methods and the llm"], llmFormalPaper);
    const withoutStopwords = keywordScore(["formal methods llm"], llmFormalPaper);
    expect(withStopwords).toBeCloseTo(withoutStopwords, 5);
  });

  it("is deterministic across repeated calls", () => {
    const a = keywordScore(["formal methods LLM"], llmFormalPaper);
    const b = keywordScore(["formal methods LLM"], llmFormalPaper);
    expect(a).toBe(b);
  });

  it("clamps to [0,1] and takes the max over multiple interest phrases", () => {
    const score = keywordScore(["totally unrelated gibberish zzzqqq", "formal verification"], {
      title: "Formal Verification of Systems",
      abstract: "text",
      categories: [],
    });
    expect(score).toBe(1.0);
    expect(score).toBeLessThanOrEqual(1);
    expect(score).toBeGreaterThanOrEqual(0);
  });
});
