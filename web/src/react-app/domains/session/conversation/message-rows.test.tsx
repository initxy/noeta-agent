import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { AssistantItem, UserItem } from '@/app/fold'
import { AssistantRow, UserRow } from './message-rows'
import { StreamingProvider } from './stream/streaming-context'

/**
 * What a message row does to the text it is given.
 *
 * The load-bearing asymmetry: the **agent's** answer is markdown and is
 * rendered as such, and the **user's** words are not and never are. Plus the
 * one thing that makes the highlighting gate reachable at all — a fenced block
 * has to arrive at `CodeBlock`, which is where "do not highlight while the turn
 * is streaming" lives.
 */

const assistant = (text: string): AssistantItem => ({ kind: 'assistant', key: 1, taskId: 't1', text })

const user = (content: string): UserItem => ({
  kind: 'user',
  key: 0,
  taskId: 't1',
  content,
  images: [],
  pending: false,
})

afterEach(cleanup)

describe('the agent answer', () => {
  it('renders markdown structure rather than the source characters', () => {
    render(<AssistantRow item={assistant('# Title\n\n- one\n- two')} />)

    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Title')
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
    // The hashes and hyphens are gone, which is the whole claim.
    expect(screen.queryByText('# Title')).toBeNull()
  })

  it('routes a fenced block through the code block, which is where the gate is', () => {
    render(
      <StreamingProvider streaming>
        <AssistantRow item={assistant('before\n\n```ts\nconst a = 1\n```')} />
      </StreamingProvider>,
    )

    const block = screen.getByTestId('code-block')
    expect(block.textContent).toBe('const a = 1')
    // Streaming: plain, un-highlighted, and scrollable in its own right so a
    // wheel gesture inside it is not the reader leaving the transcript.
    expect(block.getAttribute('data-highlighted')).toBe('false')
    expect(block.getAttribute('data-scrollable')).toBe('true')
  })

  it('keeps short inline code inline instead of opening a block for it', () => {
    render(<AssistantRow item={assistant('run `npm test` first')} />)
    expect(screen.queryByTestId('code-block')).toBeNull()
  })
})

describe('what the user said', () => {
  it('is never reinterpreted as markdown', () => {
    // Their asterisks are theirs. A renderer here eats them and re-flows the
    // line breaks of anyone who pasted a snippet into the box.
    render(<UserRow item={user('use *args and **kwargs')} />)

    expect(screen.getByText('use *args and **kwargs')).toBeTruthy()
    expect(document.querySelector('strong')).toBeNull()
    expect(document.querySelector('em')).toBeNull()
  })
})
