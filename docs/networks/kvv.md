# KVV

The Karlsruher Verkehrsverbund: Karlsruhe, Rastatt, Baden-Baden, Pforzheim, the Enzkreis and the
Südpfalz. Its definition is [`src/networks/kvv/kvv-network.ts`](../../src/networks/kvv/kvv-network.ts);
the Zentrum plan and the region plan exist only for it.

## Scope

- Pool `kvv:` is KVV's own: observed, numbered, coloured from KVV's GTFS, given line pages. DB's
  S-Bahn Rhein-Neckar (`ddb:`), rail replacement (`rab:`) and other pools show on boards as other
  operators' lines.
- The area is 48.55–49.28 N, 7.75–8.90 E: Renchen, Lingenfeld, Dahn and Mühlacker in; the
  Ortenau, Speyer, Pirmasens and Stuttgart out. Stop search lists stops beyond it too, after
  equally good matches inside.
- TRIAS search wants the town for common names: `Stuttgart Hbf` finds it, `Hauptbahnhof` and
  `Schlossplatz` alone find nothing beyond Karlsruhe's own (`LOCATION_NORESULTS`).
- The feed prefixes Karlsruhe's stop names with `KA ` or `Karlsruhe `.
- Times carry seconds; about 80 % of timetabled and estimated times have non-zero seconds. Of 40
  Europaplatz departures, 28 had a prediction.

## Stop places

Every catalog stop has a stop place, derived by name and distance
([`generated/stop-places.ts`](../../src/networks/kvv/generated/stop-places.ts)). Eight join two
stop points:

| Place | Parts |
| --- | --- |
| Europaplatz | Oben `de:08212:37` (tram and bus bays), Unten `de:08212:1004` |
| Marktplatz | Kaiserstraße `de:08212:1003`, Pyramide `de:08212:1011` |
| Hauptbahnhof | Vorplatz `de:08212:89`, Bahnhof `de:08212:90` |
| Durlach Bahnhof | Bahnhof `de:08212:802`, Straßenbahn `de:08212:801` |

Kronenplatz, Durlacher Tor, Ettlinger Tor and Kongresszentrum each join an Unten (`(U)`) and an
Oben.
[`stop-place-overrides.ts`](../../src/networks/kvv/stop-place-overrides.ts) joins Durlach's two
(named `Bahnhof` and `Karlsruhe-Durlach`), names the stations' parts, and keeps Rüppurrer Tor's
former name, Mendelssohnplatz.

The Hauptbahnhof station part shows DB's regional trains (`ddb:`) as other operators' lines beside
KVV's.

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
  stations are `de:08212:1003_Parent`. It is the `fahrplandaten_ohne_liniennetz` variant, whose
  `shapes.txt` is empty; `fahrplandaten_mit_liniennetz/bwgesamt.zip` holds the line geometry
  (658 MB compressed, `shapes.txt` 3.5 GB unpacked; 4 October 2026).

`lineCount` and `callCount` count the timetable period's journeys, not calls per day: they rank
stops and must not be shown as a frequency. Journeys via a depot track (`E` and `TSNV` via
`Tullastraße (44)`) are left out of a bay's run.

## Line colours

`npm run refresh:line-colors` writes [`generated/line-colors.ts`](../../src/networks/kvv/generated/line-colors.ts):

- KVV's lines: `route_color` from KVV's own GTFS
  (`https://projekte.kvv-efa.de/GTFS/google_transit.zip`, CC0), which the statewide feed lacks. `E`
  needs its mode: VBK's tram red or AVG's rail green. KVV's open-data page asks for a signed usage
  agreement by email. Feed version 20261027 changed the whole palette (tram 1 `#ff0000` →
  `#e30613`).
- Other operators' lines: Träwelling's `line-colors.csv` (CC0, community-kept, by operator and line
  name), kept to the operators of [`operator-areas.ts`](../../src/networks/kvv/operator-areas.ts).
  A row's journey ends pick the operator: the area holding most ends outside Karlsruhe, a named
  district counting over a whole state. Ties and unknown areas stay neutral. Not covered on
  28 October 2026: RE40, RE45, RB41, RB44; RB51 is ambiguous.

VRN's GTFS `route_color` is a placeholder (every bus `0000FF`, rail empty); VVS's was unreachable.
