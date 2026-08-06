import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import type { Model } from '@/app/types'
import { createQueryClient } from '@/react-app/infra/query-client'
import { useComposerStore } from '../../state/composer-store'
import { useConversationStore } from '../../state/conversation-store'
import { Composer } from '../composer'
import { useMentionStore } from './mention-store'

/**
 * What the editor's grammar becomes on the wire.
 *
 * Lives beside the editor because it is the editor's half of the send path: a
 * slash command is not a second endpoint, it is one array on an otherwise
 * ordinary `POST /messages`, and a mention is text. The composer's own
 * behaviour — steer, queue, stop, Escape — is pinned in `composer.test.tsx`.
 */

const MODELS: Model[] = [
  { id: 'deep', label: 'Deep', default: true, efforts: ['high'], default_effort: 'high' },
]

vi.mock('@/app/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/app/api')>()
  return {
    ...actual,
    fetchModels: vi.fn(async () => MODELS),
    listSessions: vi.fn(async () => []),
    listFiles: vi.fn(async () => []),
    sendMessage: vi.fn(async () => ({ task_id: 'task-1' })),
  }
})

const api = await import('@/app/api')
const sendMessage = vi.mocked(api.sendMessage)

async function show() {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={['/project/p1/session/s1']}>
        <Composer projectId="p1" sessionId="s1" />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  await screen.findByLabelText('Model')
}

const setDraft = (text: string) => {
  act(() => {
    useComposerStore.getState().setDraft('s1', text)
  })
}

const run = () => fireEvent.click(screen.getByRole('button', { name: 'Run' }))

beforeEach(() => {
  useConversationStore.setState({ runtimes: {}, order: [] })
  useComposerStore.setState({ drafts: {}, choices: {}, steering: {} })
  useMentionStore.setState({ tables: {} })
  sendMessage.mockClear()
  sendMessage.mockResolvedValue({ task_id: 'task-1' })
})

afterEach(() => {
  cleanup()
})

describe('a slash command on the wire', () => {
  it('sends the name as a pinned skill and the rest as the goal', async () => {
    await show()
    setDraft('/review look at the diff')
    run()

    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1))
    expect(sendMessage.mock.calls[0][1]).toEqual({
      text: 'look at the diff',
      model: 'deep',
      effort: 'high',
      skills: ['review'],
    })
  })

  it('omits `skills` entirely when there is no command', async () => {
    await show()
    setDraft('look at the diff')
    run()

    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1))
    // Not `[]`: `activations=()` keeps the seed byte-identical to the no-skill
    // path, and an empty array is a needless difference on the wire.
    expect(sendMessage.mock.calls[0][1].skills).toBeUndefined()
  })

  it('withholds the send for a command with no goal', async () => {
    await show()
    setDraft('/review')
    expect((screen.getByRole('button', { name: 'Run' }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('a mention on the wire', () => {
  it('decodes a known mention into the goal text', async () => {
    await show()
    act(() => useMentionStore.getState().remember('s1', 'src/a b.ts', 'file'))
    setDraft('open @src/a%20b.ts please')
    run()

    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1))
    expect(sendMessage.mock.calls[0][1].text).toBe('open @src/a b.ts please')
  })

  it('leaves an @word it does not know exactly as typed', async () => {
    await show()
    setDraft('ask @nobody about it')
    run()

    await waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1))
    expect(sendMessage.mock.calls[0][1].text).toBe('ask @nobody about it')
  })
})
