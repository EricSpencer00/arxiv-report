import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { PRESET_INTERESTS } from "../src/keywords";

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

  it("renders the interest tag-list input and preset suggestion pills", async () => {
    const res = await SELF.fetch("https://x/");
    const body = await res.text();

    // Tag-input container and its text field
    expect(body).toContain('id="interest-tags"');
    expect(body).toContain('id="interest-input"');

    // Every preset topic renders as a clickable suggestion pill
    for (const preset of PRESET_INTERESTS) {
      expect(body).toContain(`data-preset="${preset}"`);
    }
  });
});
