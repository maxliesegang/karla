import type { Departure } from "../data/transit-types";

export function formatPositionDataAge(readAt: number | undefined, now: number): string {
  if (readAt === undefined) return "Datenalter unbekannt";
  const seconds = Math.max(0, Math.floor((now - readAt) / 1_000));
  return `${seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min`} alt`;
}

/** Position evidence belongs to the calls, independently of the row's prediction. */
export function getVehiclePositionSourceLabel(
  run: Departure,
  now: number,
  fromStopId?: string,
  toStopId?: string,
): string {
  const calls = run.tripCalls ?? [];
  const hasPrediction = calls.some(
    (call) => call.delayMinutes !== undefined || call.arrivalDelayMinutes !== undefined,
  );
  const index = calls.findIndex(
    (call, index) => call.localStopId === fromStopId && calls[index + 1]?.localStopId === toStopId,
  );
  const from = calls[index];
  const to = calls[index + 1];
  const hasStatedEndpoints =
    (from?.delayMinutes ?? from?.arrivalDelayMinutes) !== undefined &&
    (to?.arrivalDelayMinutes ?? to?.delayMinutes) !== undefined;
  const source = !hasPrediction
    ? "nach Fahrplan"
    : index >= 0 && !hasStatedEndpoints
      ? "mit fortgeschriebener Prognose"
      : "nach Echtzeitprognose";
  if (run.readAt?.sequenceRefreshFailedAt === undefined) return source;
  const age = formatPositionDataAge(run.readAt.coverageReadAt ?? run.readAt.sequenceReadAt, now);
  return `${source} · ${age} · Aktualisierung fehlgeschlagen`;
}
