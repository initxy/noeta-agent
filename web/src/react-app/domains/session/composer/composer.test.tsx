import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { ApiError } from '@/app/api'
import type { Model } from '@/app/types'
import type { RawUIEvent } from '@/app/types'
import { createQueryClient } from '@/react-app/infra/query-client'
import { useConversationStore } from '../state/conversation-store'
import { useComposerStore } from '../state/composer-store'
import { Composer } from './composer'

/**
 * The composer's own behaviour: what it sends, when it may send it, what it
 * holds back, and what it does with the words when the server says no.
 *
 * The state table is pinned as a pure function in `send-controls.test.tsx`;
 * what is pinned *here* is the wiring — that steer really is the idle send
 * path, and that neither a single Escape nor an IME commit can cost the user a
 * turn.
 */

const MODELS: Model[] = [
  { id: 'fast', label: 'Fast', default: false, efforts: ['low', 'medium'], default_effort: 'low' },
  { id: 'deep', label: 'Deep', default: true, efforts: ['low', 'high'], default_effort: 'high' },
]

vi.mock('@/app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/app/api')>()
  return {
    ...actual,
    fetchModels: vi.fn(async () => MODELS),
    listSessions: vi.fn(async () => []),
    sendMessage: vi.fn(async () => ({ task_id: 'task-1' })),
    interruptSession: vi.fn(async () => undefined),
    createSession: vi.fn(async () => ({
      id: 'fresh',
      project_id: 'p1',
      title: 'New session',
      status: 'idle' as const,
      created_at: '2026-07-31T00:00:00Z',
      updated_at: '2026-07-31T00:00:00Z',
      task_streams: [],
    })),
  }
})

const api = await import('@/app/api')
const sendMessage = vi.mocked(api.sendMessage)
const createSession = vi.mocked(api.createSession)
const interruptSession = vi.mocked(api.interruptSession)

const frame = (type: string, data: Record<string, unknown> = {}, seq: number | null = null) =>
  ({ seq, type, data }) as RawUIEvent

function Location() {
  return <span data-testid="path">{useLocation().pathname}</span>
}

/**
 * Which draft key the mounted composer is writing to. The editor is a
 * contentEditable, so the draft store — not `input().value` — is where the
 * text under test lives.
 */
let activeKey = 's1'

