import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useUi, type MenuItem } from "../state/ui";
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
  return (
    <div ref={ref}>
      <MenuList key={`${menu.x},${menu.y}`} items={menu.items} x={menu.x} y={menu.y} onDone={hide} />
    </div>
  );
}

/** One level of a menu, kept inside the window; items with `children` open a submenu on hover. */
function MenuList({ items, x, y, onDone, flipFrom }: { items: MenuItem[]; x: number; y: number; onDone(): void; flipFrom?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  const [sub, setSub] = useState<{ index: number; x: number; y: number; flip: number } | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let left = x;
    // A submenu that doesn't fit on the right opens to the left of its parent.
    if (left + r.width > window.innerWidth - 6) left = flipFrom !== undefined ? flipFrom - r.width : window.innerWidth - r.width - 6;
    const top = Math.max(6, Math.min(y, window.innerHeight - r.height - 6));
    setPos({ left: Math.max(6, left), top });
  }, [x, y, flipFrom]);

  return (
    <>
      <div ref={ref} className="menu" style={pos} role="menu">
        {items.map((it, i) =>
          it.separator ? (
            <div key={i} className="menu-sep" />
          ) : (
            <button
              key={i}
              role="menuitem"
              aria-haspopup={it.children ? "menu" : undefined}
              disabled={it.disabled}
              className={[it.danger ? "danger" : "", sub?.index === i ? "open" : ""].join(" ").trim() || undefined}
              onMouseEnter={(e) => {
                if (!it.children) return setSub(null);
                const r = e.currentTarget.getBoundingClientRect();
                setSub({ index: i, x: r.right + 2, y: r.top - 5, flip: r.left - 2 });
              }}
              onClick={(e) => {
                if (it.children) {
                  const r = e.currentTarget.getBoundingClientRect();
                  setSub({ index: i, x: r.right + 2, y: r.top - 5, flip: r.left - 2 });
                  return;
                }
                onDone();
                it.action?.();
              }}
            >
              <span className="menu-check">{it.checked ? "✓" : ""}</span>
              <span className="menu-label">
                {it.label}
                {it.detail && <small>{it.detail}</small>}
              </span>
              {it.shortcut && <kbd>{it.shortcut}</kbd>}
              {it.children && <span className="menu-arrow">›</span>}
            </button>
          ),
        )}
      </div>
      {sub && items[sub.index]?.children && (
        <MenuList key={sub.index} items={items[sub.index].children!} x={sub.x} y={sub.y} flipFrom={sub.flip} onDone={onDone} />
      )}
    </>
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

export function PromptDialog() {
  const p = useUi((s) => s.prompt);
  const answer = useUi((s) => s.answerText);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [p]);
  if (!p) return null;
  return (
    <div className="modal-backdrop" onMouseDown={() => answer(null)}>
      <form
        className="modal"
        onMouseDown={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          answer(input.current?.value ?? "");
        }}
      >
        <h2>{p.title}</h2>
        <input ref={input} className="text-input" defaultValue={p.value} placeholder={p.placeholder} onKeyDown={(e) => e.key === "Escape" && answer(null)} />
        <div className="modal-actions">
          <button type="button" onClick={() => answer(null)}>Cancel</button>
          <button type="submit" className="primary">OK</button>
        </div>
      </form>
    </div>
  );
}
