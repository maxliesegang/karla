/**
 * Scrolls an element into view, smoothly unless reduced motion is preferred. The target's
 * `scroll-margin-top` clears the pinned bar.
 */
export function scrollIntoView(
  element: HTMLElement,
  { block = "start" }: { block?: ScrollLogicalPosition } = {},
): void {
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  element.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block, inline: "nearest" });
}
