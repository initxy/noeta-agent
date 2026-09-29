/**
 * The optimistic-mutation protocol for pin and archive.
 *
 * Pin and archive are server state (the `sessions` table owns both columns),
 * but they must feel local: a pin that waits for a round trip before it moves
 * is a pin the user clicks twice. So the edit is applied first and reconciled
 * afterwards — and reconciliation is where the three parts that make this safe
 * live. Each one exists because leaving it out produces a specific, silent
 * bug:
 *
 * 1. **Monotonic versions.** Every optimistic edit takes a client mutation
 *    number; every server row carries its own `version`, bumped in the same
 *    UPDATE that changed it (see `store/sessions.py`).
 * 2. **Last writer wins by version, not by arrival.** Two PATCHes on one row
 *    can settle in either order — the network decides, not the user. Applying
 *    whichever *arrived* last lets a slow response for the older edit overwrite
 *    the newer one, and the row silently reverts a second after the user
 *    watched it change. Comparing versions makes arrival order irrelevant.
 * 3. **Polls are deferred while mutations are in flight.** The sidebar re-reads
 *    the session list on a timer. A poll that started before a mutation lands
 *    carries pre-mutation values, and applying it mid-flight reverts exactly
 *    the thing the user just did. It is held and applied after the last
 *    mutation settles — and dropped entirely if a mutation result superseded
 *    it.
 *
 * One deliberate choice: a **failed** mutation rolls its optimistic edit back.
 * A design that never rolls back — waiting for the next poll to reconcile —
 * would need a server-side event feed to correct itself. Here the server's row
 * `version` does not move when a PATCH fails, so a poll would never contradict
 * the optimistic value and the wrong state would stick forever. Dropping the
 * override on failure falls back to the last authoritative state, which is the
 * truth.
 *
 * The module is pure: no React, no fetch, no store. That is what lets the two
 * races above be tested by writing them down rather than by hoping to observe
 * them.
 */

/** The two user-owned organisation fields, and nothing else. */
export interface SessionOrganisation {
  pinned: boolean
  archived: boolean
}

/**
 * One row's authoritative organisation state, with the server version it came
 * from. `version` is the store's per-row counter — monotonic, bumped by every
 * write including the ones engine threads make.
 */
export interface OrganisationSnapshot extends SessionOrganisation {
  id: string
  version: number
}

interface Override {
  /** The client mutation number this optimistic edit belongs to. */
  mutation: number
  patch: Partial<SessionOrganisation>
}

export interface OrganisationState {
  /** Last authoritative state per row, by server version. */
  readonly base: Readonly<Record<string, OrganisationSnapshot>>
  /** Optimistic edits not yet settled, at most one per row (they merge). */
  readonly overrides: Readonly<Record<string, Override>>
  /** How many mutations are in flight. Zero is what releases a deferred poll. */
  readonly pending: number
  readonly nextMutation: number
  /** A poll that landed mid-flight, waiting for the last mutation to settle. */
  readonly deferred: readonly OrganisationSnapshot[] | null
}

export const EMPTY_ORGANISATION: OrganisationState = {
  base: {},
  overrides: {},
  pending: 0,
  nextMutation: 0,
  deferred: null,
}

/** Row-level last-writer-wins: only a strictly newer server version replaces. */
function mergeRow(
  base: Record<string, OrganisationSnapshot>,
  row: OrganisationSnapshot,
): boolean {
  const current = base[row.id]
  if (current && current.version >= row.version) return false
  base[row.id] = row
  return true
}

function applyRows(
  state: OrganisationState,
  rows: readonly OrganisationSnapshot[],
): OrganisationState {
  const base = { ...state.base }
  let changed = false
  for (const row of rows) changed = mergeRow(base, row) || changed
  return changed ? { ...state, base } : state
}

export interface BegunMutation {
  state: OrganisationState
  /** Hand this back to `settleMutation` when the request resolves. */
  mutation: number
}

/**
 * Apply an optimistic edit and take a mutation number.
 *
 * The edit is applied **first and unconditionally** — the UI never waits on the
 * network. A second edit to the same row merges into the first's patch and
 * takes the newer number, so pinning and then archiving shows both.
 */
export function beginMutation(
  state: OrganisationState,
  sessionId: string,
  patch: Partial<SessionOrganisation>,
): BegunMutation {
  const mutation = state.nextMutation + 1
  const previous = state.overrides[sessionId]
  return {
    mutation,
    state: {
      ...state,
      nextMutation: mutation,
      pending: state.pending + 1,
      overrides: {
        ...state.overrides,
        [sessionId]: { mutation, patch: { ...previous?.patch, ...patch } },
      },
    },
  }
}

/**
 * Settle one mutation: `row` is the server's answer, or `null` when it failed.
 *
 * The override is dropped only when this mutation is the newest one for that
 * row — a later edit is still in flight and its optimistic value must survive.
 */
export function settleMutation(
  state: OrganisationState,
  sessionId: string,
  mutation: number,
  row: OrganisationSnapshot | null,
): OrganisationState {
  let next: OrganisationState = { ...state, pending: Math.max(0, state.pending - 1) }

  if (row) next = applyRows(next, [row])

  const override = next.overrides[sessionId]
  if (override && override.mutation <= mutation) {
    const overrides = { ...next.overrides }
    delete overrides[sessionId]
    next = { ...next, overrides }
  }

  if (next.pending === 0 && next.deferred) {
    // The poll was held for exactly this moment. Its rows are still subject to
    // per-row version comparison, so anything the mutations already advanced
    // past is ignored rather than reverted.
    next = { ...applyRows(next, next.deferred), deferred: null }
  }

  return next
}

/**
 * Fold a snapshot of the session list in — the poll path.
 *
 * Deferred, never dropped, while anything is in flight: dropping it would lose
 * a change made outside this tab, and applying it would revert the user's own
 * edit. Only the most recent snapshot is held, which is safe in either arrival
 * order — the per-row version comparison in `applyRows` makes an older
 * snapshot a no-op rather than a regression.
 */
export function applySync(
  state: OrganisationState,
  rows: readonly OrganisationSnapshot[],
): OrganisationState {
  if (state.pending > 0) return { ...state, deferred: rows }
  return applyRows(state, rows)
}

/**
 * What a row's organisation currently *is*, as the sidebar should draw it:
 * the authoritative state, with any optimistic edit on top.
 *
 * Falls back to the row itself before the first snapshot has been folded in,
 * so a first paint is never blank.
 */
export function viewOrganisation(
  state: OrganisationState,
  row: OrganisationSnapshot,
): SessionOrganisation {
  const base = state.base[row.id] ?? row
  const override = state.overrides[row.id]
  return {
    pinned: override?.patch.pinned ?? base.pinned,
    archived: override?.patch.archived ?? base.archived,
  }
}
