import { useCallback, useEffect, useRef } from "react";
import {
  getPullDistance,
  isPullTriggered,
  PULL_TO_REFRESH_SETTLE_TIMEOUT_MS,
  PULL_TO_REFRESH_TRIGGER_PX,
} from "../lib/pull-to-refresh";

/** The strip's height while a refresh runs. */
const PULL_TO_REFRESH_REST_PX = PULL_TO_REFRESH_TRIGGER_PX;

type PullGestureState = {
  /** Where the finger started. */
  startY: number;
  /** Whether the scrollport left its top during the gesture, making it a scroll. */
  hasScrolled: boolean;
  /** Whether the gesture was taken from the browser's scrolling. */
  isEngaged: boolean;
  /** How far the board followed at the last move; a release is judged by it. */
  distance: number;
  isRefreshing: boolean;
  /** The reading count when the refresh was asked for. */
  refreshedFrom: number | undefined;
  settleTimer: number;
};

/**
 * Pulling a board down from its top asks the feed again. Read on the list, pulled from whichever
 * scrollport holds it; once engaged the app handles it, keeping out Android's reload and iOS's
 * rubber band. Drawn through the DOM, not state, so a drag re-renders nothing. Settles when the
 * reading count moves, or after a timeout.
 */
export function usePullToRefresh({
  listRef,
  indicatorRef,
  isPageScrollport = false,
  onRefresh,
  readingCount,
  isEnabled,
}: {
  /** The board's list, where the gesture is read. */
  listRef: React.RefObject<HTMLElement | null>;
  /** The strip, drawn through the DOM. */
  indicatorRef: React.RefObject<HTMLDivElement | null>;
  /** Whether the document is the scrollport (stacked layout). */
  isPageScrollport?: boolean;
  onRefresh: () => void;
  /** Readings answered, failures included. */
  readingCount: number | undefined;
  /** Off until a board has been read. */
  isEnabled: boolean;
}): void {
  const gesture = useRef<PullGestureState>({
    startY: 0,
    hasScrolled: false,
    isEngaged: false,
    distance: 0,
    isRefreshing: false,
    refreshedFrom: undefined,
    settleTimer: 0,
  });
  // Handlers attach once per mount, so they read props through refs.
  const onRefreshRef = useRef(onRefresh);
  const readingCountRef = useRef(readingCount);
  useEffect(() => {
    onRefreshRef.current = onRefresh;
    readingCountRef.current = readingCount;
  }, [onRefresh, readingCount]);

  const finishRefresh = useCallback(() => {
    const state = gesture.current;
    if (!state.isRefreshing) return;
    state.isRefreshing = false;
    state.refreshedFrom = undefined;
    window.clearTimeout(state.settleTimer);
    const indicator = indicatorRef.current;
    if (indicator) {
      indicator.classList.remove("is-pulling", "is-armed", "is-refreshing");
      indicator.style.height = "0px";
    }
  }, [indicatorRef]);

  const startRefresh = useCallback(() => {
    const state = gesture.current;
    state.isRefreshing = true;
    state.refreshedFrom = readingCountRef.current;
    const indicator = indicatorRef.current;
    if (indicator) {
      indicator.classList.remove("is-pulling", "is-armed");
      indicator.classList.add("is-refreshing");
      indicator.style.height = `${PULL_TO_REFRESH_REST_PX}px`;
    }
    state.settleTimer = window.setTimeout(finishRefresh, PULL_TO_REFRESH_SETTLE_TIMEOUT_MS);
    onRefreshRef.current();
  }, [finishRefresh, indicatorRef]);

  useEffect(() => {
    if (!isEnabled) return;
    const element = listRef.current;
    if (!element) return;
    // Copied for the cleanup, which tears down this run's state.
    const gestureState = gesture.current;
    const indicator = indicatorRef.current;

    const getScrollOffset = () => (isPageScrollport ? window.scrollY : element.scrollTop);

    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) return;
      const state = gesture.current;
      state.startY = event.touches[0].clientY;
      state.hasScrolled = false;
      state.isEngaged = false;
      state.distance = 0;
    };

    const onTouchMove = (event: TouchEvent) => {
      const state = gesture.current;
      const touch = event.touches[0];
      if (!touch) return;
      const offset = getScrollOffset();
      if (offset > 0) state.hasScrolled = true;
      if (!state.isEngaged) {
        if (state.hasScrolled || offset > 0 || touch.clientY <= state.startY) return;
        // The gesture is ours; the browser's reload or rubber band never starts.
        state.isEngaged = true;
      }
      event.preventDefault();
      // A pull during a refresh does nothing.
      if (state.isRefreshing) return;
      const distance = getPullDistance(touch.clientY - state.startY);
      state.distance = distance;
      const indicator = indicatorRef.current;
      if (!indicator) return;
      indicator.classList.add("is-pulling");
      indicator.style.height = `${distance}px`;
      indicator.classList.toggle("is-armed", isPullTriggered(distance));
    };

    const onTouchEnd = () => {
      const state = gesture.current;
      state.isEngaged = false;
      const triggered = isPullTriggered(state.distance);
      state.distance = 0;
      const indicator = indicatorRef.current;
      if (indicator) indicator.classList.remove("is-pulling");
      if (state.isRefreshing) return;
      if (triggered) startRefresh();
      else if (indicator) indicator.style.height = "0px";
    };

    // A cancelled gesture means nothing.
    const onTouchCancel = () => {
      const state = gesture.current;
      state.isEngaged = false;
      state.distance = 0;
      const indicator = indicatorRef.current;
      if (!indicator) return;
      indicator.classList.remove("is-pulling");
      if (!state.isRefreshing) indicator.style.height = "0px";
    };

    element.addEventListener("touchstart", onTouchStart, { passive: true });
    element.addEventListener("touchmove", onTouchMove, { passive: false });
    element.addEventListener("touchend", onTouchEnd, { passive: true });
    element.addEventListener("touchcancel", onTouchCancel, { passive: true });
    return () => {
      element.removeEventListener("touchstart", onTouchStart);
      element.removeEventListener("touchmove", onTouchMove);
      element.removeEventListener("touchend", onTouchEnd);
      element.removeEventListener("touchcancel", onTouchCancel);
      // The gesture dies with its reading, or the strip would hang.
      window.clearTimeout(gestureState.settleTimer);
      gestureState.isRefreshing = false;
      gestureState.refreshedFrom = undefined;
      if (indicator) {
        indicator.classList.remove("is-pulling", "is-armed", "is-refreshing");
        indicator.style.height = "0px";
      }
    };
  }, [isEnabled, isPageScrollport, indicatorRef, listRef, startRefresh]);

  // Any answer settles the strip.
  useEffect(() => {
    const state = gesture.current;
    if (!state.isRefreshing || readingCount === state.refreshedFrom) return;
    finishRefresh();
  }, [readingCount, finishRefresh]);
}
