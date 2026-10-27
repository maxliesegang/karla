/**
 * A stop place's parts: its stop points as a rider tells them apart (`Tunnel`, `Vorplatz`), and
 * by which a board is filtered. A place of one stop point has none.
 */
import { network } from "../networks/network";
import { appSettings } from "./app-settings";
import { createStopSlug } from "./stop-slug";
import { createStoredPreference } from "./stored-preference";

export type StopPlacePart = {
  /** Its address (`vorplatz`). */
  id: string;
  name: string;
  stopPointId: string;
};

const NO_PARTS: readonly StopPlacePart[] = [];

const partsByStopId = new Map(
  Object.entries(network.stopPlaces).flatMap(([stopId, { stopPoints, parts }]) =>
    parts
      ? [
          [
            stopId,
            stopPoints.map((stopPointId, index) => ({
              id: createStopSlug(parts[index]),
              name: parts[index],
              stopPointId,
            })),
          ] as const,
        ]
      : [],
  ),
);

export const getStopPlaceParts = (stopId: string): readonly StopPlacePart[] =>
  partsByStopId.get(stopId) ?? NO_PARTS;

export const findStopPlacePart = (stopId: string, partId: string | undefined) =>
  partId ? getStopPlaceParts(stopId).find(({ id }) => id === partId) : undefined;

/** The part a row leaves from, on a place with parts. */
export const findStopPointPart = (stopId: string, stopPointId: string) =>
  getStopPlaceParts(stopId).find((part) => part.stopPointId === stopPointId);

/** The part last chosen at each place, by stop id; kept while the rider lets stops be remembered. */
export const chosenStopPlaceParts = createStoredPreference<Readonly<Record<string, string>>>({
  key: "karla:stop-place-parts",
  parse: (stored) => {
    const parsed: unknown = stored ? JSON.parse(stored) : {};
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  },
  serialize: JSON.stringify,
});

/** Keeps a place's chosen part, or forgets it for the whole place; only while stops are remembered. */
export function chooseStopPlacePart(stopId: string, partId: string | undefined): void {
  if (!appSettings.read().isRememberingStops) return;
  const { [stopId]: _previous, ...others } = chosenStopPlaceParts.read();
  chosenStopPlaceParts.write(partId ? { ...others, [stopId]: partId } : others);
}

export function forgetChosenStopPlaceParts(): void {
  if (Object.keys(chosenStopPlaceParts.read()).length > 0) chosenStopPlaceParts.write({});
}
