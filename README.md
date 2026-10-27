# KARLA

Karlsruher Abfahrten & Linien — a static React site showing the current state of a public
transport network, KVV's in Karlsruhe: the stops served in the Zentrum, a line index, and stop views
with live departures from the realtime feed. It is not a journey planner: no routing, no ticketing,
no accounts.

KARLA is not an official KVV service.

The rider-facing copy is German; the code and this document are English.

## Development

```bash
npm install
npm run dev     # reads the deployed proxy
npm test        # tests and build must pass
```

`npm run proxy` runs the TRIAS proxy locally on :8080 (`VITE_TRIAS_PROXY_URL=/api/ npm run dev`
uses it). It and the scripts run by hand (`refresh:stops`, `probe:trias`) need the requestor ref
in `.env.local` as `TRIAS_REQUESTOR_REF`.

## Addresses

Routing is hash-based, so every view is a shareable deep link. Each level of the selection chain
refines the one above it:

- `#/` — the home: search, recent stops, and the other pages
- `#/experiment` — the experiment page, opening its first map, the Zentrum plan
- `#/experiment/center/line/2` — the plan following one line
- `#/experiment/center/stop/marktplatz` — the plan read from one stop
- `#/experiment/center/full`, `#/experiment/center/full/line/2` — the plan at screen size
- `#/network` — the line index
- `#/nearby` — the six nearest observed stops after a location reading
- `#/settings` — where the app opens, whether it remembers stops, whether diagrams show other
  vehicles, and the data terms (not official, no KVV liability; NVBW timetable data)
- `#/stop/europaplatz` — a stop with its departure board
- `#/stop/hauptbahnhof/vorplatz` — the board of one part of a stop (below)
- `#/stop/europaplatz/line/2` — a line calling there, beside the board
- `#/stop/hochstetten/line/S1+S11` — two lines read together over the stretch they share
- `#/stop/europaplatz/line/2/journey/:journeyRef/:day` — one journey of that line, highlighted
- `#/stop/europaplatz/journey/:journeyRef/:day` — one journey opened from the stop board
- `#/journey/:journeyRef/:day` — that journey read on its own: the ride
- `#/journey/:journeyRef/:day/from/:stopId/to/:stopId` — the ride with where the rider got on and
  gets off; either part may be left out

A journey is addressed by TRIAS's `JourneyRef` and `OperatingDayRef`
(`#/journey/kvv:22311:E:H:s26:161/2026-10-27`). `#/line/2` names no stop; it opens the first stop
the line is seen calling at. Earlier address forms are not read.

A stop's id is its stop place's slug: the name before any `/` (`ettlinger-tor`), led by the
district outside Karlsruhe (`durlach-turmberg`). A stop beyond the catalog is `name--digest`.

### Parts of a stop

A stop place may join several stop points: Europaplatz's street and tunnel, Hauptbahnhof's
Vorplatz and station. Its board offers `Alle` and each part (`Straße`, `Tunnel`, `Vorplatz`,
`Bahnhof`); a part reads its own stop point's board, so it reaches as far ahead as that part
alone. On the whole place, each row names its part beside the bay. The part chosen last at a
place opens a bare stop address while stops are remembered; a line or journey link reads the whole
place.

With no address the app opens the stop last read, or the home for a reader with no history (the
*Beim Öffnen* setting can always open the home). It never opens on a location prompt. The *Nähe*
button locates on request and opens the closest stop; *Andere* opens `#/nearby` if that guess is
wrong. Recently read stops are listed under the search on the home.

## Station board mode

Unattended displays use the normal stop URL with a configuration before the hash:
`?display=stop#/stop/europaplatz` for the whole board, `?display=stop#/stop/hauptbahnhof/vorplatz`
for one part, `?display=platform&platform=2#/…` for one platform, `platform=2,3` for an island
pair. Platform names are normalised (`2`, `Gleis 2`,
`Bstg. 2` are the same platform), and the board prints the feed's own word (`Gleis` or `Bstg.`).

| Parameter | Effect |
| --- | --- |
| `rows=3…20` | fixed row count (default 8); type size follows the row height |
| `detail=note\|via\|off` | second line: operating note (default), else the route, or nothing |
| `minMinutes=0…30` | lead time; unreachable departures are not listed |
| `group=platform` | order by platform instead of by time |
| `reloadMinutes=15…10080` | self-reload so a deploy arrives (default 24 h) |

The board fills exactly one screen and pages instead of scrolling. If the configured platform is
not in the feed, it names the platforms actually reported.

## Data

`src/data/transit-source.ts` is the boundary between views and data. `TriasTransitSource` reads the
TRIAS interface through a thin PHP proxy (`proxy/`, deployed with the site to
`karla.app.liesegang.info`), which holds the access key: boards, dated journeys, line routes and
stop search, with times to the second; a stop's serving lines are learned from the journeys read.
The app shows no service notices for now; TRIAS's situations (`parseTriasSituations`) stay readable.
Failed reads retain the last complete reading and its age. Verified behaviour is recorded in
[`docs/trias-api.md`](docs/trias-api.md).

