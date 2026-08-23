import { useEffect, useRef } from "react";

/** How long the bar stays after the last scroll event — long enough to see where it came to rest. */
const SCROLLBAR_LINGER_MS = 700;

/**
 * A scrollport whose bar is only there while it is being scrolled.
 *
 * The two long views — the board and the diagram — are lists that fill their panel, so a bar drawn
 * at rest is a permanent ruler down the side of the view saying nothing a rider asked for. The bar
 * is an answer to "where am I in this", and that question is only ever asked mid-scroll: the
 * stylesheet keeps the thumb transparent and this marks the element while it moves, which is what
 * paints it. A trackpad's own overlay bars already behave this way; this gives the same manners to
 * the scrollbars a desktop draws permanently.
 *
 * The class goes on through the DOM rather than through state: a scroll must not re-render a list
 * whose rows are the thing being scrolled.
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
