/**
 * Touch screens have no right click: holding a finger still on an element opens the same menu,
 * as everywhere on iOS. After the hold, a real `contextmenu` event reaches the element (so every
 * `onContextMenu` in the app works as is) and the click that the lifted finger would make is
 * swallowed, so a held server opens its menu instead of connecting.
 *
 * The terminal, the remote desktop and text fields handle touches themselves and are left alone.
 */

export const HOLD_MS = 500;
const SLOP = 10;
const OWN_TOUCH = ".xterm, canvas, input, textarea, select, [contenteditable], [data-own-touch]";

export function installLongPress(root: Document = document): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let start: { x: number; y: number; id: number } | null = null;
  let swallowClick = false;

  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    start = null;
  };

  const onDown = (e: PointerEvent) => {
    if (e.pointerType !== "touch" || !e.isPrimary) return;
    const target = e.target as Element | null;
    if (!target || target.closest(OWN_TOUCH)) return;
    cancel();
    start = { x: e.clientX, y: e.clientY, id: e.pointerId };
    const { clientX, clientY } = e;
    timer = setTimeout(() => {
      timer = null;
      const menu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX, clientY, button: 2 });
      // Only a handled hold eats the click; elsewhere the tap goes through as usual.
      if (!target.dispatchEvent(menu)) swallowClick = true;
    }, HOLD_MS);
  };
  const onMove = (e: PointerEvent) => {
    if (start && e.pointerId === start.id && Math.hypot(e.clientX - start.x, e.clientY - start.y) > SLOP) cancel();
  };
  const onUp = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    start = null;
  };
  const onClick = (e: MouseEvent) => {
    if (!swallowClick) return;
    swallowClick = false;
    e.preventDefault();
    e.stopPropagation();
  };

  root.addEventListener("pointerdown", onDown, true);
  root.addEventListener("pointermove", onMove, true);
  root.addEventListener("pointerup", onUp, true);
  root.addEventListener("pointercancel", cancel, true);
  root.addEventListener("click", onClick, true);
  return () => {
    cancel();
    root.removeEventListener("pointerdown", onDown, true);
    root.removeEventListener("pointermove", onMove, true);
    root.removeEventListener("pointerup", onUp, true);
    root.removeEventListener("pointercancel", cancel, true);
    root.removeEventListener("click", onClick, true);
  };
}
