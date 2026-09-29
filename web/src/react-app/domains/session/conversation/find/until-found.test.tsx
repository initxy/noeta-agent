import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { applyHighlights, collectMarks } from './highlight'
import { UntilFound } from './until-found'

afterEach(() => {
  cleanup()
})

describe('a collapsed panel that stays searchable', () => {
  it('keeps its content in the DOM while closed', () => {
    // The obvious disclosure unmounts its body, and every word inside becomes
    // unsearchable by both find bars.
    render(
      <UntilFound open={false} onReveal={() => {}}>
        <p>the fold is pure</p>
      </UntilFound>,
    )

    const panel = screen.getByText('the fold is pure').parentElement as HTMLElement
    expect(panel.getAttribute('hidden')).toBe('until-found')
    expect(panel.textContent).toBe('the fold is pure')
  })

  it('is reachable by find while collapsed', () => {
    const { container } = render(
      <UntilFound open={false} onReveal={() => {}}>
        <p>the fold is pure</p>
      </UntilFound>,
    )
    applyHighlights(container, 'fold')

    expect(collectMarks(container)).toHaveLength(1)
  })

  it('tells its owner to open when the browser finds a match inside', () => {
    const onReveal = vi.fn()
    render(
      <UntilFound open={false} onReveal={onReveal}>
        <p>match</p>
      </UntilFound>,
    )

    const panel = screen.getByText('match').parentElement as HTMLElement
    panel.dispatchEvent(new Event('beforematch'))

    // The component's own state has to move, or the next render re-hides what
    // the browser just revealed.
    expect(onReveal).toHaveBeenCalledTimes(1)
  })

  it('drops the attribute when opened', () => {
    const { rerender } = render(
      <UntilFound open={false} onReveal={() => {}}>
        <p>body</p>
      </UntilFound>,
    )
    rerender(
      <UntilFound open={true} onReveal={() => {}}>
        <p>body</p>
      </UntilFound>,
    )

    expect((screen.getByText('body').parentElement as HTMLElement).hasAttribute('hidden')).toBe(
      false,
    )
  })
})
