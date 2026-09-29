import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useRef } from 'react'
import { ACTIVE_ATTR, MARK_SELECTOR } from './highlight'
import { FindBar } from './find-bar'
import { findActions, useFindStore } from './find-store'
import { useFind } from './use-find'

/**
 * The property worth an integration test is the one that cannot be stated
 * purely: an open search survives the transcript changing underneath it,
 * keeping the reader on the same match. Everything else here is the wiring
 * around that — the debounce, the ownership, the wrap.
 */

function Harness({ sessionId, rows }: { sessionId: string; rows: string[] }) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const find = useFind(sessionId, containerRef)
  return (
    <div>
      <div ref={containerRef} data-testid="scope">
        {rows.map((row) => (
          <p key={row}>{row}</p>
        ))}
      </div>
      <FindBar find={find} />
    </div>
  )
}

const marks = () => [...screen.getByTestId('scope').querySelectorAll<HTMLElement>(MARK_SELECTOR)]
const activeMark = () => screen.getByTestId('scope').querySelector(`[${ACTIVE_ATTR}]`)

afterEach(() => {
  act(() => findActions().closeFind())
  cleanup()
})

async function search(query: string) {
  act(() => findActions().openFind('s1'))
  act(() => findActions().setQuery(query))
  await waitFor(() => expect(marks().length).toBeGreaterThan(0))
  await waitFor(() => expect(activeMark()).not.toBeNull())
}

describe('find in conversation', () => {
  it('marks every hit and activates the first', async () => {
    render(<Harness sessionId="s1" rows={['the fold is pure', 'fold again']} />)
    await search('fold')

    expect(marks()).toHaveLength(2)
    expect(activeMark()).toBe(marks()[0])
    expect(useFindStore.getState().matchCount).toBe(2)
  })

  it('keeps the reader on the same match when the transcript grows', async () => {
    const { rerender } = render(<Harness sessionId="s1" rows={['fold one', 'fold two']} />)
    await search('fold')

    act(() => screen.getByLabelText('Next match').click())
    const active = activeMark()
    expect(active).toBe(marks()[1])

    // A streamed row lands *above* nothing and *below* everything, but the
    // list is rebuilt either way — index 1 is only still right by accident.
    rerender(<Harness sessionId="s1" rows={['fold one', 'fold two', 'fold three']} />)

    await waitFor(() => expect(marks()).toHaveLength(3))
    // Same element, not the same index: identity is what is retained.
    expect(activeMark()).toBe(active)
  })

  it('wraps forwards and backwards', async () => {
    render(<Harness sessionId="s1" rows={['fold one', 'fold two']} />)
    await search('fold')

    act(() => screen.getByLabelText('Previous match').click())
    expect(activeMark()).toBe(marks()[1])
    act(() => screen.getByLabelText('Next match').click())
    expect(activeMark()).toBe(marks()[0])
  })

  it('says how many matches there are, and says when there are none', async () => {
    render(<Harness sessionId="s1" rows={['the fold is pure']} />)
    await search('fold')
    expect(screen.getByTestId('find-bar').textContent).toContain('1/1')

    act(() => findActions().setQuery('nowhere'))
    await waitFor(() => expect(screen.getByTestId('find-bar').textContent).toContain('No matches'))
    expect(marks()).toHaveLength(0)
  })

  it('shows no counter under the minimum query length', async () => {
    render(<Harness sessionId="s1" rows={['fold']} />)
    act(() => findActions().openFind('s1'))
    act(() => findActions().setQuery('f'))

    await waitFor(() => expect(useFindStore.getState().appliedQuery).toBe('f'))
    expect(marks()).toHaveLength(0)
  })

  it('closes on Escape and takes its marks with it', async () => {
    render(<Harness sessionId="s1" rows={['the fold is pure']} />)
    await search('fold')

    fireEvent.keyDown(screen.getByLabelText('Find in conversation'), { key: 'Escape' })

    await waitFor(() => expect(screen.queryByTestId('find-bar')).toBeNull())
    expect(marks()).toHaveLength(0)
    // The text is intact — the original nodes went back where they came from.
    expect(screen.getByTestId('scope').textContent).toBe('the fold is pure')
  })

  it('opens only on the surface that owns the bar', () => {
    render(<Harness sessionId="s1" rows={['fold']} />)
    act(() => findActions().openFind('other-session'))

    expect(screen.queryByTestId('find-bar')).toBeNull()
  })
})
