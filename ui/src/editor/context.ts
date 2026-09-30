import { Facet } from "@codemirror/state";

/** What editor extensions need from the app, injected per editor instance. */
export interface EditorContext {
  path: string;
  /** Vault path for a link target, or null if unresolved. */
  resolve(target: string): string | null;
  /** Opens a wikilink / markdown link target (creating the note if unresolved). */
  openLink(target: string, newTab: boolean): void;
  openExternal(url: string): void;
  fileUrl(path: string): Promise<string>;
  readText(path: string): Promise<string>;
  /** Candidates for [[ completion. */
  linkCandidates(): { label: string; detail: string }[];
}

export const editorContext = Facet.define<EditorContext, EditorContext>({
  combine: (values) => values[0],
});
