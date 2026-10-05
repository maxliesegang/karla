/**
 * Local stop ids (stable, URL-friendly) mapped to KVV EFA ids, which never reach routes or views.
 *
 * One local id is one page. EFA answers a whole complex from any of its ids, with no parameter to
 * separate tunnel and street (Europaplatz's `7000037` and `7001004` return identical boards), so a
 * complex is one entry and its board is split in `lib/boarding-places.ts`, by observed trips rather
 * than platform codes: Europaplatz's street platforms are two places 110 m apart (line 4 calls at
 * `Gleis 3` at 08:58 and `Gleis 5` at 08:59).
 *
 * Verified against XSLT_STOPFINDER_REQUEST on 21/22 August 2026, XSLT_DM_REQUEST on 28 August 2026,
 * and XML_TRIPSTOPTIMES_REQUEST on 4 September 2026.
 */
export type KvvStopMapping = {
  /** EFA stop id queried for departures. */
  providerStopId: string;
  /**
   * Rows to ask this stop's board for where the default is not enough: a complex shares its rows
   * between places (Europaplatz: 30 street, 10 tunnel, street trips listed twice).
   */
  departureLimit?: number;
  /**
   * The complex's other EFA stop points. Trips call at the level they run on (the S1 calls at
   * Europaplatz's `7001004`), so unlisted points would resolve to a separate stop.
   */
  otherProviderStopIds?: readonly string[];
};

export const kvvStopMappingByLocalStopId: Record<string, KvvStopMapping> = {
  "muehlburger-tor": { providerStopId: "7000039" },
  // Four places: the tunnel, two street pairs, the bus bay.
  europaplatz: { providerStopId: "7000037", otherProviderStopIds: ["7001004"], departureLimit: 40 },
  // Kaiserstraße tunnel and, beneath the pyramid, `7001011`; the S1 calls at both (Pyramide `4(U)`,
  // then Kaiserstraße `1(U)`).
  marktplatz: { providerStopId: "7001003", otherProviderStopIds: ["7001011"], departureLimit: 40 },
  kronenplatz: { providerStopId: "7001002", otherProviderStopIds: ["7000080"] },
  "durlacher-tor": { providerStopId: "7001001", otherProviderStopIds: ["7000003"] },
  karlstor: { providerStopId: "7000061" },
  mathystrasse: { providerStopId: "7000062" },
  kolpingplatz: { providerStopId: "7000063" },
  ebertstrasse: { providerStopId: "7000091" },
  albtalbahnhof: { providerStopId: "7001201" },
  // The station's stop point: `7000089` answers with the Vorplatz tram stop only, `7000090` with
  // both.
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
  // Verified 22 August 2026. The Zentrum's edges are mapped so their ids do not depend on
  // discovery.
  werderstrasse: { providerStopId: "7000083" },
  poststrasse: { providerStopId: "7000098" },
  ostendstrasse: { providerStopId: "7000622" },
  "karl-wilhelm-platz": { providerStopId: "7000401" },
  "gottesauer-platz": { providerStopId: "7000006" },
  tullastrasse: { providerStopId: "7000007" },
  "wolfartsweierer-strasse": { providerStopId: "7000623" },
  "schloss-gottesaue": { providerStopId: "7000624" },
  zkm: { providerStopId: "7000065" },
  welfenstrasse: { providerStopId: "7006218" },
  barbarossaplatz: { providerStopId: "7005003" },
  arbeitsagentur: { providerStopId: "7000064" },
  lessingstrasse: { providerStopId: "7000507" },
  "otto-sachs-strasse": { providerStopId: "7000508" },
  // Reach posts, mapped so they are addressable before discovery. Verified 29 August 2026. The
  // station and the tram stop in front answer with identical boards, so they are one place.
  "durlach-bahnhof": { providerStopId: "7000802", otherProviderStopIds: ["7000801"] },
  rheinbergstrasse: { providerStopId: "7000107" },
  entenfang: { providerStopId: "7000051" },
  zuendhuetle: { providerStopId: "7004492" },
  turmberg: { providerStopId: "7000018" },
};
