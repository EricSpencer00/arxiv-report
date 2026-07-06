import { SELF } from "cloudflare:test";
import { describe, it, expect } from "vitest";

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
});
