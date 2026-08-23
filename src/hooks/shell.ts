import { useEffect, useState } from "react";
import { navigateTo, routePaths } from "../routing";
import { describePanelChange, type PanelChange, type PanelKeys } from "../view-layout";

/**
 * The keyboard affordances a wide screen expects and this app had none of: `/` to search, `g` then
 * `z` or `n` for the two roots. Typing into a field is never a shortcut, and neither is a chord the
 * browser or the operating system already owns.
 */
export function useViewShortcuts({
  searchInputRef,
  isEnabled,
}: {
  searchInputRef: React.RefObject<HTMLInputElement | null>;
  isEnabled: boolean;
}) {
  useEffect(() => {
    if (!isEnabled) return;

    let isAwaitingGoTarget = false;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isTyping =
        target?.isContentEditable ||
        ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName ?? "");
      if (isTyping || event.metaKey || event.ctrlKey || event.altKey) return;

      if (isAwaitingGoTarget) {
        isAwaitingGoTarget = false;
        if (event.key === "z") navigateTo(routePaths.core());
        if (event.key === "n") navigateTo(routePaths.network("city"));
        return;
      }
      if (event.key === "g") {
        isAwaitingGoTarget = true;
        return;
      }
      if (event.key === "/") {
        event.preventDefault();
        // The search lives at the top of the home and nowhere else, so from any other view the
        // shortcut's first job is to go where the field is; it is focused on arrival there.
        if (searchInputRef.current) searchInputRef.current.focus();
        else navigateTo(routePaths.home());
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isEnabled, searchInputRef]);
}

/**
 * A screen left running for weeks reloads itself.
 *
 * It is how an unattended board picks up a deploy, and it resets whatever a browser has accumulated
 * over a week of running one page. Scheduled from the moment the page loaded rather than from a
 * wall-clock hour, so a wall of screens does not blink at once.
 */
export function useStationBoardReload(reloadMinutes: number | undefined) {
  useEffect(() => {
    if (!reloadMinutes) return;
    const timer = window.setTimeout(() => window.location.reload(), reloadMinutes * 60_000);
    return () => window.clearTimeout(timer);
  }, [reloadMinutes]);
}

/**
 * Which half of the dashboard changed on the navigation being rendered.
 *
 * Derived while rendering rather than in an effect: the answer has to be on the element in the same
 * commit that mounts the new panel, or the entrance it orders would already be a frame under way.
 * The previous keys are held as state and compared, which is React's own way of deriving from props
 * that changed — a ref would be read before the render that set it under a concurrent re-entry.
 */
export function usePanelChange(keys: PanelKeys): PanelChange {
  const [previous, setPrevious] = useState({
    ...keys,
    // The first paint is a full arrival, so both halves enter together.
    change: "both" as PanelChange,
  });

  if (previous.primaryKey === keys.primaryKey && previous.boardKey === keys.boardKey) {
    return previous.change;
  }
  const change = describePanelChange(previous, keys);
  setPrevious({ ...keys, change });
  return change;
}
