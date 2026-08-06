import { renderHook } from '@testing-library/react'
import { act } from 'react'
import { beforeEach, describe, expect, it } from 'vitest'
import {
  HISTORY_LIMIT,
  NOT_RECALLING,
  appendHistory,
  stepBack,
  stepForward,
  syncRecall,
  useHistoryRecall,
  useHistoryStore,
} from './history'

const HISTORY = ['first', 'second', 'third']

beforeEach(() => {
  useHistoryStore.setState({ entries: [] })
})

describe('the history buffer', () => {
  it('lives outside per-session composer state', () => {
    // It is a property of the person, not the conversation: the prompt you
    // want back is usually the one you just sent somewhere else, and a
    // per-session buffer is empty exactly when a new session makes recall
    // most useful. It also means the clearDraft after every successful send
    // cannot take the recall buffer with it.
    appendHistory('from session A')
    appendHistory('from session B')
    expect(useHistoryStore.getState().entries).toEqual(['from session A', 'from session B'])
  })

  it('trims, ignores empties, and skips consecutive duplicates', () => {
    appendHistory('  spaced  ')
    appendHistory('')
    appendHistory('   ')
    appendHistory('spaced')
    appendHistory('other')
    appendHistory('spaced')
    expect(useHistoryStore.getState().entries).toEqual(['spaced', 'other', 'spaced'])
  })

  it('caps at the limit, keeping the newest', () => {
    for (let index = 0; index < HISTORY_LIMIT + 5; index += 1) appendHistory(`p${index}`)
    const entries = useHistoryStore.getState().entries
    expect(entries).toHaveLength(HISTORY_LIMIT)
    expect(entries[entries.length - 1]).toBe(`p${HISTORY_LIMIT + 4}`)
    expect(entries[0]).toBe('p5')
  })
})

describe('↑ starts recall only on an empty composer', () => {
  it('recalls the newest entry from a blank box', () => {
    expect(stepBack(NOT_RECALLING, '', HISTORY)).toEqual({
      state: { position: 2, expected: 'third', stash: '' },
      draft: 'third',
    })
  })

  it('does nothing at all when the box holds text', () => {
    // Returning null means the caller lets the event through. If ↑ replaced a
    // half-written message there would be no undo, from a keystroke the user
    // pressed to move the caret.
    expect(stepBack(NOT_RECALLING, 'half a thought', HISTORY)).toBeNull()
    expect(stepBack(NOT_RECALLING, 'x', HISTORY)).toBeNull()
  })

  it('treats a whitespace-only box as empty, and stashes the whitespace', () => {
    expect(stepBack(NOT_RECALLING, '  \n ', HISTORY)).toEqual({
      state: { position: 2, expected: 'third', stash: '  \n ' },
      draft: 'third',
    })
  })

  it('does nothing when there is no history', () => {
    expect(stepBack(NOT_RECALLING, '', [])).toBeNull()
  })

  it('steps older while in recall, and stops at the oldest', () => {
    const first = stepBack(NOT_RECALLING, '', HISTORY)!
    const second = stepBack(first.state, first.draft, HISTORY)!
    expect(second.draft).toBe('second')
    const third = stepBack(second.state, second.draft, HISTORY)!
    expect(third.draft).toBe('first')
    // Bottom of history reached: not prevented, so the caret moves.
    expect(stepBack(third.state, third.draft, HISTORY)).toBeNull()
  })
})

describe('any edit exits recall', () => {
  it('drops out the moment the draft stops matching what recall wrote', () => {
    const recalled = stepBack(NOT_RECALLING, '', HISTORY)!
    expect(syncRecall(recalled.state, 'third')).toBe(recalled.state)
    expect(syncRecall(recalled.state, 'thirdx')).toEqual(NOT_RECALLING)
  })

  it('makes the next ↑ a caret move, because the box is no longer empty', () => {
    const recalled = stepBack(NOT_RECALLING, '', HISTORY)!
    // The user typed one character into the recalled text.
    expect(stepBack(recalled.state, 'third!', HISTORY)).toBeNull()
  })

  it('re-enters cleanly once the box is emptied again', () => {
    const recalled = stepBack(NOT_RECALLING, '', HISTORY)!
    const edited = syncRecall(recalled.state, 'third!')
    expect(stepBack(edited, '', HISTORY)).toEqual({
      state: { position: 2, expected: 'third', stash: '' },
      draft: 'third',
    })
  })
})

describe('↓', () => {
  it('does nothing when not recalling', () => {
    expect(stepForward(NOT_RECALLING, 'anything', HISTORY)).toBeNull()
    expect(stepForward(NOT_RECALLING, '', HISTORY)).toBeNull()
  })

  it('steps newer, then restores the pre-recall stash past the newest', () => {
    const back1 = stepBack(NOT_RECALLING, '  ', HISTORY)!
    const back2 = stepBack(back1.state, back1.draft, HISTORY)!
    expect(back2.draft).toBe('second')

    const forward1 = stepForward(back2.state, back2.draft, HISTORY)!
    expect(forward1.draft).toBe('third')

    const forward2 = stepForward(forward1.state, forward1.draft, HISTORY)!
    expect(forward2.state).toEqual(NOT_RECALLING)
    expect(forward2.draft).toBe('  ')
  })

  it('is inert after an edit dropped recall', () => {
    const recalled = stepBack(NOT_RECALLING, '', HISTORY)!
    expect(stepForward(recalled.state, 'third and more', HISTORY)).toBeNull()
  })
})

describe('useHistoryRecall', () => {
  it('judges each keystroke against the draft it is handed, not a captured one', () => {
    appendHistory('alpha')
    appendHistory('beta')
    const { result } = renderHook(() => useHistoryRecall())

    expect(result.current.back('')).toBe('beta')
    expect(result.current.back('beta')).toBe('alpha')
    // A keydown handler runs between renders; a recall that judged "unedited"
    // from a stale draft is the bug this shape exists to prevent.
    expect(result.current.back('alpha edited')).toBeNull()
    expect(result.current.forward('alpha edited')).toBeNull()
  })

  it('sees entries appended after it mounted', () => {
    const { result } = renderHook(() => useHistoryRecall())
    expect(result.current.back('')).toBeNull()
    act(() => appendHistory('later'))
    expect(result.current.back('')).toBe('later')
  })
})
