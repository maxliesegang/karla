# KVV GTFS reference

KVV publishes its scheduled timetable as a GTFS archive. KARLA reads it only offline, to generate
[`src/data/generated/kvv-stop-catalog.ts`](../src/data/generated/kvv-stop-catalog.ts) and the line
colours in [`src/data/line-signs.ts`](../src/data/line-signs.ts). Nothing in the app fetches it.

> [!IMPORTANT]
> This is the **planned** timetable for a period, not what is running. Every realtime claim stays
> with the EFA endpoints in [`kvv-efa-api.md`](./kvv-efa-api.md). Verified against the live archive
> on **28 August 2026**.

```text
https://projekte.kvv-efa.de/GTFS/google_transit.zip
```

21 MB compressed, 227 MB unpacked, served without authentication. Licensed CC0; KVV's
[open-data page](https://www.kvv.de/fahrplan/fahrplaene/open-data.html) additionally asks for a
signed usage agreement by email, which is worth settling before the dependency grows.

`feed_info.txt` dates each build. The archive read on 28 August 2026 stated `feed_version 20260828`
for the period `20260614`–`20261212`, and KVV rebuilds it close to daily.

## Members

| Member | Size | Used for |
| --- | --- | --- |
| `stop_times.txt` | 207 MB | Calls per station, joined through `trips.txt` |
| `trips.txt` | 10 MB | Trip → route |
| `transfers.txt` | 8.5 MB | Not used — see below |
| `stops.txt` | 587 KB | Platform → parent station |
| `routes.txt` | 62 KB | Line short names and `route_color` |
| `calendar.txt` | 107 KB | Not used; would be needed for a per-day frequency |

## Identity

GTFS names a station `Pde:08212:1011` where EFA names the same stop `de:08212:1011` — the same
national id under a `P`. The catalog joins the two sources on that id.

EFA's numeric ids relate to global ids by dropping a leading digit (`7000089` → `de:08212:89`), but
that is a property of the numbering rather than a rule either publisher states, so the generator
takes the pairing from EFA's own `XML_STOPLIST_REQUEST` output instead of reconstructing it.

## What it answers that EFA does not

Distinct lines and scheduled calls per station, for every stop at once. EFA answers the same
question through `XML_SERVINGLINES_REQUEST`, but one stop per request at roughly 30 KB each.

```text
lines  calls   stop
   33  23297   Hauptbahnhof (Vorplatz)
   29  27715   Entenfang
   24  17594   Poststraße
   22  24923   Durlach Bahnhof
   21  27307   Tullastraße/Alter Schlachthof
```

`calls` counts calls in the feed's trip set, not calls per day: a trip running two days a week is
counted once. It ranks stops against each other and must not be presented as a frequency.

## What it does not answer

**Places.** GTFS has no locality field. `parent_station` is one Haltestelle — Marktplatz is two
stations in GTFS exactly as it is in EFA — so which stops make up one place comes from EFA's
`omc`/`placeID`, which is why the generator reads both sources.

**Walking transfers.** `transfers.txt` holds 69,213 rows but only 230 cross-station pairs, 24 of
them in Karlsruhe, and it states just one of the five tunnel/street pairs in the Zentrum.

KARLA no longer needs them for stop identity. EFA answers both levels of such a place from either
stop id — a board requested for `7000037` and one for `7001004` come back with the same departures
at Europaplatz — so each place is one local stop. See `kvv-stop-mappings.ts`.

That does not make every change at such a place a step across the platform. `stops.txt` is the one
source here that states platform positions, and it is what showed that Europaplatz's `Gleis 3` and
`Gleis 5` are 107 m apart while its `Gleis 5` is 3 m from the tunnel's `Gleis 1(U)` — so distance
alone can neither part the street platforms nor keep the levels apart, since neither GTFS nor EFA
publishes a height. Which platforms are one place to stand is therefore read from the trips
themselves (`src/lib/boarding-places.ts`); these positions only order the merges.
