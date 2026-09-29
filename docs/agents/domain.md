# Domain Docs

Single-context: [`CONTEXT.md`](../../CONTEXT.md) at the repo root and [`docs/adr/`](../adr/).

## Before exploring

Read `CONTEXT.md`, and any ADR touching the area you are about to work in.

## Use the glossary's vocabulary

When your output names a domain concept (an issue title, a refactor proposal, a hypothesis, a test
name), use the term as `CONTEXT.md` defines it, not a synonym it lists under _Avoid_. A concept
missing from the glossary is either invented language (reconsider) or a real gap (note it for
`/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an ADR, say so explicitly rather than silently overriding it:

> _Contradicts ADR-0002 (run key without date), but worth reopening because…_
