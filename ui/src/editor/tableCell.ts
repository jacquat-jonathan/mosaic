import { MATH_INLINE_RE, renderInlineMarkdown } from "../markdown";

// Convert the small inline editing surface back into portable Markdown. Untouched cells keep their
// original source; only actual input uses this serializer. Pasted HTML never enters the surface.
const escapeText = (text: string) => text.replace(/\u00a0/g, " ").replace(/([\\*_`~[\]<>])/g, "\\$1");
const marked = (text: string, delimiter: string) => {
  const [, leading, content, trailing] = /^(\s*)([\s\S]*?)(\s*)$/.exec(text)!;
  return content ? `${leading}${delimiter}${content}${delimiter}${trailing}` : text;
};
export function cellMarkdown(cell: HTMLElement): string {
  if (cell.childNodes.length === 1 && cell.firstChild instanceof HTMLBRElement) return "";
  const read = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return escapeText(node.textContent ?? "");
    if (!(node instanceof HTMLElement)) return "";
    if (node.dataset.markdownSource !== undefined) return node.dataset.markdownSource;
    const text = () => [...node.childNodes].map(read).join("");
    const math = node.matches(".katex") ? node.querySelector('annotation[encoding="application/x-tex"]') : null;
    if (math) return `$${math.textContent}$`;
    const target = node.dataset.target;
    if (target !== undefined) {
      const label = node.textContent ?? target;
      return `${node.classList.contains("embed") ? "!" : ""}[[${target}${label === target || label === target.split("/").at(-1) ? "" : `|${label}`}]]`;
    }
    switch (node.tagName) {
      case "B":
      case "STRONG":
        return marked(text(), "**");
      case "I":
      case "EM":
        return marked(text(), "*");
      case "S":
      case "DEL":
      case "STRIKE":
        return marked(text(), "~~");
      case "CODE": {
        const raw = node.textContent ?? "";
        const fence = "`".repeat(Math.max(0, ...[...raw.matchAll(/`+/g)].map((m) => m[0].length)) + 1);
        return `${fence}${raw.includes("`") ? " " : ""}${raw}${raw.includes("`") ? " " : ""}${fence}`;
      }
      case "MARK":
        return marked(text(), "==");
      case "BR":
        return "<br>";
      case "A":
        return `[${text()}](<${(node.getAttribute("href") ?? "").replace(/>/g, "%3E")}>)`;
      case "IMG":
        return `![${node.getAttribute("alt") ?? ""}](<${node.getAttribute("src") ?? ""}>)`;
      case "DIV":
      case "P":
        return `${node.previousSibling ? "<br>" : ""}${text()}`;
      default:
        return text();
    }
  };
  return [...cell.childNodes].map(read).join("");
}

/** Keep inline formula objects intact while adjacent cell text is edited. */
export function renderCellMarkdown(cell: HTMLElement, source: string) {
  cell.innerHTML = renderInlineMarkdown(source);
  const formulas = [...source.matchAll(MATH_INLINE_RE)];
  cell.querySelectorAll<HTMLElement>(".katex").forEach((el, index) => {
    if (formulas[index]) {
      el.dataset.markdownSource = formulas[index][0];
      el.contentEditable = "false";
    }
  });
}
