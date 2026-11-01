import type { StopEvent } from "../data/transit-types";
import { isSameDatedJourney } from "./journeys";

/**
 * What a view remembers of the journeys it has drawn, so each mark enters once per view and a
 * refresh shows only on marks whose reading changed.
 */

export type PresentedMark = {
  /** The element's `data-marker-key`. */
  key: string;
  stopEvent: StopEvent;
  /** The stop place the mark is heading to, where its delay is read; else the row's delay. */
  toStopId?: string;
};

/** `enter`: the journey is new to the view. `update`: its delay moved or live data arrived. */
export type MarkPresenceEvent = "enter" | "update";

type Sighting = { identities: ReadonlySet<string>; stopEvent: StopEvent; drawnAt: number };

export type MarkPresence = {
  /** Records the marks drawn now and returns what each should show; layers may share one record. */
  note: (marks: readonly PresentedMark[], now: number) => Map<string, MarkPresenceEvent>;
};

// Any identifier boards share settles the journey, as in `isSameDatedJourney`; the mark key keeps
// a turnaround or a joined mark's portions together.
const getIdentities = ({ key, stopEvent }: PresentedMark): string[] => [
  `mark:${key}`,
  `event:${stopEvent.id}`,
  ...(stopEvent.datedJourneyId ? [`journey:${stopEvent.datedJourneyId}`] : []),
  ...(stopEvent.journeyRef ? [`ref:${stopEvent.journeyRef}`] : []),
];

const hasPrediction = ({ calls, delayMinutes }: StopEvent): boolean =>
  calls?.length
    ? calls.some((call) => (call.arrivalDelayMinutes ?? call.delayMinutes) !== undefined)
    : delayMinutes !== undefined;

const getHeadingDelay = (stopEvent: StopEvent, toStopId?: string): number | undefined => {
  const call = stopEvent.calls?.find(({ stopPlaceId }) => stopPlaceId === toStopId);
  return call ? (call.arrivalDelayMinutes ?? call.delayMinutes) : stopEvent.delayMinutes;
};

export function hasMarkReadingChanged(
  previous: StopEvent,
  next: StopEvent,
  toStopId?: string,
): boolean {
  if (!hasPrediction(previous)) return hasPrediction(next);
  const previousDelay = getHeadingDelay(previous, toStopId);
  const nextDelay = getHeadingDelay(next, toStopId);
  return (
    previousDelay !== undefined &&
    nextDelay !== undefined &&
    Math.abs(nextDelay - previousDelay) >= 1
  );
}

/** A journey not drawn for `graceMs` enters again; a feed dropping it for a refresh does not. */
export function createMarkPresence(graceMs: number): MarkPresence {
  const sightingByIdentity = new Map<string, Sighting>();
  return {
    note(marks, now) {
      const events = new Map<string, MarkPresenceEvent>();
      for (const mark of marks) {
        const identities = getIdentities(mark);
        const seen = identities
          .map((identity) => sightingByIdentity.get(identity))
          .find((sighting) => sighting && now - sighting.drawnAt <= graceMs);
        if (!seen) events.set(mark.key, "enter");
        else if (
          seen.stopEvent !== mark.stopEvent &&
          isSameDatedJourney(seen.stopEvent, mark.stopEvent) &&
          hasMarkReadingChanged(seen.stopEvent, mark.stopEvent, mark.toStopId)
        ) {
          events.set(mark.key, "update");
        }
        const sighting: Sighting = {
          identities: new Set([...(seen?.identities ?? []), ...identities]),
          stopEvent: mark.stopEvent,
          drawnAt: now,
        };
        for (const identity of sighting.identities) sightingByIdentity.set(identity, sighting);
      }
      for (const [identity, sighting] of sightingByIdentity) {
        if (now - sighting.drawnAt > graceMs) sightingByIdentity.delete(identity);
      }
      return events;
    },
  };
}
