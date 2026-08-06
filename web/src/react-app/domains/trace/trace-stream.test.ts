import { describe, expect, it } from 'vitest'
import type { RawEnvelope, RawEventsPayload } from '@/app/types'
import { applyRawEventsPage, countByStream, initialTraceStreamState } from './trace-stream'

/**
 * The cursor is a `{task_id: last_seq}` map, and the whole point of this file
 * is that it never collapses back into a scalar. The defect it guards is
 * concrete and shipped once: a cursor that tracked only the root stream, so
 * clicking a subagent on the trace page showed nothing at all.
 */

function env(taskId: string, seq: number, type = 'MessagesAppended'): RawEnvelope {
  return { task_id: taskId, seq, type, payload: {} }
}

function page(events: RawEnvelope[], cursor: Record<string, number>): RawEventsPayload {
  return { events, cursor }
}

/** The cursor a server would return for a page: the max seq per stream. */
function cursorOf(events: RawEnvelope[]): Record<string, number> {
  const cursor: Record<string, number> = {}
  for (const item of events) {
    const seq = item.seq
    if (cursor[item.task_id] === undefined || cursor[item.task_id] < seq) cursor[item.task_id] = seq
  }
  return cursor
}

describe('the raw-events cursor', () => {
  it('tracks a high-water seq per stream, not one number for the session', () => {
    const events = [env('root', 0), env('root', 1), env('sub-a', 0), env('root', 2), env('sub-a', 1)]
    const state = applyRawEventsPage(initialTraceStreamState, page(events, cursorOf(events)))

    expect(state.cursor).toEqual({ root: 2, 'sub-a': 1 })
    expect(state.events).toHaveLength(5)
  })

  it('increments strictly across two streams over successive pages', () => {
    const first = [env('root', 0), env('root', 1), env('sub-a', 0)]
    const afterFirst = applyRawEventsPage(initialTraceStreamState, page(first, cursorOf(first)))
    expect(afterFirst.cursor).toEqual({ root: 1, 'sub-a': 0 })

    // The second page is what the server returns *for that cursor*: the next
    // envelope of each stream, and nothing already delivered.
    const second = [env('root', 2), env('sub-a', 1), env('sub-a', 2)]
    const afterSecond = applyRawEventsPage(afterFirst, page(second, cursorOf(second)))

    expect(afterSecond.cursor).toEqual({ root: 2, 'sub-a': 2 })
    expect(afterSecond.events.map((e) => `${e.task_id}#${e.seq}`)).toEqual([
      'root#0',
      'root#1',
      'sub-a#0',
      'root#2',
      'sub-a#1',
      'sub-a#2',
    ])
  })

  it('accepts a subtask seq 0 that sits far below the root high-water mark', () => {
    // The exact shape of the shipped defect: one scalar cursor at 40 swallowed
    // a whole subagent, whose own stream had only just started counting.
    const rootRun = Array.from({ length: 41 }, (_, seq) => env('root', seq))
    const afterRoot = applyRawEventsPage(initialTraceStreamState, page(rootRun, cursorOf(rootRun)))
    expect(afterRoot.cursor).toEqual({ root: 40 })

    const spawned = [env('root', 41), env('sub-a', 0), env('sub-a', 1)]
    const after = applyRawEventsPage(afterRoot, page(spawned, cursorOf(spawned)))

    expect(after.cursor).toEqual({ root: 41, 'sub-a': 1 })
    expect(after.events.filter((e) => e.task_id === 'sub-a')).toHaveLength(2)
    expect(after.streams).toEqual(['root', 'sub-a'])
  })

  it('drops an overlapping envelope by its own stream, and keeps the rest', () => {
    const first = [env('root', 0), env('root', 1), env('sub-a', 0)]
    const afterFirst = applyRawEventsPage(initialTraceStreamState, page(first, cursorOf(first)))

    // A server that re-sends the boundary envelope must not duplicate the row,
    // and must not stall the stream either.
    const overlap = [env('root', 1), env('root', 2), env('sub-a', 0), env('sub-a', 1)]
    const after = applyRawEventsPage(afterFirst, page(overlap, cursorOf(overlap)))

    expect(after.events.map((e) => `${e.task_id}#${e.seq}`)).toEqual([
      'root#0',
      'root#1',
      'sub-a#0',
      'root#2',
      'sub-a#1',
    ])
  })

  it('keeps a stream whose increment was empty this round', () => {
    const first = [env('root', 0), env('sub-a', 0)]
    const afterFirst = applyRawEventsPage(initialTraceStreamState, page(first, cursorOf(first)))

    // Only the root moved. Dropping `sub-a` from the cursor would ask for that
    // stream from zero next time and re-deliver it forever.
    const second = [env('root', 1)]
    const after = applyRawEventsPage(afterFirst, page(second, { root: 1, 'sub-a': 0 }))

    expect(after.cursor).toEqual({ root: 1, 'sub-a': 0 })
  })

  it('never rewinds a stream, whatever the server echoes back', () => {
    const first = [env('root', 5)]
    const afterFirst = applyRawEventsPage(initialTraceStreamState, page(first, { root: 5 }))

    const after = applyRawEventsPage(afterFirst, page([], { root: 2 }))

    expect(after.cursor).toEqual({ root: 5 })
    expect(after).toBe(afterFirst)
  })

  it('registers a stream the server names before any of its envelopes arrive', () => {
    const after = applyRawEventsPage(initialTraceStreamState, page([env('root', 0)], { root: 0, 'sub-a': 3 }))

    expect(after.streams).toEqual(['root', 'sub-a'])
    expect(after.cursor).toEqual({ root: 0, 'sub-a': 3 })
  })

  it('returns the same state reference when a page carried nothing new', () => {
    const first = [env('root', 0), env('root', 1)]
    const afterFirst = applyRawEventsPage(initialTraceStreamState, page(first, cursorOf(first)))

    const again = applyRawEventsPage(afterFirst, page(first, cursorOf(first)))

    // Identity, not deep equality: it is what stops a polling page re-rendering
    // every two seconds against an idle session.
    expect(again).toBe(afterFirst)
  })

  it('accepts a seq-less envelope without letting it touch the cursor', () => {
    const malformed = { task_id: 'root', type: 'Mystery', payload: {} } as unknown as RawEnvelope
    const after = applyRawEventsPage(initialTraceStreamState, page([env('root', 0), malformed], { root: 0 }))

    expect(after.events).toHaveLength(2)
    expect(after.cursor).toEqual({ root: 0 })
  })

  it('files an envelope with no task id under a single named stream', () => {
    const orphan = { seq: 0, type: 'Mystery', payload: {} } as unknown as RawEnvelope
    const after = applyRawEventsPage(initialTraceStreamState, page([orphan], {}))

    expect(after.streams).toHaveLength(1)
    expect(after.events).toHaveLength(1)
  })

  it('survives a payload with no events array at all', () => {
    const after = applyRawEventsPage(initialTraceStreamState, {} as unknown as RawEventsPayload)

    expect(after).toBe(initialTraceStreamState)
  })
})

describe('countByStream', () => {
  it('counts per stream', () => {
    expect(countByStream([env('root', 0), env('sub-a', 0), env('root', 1)])).toEqual({
      root: 2,
      'sub-a': 1,
    })
  })
})
