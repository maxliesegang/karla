/**
 * Local stop ids stay stable and URL-friendly; KVV EFA ids are provider ids and must not leak into
 * routes or views.
 *
 * One local id is one page, not one stop point. Where a place has a tunnel platform and a street
 * platform, EFA answers both from either id — a board requested for `7000037` and one requested for
 * `7001004` come back with the same departures at Europaplatz, row for row, whether
 * `useProxFootSearch` is `0` or left off entirely. There is no parameter that separates them, so a
 * second page for the second id would be the same board under another address; the two are one
 * entry here, requested by the id below, and the board is split where it is read
 * (`lib/boarding-places.ts`).
 *
 * What that split may *not* be read from is the platform code. The tunnel signs itself `1(U)`,
 * `2(U)` against the street's `3`–`6`, which looks like the whole answer until Europaplatz's four
 * street platforms turn out to be two boarding places 110 m apart: line 4 to Oberreut calls at
 * `Gleis 3` at 08:58 and at `Gleis 5` at 08:59, one vehicle, one stop point, two places to stand.
 * The stop point states the level; only the trips themselves state the rest.
 *
 * Verified against https://projekte.kvv-efa.de/sl3-alone/XSLT_STOPFINDER_REQUEST on 21/22 August
 * 2026; the merged boards re-verified against XSLT_DM_REQUEST on 28 August 2026, and the double
 * calls at Marktplatz and Europaplatz against XML_TRIPSTOPTIMES_REQUEST on 4 September 2026.
 */
export type KvvStopMapping = {
  /** EFA stop id queried for departures. */
  providerStopId: string;
  /**
   * How many rows to ask this stop's board for, where the default is not enough.
   *
   * The default is the whole bandwidth budget and is right for a stop with one boarding place. A
   * place that spans several shares those rows between them — Europaplatz answered 40 rows as 30
   * street and 10 tunnel, and its street trips are each published twice, once at either boarding
   * place — so a rider walking to one of them reads a handful of rows about it. Stated per stop
   * rather than raised for everything: the extra rows are only owed where the board is shared.
   */
  departureLimit?: number;
  /**
   * The place's other EFA stop points, which are this same local stop.
   *
   * A board is only ever requested for the id above, but a trip calls at the level it runs on: the
   * S1 through the Kaiserstraße tunnel calls at Europaplatz's `7001004`, never at the `7000037` its
   * page is asked for. Left unlisted, that calling point resolves to a stop of its own, and the
   * trip the rider is watching leaves from a stop the page has never heard of — no corridor is
   * read for it, no diagram places it, and the row falls back to its headsign.
   */
  otherProviderStopIds?: readonly string[];
};

export const kvvStopMappingByLocalStopId: Record<string, KvvStopMapping> = {
  "muehlburger-tor": { providerStopId: "7000039" },
  // Four boarding places: the tunnel, the two street pairs the trams call at in turn, and the bus
  // bay. See the module note above for why the street pair cannot be read off the platform code.
  europaplatz: { providerStopId: "7000037", otherProviderStopIds: ["7001004"], departureLimit: 40 },
  // The Kaiserstraße tunnel platform and, on the north–south axis beneath the pyramid, `7001011`.
  // Two boarding places, and a trip calls at both: the S1 to Hochstetten is published at Pyramide
  // `4(U)` and again at Kaiserstraße `1(U)`, which is a walk between tunnels and not a repeat.
  marktplatz: { providerStopId: "7001003", otherProviderStopIds: ["7001011"], departureLimit: 40 },
  kronenplatz: { providerStopId: "7001002", otherProviderStopIds: ["7000080"] },
  "durlacher-tor": { providerStopId: "7001001", otherProviderStopIds: ["7000003"] },
  karlstor: { providerStopId: "7000061" },
  mathystrasse: { providerStopId: "7000062" },
  kolpingplatz: { providerStopId: "7000063" },
  ebertstrasse: { providerStopId: "7000091" },
  albtalbahnhof: { providerStopId: "7001201" },
  // The station's own stop point, not the Vorplatz: `7000089` answers with the Vorplatz tram stop
  // alone, while `7000090` answers with both, which is what a rider at the Hauptbahnhof is asking.
  hauptbahnhof: {
    providerStopId: "7000090",
    otherProviderStopIds: ["7000089"],
    departureLimit: 40,
  },
  "ettlinger-tor": { providerStopId: "7001012", otherProviderStopIds: ["7000071"] },
  kongresszentrum: { providerStopId: "7001013", otherProviderStopIds: ["7000072"] },
  augartenstrasse: { providerStopId: "7000074" },
  "rueppurrer-tor": { providerStopId: "7000085" },
  tivoli: { providerStopId: "7000084" },
  // Verified against XSLT_STOPFINDER_REQUEST on 22 August 2026. These carry the eastern, western and
  // southern edges of the Zentrum, so they are mapped rather than left to be registered from a trip:
  // a stop the Zentrum is listed to cover needs an id that does not depend on how it was discovered.
  werderstrasse: { providerStopId: "7000083" },
  poststrasse: { providerStopId: "7000098" },
  ostendstrasse: { providerStopId: "7000622" },
  "karl-wilhelm-platz": { providerStopId: "7000401" },
  "gottesauer-platz": { providerStopId: "7000006" },
  zkm: { providerStopId: "7000065" },
  welfenstrasse: { providerStopId: "7006218" },
  barbarossaplatz: { providerStopId: "7005003" },
  arbeitsagentur: { providerStopId: "7000064" },
  lessingstrasse: { providerStopId: "7000507" },
  "otto-sachs-strasse": { providerStopId: "7000508" },
  // The reach posts. These are outside the Zentrum and no page lists them as part of it; they are
  // here because an observation post has to be addressable by an id that does not depend on having
  // already been discovered, which is the same reason the Zentrum's own edges are mapped above.
  // Verified against XSLT_DM_REQUEST on 29 August 2026.
  //
  // The station and the tram stop in front of it answer with the same twenty departures — verified
  // row for row — so they are one place here, exactly as Europaplatz and the Hauptbahnhof are.
  "durlach-bahnhof": { providerStopId: "7000802", otherProviderStopIds: ["7000801"] },
  rheinbergstrasse: { providerStopId: "7000107" },
  entenfang: { providerStopId: "7000051" },
  zuendhuetle: { providerStopId: "7004492" },
  turmberg: { providerStopId: "7000018" },
};
