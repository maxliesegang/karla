import assert from "node:assert/strict";
import test from "node:test";
import { parseServiceNoticeResponse } from "../src/data/kvv-efa-parsers.ts";

/** The shape the operator answers with, reduced to the fields the parser reads. */
const createResponse = (entries: unknown[]) => ({
  additionalInformation: { travelInformations: { travelInformation: entries } },
});

const publishedEntry = {
  infoID: "100004213_KVV_ICSKVV",
  seqID: "3",
  publish: "1",
  valid: "1",
  deactivated: "false",
  priority: "normal",
  concernedLines: [{ number: "012" }, { number: "S11" }],
  concernedStops: [{ stopID: "7001224", name: "Am Lindscharren" }],
  validityPeriod: [
    {
      itdDateTime_From: {
        itdDate: { year: "2026", month: "7", day: "31" },
        itdTime: { hour: "21", minute: "0" },
      },
      itdDateTime_To: {
        itdDate: { year: "2026", month: "9", day: "11" },
        itdTime: { hour: "3", minute: "59" },
      },
    },
  ],
  infoLink: {
    infoLinkText: "Ettlingen: Umleitung wegen Bauarbeiten",
    infoLinkURL:
      "http://projekte.kvv-efa.de:80/cm/XSLT_CM_SHOWADDINFO_REQUEST?infoID=100004213_KVV_ICSKVV",
    htmlText:
      "<p><strong>Linien:</strong> 12, S11<br />Zeitraum: 31.07. bis 11.09.2026</p>\n" +
      "<p>Wegen Bauarbeiten in der Stra&szlig;e:<br />&bull;&nbsp;&nbsp;Umleitung &uuml;ber " +
      "Bruchhausen &ndash; Ettlingen<br />&bull; Haltestelle entf&#228;llt</p>",
  },
};

test("reads a published notice and leaves the withdrawn ones out", () => {
  const notices = parseServiceNoticeResponse(
    createResponse([
      publishedEntry,
      { ...publishedEntry, infoID: "withdrawn", valid: "0" },
      { ...publishedEntry, infoID: "unpublished", publish: "0" },
      { ...publishedEntry, infoID: "deactivated", deactivated: "true" },
    ]),
  );

  assert.equal(notices.length, 1);
  const [notice] = notices;
  assert.equal(notice.id, "100004213_KVV_ICSKVV@3");
  assert.equal(notice.title, "Ettlingen: Umleitung wegen Bauarbeiten");
  // The operator pads its own line numbers; a departure board does not.
  assert.deepEqual(notice.lineNumbers, ["12", "S11"]);
  assert.deepEqual(notice.concernedStops, [{ providerId: "7001224", name: "Am Lindscharren" }]);
  // The operator's page is closed to the public, so the full wording is taken from the reading
  // itself: its rich text becomes the paragraphs it was written in, and nothing else.
  assert.deepEqual(notice.details, [
    "Linien: 12, S11",
    "Zeitraum: 31.07. bis 11.09.2026",
    "Wegen Bauarbeiten in der Straße:",
    "• Umleitung über Bruchhausen – Ettlingen",
    "• Haltestelle entfällt",
  ]);
  assert.equal(notice.validFrom, "2026-07-31T19:00:00.000Z");
  assert.equal(notice.validUntil, "2026-09-11T01:59:00.000Z");
});
