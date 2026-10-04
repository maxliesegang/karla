import assert from "node:assert/strict";
import test from "node:test";
import { getZentrumExperimentsFromStored } from "../src/lib/zentrum-experiments.ts";

test("saved experiment choices use the current names", () => {
  assert.deepEqual(
    getZentrumExperimentsFromStored({
      overviewPaths: "ahead",
      unlitLineStyle: "dashes",
      destinationTime: "ride",
      openAt: "nearest",
    }),
    {
      overviewPaths: "ahead",
      unlitLineStyle: "dashes",
      destinationTime: "ride",
      openAt: "nearest",
    },
  );
});

test("experiment choices saved under earlier names are preserved", () => {
  assert.deepEqual(
    getZentrumExperimentsFromStored({ planWays: "ahead", callingLineStyle: "dots" }),
    { overviewPaths: "ahead", unlitLineStyle: "dots", destinationTime: "arrival", openAt: "plan" },
  );
  assert.deepEqual(
    getZentrumExperimentsFromStored({
      overviewPaths: "off",
      planWays: "ahead",
      unlitLineStyle: "trace",
      callingLineStyle: "dots",
    }),
    { overviewPaths: "off", unlitLineStyle: "trace", destinationTime: "arrival", openAt: "plan" },
  );
});

test("missing and invalid experiment choices take their defaults", () => {
  for (const stored of [null, "invalid", {}, { overviewPaths: true, unlitLineStyle: "invalid" }]) {
    assert.deepEqual(getZentrumExperimentsFromStored(stored), {
      overviewPaths: "off",
      unlitLineStyle: "dots-muted",
      destinationTime: "arrival",
      openAt: "plan",
    });
  }
});
