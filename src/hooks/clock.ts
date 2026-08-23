import { useEffect, useState } from "react";
import { getFeedNow } from "../lib/feed-clock";
import type { DepartureBoard } from "../data/transit-types";

const VEHICLE_TICK_MS = 1_000;
/** Fine enough that a countdown turns over within a few seconds of the minute it belongs to. */
const FEED_CLOCK_TICK_MS = 5_000;
/** The breakpoint the stacked layout is keyed to; the stylesheet carries the same one. */
const NARROW_VIEWPORT_QUERY = "(max-width: 860px)";

/**
 * Ticks a wall clock, aligned to the minute it is about to show.
 *
 * A free-running interval flips the visible minute up to its own period late, which on a station
 * clock read from across a hall is exactly the error a rider notices. Each tick is scheduled for
 * the next minute boundary instead, so the clock changes when the minute does.
 */
export function useCurrentTime(): Date {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    let timer = 0;
    const tick = () => {
      const current = new Date();
      setNow(current);
      // A few milliseconds past the boundary, so a rounding error cannot land the tick early.
      timer = window.setTimeout(
        tick,
        60_000 - (current.getSeconds() * 1_000 + current.getMilliseconds()) + 50,
      );
    };
    tick();
    return () => window.clearTimeout(timer);
  }, []);

  return now;
}

/**
 * A clock that ticks only while the page is being read.
 *
 * A countdown nobody can see is worth no wake-ups: a tab left behind another app spends a phone's
 * battery re-rendering a diagram for nobody, and the boards behind it have already stopped
 * refreshing. Coming back reads the clock at once, so the first frame a rider sees is current
 * rather than a tick out of date. The way back is heard through `visibilitychange`, `pageshow` and
 * `focus` alike, because a resumed home-screen app does not always deliver the first of them.
 */
function useClockTick(intervalMs: number, isEnabled = true): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!isEnabled) return;
    let timer = 0;
    let resumeTimer = 0;
    const start = () => {
      window.clearInterval(timer);
      setNow(Date.now());
      if (document.visibilityState === "hidden") return;
      timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    };
    // The same deferred reading of the visibility state the refresh chain uses: the state an event
    // announces can still disagree with what the document reports while the event is delivered.
    const resume = () => {
      window.clearTimeout(resumeTimer);
      resumeTimer = window.setTimeout(start);
    };

    start();
    window.addEventListener("visibilitychange", resume);
    window.addEventListener("pageshow", resume);
    window.addEventListener("focus", resume);
    return () => {
      window.clearInterval(timer);
      window.clearTimeout(resumeTimer);
      window.removeEventListener("visibilitychange", resume);
      window.removeEventListener("pageshow", resume);
      window.removeEventListener("focus", resume);
    };
  }, [intervalMs, isEnabled]);

  return now;
}

/**
 * The feed's clock, ticking.
 *
 * Every countdown a rider reads is counted from the source's clock rather than the device's, and it
 * has to run down between refreshes rather than in thirty-second jumps. The board states when it
 * was produced and when it arrived; the difference between the two is fixed, so the reading is the
 * device's own tick shifted by it. A board that has not arrived yet leaves the device's clock, which
 * is the only one there is.
 */
export function useFeedNow(departureBoard: DepartureBoard | null): number {
  return getFeedNow(departureBoard, useClockTick(FEED_CLOCK_TICK_MS));
}

/**
 * The device's own clock, ticking on the same cadence a countdown is read on.
 *
 * For the one question that is asked of the device clock rather than the feed's: how old a reading
 * in hand is, which is a difference between two device timestamps and would be wrong on the feed's.
 * Ticking, because "is this still current?" has to stop being true on its own rather than at
 * whatever moment the view happens to re-render next.
 */
export function useDeviceNow(): number {
  return useClockTick(FEED_CLOCK_TICK_MS);
}

/**
 * A finer clock for estimated vehicle positions. CSS eases each one-second step into the next, so
 * markers keep travelling between the less frequent provider refreshes instead of moving in bursts.
 */
export function useVehicleFeedNow(
  enabled = true,
  departureBoard: DepartureBoard | null = null,
): number {
  // Placements are compared against scheduled call times, which are the feed's, so this clock has
  // to be the feed's too — a marker read off the device clock would sit minutes out of place.
  return getFeedNow(departureBoard, useClockTick(VEHICLE_TICK_MS, enabled));
}

/** A boolean media query, updated only while the page is being read. */
function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);

  useEffect(() => {
    const queryList = window.matchMedia(query);
    const update = () => setMatches(queryList.matches);
    update();
    queryList.addEventListener("change", update);
    return () => queryList.removeEventListener("change", update);
  }, [query]);

  return matches;
}

/** Responsive composition belongs in the shell; components receive the resulting layout as data. */
export function useIsNarrowViewport(): boolean {
  return useMediaQuery(NARROW_VIEWPORT_QUERY);
}
