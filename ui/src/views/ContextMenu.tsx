import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check, ChevronRight } from "lucide-react";
import { useUi, type MenuItem } from "../state/ui";
import { DesignSystemScope } from "./DesignSystemScope";
import "./contextMenu.css";

export function ContextMenu() {
  const menu = useUi((s) => s.menu);
  const hide = useUi((s) => s.hideMenu);
  const ref = useRef<HTMLDivElement>(null);
  const restore = useRef(true);
  useLayoutEffect(() => {
    if (!menu) return;
    const previous = document.activeElement;
    restore.current = true;
    const close = (event: Event) => {
      if (!ref.current?.contains(event.target as Node)) {
        restore.current = false;
        hide();
      }
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" || event.key === "Tab") {
        event.preventDefault();
        hide();
      }
    };
    const blur = () => {
      restore.current = false;
      hide();
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", key);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", key);
      window.removeEventListener("blur", blur);
      if (restore.current && previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, [menu, hide]);
  if (!menu) return null;
  return (
    <div ref={ref}>
      <DesignSystemScope>
        <MenuList key={`${menu.x},${menu.y}`} items={menu.items} x={menu.x} y={menu.y} onDone={hide} focusOnOpen />
      </DesignSystemScope>
    </div>
  );
}

/** Keep the existing nested menu and edge flipping, with explicit keyboard navigation. */
function MenuList({
  items,
  x,
  y,
  onDone,
  flipFrom,
  focusOnOpen,
  onBack,
}: {
  items: MenuItem[];
  x: number;
  y: number;
  onDone(): void;
  flipFrom?: number;
  focusOnOpen: boolean;
  onBack?(): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({
    left: x,
    top: y,
    maxHeight: window.innerHeight - 12,
    maxWidth: window.innerWidth - 12,
  });
  const [sub, setSub] = useState<{ index: number; x: number; y: number; flip: number; keyboard: boolean } | null>(null);
  const typeahead = useRef({ value: "", time: 0 });
  const buttons = useCallback(
    () => [...(ref.current?.querySelectorAll<HTMLButtonElement>(":scope > button:not(:disabled)") ?? [])],
    [],
  );
  useLayoutEffect(() => {
    const position = () => {
      const el = ref.current;
      if (!el) return;
      const scale = Number.parseFloat(document.documentElement.style.zoom) || 1;
      const r = el.getBoundingClientRect();
      let left = x;
      if (left + r.width > window.innerWidth - 6)
        left = flipFrom !== undefined ? flipFrom - r.width : window.innerWidth - r.width - 6;
      const top = Math.max(6, Math.min(y, window.innerHeight - r.height - 6));
      setPos({
        left: Math.max(6, left) / scale,
        top: top / scale,
        maxHeight: (window.innerHeight - 12) / scale,
        maxWidth: Math.min(340, (window.innerWidth - 12) / scale),
      });
    };
    position();
    window.addEventListener("resize", position);
    return () => window.removeEventListener("resize", position);
  }, [x, y, flipFrom]);
  useEffect(() => {
    if (focusOnOpen) buttons()[0]?.focus({ preventScroll: true });
  }, [focusOnOpen, buttons]);
  const openSub = (index: number, button: HTMLButtonElement, keyboard: boolean) => {
    const r = button.getBoundingClientRect();
    setSub({ index, x: r.right + 2, y: r.top - 5, flip: r.left - 2, keyboard });
  };
  return (
    <>
      <div
        ref={ref}
        className="mds-context-menu"
        style={pos}
        role="menu"
        aria-label="Actions"
        onKeyDown={(event) => {
          const all = buttons(),
            current = all.indexOf(document.activeElement as HTMLButtonElement);
          let next: number | undefined;
          if (event.key === "ArrowDown") next = (current + 1) % all.length;
          else if (event.key === "ArrowUp") next = (current - 1 + all.length) % all.length;
          else if (event.key === "Home") next = 0;
          else if (event.key === "End") next = all.length - 1;
          else if (event.key === "ArrowLeft" && onBack) {
            event.preventDefault();
            event.stopPropagation();
            onBack();
            return;
          } else if (event.key.length === 1 && !event.altKey && !event.ctrlKey && !event.metaKey && event.key !== " ") {
            const now = Date.now();
            typeahead.current = {
              value: (now - typeahead.current.time < 700 ? typeahead.current.value : "") + event.key.toLowerCase(),
              time: now,
            };
            for (let offset = 1; offset <= all.length; offset++) {
              const i = (current + offset) % all.length;
              if (all[i].dataset.label?.toLowerCase().startsWith(typeahead.current.value)) {
                next = i;
                break;
              }
            }
          }
          if (next !== undefined) {
            event.preventDefault();
            all[next]?.focus();
          }
        }}
      >
        {items.map((item, i) =>
          item.separator ? (
            <div key={i} className="mds-context-separator" role="separator" />
          ) : (
            <button
              key={i}
              type="button"
              role={item.checked === undefined ? "menuitem" : "menuitemcheckbox"}
              aria-checked={item.checked}
              aria-haspopup={item.children ? "menu" : undefined}
              aria-expanded={item.children ? sub?.index === i : undefined}
              disabled={item.disabled}
              data-label={item.label}
              className={[item.danger ? "danger" : "", sub?.index === i ? "open" : ""].join(" ")}
              onMouseEnter={(event) => (item.children ? openSub(i, event.currentTarget, false) : setSub(null))}
              onKeyDown={(event) => {
                if (item.children && (event.key === "ArrowRight" || event.key === "Enter" || event.key === " ")) {
                  event.preventDefault();
                  event.stopPropagation();
                  openSub(i, event.currentTarget, true);
                }
              }}
              onClick={(event) => {
                if (item.children) {
                  openSub(i, event.currentTarget, event.detail === 0);
                  return;
                }
                onDone();
                item.action?.();
              }}
            >
              <span className="mds-context-check">{item.checked && <Check size={14} aria-hidden="true" />}</span>
              <span className="mds-context-label">
                {item.label}
                {item.detail && <small>{item.detail}</small>}
              </span>
              {item.shortcut && <kbd>{item.shortcut}</kbd>}
              {item.children && <ChevronRight size={14} aria-hidden="true" />}
            </button>
          ),
        )}
      </div>
      {sub && items[sub.index]?.children && (
        <MenuList
          key={sub.index}
          items={items[sub.index].children!}
          x={sub.x}
          y={sub.y}
          flipFrom={sub.flip}
          onDone={onDone}
          focusOnOpen={sub.keyboard}
          onBack={() => {
            const parent = ref.current?.children[sub.index] as HTMLElement | undefined;
            setSub(null);
            parent?.focus();
          }}
        />
      )}
    </>
  );
}
