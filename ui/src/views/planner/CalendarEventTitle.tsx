import { useLayoutEffect, useRef } from "react";

/** Fit the label to the actual card, including short events and overlapping columns. */
export function CalendarEventTitle({ children }: { children: string }) {
  const label = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const title = label.current,
      card = title?.parentElement;
    if (!title || !card) return;
    const fitTitle = () => {
      title.style.fontSize = "";
      title.style.lineHeight = "";
      const style = getComputedStyle(card);
      const height = card.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
      const maximum = parseFloat(getComputedStyle(title).fontSize);
      if (!height || !title.clientWidth || !maximum) return;
      title.style.whiteSpace = height >= 16 ? "normal" : "nowrap";
      title.style.overflowWrap = "anywhere";
      if (height < 16) title.style.lineHeight = "1";
      for (let size = maximum; size >= 8; size -= 0.5) {
        title.style.fontSize = `${size}px`;
        // WebKit rounds scroll/client dimensions differently under fractional interface zoom.
        if (title.scrollHeight <= height + 1 && title.scrollWidth <= title.clientWidth + 1) break;
      }
    };
    fitTitle();
    const observer = new ResizeObserver(fitTitle);
    observer.observe(card);
    return () => observer.disconnect();
  }, [children]);
  return (
    <strong ref={label} className="planner-card-title">
      {children}
    </strong>
  );
}
