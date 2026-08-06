/**
 * The client-side fold: wire frames in, a renderable conversation out.
 *
 * A pure reducer, with no React anywhere near it. That is not an aesthetic
 * choice — this is the single most defect-prone piece of the frontend (it
 * encodes replay, dedup, optimistic echo and force-close all at once), and
 * being a plain function is what makes every one of those rules testable
 * without mounting anything.
 *
 * The invariants, in the order the reducer applies them:
 *
 * 1. **Dedup first, per task stream.** A frame whose `seq` is at or below its
 *    own stream's cursor has already been applied; replay and the live stream
 *    deliberately overlap, so this is the normal path, not an error path. The
 *    cursor is kept **per `_task`** because a session's own stream, a fork's
 *    inherited prefix (seq-less, on another tag) and subtask frames each carry
 *    their own tag — one shared cursor would dedup across streams that count
 *    `seq` independently.
 * 2. **Ephemeral frames never enter the item list.** `delta`, `llm_retry`,
 *    `replay_done` and `session_meta` are handled before anything can append.
 * 3. **Synthetic frames get negative keys** from a monotonically decreasing
 *    counter, so they can never collide with a real `seq`.
 * 4. **`error` clears `running` too.** If `running` depended on `turn_finished`
 *    alone, one lost frame would wedge the UI on "running" forever.
 * 5. **A cancelled or failed turn force-closes what it left open.** A cancelled
 *    tool never gets a paired result, and the subtask cascade frames are
 *    synthetic — after a refresh, the parent's `turn_finished` is the only
 *    thing that can close a subtask card.
 * 6. **Re-applying a seq-less frame is a no-op.** Subtask and inherited-prefix
 *    frames carry no seq, so the cursor cannot dedup them; a full replay
 *    (`since_seq` absent) re-sends them. Matching on the identity the frame
 *    carries — `subtask_id`, `call_id` — is what keeps that from doubling a
 *    card in the transcript.
 *
 * A session owns exactly one stream (a `fork` is its own child session), so
 * there is no per-branch projection: the fold renders every item it holds. A
 * fork's inherited history arrives already spliced onto its stream from the
 * server, so the fold treats it as ordinary frames.
 */

import { applyDelta, resetCall } from './delta-buffer'
import type { DeltaState } from './delta-buffer'
import type {
  ConversationItem,
  QuestionItem,
  StepItem,
  StepStatus,
  SubtaskItem,
  TodosItem,
  TurnOutcome,
  UserItem,
} from './items'
import { asUIEvent } from '../types/ui-events'
import type {
  DeltaEvent,
  ImageRef,
  LlmRetryEvent,
  RawUIEvent,
  ReplayDoneEvent,
  SessionMetaEvent,
  TaskScope,
  UIEvent,
} from '../types/ui-events'

export interface ConversationState {
  readonly items: readonly ConversationItem[]
  /** A turn is in flight. Also true while a question is pending — the turn is not over. */
  readonly running: boolean
  /**
   * The resume cursor handed to the next connection: the **lowest** per-stream
   * cursor, or `-1` for "nothing seen".
   *
   * `-1` rather than `0` because seq space starts at 0 and the backend reads a
   * missing cursor as `-1`; a cursor of `0` would ask it to skip the session's
   * very first envelope.
   *
   * The lowest rather than the highest because `since_seq` is one floor applied
   * to **every** stream the session owns: a session holding a 50-frame root and
   * a 3-frame branch that resumed from 50 would never be sent the branch at
   * all. Resuming from the laggard re-sends frames the fold already has, and
   * the per-stream cursors below drop them on arrival.
   */
  readonly lastSeq: number
  /**
   * The dedup cursor per task stream, keyed by `_task` (`""` for a frame with
   * none). A session owns one live stream, but a fork's inherited prefix rides
   * a different tag seq-lessly and subtask frames ride their own — so the
   * cursor is a map, and a frame is deduped against its own stream's cursor.
   */
  readonly cursors: Readonly<Record<string, number>>
  /** The in-flight streaming preview. Repainted by the durable frame that follows. */
  readonly delta: DeltaState | null
  /** Title pushed by the generation thread, or null while it has not landed. */
  readonly title: string | null
  /** True once the stream has finished replaying and is live. */
  readonly replayDone: boolean
  /** The question the turn is parked on, if any. */
  readonly pendingQuestionId: string | null
  /** How the last turn ended — `turn_failed` is resumable, `failed` is not. */
  readonly lastOutcome: TurnOutcome | null
  /** Next synthetic render key. Starts at -1 and only decreases. */
  readonly nextKey: number
}

