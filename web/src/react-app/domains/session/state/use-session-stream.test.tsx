import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import type { SessionStream, SessionStreamOptions } from '@/app/sse'
import type { RawUIEvent } from '@/app/types'
import { useConversationStore } from './conversation-store'
import { useSessionStream } from './use-session-stream'
import type { Scheduler } from './event-batcher'

/**
 * The React binding, and only the React binding.
 *
 * The parser, the backoff ladder and the abort-on-switch are pinned in
 * `app/sse`. What can only break here is the wiring: whether a burst of frames
 * costs one store write or twenty, and whether the resume cursor is read fresh
 * at connect time or frozen into a closure. The second one is invisible in a
 * browser — everything works, the session just replays from the top on every
 * reconnect — which is exactly why it is pinned.
 */

function manualScheduler() {
  let queued: (() => void)[] = []
  const scheduler: Scheduler = {
    schedule(fn) {
      queued.push(fn)
      return queued.length
    },
    cancel() {
      queued = []
    },
  }
  return {
    scheduler,
    tick() {
      const due = queued
      queued = []
      act(() => {
        for (const fn of due) fn()
      })
    },
  }
}

/** A stand-in for `openSessionStream` that records how it was called. */
function recordingOpener() {
  const connections: SessionStreamOptions[] = []
  const open = (options: SessionStreamOptions): SessionStream => {
    connections.push(options)
    return { close: vi.fn(), attempt: 0, closed: false }
  }
  return {
    open,
    connections,
    get latest() {
      return connections[connections.length - 1]
    },
    /** The cursor the machine would send on a reconnect right now. */
    cursor() {
      return connections[connections.length - 1].lastSeq()
    },
  }
}

const frame = (type: string, data: Record<string, unknown> = {}, seq: number | null = null) =>
  ({ seq, type, data }) as RawUIEvent

let renders = 0

function Probe({
  sessionId,
  deps,
}: {
  sessionId: string | null
  deps: { open: (o: SessionStreamOptions) => SessionStream; scheduler: Scheduler }
}) {
  useSessionStream(sessionId, deps)
  const items = useConversationStore(
    (state) => state.runtimes[sessionId ?? '']?.conversation.items.length ?? 0,
  )
  renders += 1
  return <span data-testid="items">{items}</span>
}

beforeEach(() => {
  renders = 0
  useConversationStore.setState({ runtimes: {}, order: [] })
})

afterEach(() => {
  cleanup()
})

describe('useSessionStream', () => {
  it('turns a burst of frames into one store write and one render', () => {
    const clock = manualScheduler()
    const opener = recordingOpener()
    let writes = 0
    const unsubscribe = useConversationStore.subscribe(() => {
      writes += 1
    })

    render(<Probe sessionId="s1" deps={{ open: opener.open, scheduler: clock.scheduler }} />)
    const rendersAfterMount = renders
    writes = 0

    act(() => {
      for (let i = 0; i < 30; i += 1) {
        opener.latest.onEvent(frame('delta', { call_id: 'c1', kind: 'text', text: 'x', index: 0 }))
      }
    })
    // Still nothing applied: 30 frames are waiting for the next paint.
    expect(writes).toBe(0)
    expect(renders).toBe(rendersAfterMount)

    clock.tick()

    expect(writes).toBe(1)
    expect(renders).toBe(rendersAfterMount)
    // …and the frames were not lost on the way.
    const delta = useConversationStore.getState().runtimes.s1.conversation.delta
    expect(delta?.blocks.get(0)?.text).toBe('x'.repeat(30))
    unsubscribe()
  })

  it('advances the resume cursor as frames are applied', () => {
    const clock = manualScheduler()
    const opener = recordingOpener()

    render(<Probe sessionId="s1" deps={{ open: opener.open, scheduler: clock.scheduler }} />)

    // Nothing seen yet: a full replay.
    expect(opener.cursor()).toBe(-1)

    act(() => {
      opener.latest.onEvent(frame('turn_started', {}, 0))
      opener.latest.onEvent(frame('assistant_text', { text: 'hi' }, 7))
    })
    clock.tick()

    expect(opener.cursor()).toBe(7)
  })

  it('does not advance the cursor past frames it dropped on unmount', () => {
    const clock = manualScheduler()
    const opener = recordingOpener()

    const view = render(
      <Probe sessionId="s1" deps={{ open: opener.open, scheduler: clock.scheduler }} />,
    )
    act(() => {
      opener.latest.onEvent(frame('assistant_text', { text: 'never applied' }, 4))
    })
    view.unmount()
    clock.tick()

    expect(useConversationStore.getState().runtimes.s1.conversation.lastSeq).toBe(-1)
  })

  it('resumes from the cursor instead of replaying the session', () => {
    // The regression this exists for: a cursor captured in the effect closure
    // reads -1 forever, so every reconnect replays the whole conversation and
    // it looks like a backend bug.
    const clock = manualScheduler()
    const opener = recordingOpener()

    const view = render(
      <Probe sessionId="s1" deps={{ open: opener.open, scheduler: clock.scheduler }} />,
    )
    act(() => {
      opener.latest.onEvent(frame('assistant_text', { text: 'first' }, 11))
    })
    clock.tick()
    view.unmount()

    render(<Probe sessionId="s1" deps={{ open: opener.open, scheduler: clock.scheduler }} />)

    expect(opener.connections).toHaveLength(2)
    expect(opener.cursor()).toBe(11)
  })

  it('tracks the connection phase for the header', () => {
    const clock = manualScheduler()
    const opener = recordingOpener()

    render(<Probe sessionId="s1" deps={{ open: opener.open, scheduler: clock.scheduler }} />)
    expect(useConversationStore.getState().runtimes.s1.connection).toBe('connecting')

    act(() => opener.latest.onOpen?.())
    expect(useConversationStore.getState().runtimes.s1.connection).toBe('live')

    act(() => opener.latest.onClose?.(new Error('dropped')))
    expect(useConversationStore.getState().runtimes.s1.connection).toBe('retrying')
  })

  it('opens nothing for the surface that has no session yet', () => {
    const clock = manualScheduler()
    const opener = recordingOpener()

    render(<Probe sessionId={null} deps={{ open: opener.open, scheduler: clock.scheduler }} />)

    expect(opener.connections).toHaveLength(0)
  })
})
