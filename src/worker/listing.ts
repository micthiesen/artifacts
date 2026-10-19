// One page of someone's artifact list: active or archived, optionally
// searched, newest first (pins on top). The workspace already reads the whole
// list to work out who can see what, so searching titles costs nothing more;
// contents are searched in the same Durable Object's SQLite, only while
// someone searches. Only the page shown leaves the Durable Object.

export const PAGE_SIZE = 50;
export const QUERY_MAX = 100;

type Listable = { id: string; title: string; description: string; archivedAt: string | null; pinnedAt?: string };

export type Listing<T> = {
  rows: T[];
  /** Matching artifacts in this view (active or archived), across all pages. */
  total: number;
  page: number;
  pages: number;
  /** All active and archived artifacts, ignoring the search: for the archived link and empty states. */
  activeCount: number;
  archivedCount: number;
  q: string;
};

/** The query's words, lowercased, at most a handful. */
export function queryWords(q: string): string[] {
  return [...new Set(q.toLowerCase().split(/\s+/).filter(Boolean))].slice(0, WORDS_MAX);
}
const WORDS_MAX = 8;

/** Which artifacts' files contain a word, when contents are searched too. */
export type InContent = (id: string, word: string) => boolean;

/** Every word of the query must appear in the title, description, (six or more characters of) the id, or (with inContent) the artifact's files. Case-insensitive. */
export function matches(a: Listable, q: string, inContent?: InContent): boolean {
  if (!q) return true;
  const hay = `${a.title}\n${a.description}`.toLowerCase();
  // Ids are random letters and digits, so only a longer piece of one (say, pasted from a link) counts as a match.
  return queryWords(q).every((w) => hay.includes(w) || (w.length >= 6 && a.id.includes(w)) || Boolean(inContent?.(a.id, w)));
}

export function cleanQuery(q: unknown): string {
  return typeof q === "string" ? q.trim().replace(/\s+/g, " ").slice(0, QUERY_MAX) : "";
}

export function listing<T extends Listable>(all: T[], opts: { archived: boolean; q?: unknown; page?: unknown; size?: number; clamp?: boolean; inContent?: InContent }): Listing<T> {
  const q = cleanQuery(opts.q);
  const size = opts.size ?? PAGE_SIZE;
  const archivedCount = all.filter((a) => a.archivedAt).length;
  const view = all.filter((a) => Boolean(a.archivedAt) === opts.archived && matches(a, q, opts.inContent));
  // Archived: most recently archived first. Active: as listed (pins, then newest update).
  if (opts.archived) view.sort((a, b) => b.archivedAt!.localeCompare(a.archivedAt!));
  const pages = Math.max(1, Math.ceil(view.length / size));
  const asked = Number(opts.page);
  // People get the last page for a page past the end; agents paging along get an empty one, so they stop.
  const page = Number.isInteger(asked) && asked >= 1 ? (opts.clamp === false ? asked : Math.min(asked, pages)) : 1;
  return {
    rows: view.slice((page - 1) * size, page * size),
    total: view.length,
    page,
    pages,
    activeCount: all.length - archivedCount,
    archivedCount,
    q,
  };
}
