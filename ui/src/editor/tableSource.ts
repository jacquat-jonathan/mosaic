import { StateEffect, StateField } from "@codemirror/state";
import { WidgetType, type EditorView } from "@codemirror/view";
export const editTableSource = StateEffect.define<{ from: number; to: number } | null>();
export const tableSource = StateField.define<{ from: number; to: number } | null>({
  create: () => null,
  update(value, tr) {
    if (value) value = { from: tr.changes.mapPos(value.from, -1), to: tr.changes.mapPos(value.to, 1) };
    for (const effect of tr.effects) if (effect.is(editTableSource)) value = effect.value;
    if (value && tr.selection && (tr.state.selection.main.head < value.from || tr.state.selection.main.head > value.to))
      return null;
    return value;
  },
});
export class TableSourceButton extends WidgetType {
  toDOM(view: EditorView) {
    const button = document.createElement("button");
    button.className = "table-source-back";
    button.textContent = "Back to table";
    button.addEventListener("mousedown", (e) => e.preventDefault());
    button.addEventListener("click", () => {
      view.dispatch({ effects: editTableSource.of(null) });
      view.focus();
    });
    return button;
  }
  ignoreEvent() {
    return true;
  }
}