export function initialConversationState(): ConversationState {
  return {
    items: [],
    running: false,
    lastSeq: -1,
    cursors: {},
    delta: null,
    title: null,
    replayDone: false,
    pendingQuestionId: null,
    lastOutcome: null,
    nextKey: -1,
  }
}

/**
 * The cursor bucket a frame belongs to. `""` is the session-level bucket: the
 * contract says a durable frame always carries `_task`, and a frame that does
 * not is session-level and reaches every consumer.
 */
const SESSION_SCOPE = ''

function taskKeyOf(data: Record<string, unknown> | TaskScope): string {
  const task = (data as TaskScope)._task
  return typeof task === 'string' && task !== '' ? task : SESSION_SCOPE
}

function lowestCursor(cursors: Readonly<Record<string, number>>): number {
  let lowest = Number.POSITIVE_INFINITY
  for (const seq of Object.values(cursors)) {
    if (seq < lowest) lowest = seq
  }
  return lowest === Number.POSITIVE_INFINITY ? -1 : lowest
}

type EphemeralEvent = DeltaEvent | LlmRetryEvent | ReplayDoneEvent | SessionMetaEvent

const EPHEMERAL_TYPES = new Set<string>(['delta', 'llm_retry', 'replay_done', 'session_meta'])

function isEphemeral(event: UIEvent): event is EphemeralEvent {
  return EPHEMERAL_TYPES.has(event.type)
}

function taskOf(data: TaskScope): string | null {
  return data._task ?? null
}

interface KeyAllocation {
  key: number
  nextKey: number
}

function allocateKey(state: ConversationState, seq: number | null): KeyAllocation {
  if (seq !== null) return { key: seq, nextKey: state.nextKey }
  return { key: state.nextKey, nextKey: state.nextKey - 1 }
}

/**
 * Replace the last item matching `match`, or return `null` when there is none.
 *
 * `null` rather than the unchanged array so a caller can tell "updated" from
 * "nothing to update" — the difference between a tool result landing on its
 * step and an unmatched result, which is dropped by design.
 */
function replaceLast<T extends ConversationItem>(
  items: readonly ConversationItem[],
  match: (item: ConversationItem) => item is T,
  update: (item: T) => ConversationItem,
): ConversationItem[] | null {
  const index = items.findLastIndex(match)
  if (index === -1) return null
  const next = items.slice()
  next[index] = update(items[index] as T)
  return next
}

function append(
  state: ConversationState,
  seq: number | null,
  build: (key: number) => ConversationItem,
  patch: Partial<ConversationState> = {},
): ConversationState {
  const { key, nextKey } = allocateKey(state, seq)
  return { ...state, ...patch, items: [...state.items, build(key)], nextKey }
}

/**
 * The four frames that never reach the item list.
 *
 * They are the ones whose whole job is to modify state that is not a message:
 * the streaming preview, its reset on a retry, the replay boundary and the
 * session title.
 */
function foldEphemeral(state: ConversationState, event: EphemeralEvent): ConversationState {
  switch (event.type) {
    case 'delta': {
      const delta = applyDelta(state.delta, event.data)
      if (delta === state.delta) return state
      return { ...state, delta }
    }
    case 'llm_retry': {
      const callId = event.data.call_id
      // A retry frame with no call id is not a licence to clear the preview:
      // `resetCall(_, null)` clears unconditionally, and that is a caller's
      // decision (a session switch), never a malformed frame's.
      if (typeof callId !== 'string' || callId === '') return state
      const delta = resetCall(state.delta, callId)
      return delta === state.delta ? state : { ...state, delta }
    }
    case 'replay_done':
      return state.replayDone ? state : { ...state, replayDone: true }
    case 'session_meta': {
      const { title } = event.data
      if (typeof title !== 'string' || title === state.title) return state
      return { ...state, title }
    }
  }
}

/**
 * The server clock on a durable frame, or `null`.
 *
 * Read structurally rather than off a declared field because the same frame
 * *types* arrive both durable (from the root stream) and synthetic (from a
 * subtask translator, or pushed by the send path), and only the first kind was
 * ever produced by an envelope with a clock.
 */
function clockOf(data: TaskScope): number | undefined {
  const ts = (data as { ts?: unknown }).ts
  return typeof ts === 'number' && Number.isFinite(ts) ? ts : undefined
}

