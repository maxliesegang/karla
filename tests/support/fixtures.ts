import type { Departure, TransitLine } from "../../src/data/transit-types.ts";

/**
 * A departure with every field the type requires, for tests to override what they are about.
 *
 * One maker rather than one per test file, so a field the type starts requiring is added once
 * instead of drifting out of two dozen hand-written copies.
 */
export const createDeparture = (overrides: Partial<Departure> = {}): Departure => ({
  id: "departure",
  lineId: "2",
  transportMode: "tram",
  destination: "Durlach",
  minutesUntilDeparture: 0,
  platformCode: "1",
  boardingLocalStopId: "marktplatz",
  boardingProviderStopPointId: "de:08212:1:1:1",
  boardingProviderStopPointName: "Marktplatz",
  status: "realtime",
  scheduledDepartureTime: "2026-08-23T12:00:00Z",
  ...overrides,
});

/** A line sign with every field the type requires. */
export const createLine = (overrides: Partial<TransitLine> = {}): TransitLine => ({
  id: "2",
  name: "2",
  color: "#000",
  textColor: "#fff",
  destinations: [],
  zentrumCalls: [],
  ...overrides,
});
