export interface NormalizedQuery {
  interests: string[];
  days: number;
  max: number;
  min_score: number;
  categories: string[];
  format: string;
}

export interface NormalizedQueryError {
  error: string;
}

const MAX_INTERESTS = 5;
const MAX_INTEREST_LENGTH = 100;

function clampInt(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

function clampFloat(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function normalizeQuery(
  params: URLSearchParams,
  defaultMinScore: number
): NormalizedQuery | NormalizedQueryError {
  const interestsRaw = params.get("interests");
  if (!interestsRaw) {
    return { error: "interests is required" };
  }

  const interests = Array.from(
    new Set(
      interestsRaw
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s.length > 0)
    )
  ).sort();

  if (interests.length === 0) {
    return { error: "interests is required" };
  }
  if (interests.length > MAX_INTERESTS) {
    return { error: `too many interests: max ${MAX_INTERESTS}` };
  }
  if (interests.some((i) => i.length > MAX_INTEREST_LENGTH)) {
    return { error: `each interest must be at most ${MAX_INTEREST_LENGTH} characters` };
  }

  const daysRaw = params.get("days");
  const days = clampInt(daysRaw !== null ? Number(daysRaw) : 7, 1, 30);

  const maxRaw = params.get("max");
  const max = clampInt(maxRaw !== null ? Number(maxRaw) : 10, 1, 10);

  const minScoreRaw = params.get("min_score");
  const min_score = clampFloat(
    minScoreRaw !== null ? Number(minScoreRaw) : defaultMinScore,
    0,
    1
  );

  const categoriesRaw = params.get("categories");
  const categories = categoriesRaw
    ? Array.from(
        new Map(
          categoriesRaw
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0)
            .map((s) => [s.toLowerCase(), s] as const)
        ).values()
      ).sort((a, b) => a.localeCompare(b))
    : [];

  const formatRaw = (params.get("format") ?? "json").toLowerCase();
  const format = formatRaw === "md" ? "md" : "json";

  return { interests, days, max, min_score, categories, format };
}

export function cacheKeyFor(normalized: NormalizedQuery, path: string): Request {
  const search = new URLSearchParams();
  search.set("interests", normalized.interests.join(","));
  search.set("days", String(normalized.days));
  search.set("max", String(normalized.max));
  search.set("min_score", String(normalized.min_score));
  search.set("categories", normalized.categories.join(","));
  search.set("format", normalized.format);
  search.sort();

  const url = `https://cache.arxiv-report${path}?${search.toString()}`;
  return new Request(url);
}

export function secondsUntilNextIngest(now: Date): number {
  const target = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 6, 0, 0, 0)
  );
  if (target.getTime() <= now.getTime()) {
    target.setUTCDate(target.getUTCDate() + 1);
  }
  const seconds = Math.round((target.getTime() - now.getTime()) / 1000);
  return Math.min(86400, Math.max(300, seconds));
}

export async function getCached(key: Request): Promise<Response | null> {
  const cache = (caches as unknown as { default: Cache }).default;
  const match = await cache.match(key);
  return match ?? null;
}

export async function putCached(key: Request, response: Response, ttl: number): Promise<void> {
  const cache = (caches as unknown as { default: Cache }).default;
  const cached = new Response(response.body, response);
  cached.headers.set("Cache-Control", `public, max-age=${ttl}`);
  await cache.put(key, cached);
}
