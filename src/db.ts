import type { Article } from "./types";

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS articles (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, abstract TEXT NOT NULL,
  authors TEXT NOT NULL, categories TEXT NOT NULL, primary_category TEXT NOT NULL,
  published TEXT NOT NULL, published_ts INTEGER NOT NULL,
  abs_url TEXT NOT NULL, pdf_url TEXT NOT NULL,
  tldr TEXT, author_notes TEXT,
  embedded INTEGER NOT NULL DEFAULT 0, ingested_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_articles_published ON articles(published_ts);
CREATE INDEX IF NOT EXISTS idx_articles_embedded ON articles(embedded, published_ts);
`;

interface ArticleRow {
  id: string;
  title: string;
  abstract: string;
  authors: string;
  categories: string;
  primary_category: string;
  published: string;
  published_ts: number;
  abs_url: string;
  pdf_url: string;
  tldr: string | null;
  author_notes: string | null;
  embedded: number;
  ingested_at: number;
}

function rowToArticle(row: ArticleRow): Article {
  return {
    id: row.id,
    title: row.title,
    abstract: row.abstract,
    authors: JSON.parse(row.authors),
    categories: JSON.parse(row.categories),
    primary_category: row.primary_category,
    published: row.published,
    published_ts: row.published_ts,
    abs_url: row.abs_url,
    pdf_url: row.pdf_url,
    tldr: row.tldr,
    author_notes: row.author_notes ? JSON.parse(row.author_notes) : null,
  };
}

export async function applySchema(db: D1Database): Promise<void> {
  const statements = SCHEMA_SQL.split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const stmt of statements) {
    await db.prepare(stmt).run();
  }
}

export async function upsertArticles(db: D1Database, articles: Article[]): Promise<void> {
  if (articles.length === 0) return;
  const now = Math.floor(Date.now() / 1000);
  const stmt = db.prepare(`
    INSERT INTO articles (
      id, title, abstract, authors, categories, primary_category,
      published, published_ts, abs_url, pdf_url,
      tldr, author_notes, embedded, ingested_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, ?)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      abstract = excluded.abstract,
      authors = excluded.authors,
      categories = excluded.categories,
      primary_category = excluded.primary_category,
      published = excluded.published,
      published_ts = excluded.published_ts,
      abs_url = excluded.abs_url,
      pdf_url = excluded.pdf_url
  `);
  const batch = articles.map((a) =>
    stmt.bind(
      a.id,
      a.title,
      a.abstract,
      JSON.stringify(a.authors),
      JSON.stringify(a.categories),
      a.primary_category,
      a.published,
      a.published_ts,
      a.abs_url,
      a.pdf_url,
      now
    )
  );
  await db.batch(batch);
}

export async function getByWindow(
  db: D1Database,
  sinceTs: number,
  categories: string[]
): Promise<Article[]> {
  const { results } = await db
    .prepare("SELECT * FROM articles WHERE published_ts >= ? ORDER BY published_ts DESC")
    .bind(sinceTs)
    .all<ArticleRow>();
  let articles = (results ?? []).map(rowToArticle);
  if (categories.length > 0) {
    const wanted = new Set(categories);
    articles = articles.filter((a) => a.categories.some((c) => wanted.has(c)));
  }
  return articles;
}

export async function getByIds(db: D1Database, ids: string[]): Promise<Article[]> {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  const { results } = await db
    .prepare(`SELECT * FROM articles WHERE id IN (${placeholders})`)
    .bind(...ids)
    .all<ArticleRow>();
  const byId = new Map((results ?? []).map((r) => [r.id, rowToArticle(r)]));
  return ids.map((id) => byId.get(id)).filter((a): a is Article => a !== undefined);
}

export async function markEmbedded(db: D1Database, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const placeholders = ids.map(() => "?").join(",");
  await db
    .prepare(`UPDATE articles SET embedded = 1 WHERE id IN (${placeholders})`)
    .bind(...ids)
    .run();
}

export async function saveTldr(db: D1Database, id: string, tldr: string): Promise<void> {
  await db.prepare("UPDATE articles SET tldr = ? WHERE id = ?").bind(tldr, id).run();
}

export async function saveAuthorNotes(
  db: D1Database,
  id: string,
  notes: Record<string, string>
): Promise<void> {
  await db
    .prepare("UPDATE articles SET author_notes = ? WHERE id = ?")
    .bind(JSON.stringify(notes), id)
    .run();
}

export async function getUnembedded(db: D1Database, limit: number): Promise<Article[]> {
  const { results } = await db
    .prepare("SELECT * FROM articles WHERE embedded = 0 ORDER BY published_ts DESC LIMIT ?")
    .bind(limit)
    .all<ArticleRow>();
  return (results ?? []).map(rowToArticle);
}

export async function purgeOlderThan(db: D1Database, ts: number): Promise<void> {
  await db.prepare("DELETE FROM articles WHERE published_ts < ?").bind(ts).run();
}