function foldItemEvent(
  state: ConversationState,
  event: Exclude<UIEvent, EphemeralEvent>,
): ConversationState {
  const taskId = taskOf(event.data)
  const ts = clockOf(event.data)

  /**
   * Append an item, stamping this frame's clock onto it.
   *
   * A wrapper rather than a parameter on every construction site: the clock
   * belongs to the *frame*, so there is exactly one place it can be forgotten.
   */
  const push = (
    base: ConversationState,
    seq: number | null,
    build: (key: number) => ConversationItem,
    patch: Partial<ConversationState> = {},
  ): ConversationState =>
    append(base, seq, (key) => (ts === undefined ? build(key) : { ...build(key), ts }), patch)

  switch (event.type) {
    case 'user_message': {
      const { content } = event.data
      const images = event.data.images ?? []
      const { key, nextKey } = allocateKey(state, event.seq)
      const item: UserItem = { kind: 'user', key, taskId, content, images, pending: false, ts }

      // Search the WHOLE list, not the tail. After a reset the SSE replay can
      // land before the optimistic dispatch, so by the time the durable frame
      // arrives the optimistic bubble may have replayed items sitting after it.
      //
      // An untagged bubble matches any stream — the composer does not know
      // which one the send will land on — while one already aimed at a branch
      // (edit-and-retry knows) matches only that branch, so the same text sent
      // on two branches does not swallow the other branch's echo.
      const index = state.items.findLastIndex(
        (it) =>
          it.kind === 'user' &&
          it.pending &&
          it.key < 0 &&
          it.content === content &&
          (it.taskId === null || it.taskId === taskId),
      )
      if (index === -1) return { ...state, items: [...state.items, item], nextKey }
      const items = state.items.slice()
      items[index] = item
      return { ...state, items, nextKey }
    }

    case 'assistant_text':
      return push(
        state,
        event.seq,
        (key) => ({ kind: 'assistant', key, taskId, text: event.data.text }),
        { delta: null },
      )

    case 'thinking':
      // Clears the preview for the same reason `assistant_text` does: once the
      // durable thinking lands, a live preview of the same bytes double-renders.
      return push(
        state,
        event.seq,
        (key) => ({ kind: 'thinking', key, taskId, text: event.data.text }),
        { delta: null },
      )

    case 'recall':
      return push(state, event.seq, (key) => ({ kind: 'recall', key, taskId, text: event.data.text }))

    case 'tool_call':
      // A call id is unique, so seeing one twice means the frame was re-sent —
      // which a subtask's seq-less frames are on any full replay. Ignoring the
      // repeat is what keeps a reconnect from doubling every step row; the
      // paired result would then land on the wrong copy.
      if (state.items.some((it) => it.kind === 'step' && it.callId === event.data.call_id)) {
        return state
      }
      return push(state, event.seq, (key) => ({
        kind: 'step',
        key,
        taskId,
        callId: event.data.call_id,
        toolName: event.data.tool_name,
        args: event.data.arguments,
        status: 'running',
        summary: null,
        output: null,
        subtaskId: event.data.subtask_id ?? null,
      }))

    case 'tool_result': {
      const items = replaceLast(
        state.items,
        (it): it is StepItem =>
          it.kind === 'step' && it.callId === event.data.call_id && it.status === 'running',
        (step) => ({
          ...step,
          status: event.data.success ? 'success' : 'failure',
          summary: event.data.summary,
          output: event.data.output,
        }),
      )
      // An unmatched result is dropped, not rendered: a `memory_*` call folded
      // into a `memory_op` card, and its paired result has no step to land on.
      return items ? { ...state, items } : state
    }

    case 'memory_op':
      return push(state, event.seq, (key) => ({
        kind: 'memory',
        key,
        taskId,
        callId: event.data.call_id,
        op: event.data.op,
        name: event.data.name,
      }))

    case 'skill_activated':
      return push(state, event.seq, (key) => ({
        kind: 'skill',
        key,
        taskId,
        skill: event.data.skill,
      }))

    case 'todo_update': {
      const todos = event.data.todos ?? []
      // One turn renders one checklist: replace the card in place if this turn
      // already has one, which also keeps its render key and so animates the
      // list instead of remounting it.
      const turnStart = state.items.findLastIndex((it) => it.kind === 'user')
      const index = state.items.findLastIndex(
        (it, i) => it.kind === 'todos' && i > turnStart,
      )
      if (index === -1) {
        return push(state, event.seq, (key) => ({ kind: 'todos', key, taskId, todos }))
      }
      const items = state.items.slice()
      items[index] = { ...(state.items[index] as TodosItem), todos }
      return { ...state, items }
    }

    case 'subtask_started':
      // Same re-send guard as `tool_call`, and it matters more here: a
      // re-appended card starts out `running` again, so a duplicate would sit
      // in the transcript spinning forever with nothing left to close it.
      if (
        state.items.some(
          (it) => it.kind === 'subtask' && it.subtaskId === event.data.subtask_id,
        )
      ) {
        return state
      }
      return push(state, event.seq, (key) => ({
        kind: 'subtask',
        key,
        taskId,
        subtaskId: event.data.subtask_id,
        agentName: event.data.agent_name,
        goal: event.data.goal,
        status: 'running',
        summary: null,
      }))

    case 'subtask_finished': {
      const items = replaceLast(
        state.items,
        (it): it is SubtaskItem =>
          it.kind === 'subtask' &&
          it.subtaskId === event.data.subtask_id &&
          it.status === 'running',
        (card) => ({ ...card, status: event.data.status, summary: event.data.summary }),
      )
      if (items) return { ...state, items }
      // No card to close: the start frame was synthetic and did not survive a
      // reconnect. Render the outcome anyway rather than losing the answer.
      return push(state, event.seq, (key) => ({
        kind: 'subtask',
        key,
        taskId,
        subtaskId: event.data.subtask_id,
        agentName: '',
        goal: '',
        status: event.data.status,
        summary: event.data.summary,
      }))
    }

    case 'question':
      return push(
        state,
        event.seq,
        (key) => ({
          kind: 'question',
          key,
          taskId,
          questionId: event.data.question_id,
          reason: event.data.reason,
          questions: event.data.questions ?? [],
          answered: false,
          withdrawn: false,
        }),
        { delta: null, pendingQuestionId: event.data.question_id },
      )

    case 'question_answered': {
      const items = replaceLast(
        state.items,
        (it): it is QuestionItem =>
          it.kind === 'question' && it.questionId === event.data.question_id,
        (card) => ({ ...card, answered: true }),
      )
      const pendingQuestionId =
        state.pendingQuestionId === event.data.question_id ? null : state.pendingQuestionId
      if (!items) return pendingQuestionId === state.pendingQuestionId ? state : { ...state, pendingQuestionId }
      return { ...state, items, pendingQuestionId }
    }

    case 'question_withdrawn': {
      // 0.6.2: Stop pressed while a question was pending. The card stays as a
      // trace, marked withdrawn, and the pending gate clears so the composer
      // returns to normal — the same shape as `question_answered`, minus the
      // answer.
      const items = replaceLast(
        state.items,
        (it): it is QuestionItem =>
          it.kind === 'question' && it.questionId === event.data.question_id,
        (card) => ({ ...card, withdrawn: true }),
      )
      const pendingQuestionId =
        state.pendingQuestionId === event.data.question_id ? null : state.pendingQuestionId
      if (!items) return pendingQuestionId === state.pendingQuestionId ? state : { ...state, pendingQuestionId }
      return { ...state, items, pendingQuestionId }
    }

    case 'compaction':
      return push(state, event.seq, (key) => ({
        kind: 'compaction',
        key,
        taskId,
        replacedCount: event.data.replaced_count ?? 0,
      }))

    case 'turn_started':
      return state.running && state.lastOutcome === null
        ? state
        : { ...state, running: true, lastOutcome: null }

    case 'turn_finished': {
      const { status } = event.data
      let items = state.items
      if (status === 'cancelled' || status === 'failed') {
        const closed: StepStatus = status === 'cancelled' ? 'cancelled' : 'failure'
        items = items.map((it) =>
          it.kind === 'step' && it.status === 'running' ? { ...it, status: closed } : it,
        )
      }
      if (status === 'cancelled') {
        // Only on cancel: the cascade writes `TaskCancelled` to the subtask's
        // own stream, so no `Delivered` reaches the parent and nothing else
        // will ever close these cards.
        items = items.map((it) =>
          it.kind === 'subtask' && it.status === 'running'
            ? { ...it, status: 'cancelled' as const }
            : it,
        )
      }
      // A finished turn can no longer be answered: the backend 409s a question
      // sent after the turn ends. Withdraw any card still open so the panel
      // clears, matching an explicit `question_withdrawn`. Without this a turn
      // stopped while a question was pending leaves the panel stuck on screen.
      items = items.map((it) =>
        it.kind === 'question' && !it.answered && !it.withdrawn
          ? { ...it, withdrawn: true }
          : it,
      )
      return {
        ...state,
        items,
        running: false,
        delta: null,
        pendingQuestionId: null,
        lastOutcome: { status, reason: event.data.reason ?? null },
      }
    }

    case 'error':
      // `running` must not depend on `turn_finished` alone: one lost frame
      // would otherwise leave the composer disabled for the rest of the session.
      return push(
        state,
        event.seq,
        (key) => ({ kind: 'error', key, taskId, message: event.data.message }),
        { running: false, delta: null },
      )

    case 'rewind': {
      // The one case that *removes* items. The engine re-based the stream to
      // before the user message at `target_seq`; everything after it is dead
      // history the transcript must drop. This runs both live (the frame lands
      // once) and on a full replay (the dead tail is re-sent, then this
      // truncates it again), so it must be idempotent and order-independent —
      // it derives the survivors purely from the current items and the target.
      const target = event.data.target_seq

      // 1. Drop the durable tail. A durable item's key IS its seq
      //    (`allocateKey`), so `key > target` is exactly "committed after the
      //    rewind boundary". `target_seq` is the boundary *before* the undone
      //    turn opened, so the anchored user bubble (a later seq) is included.
      const survivors = state.items.filter((it) => !(it.key >= 0 && it.key > target))

      // 2. Cascade-drop orphaned subtask steps. A subtask's inner tool steps
      //    are seq-less synthetic items (negative keys) that rule 1 never
      //    touches, but their parent `subtask` card carries a real seq and was
      //    just dropped — leaving dangling orphan rows. Drop any negative-key
      //    step whose owning subtask card no longer survives.
      const liveSubtasks = new Set(
        survivors
          .filter((it): it is SubtaskItem => it.kind === 'subtask')
          .map((it) => it.subtaskId),
      )
      const kept = survivors.filter(
        (it) =>
          !(
            it.key < 0 &&
            it.kind === 'step' &&
            it.subtaskId !== null &&
            !liveSubtasks.has(it.subtaskId)
          ),
      )

      // 3. Drop a pending optimistic user bubble: an un-acked send belongs to
      //    the span being undone, and there is no server seq behind it.
      const items = kept.filter((it) => !(it.kind === 'user' && it.pending))

      // 4. Land at a clean, live turn boundary. The cursor is *not* rewound:
      //    the `rewind` frame is real history past which we must never
      //    re-request, and a reconnect with `since_seq` relies on it.
      return {
        ...state,
        items,
        running: false,
        delta: null,
        pendingQuestionId: null,
        lastOutcome: null,
      }
    }
  }
}

