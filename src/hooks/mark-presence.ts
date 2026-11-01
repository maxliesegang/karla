import { useLayoutEffect, useState, type RefObject } from "react";
import {
  createMarkPresence,
  type MarkPresence,
  type MarkPresenceEvent,
  type PresentedMark,
} from "../lib/mark-presence";

/**
 * Plays a mark's entrance and update cue (`lib/mark-presence.ts`) on its element, found by
 * `data-marker-key`. Both leave `transform` alone: it carries the mark's position.
 */

/** Whether a changed reading pulses its mark's ring; off, a refresh shows on no mark. */
const SHOWS_UPDATE_CUE = true;

const ENTER_MS = 240;
const CUE_MS = 600;
const REDUCED_CUE_MS = 1_500;

/** One record per view; a new `viewKey` starts afresh. */
export function useMarkPresence(viewKey: string, graceMs: number): MarkPresence {
  const [state, setState] = useState(() => ({ viewKey, presence: createMarkPresence(graceMs) }));
  if (state.viewKey === viewKey) return state.presence;
  const next = { viewKey, presence: createMarkPresence(graceMs) };
  setState(next);
  return next.presence;
}

export function useMarkPresenceAnimations({
  container,
  presence,
  marks,
  now,
  colorProperty,
}: {
  container: RefObject<HTMLElement | null>;
  presence: MarkPresence;
  marks: readonly PresentedMark[];
  /** The device clock. */
  now: number;
  /** The custom property holding the mark's line colour. */
  colorProperty: string;
}) {
  // Every commit, before paint, so an entering mark is never seen fully formed.
  useLayoutEffect(() => {
    const events = presence.note(marks, now);
    const root = container.current;
    if (!root || events.size === 0) return;
    const isReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    for (const [key, event] of events) {
      const element = root.querySelector<HTMLElement>(`[data-marker-key="${CSS.escape(key)}"]`);
      if (element) playMarkPresenceEvent(element, event, isReduced, colorProperty);
    }
  });
}

function playMarkPresenceEvent(
  element: HTMLElement,
  event: MarkPresenceEvent,
  isReduced: boolean,
  colorProperty: string,
) {
  if (event === "enter") {
    // Ends on the element's own opacity, which dimming may lower.
    if (!isReduced) element.animate([{ opacity: 0, offset: 0 }], ENTER_MS);
    return;
  }
  if (!SHOWS_UPDATE_CUE) return;
  const style = getComputedStyle(element);
  const color = style.getPropertyValue(colorProperty).trim();
  const base = style.boxShadow === "none" ? "" : `${style.boxShadow}, `;
  const ring = (spread: number, percent: number) =>
    `${base}color-mix(in srgb, ${color} ${percent}%, transparent) 0px 0px 0px ${spread}px`;
  const reach = Math.max(6, Math.round(element.offsetHeight * 0.4));
  if (isReduced) {
    const held = ring(Math.round(reach / 2), 70);
    element.animate([{ boxShadow: held }, { boxShadow: held }], REDUCED_CUE_MS);
    return;
  }
  element.animate([{ boxShadow: ring(0, 60) }, { boxShadow: ring(reach, 0) }], {
    duration: CUE_MS,
    easing: "ease-out",
  });
}
