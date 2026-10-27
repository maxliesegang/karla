# KVV

The Karlsruher Verkehrsverbund: Karlsruhe, Rastatt, Baden-Baden, Pforzheim, the Enzkreis and the
Südpfalz. Its definition is [`src/networks/kvv/kvv-network.ts`](../../src/networks/kvv/kvv-network.ts);
the Zentrum plan and the region plan exist only for it.

## Scope

- Pool `kvv:` only. DB's S-Bahn Rhein-Neckar (`ddb:`) and rail replacement (`rab:`) share KVV's
  modes and stay out.
- Stop search keeps stops inside 48.55–49.28 N, 7.75–8.90 E: Renchen, Lingenfeld, Dahn and
  Mühlacker in; the Ortenau, Speyer, Pirmasens and Stuttgart out.
- The feed prefixes Karlsruhe's stop names with `KA ` or `Karlsruhe `.
- Times carry seconds; about 80 % of timetabled and estimated times have non-zero seconds. Of 40
  Europaplatz departures, 28 had a prediction.

## Stop places

The authored stop places are in [`stop-places.ts`](../../src/networks/kvv/stop-places.ts): the
Zentrum's stops and the observation posts, each with fixed slugs. Where one place is two stops in
the feed, the place lists both:

| Place | Stop points |
| --- | --- |
| Europaplatz | street and bus bays `de:08212:37`, tunnel `de:08212:1004` |
| Marktplatz | Kaiserstraße tunnel `de:08212:1003`, Pyramide tunnel `de:08212:1011` |
| Hauptbahnhof | station `de:08212:90`, Vorplatz tram stop `de:08212:89` |
| Durlach Bahnhof | station `de:08212:802`, tram stop `de:08212:801` |

Kronenplatz, Durlacher Tor, Ettlinger Tor and Kongresszentrum each join a tunnel and a street stop.

Height is in no source. Europaplatz's `Gleis 3` and `Gleis 5` are 107 m apart, while `Gleis 5` is
3 m from the tunnel's `Gleis 1(U)`, so distance cannot decide boarding places; they are read from
journeys (`src/lib/boarding-places.ts`).

## Catalog

`npm run refresh:stops` writes [`generated/`](../../src/networks/kvv/generated/) for the
municipality of Karlsruhe (`de:08212:`):

- **Stops** from a TRIAS sweep by rectangle: DHID, name, position and district (`Durlach`,
  `Neureut (Karlsruhe)`). 381 stops in October 2026; depot and turning points are not listed.
- **Service, line days, bay runs and positions** from NVBW's statewide GTFS
  (`bwgesamt.zip`, Datenlizenz Deutschland – Namensnennung 2.0), kept to `kvv-` routes. 54 MB
  compressed, 777 MB unpacked. Its `platform_code` carries the kind word (`Gleis 1(U)`), and its
  stations are `de:08212:1003_Parent`.

`lineCount` and `callCount` count the timetable period's journeys, not calls per day: they rank
stops and must not be shown as a frequency. Journeys via a depot track (`E` and `TSNV` via
`Tullastraße (44)`) are left out of a bay's run.

## Line colours

[`line-colors.ts`](../../src/networks/kvv/line-colors.ts) holds `route_color` from KVV's own GTFS
(`https://projekte.kvv-efa.de/GTFS/google_transit.zip`, CC0), which the statewide feed lacks. `E`
needs its mode: VBK's tram red or AVG's rail green. KVV's open-data page asks for a signed usage
agreement by email.
