import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

// NOTE on versioning: @cloudflare/vitest-pool-workers >=0.13.0 (required for the
// installed vitest ^4.1.0 per its peerDependencies) dropped the old
// `@cloudflare/vitest-pool-workers/config` subpath and `defineWorkersConfig()`
// helper entirely, replacing them with a Vite plugin, `cloudflareTest()`, used
// via vitest's own `defineConfig`. This is confirmed by the package's own
// `dist/codemods/vitest-v3-to-v4.mjs` jscodeshift codemod, which rewrites
// `defineWorkersConfig({ test: { poolOptions: { workers: X } } })` into
// `defineConfig({ plugins: [cloudflareTest(X)] })`. We follow that target shape
// directly below rather than the older (now-unavailable) API.
//
// NOTE on bindings: Vectorize and Workers AI are not simulatable locally in
// vitest-pool-workers. We point at wrangler.test.jsonc, a copy of
// wrangler.jsonc with the "vectorize" and "ai" bindings removed, so the worker
// under test still boots with real D1 + KV locally. Tasks that need AI/Vectorize
// behavior inject hand-rolled fakes for those bindings directly in test code.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.test.jsonc" },
    }),
  ],
});
