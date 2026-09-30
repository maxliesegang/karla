# KARLA

A static React + TypeScript + Vite site showing live Karlsruhe public transport departures.
The [README](./README.md) covers the data source and station-board parameters,
[CONTEXT.md](./CONTEXT.md) the domain terms, and [docs/kvv-efa-api.md](docs/kvv-efa-api.md) the
verified feed behaviour. Read the feed doc before changing a request or parser.

## Commands

```bash
npm run dev
npm run build          # tsc -b && vite build
npm run lint
npm run format         # biome format --write . — the formatter is the style authority
npm test               # tests and build must pass before handing off a change
npm run refresh:stops  # regenerates src/data/generated from the operator's published data
npm run solve:zentrum  # measures the Zentrum plan against the feed, and solves for a truer one
npm run probe:*        # live feed measurements behind the timing constants
```

GitHub Actions tests, builds and deploys `dist` on push to `main`; don't commit it.

## Layout

| Path | Role |
| --- | --- |
| [src/App.tsx](src/App.tsx) | the shell: picks a panel, hands views their data |
| [src/routing.ts](src/routing.ts) | hash routes and path builders |
| [src/selection.ts](src/selection.ts) | resolving the stop / line / trip address against live data |
| [src/selected-line.ts](src/selected-line.ts) | which line the address stands for, as a pure rule |
| [src/view-layout.ts](src/view-layout.ts) | what an address means for the two panels |
| [src/station-board.ts](src/station-board.ts) | the unattended board's `?display=` configuration |
| [src/lib/](src/lib/) | pure domain logic |
| [src/hooks/](src/hooks/) | React glue: polling (`useKeyedLoad`), store subscriptions, device state; imported by module |
| [src/components/](src/components/) | views; German copy |
| [src/data/](src/data/) | `TransitSource` boundary, run store, EFA client and parsers |
| [src/data/generated/](src/data/generated/) | written by [scripts/](scripts/); never edited by hand |
| [tests/](tests/) | `node --test`; no network. Type-checked by `npm run build`. Fixtures in `tests/support/fixtures.ts`; hooks are tested with `tests/support/render-hook.ts` (happy-dom) |

## Constraints

These describe outcomes, not implementations. If a simpler design meets them, prefer it.

- **No backend, no secrets.** The site must deploy to GitHub Pages as plain files.
- **Views never touch the provider.** Fetching, id resolution and merging live behind
  `TransitSource`.
- **The network is observed.** The stops and lines shown come from live trips, so a line that stops
  running disappears on its own.
- **Bandwidth matters.** Hidden pages neither poll nor tick. To see further along a line, filter the
  board by that line rather than asking for more rows. Fetch a run's trip once, not once per stop.
- **One run, one reading.** Every view shows the same data for the same run.
- **Run keys carry no date.** A run is keyed `line|tripCode`, and codes are reused the next day, so a
  run's record must retire well before then (see `run-reading-store.ts`).
- **Addresses degrade gracefully.** A trip that is gone falls back to its line, and a line to its
  stop. A bundle (`line/S1+S11`) exists only when the rider chooses it.
- **Routing goes through `routePaths` / `navigateTo`.** Components take time from props or clock
  hooks, never from `window.location` or `Date.now()`.

## Data honesty

- Never claim realtime for data that isn't. Without a prediction, a departure reads "nach Fahrplan".
- Count minutes against the feed's clock (`lib/feed-clock.ts`), never the device's.
- A failed refresh keeps the last good board on screen, and the board states its age.
- Each row has one time: the expected departure instant (`findExpectedDepartureInstant`). The
  countdown, printed time and order all come from it.
- Quote service notices verbatim.

## Code style

- Identifiers use US spelling. Fields the provider names keep its spelling (`trainNum`,
  `stopSeqCoords`). The Zentrum is `zentrum` in code, even though its URL segment is `/center`.
- Comments say *why*, briefly. Leave out history ("used to…"), which belongs in git, and anything
  the code already says.
- A bug fix gets a test, not a new rule in this file.

## Agent workflow

- Issues are local markdown files under `.scratch/<feature-slug>/`; see
  [docs/agents/issue-tracker.md](docs/agents/issue-tracker.md).
- For triage labels, see [docs/agents/triage-labels.md](docs/agents/triage-labels.md).
- For domain terms, see [CONTEXT.md](CONTEXT.md) and [docs/agents/domain.md](docs/agents/domain.md).
