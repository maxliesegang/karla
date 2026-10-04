import { useEffect, type RefObject } from "react";

/** How far the mouse moves, in pixels, before a press becomes a drag rather than a click. */
const DRAG_THRESHOLD_PX = 4;

/**
 * Pans a scrollport by dragging it with the mouse, as touch already does natively. A press that
 * moves past the threshold becomes a drag and swallows the click it would end in, so dragging
 * across a stop does not open it. Set through the DOM, so dragging re-renders nothing.
 */
export function useDragPan(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    let press:
      | { pointerId: number; x: number; y: number; left: number; top: number; isDragging: boolean }
      | undefined;

    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType !== "mouse" || event.button !== 0) return;
      press = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        left: element.scrollLeft,
        top: element.scrollTop,
        isDragging: false,
      };
    };

    const onPointerMove = (event: PointerEvent) => {
      if (!press || event.pointerId !== press.pointerId) return;
      const dx = event.clientX - press.x;
      const dy = event.clientY - press.y;
      if (!press.isDragging) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
        press.isDragging = true;
        element.setPointerCapture(event.pointerId);
        element.classList.add("is-drag-panning");
        window.getSelection()?.removeAllRanges();
      }
      element.scrollLeft = press.left - dx;
      element.scrollTop = press.top - dy;
    };

    const onPointerEnd = (event: PointerEvent) => {
      if (!press || event.pointerId !== press.pointerId) return;
      if (press.isDragging) {
        element.classList.remove("is-drag-panning");
        // The click that ends a drag lands wherever the mouse stopped; it is not a choice.
        const swallowClick = (click: MouseEvent) => {
          click.stopPropagation();
          click.preventDefault();
        };
        window.addEventListener("click", swallowClick, { capture: true, once: true });
        window.setTimeout(() => window.removeEventListener("click", swallowClick, true), 0);
      }
      press = undefined;
    };

    // A drag would otherwise also start selecting names or dragging the drawing as an image.
    const onDragStart = (event: DragEvent) => event.preventDefault();

    element.addEventListener("pointerdown", onPointerDown);
    element.addEventListener("pointermove", onPointerMove);
    element.addEventListener("pointerup", onPointerEnd);
    element.addEventListener("pointercancel", onPointerEnd);
    element.addEventListener("dragstart", onDragStart);
    return () => {
      element.removeEventListener("pointerdown", onPointerDown);
      element.removeEventListener("pointermove", onPointerMove);
      element.removeEventListener("pointerup", onPointerEnd);
      element.removeEventListener("pointercancel", onPointerEnd);
      element.removeEventListener("dragstart", onDragStart);
      element.classList.remove("is-drag-panning");
    };
  }, [ref]);
}
