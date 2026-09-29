import { describe, expect, it } from 'vitest'
import {
  appendOptimisticUser,
  foldEvent,
  foldEvents,
  initialConversationState,
} from './conversation'
import type { ConversationState } from './conversation'
import type { ConversationItem, StepItem, SubtaskItem, UserItem } from './items'
import type { RawUIEvent } from '../types/ui-events'

const TASK = 'task-1'

function frame(
  seq: number | null,
  type: string,
  data: Record<string, unknown> = {},
): RawUIEvent {
  return { seq, type, data: { _task: TASK, ...data } }
}

const kinds = (state: ConversationState) => state.items.map((item) => item.kind)

function itemsOf<K extends ConversationItem['kind']>(
  state: ConversationState,
  kind: K,
): Extract<ConversationItem, { kind: K }>[] {
  return state.items.filter((item): item is Extract<ConversationItem, { kind: K }> => item.kind === kind)
}

describe('foldEvent — dedup and the cursor', () => {
  it('drops a frame at or below the cursor before anything else', () => {
    const state = foldEvent(initialConversationState(), frame(3, 'assistant_text', { text: 'hi' }))
    expect(state.lastSeq).toBe(3)

    const again = foldEvent(state, frame(3, 'assistant_text', { text: 'hi' }))
    expect(again).toBe(state)
    expect(foldEvent(state, frame(1, 'assistant_text', { text: 'old' }))).toBe(state)
  })

  it('starts the cursor at -1 so seq 0 is not deduped away', () => {
    const state = foldEvent(initialConversationState(), frame(0, 'assistant_text', { text: 'first' }))
    expect(kinds(state)).toEqual(['assistant'])
    expect(state.lastSeq).toBe(0)
  })

  it('never lets a seq-less frame touch the cursor', () => {
    let state = foldEvent(initialConversationState(), frame(7, 'assistant_text', { text: 'a' }))
    state = foldEvent(state, frame(null, 'subtask_started', { subtask_id: 's', agent_name: 'x', goal: 'g' }))
    expect(state.lastSeq).toBe(7)
  })
})

describe('foldEvent — forward compatibility', () => {
  it('ignores a frame type this build does not know, without crashing', () => {
    // A later phase may add a frame type without a protocol bump, so an
    // unrecognised `type` has to be inert — and inert by identity, so it does
    // not re-render the transcript either.
    const before = initialConversationState()
    const state = foldEvent(before, frame(null, 'holographic_update', { x: 1 }))
    expect(state).toBe(before)
  })

  it('still advances the cursor past an unknown durable frame', () => {
    // The cursor means "received", not "understood": re-requesting a frame we
    // cannot render on every reconnect buys nothing.
    const state = foldEvent(initialConversationState(), frame(4, 'holographic_update'))
    expect(state.lastSeq).toBe(4)
    expect(state.items).toEqual([])
  })
})

describe('foldEvent — the frames that never enter the item list', () => {
  it('keeps delta, llm_retry, replay_done and session_meta out of the items', () => {
    const state = foldEvents(initialConversationState(), [
      frame(null, 'delta', { call_id: 'c1', kind: 'text', text: 'partial', index: 0 }),
      frame(null, 'replay_done'),
      frame(null, 'session_meta', { title: 'Named' }),
      frame(1, 'llm_retry', { call_id: 'c1' }),
    ])

    expect(state.items).toEqual([])
    expect(state.replayDone).toBe(true)
    expect(state.title).toBe('Named')
    // The retry cleared the half-stream it re-issues under the same call id.
    expect(state.delta).toBeNull()
  })

  it('repaints the preview away when the durable text lands', () => {
    let state = foldEvent(
      initialConversationState(),
      frame(null, 'delta', { call_id: 'c1', kind: 'text', text: 'hel', index: 0 }),
    )
    expect(state.delta).not.toBeNull()
    state = foldEvent(state, frame(1, 'assistant_text', { text: 'hello' }))
    expect(state.delta).toBeNull()
  })
})

describe('foldEvent — synthetic keys', () => {
  it('draws keys from a monotonically decreasing negative counter', () => {
    const state = foldEvents(initialConversationState(), [
      frame(null, 'tool_call', { call_id: 'a', tool_name: 'bash', arguments: {}, subtask_id: 's1' }),
      frame(null, 'tool_call', { call_id: 'b', tool_name: 'bash', arguments: {}, subtask_id: 's1' }),
      frame(5, 'assistant_text', { text: 'durable' }),
    ])

    const keys = state.items.map((item) => item.key)
    expect(keys).toEqual([-1, -2, 5])
    // A synthetic key can never collide with a real seq, whatever the stream does.
    expect(keys.filter((k) => k < 0)).toHaveLength(2)
  })
})

