import type { PapersResponse, RankedPaper } from "./types";
import { effectiveTldr } from "./summary";

const MAX_AUTHORS = 6;

function formatAuthors(authors: string[]): string {
  if (authors.length === 0) return "Unknown authors";
  if (authors.length <= MAX_AUTHORS) return authors.join(", ");
  return `${authors.slice(0, MAX_AUTHORS).join(", ")} et al.`;
}

function renderPaper(paper: RankedPaper, index: number): string {
  const lines: string[] = [];
  lines.push(`## ${index + 1}. [${paper.title}](${paper.abs_url})`);
  lines.push(formatAuthors(paper.authors));
  lines.push(`Score: ${paper.score.toFixed(2)} · ${paper.categories.join(", ")}`);
  if (paper.relevance_blurb) {
    lines.push(`_${paper.relevance_blurb}_`);
  }
  lines.push(effectiveTldr(paper.tldr, paper.abstract));
  return lines.join("\n\n");
}

export function renderDigest(response: PapersResponse, requestUrl: string): string {
  const date = response.generated_at.slice(0, 10);
  const parts: string[] = [];

  parts.push(`# arXiv digest — ${date}`);
  parts.push(`_Interests: ${response.query.interests.join(", ")}_`);

  if (response.note) {
    parts.push(response.note);
  }

  for (const [i, paper] of response.papers.entries()) {
    parts.push(renderPaper(paper, i));
  }

  const url = new URL(requestUrl);
  const apiUrl = `${url.origin}/api/papers?${url.searchParams.toString()}`;

  parts.push(`${response.attribution}\n\nAPI: ${apiUrl}`);

  return `${parts.join("\n\n")}\n`;
}
