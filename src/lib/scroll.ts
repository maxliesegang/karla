/**
 * Brings one element into view with motion, unless the rider's system asks for reduced motion —
 * then the same destination arrives without the animation.
 *
 * The caller owns what the scroll means; this only decides how it travels. Stopping short of the
 * viewport's top edge is the scroll target's own business (`scroll-margin-top`), which is how a
 * section clears the pinned bar without this helper knowing about the bar.
 */
export function scrollIntoView(
  element: HTMLElement,
  { block = "start" }: { block?: ScrollLogicalPosition } = {},
): void {
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  element.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block, inline: "nearest" });
}