describe('foldEvent — the optimistic user bubble', () => {
  it('replaces the pending bubble in place, searching the whole list', () => {
    // After a reset the SSE replay can beat the optimistic dispatch, so by the
    // time the durable frame arrives the bubble is no longer last.
    let state = appendOptimisticUser(initialConversationState(), 'ship it')
    state = foldEvent(state, frame(1, 'assistant_text', { text: 'thinking about it' }))
    state = foldEvent(state, frame(2, 'user_message', { content: 'ship it' }))

    const users = itemsOf(state, 'user')
    expect(users).toHaveLength(1)
    expect(users[0].pending).toBe(false)
    expect(users[0].key).toBe(2)
    // In place: the bubble did not jump to the end of the conversation.
    expect(kinds(state)).toEqual(['user', 'assistant'])
  })

  it('appends when no pending bubble matches', () => {
    let state = appendOptimisticUser(initialConversationState(), 'ship it')
    state = foldEvent(state, frame(1, 'user_message', { content: 'something else' }))
    expect(itemsOf(state, 'user').map((item) => item.content)).toEqual(['ship it', 'something else'])
  })

  it('leaves `running` alone — a 409 must not lock the composer', () => {
    const state = appendOptimisticUser(initialConversationState(), 'ship it')
    expect(state.running).toBe(false)
    expect((state.items[0] as UserItem).pending).toBe(true)
  })
})

describe('foldEvent — tool steps', () => {
  it('pairs a result onto its running step and drops an unmatched one', () => {
    let state = foldEvent(
      initialConversationState(),
      frame(1, 'tool_call', { call_id: 'c1', tool_name: 'read', arguments: { path: 'a' } }),
    )
    state = foldEvent(
      state,
      frame(2, 'tool_result', { call_id: 'c1', success: true, summary: 'read a', output: 'body' }),
    )
    const step = itemsOf(state, 'step')[0] as StepItem
    expect(step.status).toBe('success')
    expect(step.output).toBe('body')

    // A `memory_*` call folded into a memory card; its paired result has no
    // step to land on and is dropped rather than rendered as an orphan.
    const after = foldEvent(
      state,
      frame(3, 'tool_result', { call_id: 'unknown', success: true, summary: '', output: '' }),
    )
    expect(after.items).toBe(state.items)
  })
})

describe('foldEvent — turn lifecycle', () => {
  it('clears `running` on an error, not only on turn_finished', () => {
    let state = foldEvent(initialConversationState(), frame(null, 'turn_started'))
    expect(state.running).toBe(true)
    state = foldEvent(state, frame(1, 'error', { message: 'provider exploded' }))
    expect(state.running).toBe(false)
    expect(kinds(state)).toEqual(['error'])
  })

  it('force-closes pending steps and running subtasks on cancel', () => {
    let state = foldEvents(initialConversationState(), [
      frame(1, 'turn_started'),
      frame(2, 'tool_call', { call_id: 'c1', tool_name: 'bash', arguments: {} }),
      frame(null, 'subtask_started', { subtask_id: 's1', agent_name: 'writer', goal: 'draft' }),
    ])
    state = foldEvent(state, frame(3, 'turn_finished', { status: 'cancelled' }))

    expect((itemsOf(state, 'step')[0] as StepItem).status).toBe('cancelled')
    expect((itemsOf(state, 'subtask')[0] as SubtaskItem).status).toBe('cancelled')
    expect(state.running).toBe(false)
    expect(state.lastOutcome).toEqual({ status: 'cancelled', reason: null })
  })

  it('closes pending steps but not subtask cards on a failed turn', () => {
    let state = foldEvents(initialConversationState(), [
      frame(1, 'tool_call', { call_id: 'c1', tool_name: 'bash', arguments: {} }),
      frame(null, 'subtask_started', { subtask_id: 's1', agent_name: 'writer', goal: 'draft' }),
    ])
    state = foldEvent(state, frame(2, 'turn_finished', { status: 'failed' }))

    expect((itemsOf(state, 'step')[0] as StepItem).status).toBe('failure')
    // Only a cancel cascades: a failed root does not cancel a background subagent.
    expect((itemsOf(state, 'subtask')[0] as SubtaskItem).status).toBe('running')
  })

  it('carries the reason of a resumable turn_failed', () => {
    const state = foldEvent(
      initialConversationState(),
      frame(1, 'turn_finished', { status: 'turn_failed', reason: 'gateway 503' }),
    )
    expect(state.lastOutcome).toEqual({ status: 'turn_failed', reason: 'gateway 503' })
    expect(state.running).toBe(false)
  })

  it('tracks the pending question across answer and cancel', () => {
    let state = foldEvent(
      initialConversationState(),
      frame(1, 'question', {
        question_id: 'q1',
        reason: 'need a choice',
        questions: [{ id: 'a', question: 'which?', choices: [], allow_freeform: true }],
      }),
    )
    expect(state.pendingQuestionId).toBe('q1')

    state = foldEvent(state, frame(2, 'question_answered', { question_id: 'q1' }))
    expect(state.pendingQuestionId).toBeNull()
    expect(itemsOf(state, 'question')[0].answered).toBe(true)
  })

  it('marks the question withdrawn and clears the gate on a stop', () => {
    let state = foldEvent(
      initialConversationState(),
      frame(1, 'question', {
        question_id: 'q1',
        reason: 'need a choice',
        questions: [{ id: 'a', question: 'which?', choices: [], allow_freeform: true }],
      }),
    )
    expect(state.pendingQuestionId).toBe('q1')

    state = foldEvent(state, frame(2, 'question_withdrawn', { question_id: 'q1' }))
    expect(state.pendingQuestionId).toBeNull()
    const card = itemsOf(state, 'question')[0]
    expect(card.withdrawn).toBe(true)
    expect(card.answered).toBe(false)
  })

  it('withdraws a still-open question when the turn is stopped', () => {
    let state = foldEvent(
      initialConversationState(),
      frame(1, 'question', {
        question_id: 'q1',
        reason: 'need a choice',
        questions: [{ id: 'a', question: 'which?', choices: [], allow_freeform: true }],
      }),
    )
    expect(state.pendingQuestionId).toBe('q1')

    // Stop pressed with no explicit `question_withdrawn` frame: the finished
    // turn must still clear the card so the panel does not linger.
    state = foldEvent(state, frame(2, 'turn_finished', { status: 'cancelled' }))
    expect(state.pendingQuestionId).toBeNull()
    const card = itemsOf(state, 'question')[0]
    expect(card.withdrawn).toBe(true)
    expect(card.answered).toBe(false)
  })
})

