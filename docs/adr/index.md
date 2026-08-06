# docs/adr/ — Architecture Decision Records

This directory holds the **Architecture Decision Records (ADRs)** for the
`noeta-agent` product: each file captures one stable, cross-module decision —
**what was decided, why it was decided that way, and why the alternatives were
rejected**. The audience is any agent about to change this code (including
Claude Code itself): before you touch a subsystem, read the matching decision
file so you understand where things currently stand and which paths have
already been ruled out — don't walk back down a dead end someone already
explored (Chesterton's fence).

The library decisions the product sits on (the durable engine, the public SDK
surface, the execution-environment seam, MCP connectors) live in the sibling
`noeta` monorepo's `docs/adr/`. The records here are the ones the **product**
owns: the server platform, its wire, and the web client.

## Division of labor with CONTEXT.md

- **`docs/adr/`** (this directory): **why it was decided this way**, organized
  by topic. One topic per file, containing only "why it is this way / why the
  alternatives were rejected."
- **`CONTEXT.md`**: a glossary that pins down what a term **currently means** in
  this repository.
- **Nearby docstrings**: local rationale that affects only a single file or
  function lives in that docstring, not here.

Rule of thumb: the wider the impact (spanning multiple modules), the more it
belongs in `docs/adr/`; the narrower it is, the closer it should sit to the
code itself.

## Status

A decision file is **live** unless it says otherwise. When a later decision
overrides part or all of an earlier one, the earlier file gets a `> **Status:**`
blockquote directly under its title — nothing else changes, so the original
reasoning stays readable:

```markdown
# <the original title>

> **Status: superseded by [server-platform-product.md](server-platform-product.md)** (<what changed>).
> <one or two sentences: which part is dead, which part still holds.>
```

Two rules make this useful rather than decorative:

- **Say what survived.** Most supersessions are partial — the wire changed, the
  invariant did not. A blanket "superseded" throws away a rationale that is
  still load-bearing.
- **Never delete a superseded file.** The point of a decision record is the
  rejected alternatives; deleting it invites someone to re-walk the dead end.

## The decisions

The product is a **single-user, local-first workbench**: no auth, no users, no
Spaces, and a per-project choice between container and local execution instead
of a global sandbox switch. The three records at the top describe it. The ones
below them predate it and carry supersession banners naming what replaced them;
they are kept, never deleted, because the rejected alternatives are the point.

One document sits outside this directory and outranks it on the wire:
[`docs/reference/wire-contract.md`](../reference/wire-contract.md)
is **normative** for the UI-event vocabulary, the SSE contract, the REST surface
and the session status machine. The records here say *why*; that one says
*what*, exactly, and may not be contradicted here.

**The product:**
[project-model](project-model.md) — a Project is one real directory on the
user's machine, and every session of that project shares it. Why Project
replaces Space, why the directory is real, and what sharing it costs: concurrent
sessions can conflict on disk with no locking, which is why `rewind` is withheld
and why artifact conflict handling shipped with the first editable artifact.

**Execution:**
[execution-tier-per-project](execution-tier-per-project.md) — the tier is a
per-project choice carried by `sandbox_policy` keyed on the workspace directory,
and welded into a session at its first turn. Why tools are registered always,
why the system prompt is tier-agnostic, why the tier cannot be changed for an
existing session, and what `local` really means (no container, no approval gate,
writes fenced to the project directory and `shell_run` not fenced at all).

**Artifacts:**
[artifact-trust-model](artifact-trust-model.md) — the client guesses, the server
decides. Why two-stage trust is mandatory here rather than optional, why nothing
is collectible before the server has stat'ed it, why saves are optimistically
locked, and why artifact HTML never shares the app's origin.

**The wire:**
[token-streaming-projection](token-streaming-projection.md) — **live, and the
one record the rewrite carried over unchanged.** Token streaming is an ephemeral
projection; deltas ride a product-layer side channel, carry no SSE `id:`, and
the EventLog stays the only durable truth.

**Superseded — the multi-user platform:**
[server-platform-product](server-platform-product.md) — **superseded in its
product form** by the three records above. It made the product a multi-user
agent service and retired the single-user local app; the rewrite reverses
exactly that, deliberately. Its library-boundary decisions and its argument for
a translated UI-event stream survive intact.

**Superseded — the old web client:**
[web-task-creation](web-task-creation.md) ·
[web-file-panel-and-app-preview](web-file-panel-and-app-preview.md) ·
[web-image-attach](web-image-attach.md) — the request/response shape for
creating a session, the workspace file panel + live app preview (same-origin
serving), and paste/pick image attachment. All three are **partly superseded**;
their surviving rationales are the same-origin argument, the finish-on-suspend
invariant, "the request carries only a model selector, provider config stays
server-side", and the image allowlist + 5 MB cap. One claim in the file-panel
record is now **wrong** rather than merely superseded: the file surface is no
longer gated on the sandbox being enabled — a `local`-tier project has files
too.

## ADR template

One topic per file, named with a topic slug (e.g. `web-image-attach.md`). Every
file has at least a `Decision` and a `Rationale` section:

```markdown
# <one-line title: the decision itself>

## Context

The problem, constraints, and circumstances that triggered this decision.

## Decision

The current conclusion, stated in the present tense ("the system is this way"), not "we will…".

## Rationale

The core invariant or benefit this decision protects. This is the lifeblood of the Chesterton's fence — write it out fully, and don't cut it just because it "looks obvious."

## Alternatives considered

Every option that was seriously weighed and then rejected, together with **why it was rejected**, so nobody proposes the same dead end again.

## Consequences

The constraints, costs, and follow-on points this decision creates. When you need to point at where something lands, just name the module in prose.
```

`Context` / `Alternatives considered` / `Consequences` can be trimmed depending
on complexity; `Decision` and `Rationale` are mandatory.

## Writing discipline

- **Keep the why, drop the how-we-got-here.** Process numbering that only
  mattered during one construction effort never belongs in a decision file.
- **Use the present tense.** A decision describes the system as it is now, not a
  changelog.
- **Don't reference code, and don't get referenced by code.** A decision file
  may name modules, but the code side never references this directory.
- **Don't redefine terms.** Term meanings live in `CONTEXT.md`; decision files
  use them directly, adding a one-line anchor where needed.
- **Prose is in English**, with technical terms kept in their original form
  (code identifiers / APIs / library / tool / command names / file paths, plus
  fixed architecture terms like module, interface, seam, adapter, deep module).
