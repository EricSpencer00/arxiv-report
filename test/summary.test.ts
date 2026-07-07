import { describe, it, expect } from "vitest";
import { truncate, effectiveTldr } from "../src/summary";

describe("truncate", () => {
  it("returns text unchanged when under the length", () => {
    expect(truncate("short", 400)).toBe("short");
  });

  it("truncates with an ellipsis when over the length", () => {
    const text = "a".repeat(500);
    const result = truncate(text, 400);
    expect(result).toBe(`${"a".repeat(400)}…`);
  });
});

describe("effectiveTldr", () => {
  it("prefers a real tldr when present", () => {
    expect(effectiveTldr("Real summary.", "The abstract text.")).toBe("Real summary.");
  });

  it("falls back to a truncated abstract when tldr is null", () => {
    const abstract = "b".repeat(500);
    expect(effectiveTldr(null, abstract)).toBe(`${"b".repeat(400)}…`);
  });

  it("falls back to the full abstract when it is short", () => {
    expect(effectiveTldr(null, "Short abstract.")).toBe("Short abstract.");
  });
});
