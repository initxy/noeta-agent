import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import { ApiError } from '@/app/api'
import type { UserItem } from '@/app/fold'
import type { RawUIEvent } from '@/app/types'
import { createQueryClient } from '@/react-app/infra/query-client'
import { useConversationStore } from '../state/conversation-store'
import { EditAndRetry } from './edit-and-retry'

/**
 * Edit-a-message-and-retry, which is `fork` plus a send that lands on the new
 * child session.
 *
 * The properties that matter are the ones a user would otherwise discover the
 * hard way: the original session survives untouched, the edit is sent to the
 * child (not the source stream), the view navigates to the child, and the
 * shared workspace is stated before the fork, not after it.
 */

vi.mock('@/app/api/sessions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/app/api/sessions')>()
  return {
    ...actual,
    forkSession: vi.fn(async () => ({ session_id: 's-child', task_id: 't-child' })),
    sendMessage: vi.fn(async () => ({ task_id: 't-child' })),
  }
})

const navigate = vi.fn()
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>()
  return { ...actual, useNavigate: () => navigate }
})

const api = await import('@/app/api/sessions')
const forkSession = vi.mocked(api.forkSession)
const sendMessage = vi.mocked(api.sendMessage)

const frame = (
  task: string,
  seq: number | null,
  type: string,
  data: Record<string, unknown> = {},
): RawUIEvent => ({ seq, type, data: { _task: task, ...data } })

const store = () => useConversationStore.getState()

function seedTwoMessages() {
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

function show(item: UserItem) {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <EditAndRetry projectId="p1" sessionId="s1" item={item} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  useConversationStore.setState({ runtimes: {}, order: [] })
  forkSession.mockClear()
  sendMessage.mockClear()
  navigate.mockClear()
  forkSession.mockResolvedValue({ session_id: 's-child', task_id: 't-child' })
})
afterEach(cleanup)

describe('edit and retry', () => {
  it('is not offered on the opening message of a stream', () => {
    // The engine refuses it — a fork needs a prior turn to inherit — so an
    // affordance here could only ever produce a 409.
    seedTwoMessages()
    show(messageAt(0))
    expect(screen.queryByText('Edit & retry')).toBeNull()
  })

  it('states the shared workspace before the fork is made', () => {
    seedTwoMessages()
    show(messageAt(2))
    fireEvent.click(screen.getByText('Edit & retry'))
    expect(screen.getByText(/shares the project directory/)).toBeTruthy()
    expect(screen.getByText(/The original stays where it is\./)).toBeTruthy()
  })

  it('forks at the message and sends the edit to the child session', async () => {
    seedTwoMessages()
    show(messageAt(2))
    fireEvent.click(screen.getByText('Edit & retry'))

    fireEvent.change(screen.getByLabelText('Edit message'), {
      target: { value: 'second, but better' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Fork & send' }))

    await waitFor(() => expect(sendMessage).toHaveBeenCalled())

    // Forked at the anchor, on the stream the message belongs to.
    expect(forkSession).toHaveBeenCalledWith('s1', { task_id: 't-root', message_seq: 2 })
    // Sent to the CHILD session, on the child's root task — not the source.
    expect(sendMessage.mock.calls[0][0]).toBe('s-child')
    expect(sendMessage.mock.calls[0][1]).toMatchObject({
      text: 'second, but better',
      task_id: 't-child',
    })
  })

  it('navigates to the child session and leaves the source untouched', async () => {
    seedTwoMessages()
    show(messageAt(2))
    fireEvent.click(screen.getByText('Edit & retry'))
    fireEvent.change(screen.getByLabelText('Edit message'), {
      target: { value: 'second, but better' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Fork & send' }))

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith('/project/p1/session/s-child'),
    )
    // The source session's transcript is untouched — a fork writes nothing to
    // it, and nothing optimistic was appended to it either.
    const originals = store().runtimes.s1.conversation.items.filter(
      (item) => item.kind === 'user',
    )
    expect(originals).toHaveLength(2)
  })

  it('explains a refused fork instead of swallowing it', async () => {
    seedTwoMessages()
    forkSession.mockRejectedValueOnce(
      new ApiError('seq 2 is not a user message on this stream', 409, 'not_forkable'),
    )
    show(messageAt(2))
    fireEvent.click(screen.getByText('Edit & retry'))
    fireEvent.click(screen.getByRole('button', { name: 'Fork & send' }))

    expect(await screen.findByRole('alert')).toBeTruthy()
    expect(screen.getByText(/cannot be branched/)).toBeTruthy()
    expect(sendMessage).not.toHaveBeenCalled()
    expect(navigate).not.toHaveBeenCalled()
  })

  it('does not navigate when the child was made but the send was rejected', async () => {
    seedTwoMessages()
    sendMessage.mockRejectedValueOnce(new ApiError('a turn is already running', 409, 'busy'))
    show(messageAt(2))
    fireEvent.click(screen.getByText('Edit & retry'))
    fireEvent.click(screen.getByRole('button', { name: 'Fork & send' }))

    expect(await screen.findByRole('alert')).toBeTruthy()
    // The user stays put; the child exists on the server and is reachable from
    // the sidebar, but a failed send is not a reason to yank them off-screen.
    expect(navigate).not.toHaveBeenCalled()
  })
})
