# KARLA

**KAR**lsruhes **L**inien & **A**bfahrten — a static React site showing the current state of the
Karlsruhe public transport network: the stops served in the Zentrum, a line index, and stop views
with live departures from the KVV realtime feed. It is not a journey planner: no routing, no
ticketing, no accounts.

The rider-facing copy is German; the code and this document are English.

## Development

```bash
npm install
npm run dev
```

## Addresses

Routing is hash-based, so every view is a shareable deep link. Three entry points and one selection
chain, each level refining the one above it:

- `#/center` — the stops served in the Zentrum
- `#/network/city`, `#/network/region` — the line index
- `#/nearby` — the six nearest observed stops after a location reading
- `#/notices` — KVV's published notices relevant to the KARLA network
- `#/stop/europaplatz` — a stop with its departure board
- `#/stop/europaplatz/line/2` — a line calling there, beside the board
- `#/stop/hochstetten/line/S1+S11` — two of them read together over the stretch they share
- `#/stop/europaplatz/line/2/trip/:tripId` — one trip of that line, highlighted
- `#/trip/:tripId` — that trip read on its own: the ride
- `#/trip/:tripId/to/:stopId` — the same ride with the rider's alighting stop marked

Legacy links (`#/line/2`, `#/stop/…/lines`, `#/departure/…`, `#/ride/…`) still resolve and are
rewritten to the canonical chain; the old combined `line/S1-S11` is read as the bundle `S1+S11`.

With no address the app opens the stop last read, and `#/center` for a reader with no history. It
never opens on a location prompt: the busiest Zentrum platforms are underground, where a fix is
unusable, and a remembered stop needs no permission and answers instantly. Location is a control:
the *Nähe* button in the bar locates on request and opens the closest stop. If that inference is
wrong, *Andere* opens `#/nearby` with the six nearest observed alternatives.

The stops read recently are listed under the search on the home, and fill the search field while
nothing is typed. The stop they name is the one the rider last departed *from*, so it is offered as
a starting point rather than asserted as where they are standing.

## Station board mode

Unattended displays use the normal stop URL with a configuration before the hash:
`?display=stop#/stop/europaplatz` for the whole board, `?display=platform&platform=2#/…` for one
platform, `platform=2,3` for an island pair. Platform names are normalised (`2`, `Gleis 2`,
`Bstg. 2` are the same platform), and the board prints the word the feed states for that platform —
`Gleis` where the departure is rail-bound, `Bstg.` where it is a bus stand.

| Parameter | Effect |
| --- | --- |
| `rows=3…20` | fixed row count; type size follows the row height |
| `detail=note\|via\|off` | second line: operating note, else the route, or nothing |
| `minMinutes=0…30` | lead time; unreachable departures are not listed |
| `group=platform` | order by platform instead of by time |
| `reloadMinutes=15…10080` | self-reload so a deploy arrives (default 24 h) |

The board fills exactly one screen and pages instead of scrolling. If the configured platform is
not in the feed, it names the platforms actually reported rather than showing other ones.

## Data

`src/data/transit-source.ts` is the boundary between views and data; `KvvTransitSource` reads the
EFA departure monitor, stop search, and published notices at `https://projekte.kvv-efa.de/sl3-alone/`.
Those endpoints allow cross-origin reads, so the site needs no backend, proxy, or secret.
The empirically verified endpoints, parameters, response fields, payload observations and rejected
options are recorded in [`docs/kvv-efa-api.md`](docs/kvv-efa-api.md).

Every board is asked for the local network only — Stadtbahn and S-Bahn, tram, and bus. Without that
a Hauptbahnhof board is mostly ICE, IC, TGV and Flixbus, which is not what this app is opened for;
the coaches the feed's bus group carries along are dropped again by mode when the answer is read.

`src/lib/observed-network.ts` builds the served stops and the lines calling there out of those live
trips: a line that stops running leaves the view by itself. The only authored data left is which
stops count as the Zentrum (`src/data/zentrum-stops.ts`) and the verified KVV line colours.

### Reading depth

The ordinary stop board is lightweight and omits complete trip sequences on its 30-second refresh.
Opening a line reads the same stop again, filtered to that line's two directions: twenty rows spent
on one line reach most of an hour, where an unfiltered board at a busy post reaches minutes. The
first few of those departures are then read one at a time through EFA's single-trip endpoint, and
that is what the line diagram and the ride are drawn from. Sequences batched into a *board* response
stay bounded — a couple of boards along the line plus the Zentrum's own posts, never one request per
vehicle.

