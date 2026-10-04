import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

/** How much one pixel of wheel travel zooms; a mouse notch (about 100px) is about 1.25×. */
const ZOOM_PER_WHEEL_PIXEL = 0.0022;
/** Line and page wheel modes, in pixels. */
const LINE_HEIGHT_PX = 16;

/** Zooms by `factor` about a point in the scrollport, in pixels from its visible top-left corner. */
export type ZoomAt = (factor: number, point: { left: number; top: number }) => void;

/**
 * Zooms a scrollport with the mouse wheel (and a trackpad pinch, which arrives as a wheel with the
 * control key), about the point under the pointer. The wheel no longer scrolls the map; dragging
 * pans it. Events are gathered into one zoom per frame, so a fast wheel renders once per frame.
 */
export function useWheelZoom(ref: RefObject<HTMLElement | null>, zoomAt: ZoomAt) {
  const zoomAtRef = useRef(zoomAt);
  useLayoutEffect(() => {
    zoomAtRef.current = zoomAt;
  });

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    let pending: { delta: number; left: number; top: number } | undefined;
    let frame: number | undefined;

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const unit =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE
          ? LINE_HEIGHT_PX
          : event.deltaMode === WheelEvent.DOM_DELTA_PAGE
            ? element.clientHeight
            : 1;
      const rect = element.getBoundingClientRect();
      pending = {
        delta: (pending?.delta ?? 0) + event.deltaY * unit,
        left: event.clientX - rect.left - element.clientLeft,
        top: event.clientY - rect.top - element.clientTop,
      };
      frame ??= window.requestAnimationFrame(() => {
        frame = undefined;
        if (!pending) return;
        const { delta, left, top } = pending;
        pending = undefined;
        zoomAtRef.current(Math.exp(-delta * ZOOM_PER_WHEEL_PIXEL), { left, top });
      });
    };

    // Not passive: the wheel must not also scroll the map or the page.
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      element.removeEventListener("wheel", onWheel);
      if (frame !== undefined) window.cancelAnimationFrame(frame);
    };
  }, [ref]);
}
