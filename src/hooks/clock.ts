import { useEffect, useState } from "react";
import { getFeedNow } from "../lib/feed-clock";
import type { DepartureBoard } from "../data/transit-types";
import { isVisibleResumeEvent, type ResumeEventType } from "./refresh-backoff";

const VEHICLE_TICK_MS = 1_000;
/** Fine enough that a countdown turns over within seconds of its minute. */
const FEED_CLOCK_TICK_MS = 5_000;

/**
 * A wall clock ticking on each minute boundary, so the shown minute changes when the real one does.
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
 * A clock that ticks only while the page is visible, reading the time at once on return (via
 * `visibilitychange`, `pageshow` or `focus`, since resumed home-screen apps may skip the first).
 */
function useClockTick(intervalMs: number, isEnabled = true): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!isEnabled) return;
    let timer = 0;
    let resumeTimer = 0;
    const start = (resumeEventType?: ResumeEventType) => {
      window.clearInterval(timer);
      setNow(Date.now());
      if (
        document.visibilityState === "hidden" &&
        (!resumeEventType || !isVisibleResumeEvent(resumeEventType, document.visibilityState))
      )
        return;
      timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    };
    // Read a tick later, when the document's state matches the event.
    const resume = (event: Event) => {
      const eventType = event.type as ResumeEventType;
      window.clearTimeout(resumeTimer);
      resumeTimer = window.setTimeout(() => start(eventType));
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

/** The feed's clock, ticking: the device tick shifted by the board's fixed offset. */
export function useFeedNow(departureBoard: DepartureBoard | null): number {
  return getFeedNow(departureBoard, useClockTick(FEED_CLOCK_TICK_MS));
}

/** The device clock on the countdown cadence, for the age of readings (device timestamps). */
export function useDeviceNow(): number {
  return useClockTick(FEED_CLOCK_TICK_MS);
}

/** A finer feed clock for vehicle positions, so marks move between refreshes. */
export function useVehicleFeedNow(
  enabled = true,
  departureBoard: DepartureBoard | null = null,
): number {
  // Placements compare against the feed's call times, so this must be the feed's clock.
  return getFeedNow(departureBoard, useClockTick(VEHICLE_TICK_MS, enabled));
}
