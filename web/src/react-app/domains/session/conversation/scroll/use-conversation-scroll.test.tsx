import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { scrollStateOf, useScrollStore } from './scroll-store'
import { useConversationScroll } from './use-conversation-scroll'

/**
 * jsdom has no layout, so the geometry is stubbed and the test drives the
 * controller the way a browser would: set `scrollTop`, then fire the event the
 * browser would have fired. That is enough to pin the transitions, which are
 * the part that goes wrong — the machine's arithmetic is already covered
 * purely in `scroll-machine.test.ts`.
 */

const SCROLL_HEIGHT = 1000
const CLIENT_HEIGHT = 400
/** The offset at which the container is exactly at its bottom. */
const BOTTOM = SCROLL_HEIGHT - CLIENT_HEIGHT

function stub(node: HTMLElement | null) {
  if (node === null || 'scrollTopStubbed' in node) return
  let top = 0
  Object.defineProperties(node, {
    scrollTopStubbed: { value: true },
    scrollHeight: { value: SCROLL_HEIGHT, configurable: true },
    clientHeight: { value: CLIENT_HEIGHT, configurable: true },
    scrollTop: {
      configurable: true,
      get: () => top,
      set: (value: number) => {
        top = value
      },
    },
  })
}

function Harness({ sessionId }: { sessionId: string | null }) {
  const scroll = useConversationScroll(sessionId)
  return (
    <div
      {...scroll.containerProps}
      ref={(node) => {
        scroll.containerRef.current = node
        stub(node)
      }}
      data-testid="container"
    >
      <div ref={scroll.contentRef}>
        <div data-scrollable="true" data-testid="nested" />
      </div>
    </div>
  )
}

const container = () => screen.getByTestId('container')

/** Let the mount-time restore finish before the test drives anything. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 60))

beforeEach(() => {
  useScrollStore.setState({ sessions: {} })
})

afterEach(() => {
  cleanup()
})

describe('the scroll controller', () => {
  it('treats a small upward move as anchoring jitter', async () => {
    render(<Harness sessionId="s1" />)
    await settle()
    const element = container()

    element.scrollTop = BOTTOM
    fireEvent.scroll(element)
    expect(scrollStateOf('s1').mode).toBe('sticky')

    // 10px up with no gesture is layout settling, not a reader leaving.
    element.scrollTop = BOTTOM - 10
    fireEvent.scroll(element)

    expect(scrollStateOf('s1').mode).toBe('sticky')
  })

  it('treats a 16px upward move as leaving the bottom', async () => {
    render(<Harness sessionId="s1" />)
    await settle()
    const element = container()

    element.scrollTop = BOTTOM
    fireEvent.scroll(element)
    element.scrollTop = BOTTOM - 16
    fireEvent.scroll(element)

    expect(scrollStateOf('s1')).toMatchObject({ mode: 'manual', scrollTop: BOTTOM - 16 })
  })

  it('re-arms sticky when the reader returns to the exact bottom', async () => {
    render(<Harness sessionId="s1" />)
    await settle()
    const element = container()

    element.scrollTop = 100
    fireEvent.wheel(element)
    fireEvent.scroll(element)
    expect(scrollStateOf('s1').mode).toBe('manual')

    element.scrollTop = BOTTOM
    fireEvent.wheel(element)
    fireEvent.scroll(element)

    expect(scrollStateOf('s1').mode).toBe('sticky')
  })

  it('reads a downward move during a gesture as leaving, and without one as settling', async () => {
    render(<Harness sessionId="s1" />)
    await settle()
    const element = container()

    // No gesture: content growing under a sticky transcript.
    element.scrollTop = 100
    fireEvent.scroll(element)
    expect(scrollStateOf('s1').mode).toBe('sticky')

    // Same movement, but the reader's hand is on it.
    fireEvent.wheel(element)
    element.scrollTop = 200
    fireEvent.scroll(element)
    expect(scrollStateOf('s1').mode).toBe('manual')
  })

  it('ignores a gesture that belongs to a nested scroll area', async () => {
    // Scrolling a tool's output must not detach the whole transcript.
    render(<Harness sessionId="s1" />)
    await settle()
    const element = container()

    fireEvent.wheel(screen.getByTestId('nested'))
    element.scrollTop = 100
    fireEvent.scroll(element)

    expect(scrollStateOf('s1').mode).toBe('sticky')
  })

  it('does not let one session inherit another session s mode', async () => {
    const { rerender } = render(<Harness sessionId="s1" />)
    await settle()
    const element = container()

    element.scrollTop = 100
    fireEvent.wheel(element)
    fireEvent.scroll(element)
    expect(scrollStateOf('s1').mode).toBe('manual')

    rerender(<Harness sessionId="s2" />)
    await settle()

    expect(scrollStateOf('s2').mode).toBe('sticky')
    expect(scrollStateOf('s1')).toMatchObject({ mode: 'manual', scrollTop: 100 })
  })

  it('toggles overflow-anchor with the mode', async () => {
    // Off while we own the anchor; on so the browser holds the reading
    // position for someone browsing back.
    render(<Harness sessionId="s1" />)
    await settle()
    const element = container()
    expect(element.style.overflowAnchor).toBe('none')

    element.scrollTop = 100
    fireEvent.wheel(element)
    fireEvent.scroll(element)

    expect(element.style.overflowAnchor).toBe('auto')
  })
})
