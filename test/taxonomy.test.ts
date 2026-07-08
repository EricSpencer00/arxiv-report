import { describe, it, expect } from "vitest";
import { ARXIV_SUBJECTS, ALL_INTERESTS, DEFAULT_INTERESTS } from "../src/taxonomy";

describe("ARXIV_SUBJECTS", () => {
  it("covers every arXiv top-level field", () => {
    const groups = ARXIV_SUBJECTS.map((g) => g.group);
    for (const expected of [
      "Computer Science",
      "Economics",
      "Electrical Engineering and Systems Science",
      "Mathematics",
      "Physics",
      "Quantitative Biology",
      "Quantitative Finance",
      "Statistics",
    ]) {
      expect(groups).toContain(expected);
    }
  });

  it("gives every group a non-empty, alphabetically-sorted topic list", () => {
    for (const { group, topics } of ARXIV_SUBJECTS) {
      expect(topics.length, group).toBeGreaterThan(0);
      const sorted = [...topics].sort((a, b) => a.localeCompare(b));
      expect(topics, group).toEqual(sorted);
    }
  });

  it("spans fields beyond computer science", () => {
    // A few authoritative arXiv category names from different archives
    expect(ALL_INTERESTS).toContain("Genomics"); // q-bio.GN
    expect(ALL_INTERESTS).toContain("Number Theory"); // math.NT
    expect(ALL_INTERESTS).toContain("Cosmology and Nongalactic Astrophysics"); // astro-ph.CO
    expect(ALL_INTERESTS).toContain("High Energy Physics - Theory"); // hep-th
    expect(ALL_INTERESTS).toContain("Econometrics"); // econ.EM
    expect(ALL_INTERESTS).toContain("Signal Processing"); // eess.SP
  });
});

describe("ALL_INTERESTS", () => {
  it("is the flattened topic list with no case-insensitive duplicates", () => {
    const flat = ARXIV_SUBJECTS.flatMap((g) => g.topics);
    expect(ALL_INTERESTS).toEqual(flat);
    const lower = ALL_INTERESTS.map((t) => t.toLowerCase());
    expect(new Set(lower).size).toBe(lower.length);
  });

  it("keeps every topic within the API's 100-char per-interest limit", () => {
    for (const t of ALL_INTERESTS) {
      expect(t.length, t).toBeGreaterThan(0);
      expect(t.length, t).toBeLessThanOrEqual(100);
    }
  });

  it("is a broad list — well over 100 topics", () => {
    expect(ALL_INTERESTS.length).toBeGreaterThan(100);
  });
});

describe("DEFAULT_INTERESTS", () => {
  it("is a non-empty, unique subset of the full taxonomy", () => {
    expect(DEFAULT_INTERESTS.length).toBeGreaterThan(0);
    const lower = DEFAULT_INTERESTS.map((t) => t.toLowerCase());
    expect(new Set(lower).size).toBe(lower.length);
    for (const t of DEFAULT_INTERESTS) {
      expect(ALL_INTERESTS, t).toContain(t);
    }
  });

  it("spans multiple fields, not just one", () => {
    const fieldsHit = ARXIV_SUBJECTS.filter((g) =>
      g.topics.some((t) => DEFAULT_INTERESTS.includes(t)),
    ).length;
    expect(fieldsHit).toBeGreaterThanOrEqual(4);
  });
});
