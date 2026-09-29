import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { foldEvents, initialConversationState } from '@/app/fold'
import type { RawUIEvent } from '@/app/types'
import { sendState } from '../state/send-state'
import type { SendState } from '../state/send-state'
import { SendControls } from './send-controls'

/**
 * The send-state table — idle / busy / steering against Run / Stop / Send —
 * pinned twice: once as the pure machine, once as the controls that are the
 * only thing a user sees of it.
 *
 * The machine is driven through the **real fold** rather than hand-built
 * state, because "a stopped turn leaves the composer usable" is a claim about
 * what a sequence of wire frames does, and asserting it against a state object
 * someone typed by hand would pin the assumption instead of the behaviour.
 */

const frame = (type: string, data: Record<string, unknown> = {}, seq: number | null = null) =>
  ({ seq, type, data }) as RawUIEvent

const after = (...events: RawUIEvent[]) => foldEvents(initialConversationState(), events)

const started = frame('turn_started', {}, 0)

const machine = (over: {
  conversation?: ReturnType<typeof after>
  sending?: boolean
  draft?: string
  steering?: boolean
}) =>
  sendState({
    conversation: over.conversation ?? initialConversationState(),
    sending: over.sending ?? false,
    draft: over.draft ?? '',
    steering: over.steering ?? false,
  })

afterEach(() => {
  cleanup()
})

describe('the send-state table', () => {
  it('is idle with nothing running', () => {
    const state = machine({ draft: 'go' })
    expect(state.mode).toBe('idle')
    expect(state.canRun).toBe(true)
    expect(state.canSteer).toBe(false)
    expect(state.canStop).toBe(false)
    expect(state.selectorsEnabled).toBe(true)
  })

  it('is busy while a turn runs: stop and steer, no run', () => {
    const state = machine({ conversation: after(started), draft: 'also do this' })
    expect(state.mode).toBe('busy')
    expect(state.canRun).toBe(false)
    expect(state.canSteer).toBe(true)
    expect(state.canStop).toBe(true)
  })

  it('keeps the model and effort pickers live on busy, and freezes them on steering', () => {
    const conversation = after(started)
    expect(machine({ conversation, draft: 'x' }).selectorsEnabled).toBe(true)
    const steering = machine({ conversation, draft: 'x', steering: true })
    expect(steering.mode).toBe('steering')
    expect(steering.selectorsEnabled).toBe(false)
    // Steering is busy in every other respect — it is a freeze, not a mode.
    expect(steering.canSteer).toBe(true)
    expect(steering.canStop).toBe(true)
  })

  it('withholds the steer while a question is pending', () => {
    // The backend 409s anything sent into a pending question, so offering Send
    // would be offering an error.
    const conversation = after(
      started,
      frame('question', { question_id: 'q1', reason: 'pick', questions: [] }, 1),
    )
    const state = machine({ conversation, draft: 'never mind' })
    expect(state.phase).toBe('waiting')
    expect(state.canSteer).toBe(false)
    expect(state.canStop).toBe(true)
  })

  it('offers nothing to send on an empty draft, and Stop regardless', () => {
    const state = machine({ conversation: after(started), draft: '   \n ' })
    expect(state.canSteer).toBe(false)
    expect(state.canStop).toBe(true)
  })

  it('returns to idle after an interrupted turn — stopping is not dying', () => {
    const conversation = after(started, frame('turn_finished', { status: 'interrupted' }, 1))
    const state = machine({ conversation, draft: 'carry on' })
    expect(state.mode).toBe('idle')
    expect(state.canRun).toBe(true)
  })

  it('returns to idle after a turn_failed — a provider 5xx parks the turn', () => {
    const conversation = after(
      started,
      frame('turn_finished', { status: 'turn_failed', reason: 'upstream 503' }, 1),
    )
    expect(machine({ conversation, draft: 'retry' }).canRun).toBe(true)
  })
})

function show(state: SendState, over: Partial<Parameters<typeof SendControls>[0]> = {}) {
  const props = {
    state,
    onRun: vi.fn(),
    onSteer: vi.fn(),
    onStop: vi.fn(),
    ...over,
  }
  render(<SendControls {...props} />)
  return props
}

describe('the control cluster', () => {
  it('renders exactly one control when idle', () => {
    show(machine({ draft: 'go' }))
    expect(screen.getAllByRole('button').map((b) => b.textContent)).toEqual(['Run'])
  })

  it('renders Stop apart from Send when busy', () => {
    show(machine({ conversation: after(started), draft: 'more' }))
    expect(screen.getByRole('button', { name: 'Stop' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy()
    // The primary segment never becomes Stop, and there is no Run while busy.
    expect(screen.queryByRole('button', { name: 'Run' })).toBeNull()
  })

  it('steers on the primary Send when busy', () => {
    const props = show(machine({ conversation: after(started), draft: 'later' }))
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(props.onSteer).toHaveBeenCalledTimes(1)
  })

  it('leaves Stop live and hides Send when there is nothing to send', () => {
    const props = show(machine({ conversation: after(started), draft: '' }))
    const stop = screen.getByRole('button', { name: 'Stop' }) as HTMLButtonElement
    expect(stop.disabled).toBe(false)
    // No draft, no steer: Send is not drawn at all rather than drawn disabled.
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull()
    fireEvent.click(stop)
    expect(props.onStop).toHaveBeenCalledTimes(1)
  })
})