Beside a plain board, one detailed reading is reused for 30 minutes to learn which visible trips
share a first corridor. What those readings say is accumulated for the visit
(`StopCorridorPatterns`) rather than re-derived per refresh: the detailed readings run on far slower
cadences than the board they group, so recomputing made a trip stop resolving — and split off under
its own headsign — whenever an unrelated post refreshed. A trip's own reading is matched first;
otherwise the route its line predominantly runs towards that headsign stands in, counting trips
rather than readings so a re-read board cannot outvote the others. Where two routes are observed
equally often they really are two branches, and neither speaks for the other: those trips, and the
ones nothing is known about yet, group by headsign alone.

### Reading two lines together

From Hochstetten, an S11 is a way to Busenbach exactly as an S1 is, and reading them on separate
boards makes each look half as frequent as the corridor really is. So a line's view can be asked to
read a sibling alongside it: the chip in the diagram's header adds it, the address carries it
(`line/S1+S11`), and the board highlights both lines' trips as the one selection.

It is not a merged line. `lib/line-families.ts` is untouched — S1 and S11 keep their signs, notices,
ends and addresses — and a bundle is a property of *a corridor at one stop*, never of the lines. The
sibling is offered only where this visit has already observed both lines running the same route out
of this stop for at least three calls, which costs no reading of its own: the routes are the ones
`StopCorridorPatterns` accumulated for the board the rider is already looking at. A rider who deep
links straight into a line sees no offer until they step up to the stop, because discovering one
there would mean spending a request on a question nobody asked.

The diagram forks. The trunk is drawn as far as every bundled line has been seen running, measured
outwards from the rider's own stop; past the stop they part at, each line gets a leg of its own —
its stops, its live vehicles, its sign — laid beside the others and running back into the junction
the trunk names once. A leg is its own stop chain and so its own coordinate system, which is why
`LineDiagramBranch` exists: a vehicle stands on the trunk while the lines run together and on
exactly one leg past that, and `tests/line-bundle-fork.test.ts` is that handover. The junction is in
each leg's chain — a mark is placed on the link between two calls, and a leg's first link has one
end on the trunk — but it is drawn as a stub rather than a stop, because the trunk already names it.

A line of the pair that simply terminates at the junction has no leg to draw and is stated in words
instead (*S11 endet in Busenbach*). That is the short working the whole bundled reading exists to
make visible.

### Naming a direction

A direction is named by the place its corridor heads into, not by a headsign: `Richtung Ettlingen`
where the vehicle's sign reads `Ettlingen Albgaubad`. EFA states a Karlsruhe district in the same
field as a municipality — `Durlach` and `Rüppurr` come back exactly as `Ettlingen` does, while the
inner city says plain `Karlsruhe` — so districts are directions too, and only a place the rider is
already standing in falls back to the stop's own name. Where two corridors of one line head into the
same place, both fall back to the stops the trips part at.

Where a corridor's trips run one behind the other — a short working turning back along the through
service's route — both ends are named: `Richtung Ettlingen → Bad Herrenalb`. That rider is choosing
how far, not which way. Trips that genuinely part are never drawn as one chain; that row states the
last point they still share.

### Honesty rules the views follow

- Countdowns are counted against the feed's clock, not the device's.
- Without a prediction a departure reads "nach Fahrplan"; realtime is never claimed.
- A failed refresh keeps the last readable board with its age ("Stand 14:03 · seit 6 Min ohne
  Aktualisierung"); past ten minutes the failure itself is the answer.
- Cancellations, diversions, and operating notes are shown, never hidden.
- Published notices (weeks-long closures, replacement services) and board deviations are separate
  facts; neither stands in for the other, and "Keine Meldungen" is only stated after a successful read.
  A stop's own notices sit under its departure board and are silent when it has none — a silence that
  claims nothing; `#/notices` lists the whole network and is reached from the footer.
- Lines outside the verified colour set get a neutral badge — a colour table is not a claim of service.

## Installing it

The site is a PWA: `public/manifest.webmanifest` makes it installable to a phone's home screen, and
`public/sw.js` caches the app shell — markup, bundle, styles, icons — so a cold start works without
a connection. **No departure is ever cached.** The feed lives on another origin and the worker
deliberately does not answer those requests, so a board can never be replayed from a cache as if it
were live; offline the app opens and says what it always says about a reading it cannot refresh.

The worker is registered only in a production build, and the shell is fetched network-first, so a
deploy arrives on the next launch rather than the one after it. Vite emits `vite-manifest.json` so
the worker can precache the build's hashed JavaScript and CSS without hard-coding generated names.

## Deployment

Every push to `main` builds and publishes the site via GitHub Pages. **Settings → Pages → Source**
must be set to **GitHub Actions** once.

## License

[MIT](./LICENSE) © Maximilian Liesegang
