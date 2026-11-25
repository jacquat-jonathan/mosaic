// The smallest set of edits that turns one text into another, so a reload from disk (an agent or a
// sync writing the note) changes only what changed: the caret, selection, scroll position, open
// widgets and the user's undo history map through it instead of being reset.
//
// Lines are compared first; each changed run of lines is then compared word by word, so an outside
// edit next to text the user typed leaves that text (and its undo step) alone.

export interface TextChange {
  from: number;
  to: number;
  insert: string;
}

/** Above this many tokens × tokens, a stretch is replaced as a whole instead of diffed. */
const MAX_CELLS = 4_000_000;

/** Lines with their trailing newline, so joining them gives back the text exactly. */
const linesOf = (text: string) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
/** Words, runs of spaces, and single other characters (punctuation, newlines, emoji). */
const wordsOf = (text: string) => text.match(/[\p{L}\p{N}_]+|[ \t]+|[\s\S]/gu) ?? [];

/** Trims the shared start and end off one replaced range. */
function trimmed(a: string, b: string, offset: number): TextChange | null {
  if (a === b) return null;
  let start = 0;
  const max = Math.min(a.length, b.length);
  while (start < max && a.charCodeAt(start) === b.charCodeAt(start)) start++;
  let end = 0;
  while (end < max - start && a.charCodeAt(a.length - 1 - end) === b.charCodeAt(b.length - 1 - end)) end++;
  // Don't split a surrogate pair.
  if (start > 0 && /[\uD800-\uDBFF]/.test(a[start - 1])) start--;
  if (end > 0 && /[\uDC00-\uDFFF]/.test(a[a.length - end])) end--;
  return { from: offset + start, to: offset + a.length - end, insert: b.slice(start, b.length - end) };
}

/**
 * Diffs two token lists (whose joins are the texts) and calls `hunk` for each differing stretch with
 * the removed text, the added text and its offset in the old text.
 */
function diffTokens(
  x: string[],
  y: string[],
  offset: number,
  hunk: (removed: string, added: string, at: number) => void,
) {
  let head = 0;
  while (head < x.length && head < y.length && x[head] === y[head]) offset += x[head++].length;
  let tail = 0;
  while (tail < x.length - head && tail < y.length - head && x[x.length - 1 - tail] === y[y.length - 1 - tail]) tail++;
  const xs = x.slice(head, x.length - tail);
  const ys = y.slice(head, y.length - tail);
  if (!xs.length || !ys.length || xs.length * ys.length > MAX_CELLS) {
    hunk(xs.join(""), ys.join(""), offset);
    return;
  }
  // Longest common subsequence; the gaps between matches are the hunks.
  const n = xs.length,
    m = ys.length,
    w = m + 1;
  const lcs = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i * w + j] =
        xs[i] === ys[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
  let i = 0,
    j = 0,
    pos = offset,
    from = offset,
    removed = "",
    added = "";
  const flush = () => {
    if (removed || added) hunk(removed, added, from);
    removed = added = "";
  };
  while (i < n || j < m) {
    if (i < n && j < m && xs[i] === ys[j]) {
      flush();
      pos += xs[i++].length;
      from = pos;
      j++;
    } else if (j < m && (i >= n || lcs[i * w + j + 1] >= lcs[(i + 1) * w + j])) {
      added += ys[j++];
    } else {
      removed += xs[i];
      pos += xs[i++].length;
    }
  }
  flush();
}

/** Changes, in ascending non-overlapping order and positions of `a`, that turn `a` into `b`. */
export function textChanges(a: string, b: string): TextChange[] {
  const out: TextChange[] = [];
  if (a === b) return out;
  diffTokens(linesOf(a), linesOf(b), 0, (removed, added, at) => {
    if (!removed || !added) {
      const change = trimmed(removed, added, at);
      if (change) out.push(change);
      return;
    }
    diffTokens(wordsOf(removed), wordsOf(added), at, (r, d, offset) => {
      const change = trimmed(r, d, offset);
      if (change) out.push(change);
    });
  });
  return out;
}