A build reads one network, chosen by `VITE_NETWORK` (default and only: `kvv`). What the app knows
about it beyond the feed lives in `src/networks/<id>/` ([`docs/networks/kvv.md`](docs/networks/kvv.md)):
the pools whose lines boards keep, the area stop search keeps, line colours, and the stop catalog
`npm run refresh:stops` writes from TRIAS and NVBW's GTFS. Stop places are derived from the
catalog (`src/lib/stop-places.ts`): stop points of one name before its bracket, in one district,
within 250 m, are one place. What that rule misses is in the network's `stop-place-overrides.ts`;
`npm run refresh:stop-places` writes the result. The Zentrum
(`src/data/zentrum-stops.ts`, `src/lib/zentrum-schematic-plan.ts`, solved by `npm run
solve:zentrum`) and the region plan exist only for KVV.

`src/lib/observed-network.ts` builds the served stops and lines from live journeys, so a line that
stops running leaves the view by itself.

### Bandwidth

- Opening a line reads the rider's stop again, filtered to that line's two directions: twenty rows
  of one line reach hours ahead, where an unfiltered busy board reaches minutes.
- The line's other stops are read filtered and without calls; each dated journey out on the line
  is then read once (`TripInfoRequest`).
- Boards refresh every 90 s on a line; dated journeys refresh on their own tolerance
  (`LINE_DATED_JOURNEY_READING_MAX_AGE_MS`).
- What a stop's journeys were observed to do is remembered for the visit (`StopCorridorPatterns`),
  so grouping does not depend on which detailed board happens to be in hand.

### Reading two lines together

A line view can add a sibling (`line/S1+S11`), so a corridor served by both reads at its real
frequency. It is not a merged line: S1 and S11 keep their signs, notices and addresses. A sibling is
offered only where this visit has observed both lines on the same route out of this stop for at
least three calls. The diagram draws a shared trunk and forks into one leg per line past the stop
they part at; a line ending at the junction is stated in words (*S11 endet in Busenbach*).

The Zentrum discovers observation posts from live journeys' calls: the last stop before each
exit, and arrival plus departure boards at internal termini. All area boards bootstrap the reading
and refresh every five minutes to discover changed routes. Learned posts refresh every 90 seconds,
filtered by rail direction; crowded boards receive separate direction reads to extend their horizon.
Dated journeys are retained within ten minutes of an area visit and two minutes after leaving it.

Boarding places share one stop name and board address; a stop point may hold several (Europaplatz's
street stop serves tram bays and bus bays 107 m apart). Bay coordinates and observed neighbouring
calls determine their grouping, including neighbours outside the map. Places with overlapping drawn
routes receive separate marks positioned from their geographic offsets; Gleise remain visible.
Corridors follow horizontal, vertical or 45° segments.

### Vehicle marks

Marks are placed from each dated journey's own calls, never from a position feed (TRIAS states
none). Pointing at or tapping a mark shows its destination. Marks standing at a terminus are drawn
quieter, since no position was measured; an arrival and the departure it turns into are drawn as one
standing mark where the narrow rules in `lib/line-turnarounds.ts` pair them.

### Directions

A direction is named by the place its corridor heads into (`Richtung Ettlingen`, not the headsign
`Ettlingen Albgaubad`); Karlsruhe districts count as places. Where a short working and its through
service share a route, both ends are named (`Richtung Ettlingen → Bad Herrenalb`).

### Honesty rules

- Countdowns are counted against the feed's clock, not the device's.
- Without a prediction a departure reads "nach Fahrplan"; realtime is never claimed.
- A failed refresh keeps the last readable board with its age ("Stand 14:03 · seit 6 Min ohne
  Aktualisierung"); past ten minutes the failure itself is the answer.
- Cancellations, diversions, and operating notes are shown, never hidden.
- Lines outside the verified colour set get a neutral badge.

## Installing it

The site is a PWA: `public/manifest.webmanifest` makes it installable, and `public/sw.js` caches the
app shell so a cold start works offline. **No departure is ever cached**: the worker does not answer
feed requests, so offline the app opens and states that it cannot refresh. The worker is registered
only in production builds and fetches the shell network-first, so a deploy arrives on the next
launch. Vite emits `vite-manifest.json` so the worker can precache the hashed bundle.

## Deployment

Every push to `main` is tested and built, then published to GitHub Pages and, with the proxy, to
All-Inkl (`karla.app.liesegang.info`) by `.github/workflows/deploy.yml`. **Settings → Pages →
Source** must be set to **GitHub Actions** once. The FTP login is a repository secret; the proxy's
requestor ref stays on the server ([proxy/README.md](proxy/README.md)).

## License

[MIT](./LICENSE) © Maximilian Liesegang
