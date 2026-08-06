import { describe, expect, it } from 'vitest'
import { sortSessionRows } from './session-order'
import type { SessionRow } from '@/app/types'

function row(partial: Partial<SessionRow> & { id: string }): SessionRow {
  return {
    project_id: 'p1',
    title: partial.id,
    status: 'idle',
    created_at: '2026-07-31T10:00:00Z',
    updated_at: '2026-07-31T10:00:00Z',
    ...partial,
  }
}

describe('sortSessionRows', () => {
  it('puts the most recently touched session first', () => {
    const sorted = sortSessionRows([
      row({ id: 'old', updated_at: '2026-07-30T10:00:00Z' }),
      row({ id: 'new', updated_at: '2026-07-31T12:00:00Z' }),
      row({ id: 'mid', updated_at: '2026-07-31T09:00:00Z' }),
    ])
    expect(sorted.map((s) => s.id)).toEqual(['new', 'mid', 'old'])
  })

  it('floats pinned rows above everything, newest-first among themselves', () => {
    const sorted = sortSessionRows([
      row({ id: 'recent', updated_at: '2026-07-31T12:00:00Z' }),
      row({ id: 'pin-old', pinned: true, updated_at: '2026-07-01T00:00:00Z' }),
      row({ id: 'pin-new', pinned: true, updated_at: '2026-07-20T00:00:00Z' }),
    ])
    expect(sorted.map((s) => s.id)).toEqual(['pin-new', 'pin-old', 'recent'])
  })

  it('drops archived rows', () => {
    const sorted = sortSessionRows([row({ id: 'a' }), row({ id: 'b', archived: true })])
    expect(sorted.map((s) => s.id)).toEqual(['a'])
  })

  it('falls back to a stable order when timestamps are equal or unusable', () => {
    // A comparator that returns NaN leaves the order to the sort
    // implementation, which is how a list silently reshuffles between renders.
    const sorted = sortSessionRows([
      row({ id: 'b', updated_at: 'not-a-date' }),
      row({ id: 'a', updated_at: 'not-a-date' }),
    ])
    expect(sorted.map((s) => s.id)).toEqual(['a', 'b'])
  })

  it('does not mutate the array it was handed', () => {
    // It is the query cache's array; sorting in place reorders it for every
    // other consumer without notifying any of them.
    const input = [row({ id: 'b', updated_at: '2026-07-30T00:00:00Z' }), row({ id: 'a' })]
    const snapshot = input.map((s) => s.id)
    sortSessionRows(input)
    expect(input.map((s) => s.id)).toEqual(snapshot)
  })
})