describe('foldEvent — todos', () => {
  it('replaces the checklist in place within the current turn', () => {
    let state = foldEvents(initialConversationState(), [
      frame(1, 'user_message', { content: 'go' }),
      frame(2, 'todo_update', { todos: [{ id: '1', content: 'first', status: 'pending' }] }),
      frame(3, 'assistant_text', { text: 'working' }),
      frame(4, 'todo_update', { todos: [{ id: '1', content: 'first', status: 'completed' }] }),
    ])

    expect(kinds(state)).toEqual(['user', 'todos', 'assistant'])
    expect(itemsOf(state, 'todos')[0].todos[0].status).toBe('completed')
  })

  it('starts a new checklist in the next turn', () => {
    const state = foldEvents(initialConversationState(), [
      frame(1, 'user_message', { content: 'first turn' }),
      frame(2, 'todo_update', { todos: [{ id: '1', content: 'a', status: 'completed' }] }),
      frame(3, 'user_message', { content: 'second turn' }),
      frame(4, 'todo_update', { todos: [{ id: '2', content: 'b', status: 'pending' }] }),
    ])
    expect(kinds(state)).toEqual(['user', 'todos', 'user', 'todos'])
  })
})

describe('foldEvent — subtasks', () => {
  it('closes the running card rather than appending a second one', () => {
    let state = foldEvent(
      initialConversationState(),
      frame(null, 'subtask_started', { subtask_id: 's1', agent_name: 'writer', goal: 'draft' }),
    )
    state = foldEvent(
      state,
      frame(null, 'subtask_finished', { subtask_id: 's1', status: 'completed', summary: 'done' }),
    )

    const cards = itemsOf(state, 'subtask')
    expect(cards).toHaveLength(1)
    expect(cards[0].status).toBe('completed')
    expect(cards[0].summary).toBe('done')
  })

  it('still renders the outcome when the start frame did not survive a reconnect', () => {
    const state = foldEvent(
      initialConversationState(),
      frame(null, 'subtask_finished', { subtask_id: 's9', status: 'failed', summary: 'blew up' }),
    )
    expect(itemsOf(state, 'subtask')[0].status).toBe('failed')
  })
})

describe('foldEvent — task tagging', () => {
  it('records the task stream on every item and null for session-level frames', () => {
    const state = foldEvents(initialConversationState(), [
      frame(1, 'assistant_text', { text: 'tagged' }),
      // A session-level frame carries no `_task`, so its item is null-tagged.
      { seq: 2, type: 'error', data: { message: 'session-level' } },
    ])
    expect(state.items.map((item) => item.taskId)).toEqual([TASK, null])
  })
})

