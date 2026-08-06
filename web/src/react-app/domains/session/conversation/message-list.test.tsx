import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { foldEvents, initialConversationState } from '@/app/fold'
import type { ConversationState } from '@/app/fold'
import type { RawUIEvent } from '@/app/types'
import { MessageList } from './message-list'

/**
 * Every frame in the vocabulary reaches the screen.
 *
 * The fold is pinned in `app/`; this pins the other half of the contract — that
 * a frame type nobody wrote a row for does not silently vanish. The transcript
 * is built by folding real wire frames rather than by handing the list a bag of
 * item objects, so a frame the fold and the renderer disagree about fails here.
 */

const frame = (type: string, data: Record<string, unknown> = {}, seq: number | null = null) =>
  ({ seq, type, data }) as RawUIEvent

function fold(...events: RawUIEvent[]): ConversationState {
  return foldEvents(initialConversationState(), events)
}

function show(conversation: ConversationState) {
  return render(<MessageList conversation={conversation} emptyNote="No messages yet." />)
}

afterEach(() => {
  cleanup()
})

describe('the transcript', () => {
  it('renders one row for every frame type in the vocabulary', () => {
    let seq = 0
    const next = (type: string, data: Record<string, unknown> = {}) => frame(type, data, seq++)

    show(
      fold(
        next('turn_started'),
        next('user_message', { content: 'plan the week' }),
        next('recall', { text: 'you prefer mornings' }),
        next('thinking', { text: 'weighing the options' }),
        next('skill_activated', { skill: 'planner' }),
        next('todo_update', {
          todos: [
            { id: 't1', content: 'draft the plan', status: 'in_progress' },
            { id: 't2', content: 'send it', status: 'pending' },
          ],
        }),
        next('tool_call', { call_id: 'c1', tool_name: 'Bash', arguments: { command: 'ls -la' } }),
        next('tool_result', { call_id: 'c1', success: true, summary: '3 files', output: 'a\nb\nc' }),
        next('memory_op', { call_id: 'c2', op: 'write', name: 'weekly-preferences' }),
        next('subtask_started', { subtask_id: 's1', agent_name: 'researcher', goal: 'find dates' }),
        next('subtask_finished', { subtask_id: 's1', status: 'completed', summary: 'three slots' }),
        next('question', {
          question_id: 'q1',
          reason: 'need a target',
          questions: [{ id: 'q1a', question: 'Which day?', choices: [], allow_freeform: true }],
        }),
        next('question_answered', { question_id: 'q1' }),
        next('compaction', { replaced_count: 3 }),
        next('assistant_text', { text: 'Here is the plan.' }),
        next('error', { message: 'the provider hiccupped' }),
      ),
    )

    expect(screen.getByText('plan the week')).toBeTruthy()
    expect(screen.getByText('Here is the plan.')).toBeTruthy()
    expect(screen.getByText('Thought')).toBeTruthy()
    expect(screen.getByText('Recalled')).toBeTruthy()
    expect(screen.getByText('planner')).toBeTruthy()
    // The plan is no longer a transcript row: it is hoisted into the persistent
    // `TodoStrip` above the composer, so a `todo_update` frame renders nothing
    // in the step stream. Its own tests cover the strip.
    // A tool call is a sentence plus its command, never a tool name and JSON.
    expect(screen.getByText('Ran a command')).toBeTruthy()
    expect(screen.getByText('ls -la')).toBeTruthy()
    expect(screen.getByText('Remembered')).toBeTruthy()
    expect(screen.getByText('weekly-preferences')).toBeTruthy()
    expect(screen.getByText('researcher')).toBeTruthy()
    expect(screen.getByText('find dates')).toBeTruthy()
    expect(screen.getByText('Question')).toBeTruthy()
    expect(screen.getByText('Answered')).toBeTruthy()
    expect(screen.getByText('Compacted 3 earlier messages')).toBeTruthy()
    expect(screen.getByText('the provider hiccupped')).toBeTruthy()
  })

  it('shows a withdrawn question as Cancelled', () => {
    let seq = 0
    const next = (type: string, data: Record<string, unknown> = {}) => frame(type, data, seq++)
    show(
      fold(
        next('question', {
          question_id: 'q1',
          reason: 'need a target',
          questions: [{ id: 'q1a', question: 'Which day?', choices: [], allow_freeform: true }],
        }),
        next('question_withdrawn', { question_id: 'q1' }),
      ),
    )
    expect(screen.getByText('Question')).toBeTruthy()
    expect(screen.getByText('Cancelled')).toBeTruthy()
  })

  it('collapses tool detail by default and keeps it findable', () => {
    show(
      fold(
        frame(
          'tool_call',
          { call_id: 'c1', tool_name: 'Bash', arguments: { command: 'ls' } },
          0,
        ),
        frame('tool_result', { call_id: 'c1', success: true, summary: 'ok', output: 'a.txt' }, 1),
      ),
    )

    // Collapsed, but present in the DOM as `hidden="until-found"` — the
    // browser's own find has to be able to reach it, and `beforematch` is what
    // opens the panel around a hit. Unmounting collapsed content would make
    // both the native and the in-app search miss most of the transcript.
    const body = screen.getByText('a.txt').closest('[hidden]')
    expect(body?.getAttribute('hidden')).toBe('until-found')

    // The tool row is on the turn's rail, its detail collapsed — open the
    // call's own row (the tool sentence *is* the disclosure) to reveal it.
    fireEvent.click(screen.getByRole('button', { name: /Ran a command/ }))
    expect(screen.getByText('a.txt').closest('[hidden]')).toBeNull()
  })

  it('nests a subagent’s steps under its node, collapsed but findable', () => {
    let seq = 0
    const next = (type: string, data: Record<string, unknown> = {}) => frame(type, data, seq++)

    show(
      fold(
        next('user_message', { content: 'delegate it' }),
        next('subtask_started', { subtask_id: 's1', agent_name: 'researcher', goal: 'dig' }),
        next('tool_call', {
          call_id: 'r1',
          tool_name: 'Read',
          arguments: { path: '/w/deepfile.ts' },
          subtask_id: 's1',
        }),
        next('tool_result', { call_id: 'r1', success: true, summary: 'ok', output: '' }),
        next('subtask_finished', { subtask_id: 's1', status: 'completed', summary: 'found it' }),
        next('assistant_text', { text: 'done delegating' }),
      ),
    )

    // The node line is always visible; the nested step is in the DOM but
    // collapsed as `hidden="until-found"`, so it stays reachable by find.
    expect(screen.getByText('researcher')).toBeTruthy()
    const nested = screen.getByText('deepfile.ts').closest('[hidden]')
    expect(nested?.getAttribute('hidden')).toBe('until-found')

    // The subagent node is on the rail; open it — the nested step is revealed.
    fireEvent.click(screen.getByRole('button', { name: /researcher/ }))
    expect(screen.getByText('deepfile.ts').closest('[hidden]')).toBeNull()
  })

  it('never renders auto-recall as something the user said', () => {
    show(fold(frame('recall', { text: 'the user likes mornings' }, 0)))

    // Present, but as a muted chip and never inside a user bubble.
    expect(screen.getByText('Recalled')).toBeTruthy()
    for (const node of screen.getAllByText('the user likes mornings')) {
      expect(node.closest('[data-item-kind="user"]')).toBeFalsy()
    }
  })

  it('shows the streaming preview until the durable frame repaints it', () => {
    const streaming = fold(
      frame('turn_started', {}, 0),
      frame('delta', { call_id: 'c1', kind: 'text', text: 'half a sen', index: 0 }),
      frame('delta', { call_id: 'c1', kind: 'text', text: 'tence', index: 0 }),
    )
    const view = show(streaming)
    expect(screen.getByTestId('streaming-preview').textContent).toBe('half a sentence')

    view.rerender(
      <MessageList
        conversation={foldEvents(streaming, [
          frame('assistant_text', { text: 'half a sentence, finished' }, 1),
        ])}
        emptyNote="No messages yet."
      />,
    )

    expect(screen.queryByTestId('streaming-preview')).toBeNull()
    expect(screen.getByText('half a sentence, finished')).toBeTruthy()
  })

  it('shows a working line on a provider that never streams', () => {
    // The mock provider implements no streaming interface, so a live turn has
    // no delta to render and would otherwise look frozen.
    show(fold(frame('turn_started', {}, 0)))
    expect(screen.getByTestId('working')).toBeTruthy()
  })

  it('says "Stopped." for an interrupted turn instead of rendering a dead session', () => {
    show(
      fold(
        frame('turn_started', {}, 0),
        frame('assistant_text', { text: 'partial' }, 1),
        frame('turn_finished', { status: 'interrupted' }, 2),
      ),
    )

    expect(screen.getByText(/Stopped\./)).toBeTruthy()
    expect(screen.getByText('partial')).toBeTruthy()
  })

  it('renders turn_failed as a retriable error carrying its reason', () => {
    show(
      fold(
        frame('turn_started', {}, 0),
        frame('turn_finished', { status: 'turn_failed', reason: 'upstream 503' }, 1),
      ),
    )

    expect(screen.getByText('The turn did not finish.')).toBeTruthy()
    expect(screen.getByText('upstream 503')).toBeTruthy()
    expect(screen.getByText(/Send a message to retry/)).toBeTruthy()
  })

  it('closes a running tool step when the turn is cancelled', () => {
    show(
      fold(
        frame('tool_call', { call_id: 'c1', tool_name: 'bash', arguments: {} }, 0),
        frame('turn_finished', { status: 'cancelled' }, 1),
      ),
    )

    expect(screen.getByText('⊘')).toBeTruthy()
    expect(screen.getByText('Cancelled.')).toBeTruthy()
  })

  it('renders the empty note only when there is nothing at all', () => {
    show(initialConversationState())
    expect(screen.getByText('No messages yet.')).toBeTruthy()
  })
})