function show(sessionId: string | null = 's1') {
  activeKey = sessionId ?? '@new'
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={['/project/p1/session']}>
        <Composer projectId="p1" sessionId={sessionId} />
        <Location />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

/** Wait for the catalogue, so a send carries a resolved model rather than none. */
async function showWithModels(sessionId: string | null = 's1') {
  const view = show(sessionId)
  await screen.findByLabelText('Model')
  return view
}

const input = () => screen.getByLabelText('Message')
const runButton = () => screen.getByRole('button', { name: 'Run' }) as HTMLButtonElement
const sendButton = () => screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement
const stopButton = () => screen.getByRole('button', { name: 'Stop' }) as HTMLButtonElement
/** The model/effort popover trigger — a button carrying the accessible name "Model". */
const modelTrigger = () => screen.getByRole('button', { name: 'Model' }) as HTMLButtonElement
/** Open the popover and pick a model by its label. */
const pickModel = (label: string) => {
  fireEvent.click(modelTrigger())
  fireEvent.click(screen.getByRole('menuitemradio', { name: new RegExp(label) }))
}

/** What the composer currently holds — the draft string, not a DOM value. */
const draftValue = () => useComposerStore.getState().drafts[activeKey] ?? ''
const type = (text: string) => {
  act(() => {
    useComposerStore.getState().setDraft(activeKey, text)
  })
}
const apply = (...events: RawUIEvent[]) => {
  act(() => useConversationStore.getState().apply('s1', events))
}

/** Put session `s1` into a running turn. */
const startTurn = () => apply(frame('turn_started', {}, 0))

beforeEach(() => {
  useConversationStore.setState({ runtimes: {}, order: [] })
  useComposerStore.setState({ drafts: {}, choices: {}, steering: {} })
  sendMessage.mockClear()
  createSession.mockClear()
  interruptSession.mockClear()
  sendMessage.mockResolvedValue({ task_id: 'task-1' })
  interruptSession.mockResolvedValue(undefined)
})

afterEach(() => {
  cleanup()
})

describe('running a turn', () => {
  it('sends the draft with the catalogue default model and effort', async () => {
    await showWithModels()
    type('  plan the week  ')
    fireEvent.click(runButton())

    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1))
    expect(sendMessage.mock.calls[0][0]).toBe('s1')
    expect(sendMessage.mock.calls[0][1]).toEqual({
      text: 'plan the week',
      model: 'deep',
      effort: 'high',
    })
    // The draft is cleared and the message is on screen before the round trip.
    expect(draftValue()).toBe('')
    const items = useConversationStore.getState().runtimes.s1.conversation.items
    expect(items).toHaveLength(1)
    expect(items[0].kind === 'user' && items[0].pending).toBe(true)
  })

  it('sends the effort the picked model actually offers', async () => {
    await showWithModels()
    pickModel('Fast')
    type('go')
    fireEvent.click(runButton())

    // `deep`'s default effort is `high`, which `fast` does not offer — sending
    // it would be a 422 the user never asked for.
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1))
    expect(sendMessage.mock.calls[0][1]).toEqual({ text: 'go', model: 'fast', effort: 'low' })
  })

  it('sends on Enter, and inserts a newline on Shift+Enter', async () => {
    await showWithModels()
    type('now')

    fireEvent.keyDown(input(), { key: 'Enter', shiftKey: true })
    expect(sendMessage).not.toHaveBeenCalled()

    fireEvent.keyDown(input(), { key: 'Enter' })
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1))
  })

  it('sends on Cmd/Ctrl+Enter too — there is no queue to hold it back', async () => {
    await showWithModels()
    type('now')

    fireEvent.keyDown(input(), { key: 'Enter', metaKey: true })
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1))
    expect(sendMessage.mock.calls[0][1].text).toBe('now')
  })

  it('does not send on the Enter that commits an IME composition', async () => {
    await showWithModels()
    type('你好')

    fireEvent.keyDown(input(), { key: 'Enter', keyCode: 229 })
    fireEvent.keyDown(input(), { key: 'Enter', isComposing: true })
    fireEvent.compositionStart(input())
    fireEvent.keyDown(input(), { key: 'Enter' })

    expect(sendMessage).not.toHaveBeenCalled()

    fireEvent.compositionEnd(input())
    fireEvent.keyDown(input(), { key: 'Enter' })
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1))
  })

  it('is disabled on an empty draft', async () => {
    await showWithModels()
    expect(runButton().disabled).toBe(true)
    type('   ')
    expect(runButton().disabled).toBe(true)
  })

  it('gives the words back when the send is rejected', async () => {
    sendMessage.mockRejectedValueOnce(
      new ApiError('A turn is already running', 409, 'session_busy'),
    )
    await showWithModels()
    type('too soon')
    fireEvent.click(runButton())

    await screen.findByText('A turn is already running')
    expect(draftValue()).toBe('too soon')
    // The optimistic bubble is withdrawn: the turn was never seeded.
    expect(useConversationStore.getState().runtimes.s1.conversation.items).toHaveLength(0)
    expect(useConversationStore.getState().runtimes.s1.sending).toBe(false)
  })

  it('does not hand the sent draft back when the first message creates the session', async () => {
    // The key changes `@new` -> <session id> at the same moment the draft is
    // *consumed*. Persisting it under the new key, or carrying it across the
    // rename, restores the message that was just dispatched into the box the
    // user is about to type their next one into.
    await showWithModels(null)
    type('first ever')
    fireEvent.click(runButton())

    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(useComposerStore.getState().drafts.fresh ?? '').toBe(''))
    expect(useComposerStore.getState().drafts['@new'] ?? '').toBe('')
  })

  it('creates the session on the first message and moves to it', async () => {
    await showWithModels(null)
    type('first ever')
    fireEvent.click(runButton())

    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1))
    expect(createSession).toHaveBeenCalledWith('p1', {})
    expect(sendMessage.mock.calls[0][0]).toBe('fresh')
    await waitFor(() =>
      expect(screen.getByTestId('path').textContent).toBe('/project/p1/session/fresh'),
    )
    expect(useConversationStore.getState().runtimes.fresh.conversation.items).toHaveLength(1)
  })
})

