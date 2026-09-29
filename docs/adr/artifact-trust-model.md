# Artifacts: the client guesses, the server decides — nothing is collectible before the server has stat'ed it, and artifact HTML never shares the app's origin

## Context

The side panel's job is to put what the agent produced one click away: a report,
a sheet, a generated page. Nothing on the wire says "this is an artifact" — the
UI-event vocabulary carries tool calls, tool output and prose, and the paths are
buried inside them. So the panel is fed by a **derivation engine**: a scan over
the folded transcript that proposes candidates from tool metadata, tool output
and assistant prose, weighted by provenance.

A scan over text is a guess by construction. Text lies: a model writes "I saved
this to `report.md`" and did not, or names a file it only intended to write. And
in this product the client cannot check: with the `sandbox` tier the files live
inside a container, and even on `local` the browser has no filesystem.

Two more things about *this* product raise the stakes over the reference
implementation the engine is modelled on. All sessions of a project share one
directory with no locking, so a file under an open editor can be rewritten by
another session or by this session's own agent mid-turn. And the agent writes
HTML, which a panel is expected to render.

## Decision

**Two-stage trust is mandatory here, not optional.**

- **Stage 1, the client, is allowed to be greedy.** A provenance-weighted scan
  produces candidates: a write tool's own arguments (95), a write tool's prose
  output (90), another tool's payload — URLs only (75), assistant prose behind an
  artifact verb (65), user text (40); deduped by id with higher-or-equal
  confidence winning. **Discovery tools (`glob` / `grep` / `search` / `find`) are
  excluded wholesale** before any lane runs.
- **Stage 2, the server, decides.** `POST /api/v1/sessions/{id}/artifacts/resolve`
  stats each candidate through the workspace file surface and **overwrites**
  `exists`, `size`, `updatedAt` and `preview`. The batch is capped (80). The
  request carries **paths only** — a URL has nothing to stat — and a row is keyed
  by **the path the client sent, echoed verbatim**, because that string is the
  client's fold key.
- **Nothing is collectible before that round trip, as a type invariant.** A
  candidate carries no resolution fields at all; a resolved target's `exists` is
  `boolean | null` and every collectibility check compares against `true`. A
  candidate outside the cap, or one the server declined, is uncollectible by
  construction rather than by discipline. `preview` is recomputed server-side
  rather than trusted, for the same reason.
- **Auto-open stays off.** Resolution decides what *may* be opened; a human
  clicks.
- **Editing is optimistically locked.** A save carries the `base_mtime` from the
  read that produced the bytes in the editor; a mismatch is **409
  `file_conflict`** carrying `current_mtime`, and the UI offers "reload theirs" or
  "overwrite with mine". There is no merge. Writes go to the **host directory**,
  not through the container.
- **Spreadsheets are read-only.** Binary workbooks are not parsed at all.
- **Artifact HTML never shares the app's origin.** It renders in an
  opaque-origin frame (`sandbox="allow-scripts"`, no `allow-same-origin`). The
  container's own panels (noVNC, terminal, code-server), which genuinely need
  `allow-same-origin`, are served from a **separate origin on a separate port**
  that carries nothing of ours.

## Rationale

- **The scan is only allowed to be greedy because the server culls.** A
  candidate invented out of a paragraph fails `exists` and disappears. Invert the
  order — trust the client, verify on open — and the panel fills with tabs that
  open onto nothing, which teaches the user that the panel lies. That is the
  failure the weights and the discovery exclusion are tuning against, and it is
  why the exclusion is not merely a ranking penalty: one `grep` that matched 400
  `package.json`s would otherwise flood the panel on its own.
- **The client physically cannot resolve.** In the reference implementation
  two-stage trust is a nicety, because its files are on the same machine as the
  UI. Here the file may be inside a container, so "resolve on the server" is the
  only implementation that exists — which is exactly why making it a *type*
  invariant costs nothing and buys immunity from the shortcut.