/**
 * Apply one wire frame.
 *
 * Returns the **same state** when the frame changed nothing — a duplicate, an
 * unmatched tool result, or a frame type this build does not know.
 */
export function foldEvent(state: ConversationState, raw: RawUIEvent): ConversationState {
  const scope = taskKeyOf(raw.data)
  if (raw.seq !== null && raw.seq <= (state.cursors[scope] ?? -1)) return state

  // The cursor means "received", not "understood": it advances past a frame
  // type this build cannot render, because re-requesting it on reconnect would
  // only produce the same shrug.
  let base = state
  if (raw.seq !== null) {
    const cursors = { ...state.cursors, [scope]: raw.seq }
    base = { ...state, cursors, lastSeq: lowestCursor(cursors) }
  }

  const event = asUIEvent(raw)
  if (!event) return base
  if (isEphemeral(event)) return foldEphemeral(base, event)
  return foldItemEvent(base, event)
}

export function foldEvents(
  state: ConversationState,
  events: readonly RawUIEvent[],
): ConversationState {
  return events.reduce(foldEvent, state)
}

/**
 * Render the user's message before the server has acknowledged it.
 *
 * The bubble carries a negative key and `pending: true`; the durable
 * `user_message` frame replaces it in place, so the message never appears to
 * jump. `running` is deliberately left alone — the send path pushes a
 * synthetic `turn_started` for that, and a 409 must not leave the composer
 * locked against a turn that was never accepted.
 *
 * The bubble is session-level (`taskId: null`): a session owns one stream, so
 * the durable `user_message` — whatever `_task` it carries — reclaims it.
 */
export function appendOptimisticUser(
  state: ConversationState,
  content: string,
  images: readonly ImageRef[] = [],
): ConversationState {
  const key = state.nextKey
  const item: UserItem = {
    kind: 'user',
    key,
    taskId: null,
    content,
    images: [...images],
    pending: true,
  }
  return { ...state, items: [...state.items, item], nextKey: key - 1 }
}
