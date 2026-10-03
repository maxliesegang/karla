import { useEffect, useState, type RefObject } from "react";

/** An element's size in CSS pixels. */
export type ElementBox = { width: number; height: number };

/**
 * An element's measured box, for fitting a drawing in both dimensions at a fixed ratio, which CSS
 * alone cannot do without distorting the Zentrum plan's marks against its corridors.
 */
export function useElementBox(ref: RefObject<HTMLElement | null>): ElementBox | null {
  const [box, setBox] = useState<ElementBox | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      // Ignore sub-pixel changes.
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
