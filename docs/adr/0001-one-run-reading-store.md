# One run reading store; views hold ids

Everything read about a run lives in one `RunReadingStore` inside the `TransitSource`, one record
per run, and every view reads runs back from it by row id (`findRun`, `useRuns`). Boards are
snapshots of which runs a stop listed, so every board hook hands its boards out through
`useLiveBoards`, which re-resolves each row against the store whenever one of its runs is re-read.
Nothing outside the store keeps a copy of a reading: the line diagram follows row ids, the ride
anchors a row id, and a diagram's held run is an id.

We chose this over letting each view merge the readings it fetched. The same tram is on many boards
and several views at once, read on different cadences (a stop board every 30 s, line boards every
90 s, the Zentrum posts every 5 min, run re-reads every minute). With per-view copies, two panels
drew the same vehicle from two different readings, and every consumer had to remember to look a
row up again or it would draw a stale sequence.

## Consequences

- A board's rows change whenever one of its runs is re-read, not only when the board refreshes.
  Anything that keeps state derived from boards must compare before setting it: an effect that
  set state on every new board queued a render per re-read and tripped React's nested-update limit.
- A failed board refresh is answered by the source with the last live board, marked
  `refreshFailedAt`, rather than by each hook keeping its own fallback.
- What a drawing remembers about its marks' motion is not a reading, and is owned by the drawing
  (`createRunMotions`), not the store.
