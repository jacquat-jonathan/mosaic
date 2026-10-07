export type DiffLine = { op: "same" | "add" | "del"; text: string };
export type ReviewDiffLine = DiffLine & { hunk: number | null };

/** Line diff (LCS). Fine for notes; falls back to a whole replace for very large inputs. */
export function diffLines(a: string, b: string): DiffLine[] {
  const x = a.split("\n");
  const y = b.split("\n");
  if (x.length * y.length > 4_000_000) {
    return [...x.map((text) => ({ op: "del" as const, text })), ...y.map((text) => ({ op: "add" as const, text }))];
  }
  const n = x.length;
  const m = y.length;
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      out.push({ op: "same", text: x[i] });
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) out.push({ op: "del", text: x[i++] });
    else out.push({ op: "add", text: y[j++] });
  }
  while (i < n) out.push({ op: "del", text: x[i++] });
  while (j < m) out.push({ op: "add", text: y[j++] });
  return out;
}

/** Labels each contiguous changed region so review can accept changes hunk by hunk. */
export function reviewHunks(a: string, b: string): ReviewDiffLine[] {
  let hunk = -1;
  let changing = false;
  return diffLines(a, b).map((line) => {
    if (line.op === "same") {
      changing = false;
      return { ...line, hunk: null };
    }
    if (!changing) hunk++;
    changing = true;
    return { ...line, hunk };
  });
}

/** Applies only the selected proposed hunks; unselected hunks keep the current text. */
export function acceptHunks(current: string, proposed: string, selected: Set<number>): string {
  const out: string[] = [];
  for (const line of reviewHunks(current, proposed)) {
    if (line.op === "same" || (line.op === "add" && selected.has(line.hunk!)) || (line.op === "del" && !selected.has(line.hunk!))) out.push(line.text);
  }
  return out.join("\n");
}
