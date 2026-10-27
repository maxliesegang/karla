import type { StopEvent, TransitLine } from "../../src/data/transit-types.ts";

/** A departure with every required field, for tests to override. */
export const createStopEvent = (overrides: Partial<StopEvent> = {}): StopEvent => ({
  id: "departure",
  lineId: "2",
  ptMode: "tram",
  destinationText: "Durlach",
  minutesUntilDeparture: 0,
  bay: "1",
  boardingStopPlaceId: "marktplatz",
  boardingStopPointId: "de:08212:1:1:1",
  boardingStopPointName: "Marktplatz",
  status: "realtime",
  timetabledDepartureTime: "2026-08-23T12:00:00Z",
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
