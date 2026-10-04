import assert from "node:assert/strict";
import test from "node:test";
import { getZentrumPlanOptionsFromStored } from "../src/lib/zentrum-plan-options.ts";

test("saved plan options use the current names", () => {
  assert.deepEqual(
    getZentrumPlanOptionsFromStored({
      vehiclePathMode: "ahead",
      unlitLineStyle: "trace",
      travelMeasure: "ride",
      initialView: "nearest",
    }),
    {
      vehiclePathMode: "ahead",
      unlitLineStyle: "trace",
      travelMeasure: "ride",
      initialView: "nearest",
    },
  );
});

test("plan options saved under earlier names are preserved", () => {
  assert.deepEqual(
    getZentrumPlanOptionsFromStored({ planWays: "ahead", callingLineStyle: "trace" }),
    {
      vehiclePathMode: "ahead",
      unlitLineStyle: "trace",
      travelMeasure: "arrival",
      initialView: "plan",
    },
  );
  assert.deepEqual(
    getZentrumPlanOptionsFromStored({
      vehiclePathMode: "off",
      planWays: "ahead",
      unlitLineStyle: "trace",
      callingLineStyle: "dots",
    }),
    {
      vehiclePathMode: "off",
      unlitLineStyle: "trace",
      travelMeasure: "arrival",
      initialView: "plan",
    },
  );
});

test("the previous plan option fields migrate to the current names", () => {
  assert.deepEqual(
    getZentrumPlanOptionsFromStored({
      overviewPaths: "ahead",
      destinationTime: "ride",
      openAt: "nearest",
      unlitLineStyle: "trace",
    }),
    {
      vehiclePathMode: "ahead",
      travelMeasure: "ride",
      initialView: "nearest",
      unlitLineStyle: "trace",
    },
  );
});

test("current option fields take precedence over legacy fields", () => {
  assert.deepEqual(
    getZentrumPlanOptionsFromStored({
      vehiclePathMode: "off",
      overviewPaths: "ahead",
      travelMeasure: "arrival",
      destinationTime: "ride",
      initialView: "plan",
      openAt: "nearest",
    }),
    {
      vehiclePathMode: "off",
      travelMeasure: "arrival",
      initialView: "plan",
      unlitLineStyle: "dots-muted",
    },
  );
});

test("missing, invalid and retired plan options take their defaults", () => {
  const retiredStyle = { unlitLineStyle: "dashes" };
  for (const stored of [null, "invalid", {}, { vehiclePathMode: true }, retiredStyle]) {
    assert.deepEqual(getZentrumPlanOptionsFromStored(stored), {
      vehiclePathMode: "off",
      unlitLineStyle: "dots-muted",
      travelMeasure: "arrival",
      initialView: "plan",
    });
  }
});
