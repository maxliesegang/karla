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
specific to one stop. Only a trip request yields one; a board's embedded calls are that board's
observation.

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
to learn the network, and in every run requested for its calls.

**Line observation**: the stops and directions learned for one line, which decide which boards to
read for it.

## Riding

**Ride**: one run read on its own, for a rider on board.

**Ausstieg**: the stop where the rider plans to get off, as chosen by the rider and carried in the
URL.

## Zentrum

**Experiment page**: a place to try experimental maps, including the Zentrum plan.

**Geographic map**: the experiment page's `geo` map. Stops stand where the feed locates them,
linked in the order observed runs call them, out to the runs' ends. Places are named by the feed's
`placeName`. Like the region plan, it draws only **daily lines**: those the timetable runs on every
day of the week (`npm run refresh:stops` lists the others).

**Region plan**: the experiment page's `region` map. An octilinear plan of the observed network,
solved offline: in Karlsruhe only junctions and ends, every other place once per branch. Stops it
leaves out are ridden past. The Zentrum's stops keep the Zentrum plan's shape; its east–west axis
runs on from Entenfang to Durlach. The map shrinks with distance from Marktplatz by its **scale**:
a fisheye, zones, or arms (zones up to the city's edge, straight arms beyond it). Arm places are
ticks named on hover; ends, Karlsruhe and the axis are named. At rest it shows corridors; an opened
stop colours its lines.

**Plan options**: choices for how the Zentrum plan opens and displays paths, lines and travel times.
_Avoid_: experiments (the page contains experimental maps; these choices configure one plan).

**Zentrum**: the authored list of city-centre stops that the schematic covers. In code it is always
`zentrum`; on the experiment page its map is `center`.

**Schematic plan**: the authored drawing of that area (nodes, edges, lanes), solved offline and never
read live.

**Corridor**: a connection between two stops observed in runs. A junction may split it into
several drawing edges; travel times and vehicle progress still measure the corridor stop to stop.

**Drawn track** (`trackId`): one lane in the schematic. Lines with the same trunk and colour share
a drawn track; their passenger-facing line identities remain separate.

**Junction**: a bend between stops, where a corridor from a stop with a platform run (Albtalbahnhof)
turns square into the street it serves. Drawn without a mark; corridors stay stop to stop for runs,
lighting and travel times.

## Boundary

**TransitSource**: the only module that talks to the provider. Views use it and nothing else.

**KvvEfa**: the operator's EFA feed. See [docs/kvv-efa-api.md](docs/kvv-efa-api.md).
