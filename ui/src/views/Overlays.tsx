import { useEffect, useRef } from "react";
import { useUi } from "../state/ui";
import { useVault } from "../state/vault";

export function ContextMenu() {
  const menu = useUi((s) => s.menu);
  const hide = useUi((s) => s.hideMenu);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menu) return;
    const close = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) hide();
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && hide();
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", esc);
    window.addEventListener("blur", hide);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", esc);
      window.removeEventListener("blur", hide);
    };
  }, [menu, hide]);

  if (!menu) return null;
  const x = Math.min(menu.x, window.innerWidth - 220);
  const y = Math.min(menu.y, window.innerHeight - menu.items.length * 30 - 12);
  return (
    <div ref={ref} className="menu" style={{ left: x, top: y }} role="menu">
      {menu.items.map((it, i) =>
        it.separator ? (
          <div key={i} className="menu-sep" />
        ) : (
          <button
            key={i}
            role="menuitem"
            className={it.danger ? "danger" : undefined}
            onClick={() => {
              hide();
              it.action?.();
            }}
          >
            <span>{it.label}</span>
            {it.shortcut && <kbd>{it.shortcut}</kbd>}
          </button>
        ),
      )}
    </div>
  );
}

export function ConfirmDialog() {
  const c = useUi((s) => s.confirm);
  const answer = useUi((s) => s.answer);
  const okRef = useRef<HTMLButtonElement>(null);
  useEffect(() => okRef.current?.focus(), [c]);
  if (!c) return null;
  return (
    <div className="modal-backdrop" onMouseDown={() => answer(false)}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.key === "Escape" && answer(false)}
      >
        <h2>{c.title}</h2>
        <p>{c.body}</p>
        <div className="modal-actions">
          <button onClick={() => answer(false)}>Cancel</button>
          <button ref={okRef} className={c.danger ? "danger primary" : "primary"} onClick={() => answer(true)}>
            {c.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export function ErrorToast() {
  const error = useVault((s) => s.error);
  const setError = useVault((s) => s.setError);
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(null), 6000);
    return () => clearTimeout(t);
  }, [error, setError]);
  if (!error) return null;
  return (
    <div className="toast" role="alert" onClick={() => setError(null)}>
      {error}
    </div>
  );
}
