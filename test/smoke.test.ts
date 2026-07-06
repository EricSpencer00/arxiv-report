import { SELF } from "cloudflare:test";
import { it, expect } from "vitest";

it("health returns ok", async () => {
  const res = await SELF.fetch("https://x/api/health");
  expect(res.status).toBe(200);
});
