export const TREE_AUTO_SCROLL_EDGE = 48;
export const TREE_AUTO_SCROLL_MAX_STEP = 14;

/** Per-frame scroll amount for a pointer near a scroll container's vertical edge. */
export function treeAutoScrollStep(
  pointerY: number,
  top: number,
  bottom: number,
  edge = TREE_AUTO_SCROLL_EDGE,
  maxStep = TREE_AUTO_SCROLL_MAX_STEP,
): number {
  if (bottom <= top || edge <= 0 || maxStep <= 0) return 0;
  const zone = Math.min(edge, (bottom - top) / 2);
  if (pointerY < top + zone) return -maxStep * Math.min(1, Math.max(0, (top + zone - pointerY) / zone));
  if (pointerY > bottom - zone) return maxStep * Math.min(1, Math.max(0, (pointerY - (bottom - zone)) / zone));
  return 0;
}