describe('foldEvent — rewind truncation', () => {
  it('drops the durable tail past target_seq and keeps everything at or below', () => {
    let state = foldEvents(initialConversationState(), [
      frame(1, 'user_message', { content: 'first' }),
      frame(2, 'assistant_text', { text: 'reply one' }),
      frame(5, 'user_message', { content: 'second' }),
      frame(6, 'assistant_text', { text: 'reply two' }),
    ])
    expect(state.items.map((i) => i.key)).toEqual([1, 2, 5, 6])

    // Re-base to before the second user turn (target_seq = 4, the boundary).
    state = foldEvent(state, frame(7, 'rewind', { target_seq: 4 }))

    expect(state.items.map((i) => i.key)).toEqual([1, 2])
    expect(itemsOf(state, 'user').map((i) => i.content)).toEqual(['first'])
  })

  it('lands live and idle — clears running, delta, question and outcome', () => {
    let state = foldEvents(initialConversationState(), [
      frame(1, 'user_message', { content: 'go' }),
      frame(2, 'turn_started'),
    ])
    expect(state.running).toBe(true)

    state = foldEvent(state, frame(3, 'rewind', { target_seq: 0 }))

    expect(state.running).toBe(false)
    expect(state.delta).toBeNull()
    expect(state.pendingQuestionId).toBeNull()
    expect(state.lastOutcome).toBeNull()
  })

  it('cascade-drops a subtask card and its seq-less inner steps together', () => {
    let state = foldEvents(initialConversationState(), [
      frame(1, 'user_message', { content: 'delegate' }),
      // A subtask card carries a real seq; its inner steps are seq-less.
      frame(5, 'subtask_started', { subtask_id: 's1', agent_name: 'w', goal: 'g' }),
      frame(null, 'tool_call', { call_id: 'c1', tool_name: 'bash', arguments: {}, subtask_id: 's1' }),
      frame(null, 'tool_call', { call_id: 'c2', tool_name: 'bash', arguments: {}, subtask_id: 's1' }),
    ])
    expect(itemsOf(state, 'subtask')).toHaveLength(1)
    expect(itemsOf(state, 'step')).toHaveLength(2)

    // Re-base to before the subtask turn: the card (seq 5) is dropped, and its
    // orphaned inner steps (negative keys) must go with it.
    state = foldEvent(state, frame(9, 'rewind', { target_seq: 1 }))

    expect(itemsOf(state, 'subtask')).toHaveLength(0)
    expect(itemsOf(state, 'step')).toHaveLength(0)
    expect(itemsOf(state, 'user').map((i) => i.content)).toEqual(['delegate'])
  })

  it('keeps the inner steps of a subtask card that survives', () => {
    let state = foldEvents(initialConversationState(), [
      frame(2, 'subtask_started', { subtask_id: 's1', agent_name: 'w', goal: 'g' }),
      frame(null, 'tool_call', { call_id: 'c1', tool_name: 'bash', arguments: {}, subtask_id: 's1' }),
      frame(8, 'assistant_text', { text: 'later turn' }),
    ])

    // Re-base above the subtask card but below the later turn: the card and its
    // step survive, only the later turn is dropped.
    state = foldEvent(state, frame(9, 'rewind', { target_seq: 5 }))

    expect(itemsOf(state, 'subtask')).toHaveLength(1)
    expect(itemsOf(state, 'step')).toHaveLength(1)
    expect(itemsOf(state, 'assistant')).toHaveLength(0)
  })

  it('drops a pending optimistic user bubble', () => {
    let state = foldEvents(initialConversationState(), [frame(1, 'user_message', { content: 'first' })])
    state = appendOptimisticUser(state, 'not yet acked')
    expect(itemsOf(state, 'user').some((i) => i.pending)).toBe(true)

    state = foldEvent(state, frame(4, 'rewind', { target_seq: 3 }))

    expect(itemsOf(state, 'user').some((i) => i.pending)).toBe(false)
    expect(itemsOf(state, 'user').map((i) => i.content)).toEqual(['first'])
  })

  it('is idempotent on a full replay — re-applying truncates the same way', () => {
    const events: RawUIEvent[] = [
      frame(1, 'user_message', { content: 'first' }),
      frame(5, 'user_message', { content: 'second' }),
      frame(6, 'assistant_text', { text: 'reply' }),
      frame(7, 'rewind', { target_seq: 4 }),
    ]
    const once = foldEvents(initialConversationState(), events)
    // A full replay re-sends the dead tail before the rewind frame; the result
    // must be identical, so the reducer cannot depend on arrival order.
    const twice = foldEvents(initialConversationState(), events)
    expect(once.items.map((i) => i.key)).toEqual([1])
    expect(twice.items.map((i) => i.key)).toEqual([1])
  })
})
