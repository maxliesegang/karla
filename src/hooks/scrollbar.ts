import { useEffect, useRef } from "react";

/** How long the bar stays after the last scroll event. */
const SCROLLBAR_LINGER_MS = 700;

/**
 * Shows a scrollport's bar only while it scrolls (the stylesheet keeps the thumb transparent at
 * rest), like overlay scrollbars. Set through the DOM, so scrolling re-renders nothing.
 */
export function useTransientScrollbar(ref: React.RefObject<HTMLElement | null>) {
  const timerRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const onScroll = () => {
      element.classList.add("is-scrolling");
      window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => {
        element.classList.remove("is-scrolling");
      }, SCROLLBAR_LINGER_MS);
    };

    element.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      element.removeEventListener("scroll", onScroll);
      window.clearTimeout(timerRef.current);
      element.classList.remove("is-scrolling");
    };
  }, [ref]);
}
