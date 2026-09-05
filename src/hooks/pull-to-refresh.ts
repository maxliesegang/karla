import { useCallback, useEffect, useRef } from "react";
import {
  getPullDistance,
  isPullTriggered,
  PULL_TO_REFRESH_SETTLE_TIMEOUT_MS,
  PULL_TO_REFRESH_TRIGGER_PX,
} from "../lib/pull-to-refresh";

/** The height the strip holds while a refresh is under way — where the trigger leaves it. */
const PULL_TO_REFRESH_REST_PX = PULL_TO_REFRESH_TRIGGER_PX;

type PullGestureState = {
  /** Where the finger started, which every drag of this gesture is measured from. */
  startY: number;
  /** Whether the scrollport left its top during this gesture: a pull from mid-board is a scroll. */
  hasScrolled: boolean;
  /** Whether the gesture has been taken over from the browser's own scrolling. */
  isEngaged: boolean;
  /** How far the board followed when the finger last moved, which is what a release is judged by. */
  distance: number;
  isRefreshing: boolean;
  /** The reading count the board stood at when the refresh was asked for. */
  refreshedFrom: number | undefined;
  settleTimer: number;
};

/**
 * Pulling a departure board down past its first row asks for the feed again.
 *
 * The gesture is read on the board's list, but it belongs to whichever scrollport holds it: a board
 * that scrolls itself is pulled from its own top, and a board stacked into the document is pulled
 * from the document's. Only from the top — anywhere else the same finger movement is a scroll and
 * stays one. Once engaged the movement is answered by the app rather than the browser, which is
 * what keeps Android's page reload and iOS's rubber band out of a gesture this page means itself.
 *
 * The strip is drawn through the DOM rather than through state, for the same reason the scrollbar
 * is (`useTransientScrollbar`): a finger moving down a board re-renders nothing. State would only
 * say what the classes already do, once per gesture at most. The refresh is asked for on release,
 * and the strip settles when the board has been read again — the reading count moving is the
 * answer, however the reading answered — or when a request has gone unanswered too long.
 */
export function usePullToRefresh({
  listRef,
  indicatorRef,
  isPageScrollport = false,
  onRefresh,
  readingCount,
  isEnabled,
}: {
  /** The board's list, where the gesture is read and whose top a wide layout pulls from. */
  listRef: React.RefObject<HTMLElement | null>;
  /** The strip that carries the gesture, which this draws through the DOM. */
  indicatorRef: React.RefObject<HTMLDivElement | null>;
  /** Whether the document is the scrollport (the stacked layout) rather than the list itself. */
  isPageScrollport?: boolean;
  onRefresh: () => void;
  /** How many readings of the board have answered, however each of them answered. */
  readingCount: number | undefined;
  /** A pull means nothing while no board has been read and nothing is there to ask again. */
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
  // The handlers are attached once per mount, so what they read of the props is read through refs.
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
    // Copied here rather than read in the cleanup: the refs outlive the effect, and what the
    // cleanup takes down is the state this run of it set up.
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
        // At the top with a finger moving down: the gesture is ours now, and the browser's own
        // reading of it — a page reload, a rubber band — never starts.
        state.isEngaged = true;
      }
      event.preventDefault();
      // A pull while one is already under way keeps the page still and answers nothing; the strip
      // holds its rest until the reading answers.
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

    // A cancelled gesture is a released one that never gets to mean anything.
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
      // The gesture dies with the reading it belongs to; a strip left holding a rest height that no
      // finger is holding would hang until the next refresh answered.
      window.clearTimeout(gestureState.settleTimer);
      gestureState.isRefreshing = false;
      gestureState.refreshedFrom = undefined;
      if (indicator) {
        indicator.classList.remove("is-pulling", "is-armed", "is-refreshing");
        indicator.style.height = "0px";
      }
    };
  }, [isEnabled, isPageScrollport, indicatorRef, listRef, startRefresh]);

  // A refresh is answered by the board being read again, not by a particular answer coming back:
  // whatever the reading was — a fresh board or a stated failure — the strip has nothing left to
  // wait for.
  useEffect(() => {
    const state = gesture.current;
    if (!state.isRefreshing || readingCount === state.refreshedFrom) return;
    finishRefresh();
  }, [readingCount, finishRefresh]);
}
