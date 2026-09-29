/**
 * The fork verb the "edit and retry" affordance needs.
 *
 * `fork` is a 201 that creates a **new child session** (nested under its source
 * in the sidebar) and returns that session plus its own root stream; it writes
 * nothing to the source. The child rests at a turn boundary — live but idle —
 * so it does nothing until the edited message is sent to it. That two-step is
 * why this hook exists rather than a single endpoint: the product's "edit that
 * and try again" is a fork plus a send, and either half can fail on its own.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { forkSession, rewindSession, sendMessage } from '@/app/api/sessions'
import { sessionKeys } from '../queries/session-queries'

export interface ForkAndRetryVariables {
  /** The session being forked. */
  sessionId: string
  /** The stream to branch. */
  taskId: string
  /** The user message to branch at — everything before it is inherited. */
  messageSeq: number
  /** The edited text, sent as the child's first message. */
  text: string
  model?: string
  effort?: string
}

/**
 * Edit a message and try again: fork at it, then send the edit to the child.
 *
 * The order is fork-then-send, and both land on the **child** session the fork
 * returns — never the source, which `fork` leaves untouched. On success it
 * returns `{ sessionId, taskId }` for the child so the caller can navigate to
 * it; the sidebar list is invalidated so the new nested row appears.
 *
 * A rejected send leaves the child session in place (it is a real session with
 * the inherited history on it) — only the message was not delivered, and the
 * caller can retry from the child once navigated there. No optimistic bubble is
 * shown on the source: the edit belongs to the child, which is not on screen
 * until navigation, so there is nowhere to show it and nothing to take back.
 */
export function useForkAndRetry() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({
      sessionId,
      taskId,
      messageSeq,
      text,
      model,
      effort,
    }: ForkAndRetryVariables): Promise<{ sessionId: string; taskId: string }> => {
      const child = await forkSession(sessionId, {
        task_id: taskId,
        message_seq: messageSeq,
      })
      await sendMessage(child.session_id, {
        text,
        task_id: child.task_id,
        model,
        effort,
      })
      return { sessionId: child.session_id, taskId: child.task_id }
    },
    onSettled: () => {
      // A new child row exists; the sidebar reads the list, not the stream.
      void queryClient.invalidateQueries({ queryKey: sessionKeys.all })
    },
  })
}

export interface RewindVariables {
  /** The session being rewound (re-based in place — no child is created). */
  sessionId: string
  /** The stream to re-base. Always sent explicitly: a destructive undo must
   *  not fall back to "the newest stream". */
  taskId: string
  /** The user message to undo — this and everything after it become dead
   *  history, and the files that span edited are restored. */
  messageSeq: number
}

/**
 * Undo the last turn(s): re-base this session's stream in place.
 *
 * Unlike {@link useForkAndRetry} this is a **single** call and there is **no
 * navigation** — the session is the one already on screen. The visible effect
 * (the transcript truncating to the anchor) is not applied optimistically: it
 * arrives as the durable `rewind` SSE frame the fold turns into a truncation,
 * so a rejected call (a busy race) leaves the transcript untouched rather than
 * diverging from the server. Session detail is invalidated so status /
 * `updated_at` refresh, but the router is deliberately not touched.
 */
export function useRewind() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ sessionId, taskId, messageSeq }: RewindVariables): Promise<void> => {
      await rewindSession(sessionId, { task_id: taskId, message_seq: messageSeq })
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: sessionKeys.all })
    },
  })
}
