# Karla

A live board and line companion for Karlsruhe public transport. These are the terms the code uses.
Where two terms are easy to confuse, the entry says how they differ.

## Stops

**Local stop** (`TransitStop`): the app's own stop identity, with one page and one URL. It may cover
several stop points (a *stop complex*, such as Europaplatz).

**Stop point**: the operator's identity for where a vehicle actually stands. Row facts such as the
platform live at this level.

**Authored / dynamic stop**: an authored stop ships with the app; a dynamic stop is first met live
(through a search hit or a call) and is registered for the rest of the session.

**Boarding place**: what a rider walks to at a stop, usually one stop point. It is derived from trips
calling at several platforms in turn. The Zentrum plan reads its places from the corridors each
platform serves and how near platforms stand, and draws one capsule per place.

## Boards and rows

**DepartureBoard**: one reading of a stop's departures: its rows, its status (live or unavailable)
and when it was read.

**Departure**: one row, meaning one run at one stop at the moment the board was read. It holds
facts about that stop (countdown, platform), not about the whole vehicle.

**Serving lines**: the line directions a stop states from its schedule. They are not evidence that
anything is running.

**Route direction id**: the provider's id for one direction of a line. It is used for board filters
and is never shown to a rider.

**Board order**: one of three orderings of a board: by time, by platform, or by line.

## Runs

**Trip**: the timetable entry, which repeats every day (`tripId`).

**Run**: one dated instance of a trip on the road today (`tripInstanceId`). This is what gets
tracked and drawn.

**Vehicle**: the mark drawn for a run.

**TripCall**: one stop in a run's sequence, with its times and platform.

**RunSequence**: a run's calls as the feed stated them, read at a single moment. It holds nothing
specific to one stop.

**RunReadingStore**: inside `TransitSource`, it holds the latest rows and sequence for each run.
Every view reads runs from it.

**Run keys** (in `lib/trips.ts`):
- `getRunRecordKey` (`line|tripCode`, undated) shares a run's data and requests.
- `getRunMarkKey` (dated) identifies a drawn vehicle.
- `getBoardRowKey` merges a board's duplicate rows for one run.

**KvvTripLocator**: the provider's address for fetching one run's trip.

## Time

**Feed clock**: the operator's clock, anchored when a board is read and advanced by the device. All
countdowns and staleness checks use it.

**Expected departure instant**: the prediction if there is one, otherwise the schedule. It is the
one time a row is read against.

## Lines

**Line**: the passenger-facing sign, such as "S1" or "2".

**Line family**: lines that share a number (S1 and S11). It says nothing about shared track.

**Line bundle**: two lines read together over a stretch they share, as chosen by the rider in the URL
(`line/S1+S11`). They are never merged automatically.

**Observed network**: the lines and stops seen live at the observation posts, the fixed stops read
to learn the network.

**Line observation**: the stops and directions learned for one line, which decide which boards to
read for it.

## Riding

**Ride**: one run read on its own, for a rider on board.

**Ausstieg**: the stop where the rider plans to get off, as chosen by the rider and carried in the
URL.

## Zentrum

**Experiment page**: a place to try experimental maps, including the Zentrum plan.

**Plan options**: choices for how the Zentrum plan opens and displays paths, lines and travel times.
_Avoid_: experiments (the page contains experimental maps; these choices configure one plan).

**Zentrum**: the authored list of city-centre stops that the schematic covers. In code it is always
`zentrum`; on the experiment page its map is `center`.

**Schematic plan**: the authored drawing of that area (nodes, edges, lanes), solved offline and never
read live.

## Boundary

**TransitSource**: the only module that talks to the provider. Views use it and nothing else.

**KvvEfa**: the operator's EFA feed. See [docs/kvv-efa-api.md](docs/kvv-efa-api.md).
