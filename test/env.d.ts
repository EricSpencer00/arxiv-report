// Ambient declaration merge so `cloudflare:test`'s `env` export (typed as
// `Cloudflare.Env`) type-checks in tests. This mirrors the bindings actually
// present in wrangler.test.jsonc (D1 + KV only -- see vitest.config.ts for why
// AI/Vectorize are excluded from the local test environment). Full app code
// continues to use the explicit `Env` interface from src/types.ts.
import type { Env as AppEnv } from "../src/types";

declare global {
  namespace Cloudflare {
    interface Env extends Pick<AppEnv, "DB" | "CACHE" | "MIN_SCORE" | "DAILY_GEN_CAP" | "CONTACT"> {}
  }
}
