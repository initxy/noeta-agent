import { describe, expect, it } from 'vitest'
import {
  EMPTY_ORGANISATION,
  applySync,
  beginMutation,
  settleMutation,
  viewOrganisation,
} from './organisation-protocol'
import type { OrganisationSnapshot } from './organisation-protocol'

function snapshot(
  id: string,
  version: number,
  organisation: Partial<Pick<OrganisationSnapshot, 'pinned' | 'archived'>> = {},
): OrganisationSnapshot {
  return { id, version, pinned: false, archived: false, ...organisation }
}

const AT_REST = snapshot('a', 1)

describe('the optimistic mutation protocol', () => {
  it('moves the row before the network has said anything', () => {
    const { state } = beginMutation(EMPTY_ORGANISATION, 'a', { pinned: true })
    expect(viewOrganisation(state, AT_REST).pinned).toBe(true)
    expect(state.pending).toBe(1)
  })

  it('resolves two responses by version, not by the order they arrive', () => {
    // The failure this prevents: pin then unpin, the *pin* response is slow,
    // it lands last, and the row silently re-pins a second after the user
    // watched it unpin.
    let state = EMPTY_ORGANISATION
    state = applySync(state, [AT_REST])

    const pin = beginMutation(state, 'a', { pinned: true })
    state = pin.state
    const unpin = beginMutation(state, 'a', { pinned: false })
    state = unpin.state

    // The newer answer settles first…
    state = settleMutation(state, 'a', unpin.mutation, snapshot('a', 3, { pinned: false }))
    // …and the older one arrives afterwards, carrying the older version.
    state = settleMutation(state, 'a', pin.mutation, snapshot('a', 2, { pinned: true }))

    expect(state.pending).toBe(0)
    expect(viewOrganisation(state, AT_REST).pinned).toBe(false)
  })

  it('keeps a newer optimistic edit alive when an older mutation settles', () => {
    // Same interleaving, seen from the override side: the first mutation
    // settling must not resurrect its own patch over a second edit that is
    // still in flight.
    let state = applySync(EMPTY_ORGANISATION, [AT_REST])

    const pin = beginMutation(state, 'a', { pinned: true })
    state = pin.state
    const archive = beginMutation(state, 'a', { archived: true })
    state = archive.state

    state = settleMutation(state, 'a', pin.mutation, snapshot('a', 2, { pinned: true }))

    const view = viewOrganisation(state, AT_REST)
    expect(view.pinned).toBe(true)
    expect(view.archived).toBe(true)
    expect(state.pending).toBe(1)
  })

  it('defers a poll that lands mid-mutation and applies it once the last one settles', () => {
    // Without the deferral the poll — which started before the PATCH and
    // carries pre-mutation values — reverts exactly what the user just did.
    let state = applySync(EMPTY_ORGANISATION, [AT_REST])

    const pin = beginMutation(state, 'a', { pinned: true })
    state = pin.state

    const stale = applySync(state, [snapshot('a', 1, { pinned: false })])
    expect(stale.deferred).not.toBeNull()
    expect(viewOrganisation(stale, AT_REST).pinned).toBe(true)

    state = settleMutation(stale, 'a', pin.mutation, snapshot('a', 2, { pinned: true }))
    expect(state.deferred).toBeNull()
    // The deferred snapshot is still version-checked when it is finally
    // applied, so it cannot undo the mutation that overtook it.
    expect(viewOrganisation(state, AT_REST).pinned).toBe(true)
  })

  it('lets a deferred poll through when it carries news the mutation did not', () => {
    let state = applySync(EMPTY_ORGANISATION, [AT_REST, snapshot('b', 1)])

    const pin = beginMutation(state, 'a', { pinned: true })
    state = pin.state
    // Something else changed row `b` while the pin was in flight.
    state = applySync(state, [snapshot('a', 1), snapshot('b', 4, { archived: true })])
    state = settleMutation(state, 'a', pin.mutation, snapshot('a', 2, { pinned: true }))

    expect(viewOrganisation(state, AT_REST).pinned).toBe(true)
    expect(viewOrganisation(state, snapshot('b', 1)).archived).toBe(true)
  })

  it('holds only the newest deferred snapshot', () => {
    let state = applySync(EMPTY_ORGANISATION, [AT_REST])
    const pin = beginMutation(state, 'a', { pinned: true })
    state = pin.state

    state = applySync(state, [snapshot('a', 5, { archived: true })])
    state = applySync(state, [snapshot('a', 6, { archived: false })])
    state = settleMutation(state, 'a', pin.mutation, snapshot('a', 2, { pinned: true }))

    // Version 6 is what the server last said; the mutation's own answer is
    // older and loses, which is the same rule applied to a different pair.
    expect(viewOrganisation(state, AT_REST)).toEqual({ pinned: false, archived: false })
  })

  it('rolls a failed edit back to the last state the server confirmed', () => {
    // The divergence from the reference protocol, and the reason for it: a
    // failed PATCH never advances the server's row version, so no later poll
    // would ever contradict the optimistic value. Left alone it would be wrong
    // forever.
    let state = applySync(EMPTY_ORGANISATION, [AT_REST])
    const pin = beginMutation(state, 'a', { pinned: true })
    state = pin.state
    expect(viewOrganisation(state, AT_REST).pinned).toBe(true)

    state = settleMutation(state, 'a', pin.mutation, null)
    expect(state.pending).toBe(0)
    expect(viewOrganisation(state, AT_REST).pinned).toBe(false)
  })

  it('ignores a snapshot older than what it already holds', () => {
    let state = applySync(EMPTY_ORGANISATION, [snapshot('a', 7, { archived: true })])
    state = applySync(state, [snapshot('a', 3, { archived: false })])
    expect(viewOrganisation(state, AT_REST).archived).toBe(true)
  })

  it('reads through to the row itself before any snapshot has landed', () => {
    // First paint: the fold has not run yet and the row is all there is.
    expect(viewOrganisation(EMPTY_ORGANISATION, snapshot('a', 1, { pinned: true }))).toEqual({
      pinned: true,
      archived: false,
    })
  })
})
