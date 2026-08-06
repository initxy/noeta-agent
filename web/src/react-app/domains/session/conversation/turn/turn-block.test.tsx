import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { foldEvents, initialConversationState } from '@/app/fold'
import type { ConversationState } from '@/app/fold'
import type { RawUIEvent } from '@/app/types'
import { MessageList } from '../message-list'

/**
 * What the reader actually sees. The grouping rules are pinned in
 * `app/fold/aggregate.test.ts`; this pins that they reach the screen — that the
 * work shows on the turn's rail (no process fold in front of it), that a run of
 * calls is one line, and that a single call's detail is one click away.
 */

let seq = 0
const frame = (type: string, data: Record<string, unknown> = {}): RawUIEvent => ({
  seq: seq++,
  type,
  data: { _task: 't1', ...data },
})

const said = (content: string) => [frame('user_message', { content })]
const replied = (text: string) => [frame('assistant_text', { text })]

const call = (id: string, toolName: string, args: unknown, output = ''): RawUIEvent[] => [
  frame('tool_call', { call_id: id, tool_name: toolName, arguments: args }),
  frame('tool_result', { call_id: id, success: true, summary: 'ok', output }),
]

const started = (id: string, toolName: string, args: unknown): RawUIEvent[] => [
  frame('tool_call', { call_id: id, tool_name: toolName, arguments: args }),
]

function conversation(build: () => RawUIEvent[][]): ConversationState {
  seq = 0
  return foldEvents(initialConversationState(), build().flat())
}

function show(state: ConversationState) {
  return render(<MessageList conversation={state} emptyNote="No messages yet." />)
}

/** Five step rows: two commands, a read, a skill, a search. */
const workedHard = (): RawUIEvent[][] => [
  call('c1', 'Bash', { command: 'ls' }),
  call('c2', 'Bash', { command: 'pwd' }),
  call('c3', 'Read', { path: '/w/a.ts' }),
  [frame('skill_activated', { skill: 'planner' })],
  call('c4', 'Grep', { pattern: 'todo' }),
  replied('here is the answer'),
]

afterEach(() => {
  cleanup()
})

describe('the turn block', () => {
  it('shows the work on a rail and keeps the answer outside it', () => {
    show(conversation(() => [said('go'), ...workedHard()]))

    // The work is on the page, not behind a process fold — no toggle in front
    // of it, and the aggregate summary is visible right away.
    expect(screen.queryByRole('button', { name: /steps|Working|Worked/ })).toBeNull()
    const summary = 'Ran 2 commands, read 1 file'
    expect(screen.getByText(summary).closest('[hidden]')).toBeNull()

    // The answer sits outside the work: it is the thing the turn was for.
    const answer = screen.getByText('here is the answer')
    expect(answer.closest('[hidden]')).toBeNull()
  })

  it('shows the live turn work on its rail too', () => {
    show(
      conversation(() => [
        said('go'),
        [frame('turn_started')],
        ...workedHard().slice(0, -1),
        started('c9', 'Bash', { command: 'pytest -q' }),
      ]),
    )

    // A live turn's work is shown, not folded: the aggregate line and the
    // self-replacing "Now:" are visible without opening anything.
    expect(screen.queryByRole('button', { name: /Working/ })).toBeNull()
    expect(screen.getByText('Ran 2 commands, read 1 file').closest('[hidden]')).toBeNull()
    expect(screen.getByText('Now:').closest('[hidden]')).toBeNull()
  })
})

describe('the aggregate line', () => {
  it('turns a run of calls into one line and a self-replacing "Now:"', () => {
    show(
      conversation(() => [
        said('go'),
        [frame('turn_started')],
        call('c1', 'Bash', { command: 'ls' }),
        started('c2', 'Bash', { command: 'pytest -q' }),
        started('c3', 'Bash', { command: 'npm run typecheck' }),
      ]),
    )

    expect(screen.getByText('Running 3 commands')).toBeTruthy()
    // Exactly one "Now:" line, and it carries the LATEST in-flight call —
    // never a list of everything still running.
    const now = screen.getAllByText('Now:')
    expect(now).toHaveLength(1)
    expect(now[0].parentElement?.textContent).toContain('npm run typecheck')
  })

  it('rolls failures up as a count rather than three red rows', () => {
    show(
      conversation(() => [
        said('go'),
        call('c1', 'Bash', { command: 'ls' }),
        [
          frame('tool_call', { call_id: 'c2', tool_name: 'Bash', arguments: { command: 'x' } }),
          frame('tool_result', { call_id: 'c2', success: false, summary: 'not found', output: '' }),
        ],
        replied('done'),
      ]),
    )

    expect(screen.getByText('Ran 2 commands')).toBeTruthy()
    expect(screen.getByText('1 failed')).toBeTruthy()
  })

  it('caps the expanded list at eight rows and opens the rest one way', () => {
    show(
      conversation(() => [
        said('go'),
        ...Array.from({ length: 10 }, (_, i) => call(`c${i}`, 'Read', { path: `/w/file-${i}.ts` })),
        replied('done'),
      ]),
    )

    fireEvent.click(screen.getByRole('button', { name: /Read 10 files/ }))

    expect(screen.getAllByRole('listitem')).toHaveLength(8)
    fireEvent.click(screen.getByRole('button', { name: 'Show 2 more' }))
    expect(screen.getAllByRole('listitem')).toHaveLength(10)
    // One way: there is no "show less" to undo it.
    expect(screen.queryByRole('button', { name: /Show/ })).toBeNull()
  })
})

describe('never a payload', () => {
  it('renders an MCP call as a sentence with the payload one click away', () => {
    show(
      conversation(() => [
        said('what did we decide'),
        call(
          'c1',
          'mcp__granola__search_meetings',
          { query: 'pricing', limit: 5 },
          '{"results": []}',
        ),
        replied('nothing yet'),
      ]),
    )

    expect(screen.getByText('Searched meetings · Granola')).toBeTruthy()
    expect(screen.getByText('“pricing”')).toBeTruthy()
    // The raw arguments exist, under the tool row itself — the sentence is the
    // disclosure — and nowhere else.
    const details = screen.getByRole('button', { name: /Searched meetings/ })
    expect(details.getAttribute('aria-expanded')).toBe('false')
    expect(screen.getByText(/"limit": 5/).closest('[hidden]')).not.toBeNull()
  })

  it('caps shell output instead of pasting a screenful into the transcript', () => {
    const flood = Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n')
    show(
      conversation(() => [
        said('go'),
        call('c1', 'Bash', { command: 'find /' }, flood),
        replied('done'),
      ]),
    )

    fireEvent.click(screen.getByRole('button', { name: /Ran a command/ }))
    const output = screen.getByText(/^line 0/)
    expect(output.textContent?.split('\n')).toHaveLength(120)
    expect(screen.getByText('… 280 more lines not shown')).toBeTruthy()
  })
})
