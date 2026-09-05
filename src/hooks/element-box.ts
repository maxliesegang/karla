import { useEffect, useState, type RefObject } from "react";

/** How much room an element has, in CSS pixels. `null` until it has been measured. */
export type ElementBox = { width: number; height: number };

/**
 * The box an element was given, watched.
 *
 * For the one thing CSS cannot state on its own: a drawing that must fit inside a box in *both*
 * dimensions without its ratio changing. A percentage sizes against one dimension, and clamping the
 * other with `max-height` gives a box whose ratio no longer matches the drawing's — which for the
 * Zentrum's plan means its corridors are letterboxed while the marks on them are stretched, and
 * the two stop meeting. So the box is measured and the fit is worked out from it.
 */
export function useElementBox(ref: RefObject<HTMLElement | null>): ElementBox | null {
  const [box, setBox] = useState<ElementBox | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      // Settle rather than re-render on every sub-pixel of a resize.
      setBox((current) =>
        current && Math.abs(current.width - width) < 0.5 && Math.abs(current.height - height) < 0.5
          ? current
          : { width, height },
      );
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);

  return box;
}
