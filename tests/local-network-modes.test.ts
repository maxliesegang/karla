import assert from "node:assert/strict";
import test from "node:test";
import { KvvEfaClient } from "../src/data/kvv-efa-client.ts";
import { parseDepartureBoardResponse } from "../src/data/kvv-efa-parsers.ts";

function boardPayload() {
  return {
    departureList: [
      {
        stopID: "7000090",
        dateTime: { year: "2026", month: "8", day: "30", hour: "10", minute: "0" },
        servingLine: { motType: "4", symbol: "3", number: "3", direction: "Rintheim" },
      },
      {
        stopID: "7000090",
        dateTime: { year: "2026", month: "8", day: "30", hour: "10", minute: "2" },
        servingLine: { motType: "6", symbol: "SEV", number: "SEV", direction: "Bruchsal" },
      },
      {
        stopID: "7000090",
        dateTime: { year: "2026", month: "8", day: "30", hour: "10", minute: "5" },
        servingLine: { motType: "0", number: "ICE 106", symbol: "", direction: "Hamburg-Altona" },
      },
      {
        stopID: "7000090",
        dateTime: { year: "2026", month: "8", day: "30", hour: "10", minute: "9" },
        servingLine: { motType: "7", symbol: "N1912", number: "N1912", direction: "Berlin" },
      },
    ],
    servingLines: {
      lines: [
        { mode: { type: "4", diva: { stateless: "kvv:21003:E:H:s26" } } },
        { mode: { type: "7", diva: { stateless: "kvv:flix:N1912:H:s26" } } },
      ],
    },
  };
}

test("a board keeps the local network and leaves long-distance rail and coaches out", () => {
  const board = parseDepartureBoardResponse(boardPayload(), "7000090");

  assert.deepEqual(
    board.departures.map((departure) => departure.lineId),
    ["3", "SEV"],
  );
});

test("long-distance serving directions are not recorded as directions to go and read", () => {
  const board = parseDepartureBoardResponse(boardPayload(), "7000090");

  assert.deepEqual(board.servingDirectionIds, ["kvv:21003:E:H:s26"]);
});

test("the departure monitor asks for tram, Stadtbahn and bus only", async () => {
  let requestedUrl: URL | undefined;
  const client = new KvvEfaClient({
    departureEndpoint: "https://example.test/XSLT_DM_REQUEST",
    fetchFn: async (input) => {
      requestedUrl = new URL(String(input));
      return new Response(JSON.stringify({ departureList: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  await client.fetchDepartureBoard("7000090");

  const parameters = requestedUrl?.searchParams;
  assert.equal(parameters?.get("includedMeans"), "checkbox");
  assert.equal(parameters?.get("std3_commonMacro"), "dm");
  assert.equal(parameters?.get("std3_inclMOT_1Macro"), "true");
  assert.equal(parameters?.get("std3_inclMOT_4Macro"), "true");
  assert.equal(parameters?.get("std3_inclMOT_5Macro"), "true");
  assert.equal(parameters?.get("std3_inclMOT_0Macro"), null);
});
