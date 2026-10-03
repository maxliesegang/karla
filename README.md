# KARLA

Karlsruher Abfahrten & Linien — a static React site showing the current state of the Karlsruhe
public transport network: the stops served in the Zentrum, a line index, and stop views with live
departures from the KVV realtime feed. It is not a journey planner: no routing, no ticketing, no
accounts.

The rider-facing copy is German; the code and this document are English.

## Development

```bash
npm install
npm run dev
```

## Addresses

Routing is hash-based, so every view is a shareable deep link. Each level of the selection chain
refines the one above it:

- `#/` — the home: search, recent stops, and the other pages
- `#/center` — the Zentrum's plan
- `#/center/line/2` — the plan following one line
- `#/center/full`, `#/center/full/line/2` — the plan at screen size
- `#/network` — the line index
- `#/nearby` — the six nearest observed stops after a location reading
- `#/notices` — KVV's published notices relevant to the KARLA network
- `#/settings` — where the app opens, whether it remembers stops, whether diagrams show other vehicles
- `#/stop/europaplatz` — a stop with its departure board
- `#/stop/europaplatz/line/2` — a line calling there, beside the board
- `#/stop/hochstetten/line/S1+S11` — two lines read together over the stretch they share
- `#/stop/europaplatz/line/2/trip/:tripId` — one trip of that line, highlighted
- `#/stop/europaplatz/trip/:tripId` — one trip opened from the stop board
- `#/trip/:tripId` — that trip read on its own: the ride
- `#/trip/:tripId/from/:stopId/to/:stopId` — the ride with where the rider got on and gets off;
  either part may be left out

`#/line/2` names no stop; it opens the first stop the line is seen calling at. Legacy links
(`#/stop/…/lines`, `#/departure/…`, `#/ride/…`, `#/network/city`, `#/center/stops`) still resolve
and are rewritten; `line/S1-S11` is read as the bundle `S1+S11`.

With no address the app opens the stop last read, or the home for a reader with no history (the
*Beim Öffnen* setting can always open the home). It never opens on a location prompt. The *Nähe*
button locates on request and opens the closest stop; *Andere* opens `#/nearby` if that guess is
wrong. Recently read stops are listed under the search on the home.

## Station board mode

Unattended displays use the normal stop URL with a configuration before the hash:
`?display=stop#/stop/europaplatz` for the whole board, `?display=platform&platform=2#/…` for one
platform, `platform=2,3` for an island pair. Platform names are normalised (`2`, `Gleis 2`,
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

`src/data/transit-source.ts` is the boundary between views and data; `KvvTransitSource` reads the
EFA departure monitor, stop search, and published notices at `https://projekte.kvv-efa.de/sl3-alone/`.
Those endpoints allow cross-origin reads, so the site needs no backend, proxy, or secret. Verified
endpoint behaviour is recorded in [`docs/kvv-efa-api.md`](docs/kvv-efa-api.md).

Boards are asked for the local network only (Stadtbahn, S-Bahn, tram, bus). Long-distance coaches
and lines from other operators' data pools, which share those mode groups, are dropped when the
answer is parsed.

`src/lib/observed-network.ts` builds the served stops and lines from live trips, so a line that
stops running leaves the view by itself. The only authored data is which stops count as the Zentrum
(`src/data/zentrum-stops.ts`), the Zentrum's drawing (`src/lib/zentrum-schematic-plan.ts`, solved by
`npm run solve:zentrum`), and the KVV line colours from GTFS (`src/data/line-signs.ts`). The stop
catalog in `src/data/generated/` is written by `npm run refresh:stops` from EFA and GTFS
([`docs/kvv-gtfs.md`](docs/kvv-gtfs.md)).

### Bandwidth

- Opening a line reads the rider's stop again, filtered to that line's two directions: twenty rows
  of one line reach hours ahead, where an unfiltered busy board reaches minutes.
- The line's other stops are read filtered and without calling sequences; each run out on the line
  is then read once through the single-trip endpoint (2.2 MB instead of 34.5 MB for one round of S4).
- Boards refresh every 90 s on a line; run readings refresh on their own tolerance
  (`LINE_RUN_READING_MAX_AGE_MS`), since the feed revises runs about every 35 s.
- What a stop's trips were observed to do is remembered for the visit (`StopCorridorPatterns`), so
  grouping does not depend on which detailed board happens to be in hand.

### Reading two lines together

A line view can add a sibling (`line/S1+S11`), so a corridor served by both reads at its real
frequency. It is not a merged line: S1 and S11 keep their signs, notices and addresses. A sibling is
offered only where this visit has observed both lines on the same route out of this stop for at
least three calls. The diagram draws a shared trunk and forks into one leg per line past the stop
they part at; a line ending at the junction is stated in words (*S11 endet in Busenbach*).

### Vehicle marks

Marks are placed from each run's own calls, never from a position feed (KVV publishes none that
answers). Pointing at or tapping a mark shows its destination. Marks standing at a terminus are drawn
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
- Published notices and board deviations are separate facts. "Keine Meldungen" is only stated after
  a successful read; a stop's notices sit under its board and are silent when it has none.
- Lines outside the verified colour set get a neutral badge.

## Installing it

The site is a PWA: `public/manifest.webmanifest` makes it installable, and `public/sw.js` caches the
app shell so a cold start works offline. **No departure is ever cached**: the worker does not answer
feed requests, so offline the app opens and states that it cannot refresh. The worker is registered
only in production builds and fetches the shell network-first, so a deploy arrives on the next
launch. Vite emits `vite-manifest.json` so the worker can precache the hashed bundle.

## Deployment

Every push to `main` builds and publishes the site via GitHub Pages. **Settings → Pages → Source**
must be set to **GitHub Actions** once.

## License

[MIT](./LICENSE) © Maximilian Liesegang
