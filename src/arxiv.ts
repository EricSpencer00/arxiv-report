import { XMLParser } from "fast-xml-parser";
import type { Article } from "./types";

const ABS_PREFIX = "http://arxiv.org/abs/";

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/** Format an epoch-seconds timestamp as arXiv's YYYYMMDDHHMM (UTC). */
function formatArxivTimestamp(ts: number): string {
  const d = new Date(ts * 1000);
  const year = d.getUTCFullYear();
  const month = pad2(d.getUTCMonth() + 1);
  const day = pad2(d.getUTCDate());
  const hour = pad2(d.getUTCHours());
  const minute = pad2(d.getUTCMinutes());
  return `${year}${month}${day}${hour}${minute}`;
}

export function buildQueryUrl(
  start: number,
  pageSize: number,
  sinceTs: number,
  untilTs: number = Math.floor(Date.now() / 1000) + 86400
): string {
  // arXiv's API 500s on open-ended ranges like [X TO *]; both bounds must be explicit.
  const since = formatArxivTimestamp(sinceTs);
  const until = formatArxivTimestamp(untilTs);
  return (
    `https://export.arxiv.org/api/query?search_query=submittedDate:[${since}+TO+${until}]` +
    `&start=${start}&max_results=${pageSize}&sortBy=submittedDate&sortOrder=ascending`
  );
}

function toArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function collapseWhitespace(text: string): string {
  return String(text).replace(/\s+/g, " ").trim();
}

/** Strip the "http://arxiv.org/abs/" prefix and version suffix (vN) from an arXiv id URL. */
function stripIdVersion(idUrl: string): string {
  const withoutPrefix = idUrl.startsWith(ABS_PREFIX) ? idUrl.slice(ABS_PREFIX.length) : idUrl;
  return withoutPrefix.replace(/v\d+$/, "");
}

interface AtomLink {
  "@_href"?: string;
  "@_title"?: string;
  "@_rel"?: string;
}

interface AtomCategory {
  "@_term"?: string;
}

interface AtomAuthor {
  name?: string;
}

interface AtomEntry {
  id: string;
  title: string;
  summary: string;
  published: string;
  author?: AtomAuthor | AtomAuthor[];
  category?: AtomCategory | AtomCategory[];
  link?: AtomLink | AtomLink[];
  "arxiv:primary_category"?: { "@_term"?: string };
}

function parseEntry(entry: AtomEntry): Article {
  const id = stripIdVersion(entry.id);
  const title = collapseWhitespace(entry.title);
  const abstract = collapseWhitespace(entry.summary);

  const authors = toArray(entry.author)
    .map((a) => a?.name)
    .filter((n): n is string => Boolean(n));

  const categories = toArray(entry.category)
    .map((c) => c?.["@_term"])
    .filter((t): t is string => Boolean(t));

  const primary_category = entry["arxiv:primary_category"]?.["@_term"] ?? categories[0] ?? "";

  const links = toArray(entry.link);
  const absLink = links.find((l) => l["@_rel"] === "alternate") ?? links.find((l) => l["@_href"]?.includes("/abs/"));
  const abs_url = absLink?.["@_href"] ?? `${ABS_PREFIX}${id}`;

  const pdfLink = links.find((l) => l["@_title"] === "pdf");
  const pdf_url = pdfLink?.["@_href"] ?? abs_url.replace("/abs/", "/pdf/");

  const publishedMs = Date.parse(entry.published);
  const published = new Date(publishedMs).toISOString();
  const published_ts = Math.floor(publishedMs / 1000);

  return {
    id,
    title,
    abstract,
    authors,
    categories,
    primary_category,
    published,
    published_ts,
    abs_url,
    pdf_url,
    tldr: null,
    author_notes: null,
  };
}

export function parseAtom(xml: string): { articles: Article[]; totalResults: number } {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
  });
  const doc = parser.parse(xml);
  const feed = doc.feed ?? {};

  const totalResultsRaw = feed["opensearch:totalResults"];
  const totalResults = Number(
    typeof totalResultsRaw === "object" ? totalResultsRaw["#text"] : totalResultsRaw
  ) || 0;

  const entries = toArray<AtomEntry>(feed.entry);
  const articles = entries.map(parseEntry);

  return { articles, totalResults };
}

export async function fetchPage(
  start: number,
  pageSize: number,
  sinceTs: number,
  contact: string,
  fetchFn: typeof fetch = fetch,
  untilTs?: number
): Promise<{ articles: Article[]; totalResults: number }> {
  const url =
    untilTs !== undefined
      ? buildQueryUrl(start, pageSize, sinceTs, untilTs)
      : buildQueryUrl(start, pageSize, sinceTs);
  const res = await fetchFn(url, {
    headers: {
      "User-Agent": `arxiv-report/1.0 (${contact})`,
    },
  });
  if (!res.ok) {
    throw new Error(`arXiv API request failed: ${res.status} ${res.statusText}`);
  }
  const xml = await res.text();
  return parseAtom(xml);
}
