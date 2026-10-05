import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import type { ZoomAt } from "./wheel-zoom";

/**
 * Zooms a scrollport with a two-finger pinch, about the point between the fingers, instead of
 * zooming the page. One finger still pans natively. Moves are gathered into one zoom per frame.
 */
export function usePinchZoom(ref: RefObject<HTMLElement | null>, zoomAt: ZoomAt) {
  const zoomAtRef = useRef(zoomAt);
  useLayoutEffect(() => {
    zoomAtRef.current = zoomAt;
  });

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    let distance: number | undefined;
    let pending: { factor: number; left: number; top: number } | undefined;
    let frame: number | undefined;

    const readPinch = (touches: TouchList) => {
      const [first, second] = [touches[0], touches[1]];
      const rect = element.getBoundingClientRect();
      return {
        distance: Math.hypot(first.clientX - second.clientX, first.clientY - second.clientY),
        left: (first.clientX + second.clientX) / 2 - rect.left - element.clientLeft,
        top: (first.clientY + second.clientY) / 2 - rect.top - element.clientTop,
      };
    };

    const onTouchStart = (event: TouchEvent) => {
      distance = event.touches.length === 2 ? readPinch(event.touches).distance : undefined;
    };

    const onTouchMove = (event: TouchEvent) => {
      if (event.touches.length !== 2 || distance === undefined) return;
      event.preventDefault();
      const pinch = readPinch(event.touches);
      if (pinch.distance === 0) return;
      pending = {
        factor: (pending?.factor ?? 1) * (pinch.distance / distance),
        left: pinch.left,
        top: pinch.top,
      };
      distance = pinch.distance;
      frame ??= window.requestAnimationFrame(() => {
        frame = undefined;
        if (!pending) return;
        const { factor, left, top } = pending;
        pending = undefined;
        zoomAtRef.current(factor, { left, top });
      });
    };

    const onTouchEnd = (event: TouchEvent) => {
      if (event.touches.length < 2) distance = undefined;
    };

    // Not passive: a pinch must not also zoom the page.
    element.addEventListener("touchstart", onTouchStart, { passive: true });
    element.addEventListener("touchmove", onTouchMove, { passive: false });
    element.addEventListener("touchend", onTouchEnd);
    element.addEventListener("touchcancel", onTouchEnd);
    return () => {
      element.removeEventListener("touchstart", onTouchStart);
      element.removeEventListener("touchmove", onTouchMove);
      element.removeEventListener("touchend", onTouchEnd);
      element.removeEventListener("touchcancel", onTouchEnd);
      if (frame !== undefined) window.cancelAnimationFrame(frame);
    };
  }, [ref]);
}
