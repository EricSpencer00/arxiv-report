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
