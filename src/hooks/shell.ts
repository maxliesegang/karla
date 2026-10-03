import { useEffect, useState } from "react";
import { navigateTo, routePaths } from "../routing";
import { describePanelChange, type PanelChange, type PanelKeys } from "../view-layout";

/**
 * Keyboard shortcuts: `/` to search, `g` then `z` or `n`. Never while typing, never browser chords.
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
        if (event.key === "z") navigateTo(routePaths.zentrum());
        if (event.key === "n") navigateTo(routePaths.network());
        return;
      }
      if (event.key === "g") {
        isAwaitingGoTarget = true;
        return;
      }
      if (event.key === "/") {
        event.preventDefault();
        // The search lives on the home, so first go there; it is focused on arrival.
        if (searchInputRef.current) searchInputRef.current.focus();
        else navigateTo(routePaths.home());
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isEnabled, searchInputRef]);
}

/**
 * An unattended screen reloads itself, picking up deploys; timed from load so screens do not blink
 * together.
 */
export function useStationBoardReload(reloadMinutes: number | undefined) {
  useEffect(() => {
    if (!reloadMinutes) return;
    const timer = window.setTimeout(() => window.location.reload(), reloadMinutes * 60_000);
    return () => window.clearTimeout(timer);
  }, [reloadMinutes]);
}

/**
 * Which dashboard half changed, derived during render so the entrance is on the element in the
 * mounting commit. Previous keys are state, not a ref, for concurrent rendering.
 */
export function usePanelChange(keys: PanelKeys): PanelChange {
  const [previous, setPrevious] = useState({
    ...keys,
    // The first paint enters both halves.
    change: "both" as PanelChange,
  });

  if (previous.primaryKey === keys.primaryKey && previous.boardKey === keys.boardKey) {
    return previous.change;
  }
  const change = describePanelChange(previous, keys);
  setPrevious({ ...keys, change });
  return change;
}
