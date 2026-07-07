const ABSTRACT_FALLBACK_LENGTH = 400;

export function truncate(text: string, length: number): string {
  if (text.length <= length) return text;
  return `${text.slice(0, length)}…`;
}

/** Prefer a generated tldr; fall back to the abstract's opening when none exists yet. */
export function effectiveTldr(tldr: string | null, abstract: string): string {
  return tldr ?? truncate(abstract, ABSTRACT_FALLBACK_LENGTH);
}
