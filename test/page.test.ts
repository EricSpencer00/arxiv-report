import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { ARXIV_SUBJECTS, ALL_INTERESTS, DEFAULT_INTERESTS } from "../src/taxonomy";

describe("landing page", () => {
  it("GET / returns 200 HTML with attribution, papers link, and agent prompt marker", async () => {
    const res = await SELF.fetch("https://x/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");

    const body = await res.text();
    expect(body).toContain("Thank you to arXiv for use of its open access interoperability.");
    expect(body).toContain("/api/papers?interests=");
    expect(body).toContain("You now have access to the arxiv-report API");
  });

  it("renders the interest tag-list input with a featured suggestion row", async () => {
    const res = await SELF.fetch("https://x/");
    const body = await res.text();

    // Tag-input container and its text field
    expect(body).toContain('id="interest-tags"');
    expect(body).toContain('id="interest-input"');

    // The curated featured topics render as clickable suggestion pills
    for (const preset of DEFAULT_INTERESTS) {
      expect(body).toContain(`data-preset="${preset}"`);
    }

    // A "show all" toggle exposes the full taxonomy
    expect(body).toContain('id="presets-toggle"');
    expect(body).toContain('id="presets-all"');
  });

  it("does not emit a backslash-mangled whitespace regex in its inline script", async () => {
    const res = await SELF.fetch("https://x/");
    const body = await res.text();
    // The inline <script> lives inside a template literal, where a raw \s collapses
    // to a literal "s". A /s+/ regex would strip the letter "s" from interest names
    // (e.g. "Genomics" -> "Genomic"). Guard against reintroducing that.
    expect(body).not.toContain("/s+/");
  });

  it("renders the full arXiv taxonomy grouped under field headings", async () => {
    const res = await SELF.fetch("https://x/");
    const body = await res.text();

    // Every field heading renders
    for (const { group } of ARXIV_SUBJECTS) {
      expect(body).toContain(group);
    }

    // Every topic in the taxonomy renders as a clickable pill (cross-field)
    for (const topic of ALL_INTERESTS) {
      expect(body).toContain(`data-preset="${topic}"`);
    }
  });
});