describe('steering a running turn', () => {
  it('swaps the single Run pill for Stop plus Send', async () => {
    await showWithModels()
    type('wait')
    startTurn()

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Run' })).toBeNull())
    expect(stopButton()).toBeTruthy()
    expect(sendButton().disabled).toBe(false)
    expect(screen.getByText(/Working/)).toBeTruthy()
  })

  it('steers through the ordinary send path — same endpoint, same body', async () => {
    await showWithModels()
    startTurn()
    type('also check the tests')
    fireEvent.click(sendButton())

    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1))
    expect(sendMessage.mock.calls[0][0]).toBe('s1')
    expect(sendMessage.mock.calls[0][1]).toEqual({
      text: 'also check the tests',
      model: 'deep',
      effort: 'high',
    })
  })

  it('keeps the pickers live on busy and freezes them on steering', async () => {
    await showWithModels()
    startTurn()
    type('adjust')
    // Busy alone must not lock the pickers: choosing the model for the *next*
    // turn while this one works is ordinary.
    expect(modelTrigger().disabled).toBe(false)

    fireEvent.click(sendButton())
    await waitFor(() => expect(modelTrigger().disabled).toBe(true))

    // The freeze lasts exactly as long as the turn it joined.
    apply(frame('turn_finished', { status: 'completed' }, 1))
    await waitFor(() => expect(modelTrigger().disabled).toBe(false))
  })

  it('withholds the steer while a question is pending', async () => {
    await showWithModels()
    type('wait')
    apply(
      frame('turn_started', {}, 0),
      frame('question', { question_id: 'q1', reason: 'pick', questions: [] }, 1),
    )

    await waitFor(() => expect(sendButton().disabled).toBe(true))
    expect(screen.getByText('Answer the question above to continue.')).toBeTruthy()
  })

  it('stays ENABLED after an interrupted turn and after a turn_failed', async () => {
    await showWithModels()
    type('carry on')

    apply(frame('turn_started', {}, 0), frame('turn_finished', { status: 'interrupted' }, 1))
    await waitFor(() => expect(runButton().disabled).toBe(false))

    apply(
      frame('turn_started', {}, 2),
      frame('turn_finished', { status: 'turn_failed', reason: 'upstream 503' }, 3),
    )
    await waitFor(() => expect(runButton().disabled).toBe(false))

    fireEvent.click(runButton())
    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1))
  })
})

describe('stopping', () => {
  it('takes two presses of Escape, and says so after the first', async () => {
    await showWithModels()
    startTurn()

    fireEvent.keyDown(input(), { key: 'Escape' })
    expect(screen.getByRole('status').textContent).toBe('Press Escape again to stop the agent')
    expect(interruptSession).not.toHaveBeenCalled()

    fireEvent.keyDown(input(), { key: 'Escape' })
    expect(interruptSession).toHaveBeenCalledTimes(1)
  })

  it('lets the armed window lapse after 3000 ms', async () => {
    vi.useFakeTimers()
    try {
      show()
      startTurn()
      fireEvent.keyDown(input(), { key: 'Escape' })
      expect(screen.queryByRole('status')).not.toBeNull()

      act(() => {
        vi.advanceTimersByTime(3000)
      })
      expect(screen.queryByRole('status')).toBeNull()

      // The next press arms again rather than stopping: the window lapsed, so
      // this is a first press.
      fireEvent.keyDown(input(), { key: 'Escape' })
      expect(interruptSession).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not arm at all when nothing is running', async () => {
    await showWithModels()
    fireEvent.keyDown(input(), { key: 'Escape' })
    expect(screen.queryByRole('status')).toBeNull()
    expect(interruptSession).not.toHaveBeenCalled()
  })
})
