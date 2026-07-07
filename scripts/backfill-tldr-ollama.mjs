#!/usr/bin/env node
// Backfills articles.tldr via a local Ollama model instead of Workers AI, bypassing
// the DAILY_GEN_CAP cloud budget. Run whenever /api/health shows a large tldr backlog
// (e.g. after launch, or after a burst of cache-consuming traffic exhausts the daily cap).
// Usage: node scripts/backfill-tldr-ollama.mjs [--days=14] [--model=llama3.1:8b] [--limit=0]

import { execSync } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  })
);

const DB_NAME = "arxiv-report";
const OLLAMA_URL = "http://localhost:11434/api/generate";
const MODEL = args.model || "llama3.1:8b";
const WINDOW_DAYS = Number(args.days) || 14;
const LIMIT = Number(args.limit) || 0; // 0 = no limit
const BATCH_SIZE = 100;

function d1Query(sql) {
  const out = execSync(
    `npx wrangler d1 execute ${DB_NAME} --remote --json --command ${JSON.stringify(sql)}`,
    { maxBuffer: 1024 * 1024 * 100 }
  );
  return JSON.parse(out.toString())[0].results;
}

function sqlEscape(s) {
  return s.replace(/'/g, "''");
}

function flushBatch(statements) {
  if (!statements.length) return;
  const file = join(tmpdir(), `tldr-batch-${Date.now()}.sql`);
  writeFileSync(file, statements.join("\n"));
  try {
    execSync(`npx wrangler d1 execute ${DB_NAME} --remote --file=${file}`, {
      stdio: "inherit",
      maxBuffer: 1024 * 1024 * 100,
    });
  } finally {
    unlinkSync(file);
  }
}

async function generateTldr(title, abstract) {
  const prompt = `Given this paper, return a single valid JSON object {"tldr": "<2-3 plain-English sentences summarizing what the paper does, no jargon dump>"} and nothing else.\nTitle: ${title}\nAbstract: ${abstract}`;
  try {
    const res = await fetch(OLLAMA_URL, {
      method: "POST",
      body: JSON.stringify({ model: MODEL, prompt, stream: false, format: "json" }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const parsed = JSON.parse(data.response);
    const tldr = typeof parsed.tldr === "string" ? parsed.tldr.trim() : null;
    return tldr && tldr.length > 0 ? tldr : null;
  } catch (err) {
    console.error("  generation failed:", err instanceof Error ? err.message : String(err));
    return null;
  }
}

async function main() {
  console.log(`Model: ${MODEL} | window: last ${WINDOW_DAYS} days | limit: ${LIMIT || "none"}`);
  console.log("Fetching rows missing tldr from remote D1...");

  const limitClause = LIMIT > 0 ? `LIMIT ${LIMIT}` : "";
  const rows = d1Query(
    `SELECT id, title, abstract FROM articles WHERE tldr IS NULL AND embedded = 1 AND published_ts > (strftime('%s','now') - ${WINDOW_DAYS}*86400) ORDER BY published_ts DESC ${limitClause}`
  );
  console.log(`Found ${rows.length} papers to backfill.\n`);

  let batch = [];
  let done = 0;
  let failed = 0;
  const start = Date.now();

  for (const row of rows) {
    const tldr = await generateTldr(row.title, row.abstract);
    if (tldr) {
      batch.push(`UPDATE articles SET tldr = '${sqlEscape(tldr)}' WHERE id = '${sqlEscape(row.id)}';`);
    } else {
      failed++;
    }
    done++;

    if (batch.length >= BATCH_SIZE) {
      flushBatch(batch);
      batch = [];
    }

    if (done % 25 === 0 || done === rows.length) {
      const elapsed = ((Date.now() - start) / 1000).toFixed(0);
      console.log(`[${elapsed}s] ${done}/${rows.length} processed (${failed} failed)`);
    }
  }

  flushBatch(batch);

  const elapsed = ((Date.now() - start) / 1000).toFixed(0);
  console.log(`\nDone in ${elapsed}s. ${done - failed} succeeded, ${failed} failed.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
