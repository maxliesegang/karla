# KARLA

A static React + TypeScript + Vite site showing live public transport departures from the TRIAS
feed, for one network per build (KVV). The [README](./README.md) covers addresses, the station
board and how to run it, [CONTEXT.md](./CONTEXT.md) the domain terms,
[docs/trias-api.md](docs/trias-api.md) the verified feed behaviour and
[docs/networks/](docs/networks/) each network's facts. Read the feed doc before changing a request
or parser.

## Commands

```bash
npm run dev
npm run build          # tsc -b && vite build
npm run lint
npm run format         # biome format --write . — the formatter is the style authority
npm test               # tests and build must pass before handing off a change
npm run refresh:stops  # regenerates src/networks/<id>/generated from TRIAS and GTFS
npm run refresh:stop-places  # rewrites the stop places after their overrides change
npm run refresh:line-colors  # regenerates line colours: the network's GTFS, other operators' from Träwelling
npm run solve:zentrum  # measures the Zentrum plan against the feed, and solves for a truer one
npm run solve:region   # derives the region plan's nodes from the feed and solves its layout
npm run probe:*        # live feed measurements behind the timing constants
npm run proxy          # the TRIAS proxy on :8080; run the app with VITE_TRIAS_PROXY_URL=/api/ to use it
VITE_NETWORK=kvv npm run dev    # the network a build reads (default and only: kvv)
```

GitHub Actions tests, builds and deploys `dist` on push to `main`; don't commit it.

## Layout

| Path | Role |
| --- | --- |
| [src/App.tsx](src/App.tsx) | the shell: picks a panel, hands views their data |
| [src/routing.ts](src/routing.ts) | hash routes and path builders |
| [src/selection.ts](src/selection.ts) | resolving the stop / line / journey address against live data |
| [src/selected-line.ts](src/selected-line.ts) | which line the address stands for, as a pure rule |
| [src/view-layout.ts](src/view-layout.ts) | what an address means for the two panels |
| [src/station-board.ts](src/station-board.ts) | the unattended board's `?display=` configuration |
| [src/lib/](src/lib/) | pure domain logic |
| [src/hooks/](src/hooks/) | React glue: polling (`useKeyedLoad`), store subscriptions, device state; imported by module |
| [src/components/](src/components/) | views; German copy |
| [src/data/](src/data/) | `TransitSource` boundary, dated journey store, the `Feed` model, the TRIAS client and parsers |
| [src/networks/](src/networks/) | `NetworkDefinition` and each network's data; `network` is the build's |
| `src/networks/<id>/generated/` | written by [scripts/](scripts/); never edited by hand |
| [proxy/](proxy/) | the PHP TRIAS proxy: holds the requestor ref, caches, passes XML through |
| [tests/](tests/) | `node --test`; no network. Type-checked by `npm run build`. Fixtures in `tests/support/fixtures.ts`; hooks are tested with `tests/support/render-hook.ts` (happy-dom) |

## Constraints

These describe outcomes, not implementations. If a simpler design meets them, prefer it.

- **Static site, one thin proxy.** The site deploys as plain files. The only server code is the PHP
  TRIAS proxy in `proxy/`; its requestor ref is the only secret and never reaches the client or the
  repo.
- **Views never touch the provider.** Fetching, id resolution and merging live behind
  `TransitSource`.
- **Generic code names no network.** What is true of one network (its pools, area, stop place
  overrides, colours, neighbouring operators' areas, numbering, default and suggested stops,
  observation posts) lives in its `NetworkDefinition`; code reads it through `network`.
  The Zentrum and region plan are KVV's and import it directly.
- **Stops are DHIDs; stop places are derived.** A stop place's stop points are stop-level DHIDs
  (`de:08212:1003`), grouped from the catalog by name and distance; only what that rule misses is
  authored. Slugs (`stopId`) are only the app's addresses.
- **The network is observed.** The stops and lines shown come from live journeys, so a line that stops
  running disappears on its own.
- **Bandwidth matters.** Hidden pages neither poll nor tick. To see further along a line, filter the
  board by that line rather than asking for more rows. Fetch a dated journey's calls once, not once per stop.
- **One dated journey, one reading.** Every view shows the same data for the same dated journey.
- **A dated journey is a `JourneyRef` on an `OperatingDayRef`.** Requests, addresses and
  `datedJourneyId` and the reading store's records use both; a `JourneyRef` alone recurs daily.
- **Addresses degrade gracefully.** A journey that is gone falls back to its line, and a line to its
  stop. A bundle (`line/S1+S11`) exists only when the rider chooses it.
- **Routing goes through `routePaths` / `navigateTo`.** Components take time from props or clock
  hooks, never from `window.location` or `Date.now()`.

## Data honesty

- Never claim realtime for data that isn't. Without a prediction, a departure reads "nach Fahrplan".
- Count minutes against the feed's clock (`lib/feed-clock.ts`), never the device's.
- A failed refresh keeps the last good board on screen, and the board states its age.
- Each row has one time: the expected departure instant (`findExpectedDepartureInstant`). The
  countdown, printed time and order all come from it.
- Keep times to the second where the feed states them; a call's instant comes
  from `getCallShiftMs`. Delays print as whole minutes, rounded. Only by the rider's setting, and only
  for a prediction to the second, does the last minute count in seconds, in ten-second steps.
- Quote service notices verbatim, once the app shows them again.

## Code style

- Identifiers use US spelling and TRIAS's terms (see CONTEXT.md): `stopPointId`, `stopPlaceId`,
  journey, call. Names the provider gives keep its spelling (`PlannedBay`, `OperatingDayRef`). The Zentrum is `zentrum` in code; its map on the experiment page is `center`.
- Comments are rare and short. Most functions need none; a good name is the documentation. Add one
  only for what the code cannot say: a feed quirk, a measured constant, a non-obvious constraint.
  One line is the norm, three the most for a function, and a module header says its role in a
  sentence or two.
- Write rules, not stories. No account of the bug a line prevents, how a value was found, or what
  went wrong before ("drawn as…, the mark leapt…"): that belongs in the commit message. Don't match
  the length of existing comments; shorten them when you touch them.
- Markdown docs follow the same budget: state facts and rules, skip the reasoning that led to them.
- A bug fix gets a test, not a new rule in this file.

## Agent workflow

- Issues are local markdown files under `.scratch/<feature-slug>/`; see
  [docs/agents/issue-tracker.md](docs/agents/issue-tracker.md).
- For triage labels, see [docs/agents/triage-labels.md](docs/agents/triage-labels.md).
- For domain terms, see [CONTEXT.md](CONTEXT.md) and [docs/agents/domain.md](docs/agents/domain.md).
