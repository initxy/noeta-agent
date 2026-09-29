import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import { ApiError } from '@/app/api'
import type { UserItem } from '@/app/fold'
import type { RawUIEvent } from '@/app/types'
import { createQueryClient } from '@/react-app/infra/query-client'
import { useConversationStore } from '../state/conversation-store'
import { UndoLastTurn } from './undo-last-turn'

/**
 * "Undo last turn", which is `rewind` — re-base this stream in place and
 * restore files. The properties that matter: it appears only on the latest
 * committed message, is hidden while a turn runs and on a fork child, states
 * the file-rollback risk before the click, and rewinds without navigating.
 */

vi.mock('@/app/api/sessions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/app/api/sessions')>()
  return {
    ...actual,
    rewindSession: vi.fn(async () => ({ task_id: 't-root' })),
  }
})

const navigate = vi.fn()
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>()
  return { ...actual, useNavigate: () => navigate }
})

const api = await import('@/app/api/sessions')
const rewindSession = vi.mocked(api.rewindSession)

const frame = (
  task: string,
  seq: number | null,
  type: string,
  data: Record<string, unknown> = {},
): RawUIEvent => ({ seq, type, data: { _task: task, ...data } })

const store = () => useConversationStore.getState()

function seedTwoFinishedTurns() {
  // No trailing `turn_started`, so the session lands idle (undo is offered).
  store().apply('s1', [
    frame('t-root', 0, 'user_message', { content: 'first' }),
    frame('t-root', 1, 'assistant_text', { text: 'answer one' }),
    frame('t-root', 2, 'user_message', { content: 'second' }),
    frame('t-root', 3, 'assistant_text', { text: 'answer two' }),
  ])
}

function messageAt(key: number): UserItem {
  const item = store().runtimes.s1.conversation.items.find(
    (candidate) => candidate.kind === 'user' && candidate.key === key,
  )
  return item as UserItem
}

function show(item: UserItem, { isRoot = true }: { isRoot?: boolean } = {}) {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <UndoLastTurn sessionId="s1" item={item} isRoot={isRoot} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  useConversationStore.setState({ runtimes: {}, order: [] })
  rewindSession.mockClear()
  navigate.mockClear()
  rewindSession.mockResolvedValue({ task_id: 't-root' })
})
afterEach(cleanup)

describe('undo last turn', () => {
  it('is offered on the latest committed message', () => {
    seedTwoFinishedTurns()
    show(messageAt(2))
    expect(screen.getByText('Undo last turn')).toBeTruthy()
  })

  it('is not offered on an earlier message', () => {
    seedTwoFinishedTurns()
    show(messageAt(0))
    expect(screen.queryByText('Undo last turn')).toBeNull()
  })

  it('is not offered on a fork child (root-only for v1)', () => {
    seedTwoFinishedTurns()
    show(messageAt(2), { isRoot: false })
    expect(screen.queryByText('Undo last turn')).toBeNull()
  })

  it('is hidden while a turn is running', () => {
    store().apply('s1', [
      frame('t-root', 0, 'user_message', { content: 'first' }),
      frame('t-root', 1, 'assistant_text', { text: 'answer one' }),
      frame('t-root', 2, 'user_message', { content: 'second' }),
      // A live turn: no `turn_finished`, so the session is running.
      frame('t-root', 3, 'turn_started'),
    ])
    show(messageAt(2))
    expect(screen.queryByText('Undo last turn')).toBeNull()
  })

  it('states the file-rollback risk before the rewind', () => {
    seedTwoFinishedTurns()
    show(messageAt(2))
    fireEvent.click(screen.getByText('Undo last turn'))
    expect(screen.getByText(/restores the project files/)).toBeTruthy()
    expect(screen.getByText(/shared with your other sessions/)).toBeTruthy()
  })

  it('rewinds at the message without navigating', async () => {
    seedTwoFinishedTurns()
    show(messageAt(2))
    fireEvent.click(screen.getByText('Undo last turn'))
    fireEvent.click(screen.getByRole('button', { name: 'Undo & restore files' }))

    await waitFor(() => expect(rewindSession).toHaveBeenCalled())
    expect(rewindSession).toHaveBeenCalledWith('s1', { task_id: 't-root', message_seq: 2 })
    // No navigation: the SSE `rewind` frame truncates the transcript in place.
    expect(navigate).not.toHaveBeenCalled()
  })

  it('explains a refused rewind instead of swallowing it', async () => {
    seedTwoFinishedTurns()
    rewindSession.mockRejectedValueOnce(
      new ApiError('seq 2 is not a user message on this stream', 409, 'not_rewindable'),
    )
    show(messageAt(2))
    fireEvent.click(screen.getByText('Undo last turn'))
    fireEvent.click(screen.getByRole('button', { name: 'Undo & restore files' }))

    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByText(/cannot be undone/)).toBeTruthy()
  })
})
