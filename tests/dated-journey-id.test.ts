import assert from "node:assert/strict";
import test from "node:test";
import { getDatedJourneyId, parseDatedJourneyId } from "../src/data/feed.ts";

test("a dated journey id reads back as its journey and operating day", () => {
  const journey = { journeyRef: "kvv:21005:E:R:s26:302", operatingDayRef: "2026-10-28" };
  assert.deepEqual(parseDatedJourneyId(getDatedJourneyId(journey)), journey);
});

test("an id naming no operating day is no dated journey", () => {
  assert.equal(parseDatedJourneyId("kvv:21005:E:R:s26:302"), undefined);
  assert.equal(parseDatedJourneyId("arrival:row@europaplatz"), undefined);
  assert.equal(parseDatedJourneyId("@2026-10-28"), undefined);
});