- **Echoing the path verbatim is load-bearing.** The client folds the response
  into its candidate list by the string it sent. Answering with the normalized
  path silently drops every candidate that needed normalizing — which is most of
  them, since a `local` project's tools print real host paths.
- **The cap is what keeps a long conversation from becoming a `stat` storm.**
  The scan re-fires whenever the derived set changes; an uncapped batch turns one
  panel refresh into thousands of syscalls. Degrading to "the first N are
  verified" is acceptable; "the panel stopped working" is not.
- **Conflict handling could not be deferred.** The reference implementation
  locks the save server-side and has no client that handles the 409, so an
  externally-rewritten file shows stale bytes and silently fails to save. Under a
  shared project directory that is not an edge case: the *other writer is the
  agent*. A conflict the user can see and answer is the minimum honest behavior,
  and it is why the base mtime comes from the read that produced the editor's
  bytes and is deliberately not re-synced by a background refetch — the save has
  to be allowed to fail.
- **`allow-same-origin` on agent-generated HTML is not a sandbox at all.** An
  iframe with `allow-same-origin` is same-origin with whatever served it, so
  serving model-written HTML from the app origin hands a generated page the
  control plane. The two mechanisms are kept apart on purpose: opaque origin for
  content we generated and cannot vouch for, a separate blank origin for
  container panels that need real storage. This extends the origin isolation the
  preview gateway already established, and is a reversal not to undo.
- **Writing to the host directory rather than through the container** is what
  keeps the editor alive when the panel is most useful: a `local` project has no
  container and an idle-stopped `sandbox` one is unreachable. Reading already
  worked in both states; a write path that only worked in one would be dead
  exactly when it mattered.

## Alternatives considered

1. **Trust the client's scan (optional two-stage, as in the reference).**
   Rejected: not implementable here — the client cannot stat a file in a
   container — and it produces tabs that open onto nothing.
2. **Derive server-side from the event log.** Rejected: the scan runs over the
   *folded transcript*, which is a client projection, and it re-fires as the
   conversation grows; moving it to the server means re-folding per request for a
   panel that may be closed. The split as built has each side doing what only it
   can: the client has the transcript, the server has the filesystem.
3. **Resolve lazily, only when a tab is opened.** Rejected: the collectible set
   *is* the panel's contents. Deciding at open time means the list itself is
   unverified, which is the failure mode being designed out.
4. **Save without a lock (last write wins).** Rejected: under a shared directory
   the loser is usually the human, and the winner is a turn that will overwrite
   it again.
5. **Three-way merge on conflict.** Rejected: it claims to know which hunks
   belong to whom, with no reviewer and no common ancestor worth the name. Two
   explicit choices are honest; a merge is a guess wearing a diff's clothes.
6. **Round-trip `.xlsx` through a `string[][]` model** (what the reference
   does). Rejected: saving destroys every other sheet, every formula and all
   formatting. A read-only spreadsheet is a limitation; a lossy save is data
   loss.
7. **Render artifact HTML with `sandbox="allow-scripts allow-same-origin"`**
   (also the reference's behavior). Rejected: effectively unsandboxed. See the
   rationale.
8. **Serve the container panels from the main port with a path prefix.**
   Rejected for the same reason in reverse: those panels *need*
   `allow-same-origin`, so the origin they run on must hold nothing of ours.

## Consequences

- **One extra round trip whenever the derived set changes**, and a batch cap that
  a very long conversation will hit. Both are visible in the panel as "not yet
  verified", never as an error.
- **`GET /sessions/{id}/preview` 404s for a project with no container**, and the
  client hides the container panels rather than rendering three iframes that
  cannot load. A 404 there is a normal answer.
- **A conflicting save leaves the bytes on disk untouched**, and the 409 carries
  `current_mtime` so "overwrite with mine" costs no extra read.
- **The preview origin binds a second port**, lazily and only for a session that
  actually has a container; a bind failure degrades to "no panels" and never
  blocks a conversation.
- **The write path carries an existing file's mode and ownership onto the
  replacement** (write temp + `os.replace`), so a container reading concurrently
  never sees half a file.
