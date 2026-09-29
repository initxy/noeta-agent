/**
 * Whether a user message can be forked at.
 *
 * Pure and framework-free so the predicate is testable without mounting the
 * affordance that uses it.
 */

/**
 * Whether a user message can be forked at.
 *
 * The engine refuses the **opening** message of a stream: a fork folds the
 * state through the turn boundary right before its anchor, and the first
 * message has no prior turn, so there is nothing to inherit. Offering an
 * affordance that can only ever 409 is worse than not offering one, so the
 * caller hides it — and the 409 is still handled, because the predicate only
 * sees the messages it was given.
 */
export function isForkableMessage(
  messages: readonly { key: number; taskId: string | null }[],
  message: { key: number; taskId: string | null },
): boolean {
  // A pending bubble has no seq yet; there is nothing on the server to fork at.
  if (message.key < 0) return false
  const onSameStream = messages.filter(
    (candidate) => candidate.taskId === message.taskId && candidate.key >= 0,
  )
  const first = onSameStream[0]
  return first !== undefined && first.key !== message.key
}

/**
 * Whether a user message is the **latest** committed one on its stream — the
 * only anchor "undo last turn" offers.
 *
 * `rewind` re-bases to before a message and undoes everything after it, so the
 * affordance only makes sense on the last committed user bubble: undoing an
 * earlier one would silently discard turns the user did not point at. Only
 * committed bubbles count (`key >= 0`); a pending optimistic bubble (`key < 0`)
 * is "latest" by array position but has no server seq to rewind to. Fork's
 * inherited history is seq-less too, so it is likewise excluded — which is part
 * of why undo is offered on root sessions only for v1.
 */
export function isLatestUserMessage(
  messages: readonly { key: number; taskId: string | null }[],
  message: { key: number; taskId: string | null },
): boolean {
  if (message.key < 0) return false
  const onSameStream = messages.filter(
    (candidate) => candidate.taskId === message.taskId && candidate.key >= 0,
  )
  const last = onSameStream[onSameStream.length - 1]
  return last !== undefined && last.key === message.key
}
