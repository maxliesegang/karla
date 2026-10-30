/**
 * A stop place's parts (`StopPlace.parts`): its stop points as a rider tells them apart (`Unten`,
 * `Vorplatz`), and by which a board is filtered. A place of one stop point has none.
 */
import type { StopPlace, StopPlacePart } from "../data/transit-types";
import { appSettings } from "./app-settings";
import { createStoredPreference } from "./stored-preference";

const NO_PARTS: readonly StopPlacePart[] = [];

export const getStopPlaceParts = (stop: StopPlace | undefined): readonly StopPlacePart[] =>
  stop?.parts ?? NO_PARTS;

export const findStopPlacePart = (stop: StopPlace | undefined, partId: string | undefined) =>
  partId ? getStopPlaceParts(stop).find(({ id }) => id === partId) : undefined;

/**
 * The part a board is read at: the addressed one, else the one last chosen there, which answers
 * only a bare stop; an addressed line or journey reads the whole place.
 */
export function findReadStopPlacePart(
  stop: StopPlace | undefined,
  { partId, lineId, addressId }: { partId: string; lineId: string; addressId?: string },
  chosenParts: Readonly<Record<string, string>>,
): StopPlacePart | undefined {
  if (!stop) return undefined;
  return findStopPlacePart(
    stop,
    partId || (lineId || addressId ? undefined : chosenParts[stop.id]),
  );
}

/** The part a row leaves from, on a place with parts. */
export const findStopPointPart = (stop: StopPlace | undefined, stopPointId: string) =>
  getStopPlaceParts(stop).find((part) => part.stopPointId === stopPointId);

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
