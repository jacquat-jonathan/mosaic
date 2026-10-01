import { Facet } from "@codemirror/state";

/** What editor extensions need from the app, injected per editor instance. */
export interface EditorContext {
  path: string;
  /** Vault path for a link target, or null if unresolved. `markdown` for `[](url)` / `![](url)` links. */
  resolve(target: string, markdown?: boolean): string | null;
  /** Opens a wikilink / markdown link target (creating the note if unresolved). */
  openLink(target: string, newTab: boolean): void;
  openExternal(url: string): void;
  openTag(tag: string): void;
  fileUrl(path: string): Promise<string>;
  readText(path: string): Promise<string>;
  /**
   * Copies files dropped from Finder next to the note and resolves to the text embedding them, or
   * returns null when the drop holds no files (then the editor handles it as usual).
   */
  importDrop(dt: DataTransfer): Promise<string> | null;
  /** Candidates for [[ completion. */
  linkCandidates(): { label: string; detail: string; insert?: string }[];
  /** Turns a ```mermaid block into an editable canvas next to the note (flowcharts, state diagrams). */
  openAsDiagram?(source: string): void;
}

export const editorContext = Facet.define<EditorContext, EditorContext>({
  combine: (values) => values[0],
});
