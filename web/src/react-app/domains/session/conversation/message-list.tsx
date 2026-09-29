/**
 * The transcript, as turns.
 *
 * The fold hands this component a flat item list, and `buildTurns` projects it
 * into blocks: one user message and everything the agent did until it parked.
 * The projection is pure and lives in `app/`, so what a turn *is* — where the
 * answer starts, which calls merged into one line, whether the run folds and
 * what its label says — is decided and tested without React anywhere near it.
 *
 * What is left here is mounting: the surface, the blocks, and the tail that
 * belongs to no turn in particular (the streaming preview, the working line,
 * the outcome notice). The tail hangs off the last block when there is one,
 * because the outcome describes that turn — and stands alone when there is not,
 * which is the first moments of a session, before a single frame has landed.
 *
 * Scrolling, the scroll overlay and find are `TranscriptSurface`'s: they share
 * two DOM nodes and every one of them needs both, so they are adopted together
 * rather than threaded through here one ref at a time.
 */

import { useMemo } from 'react'
import type { ReactNode } from 'react'
import { buildTurns } from '@/app/fold/aggregate'
import type { ConversationState, UserItem } from '@/app/fold'
import { TranscriptSurface } from './scroll/transcript-surface'
import { StreamingPreview } from './streaming-preview'
import { TurnOutcomeNotice } from './turn-outcome'
import { TurnBlockView } from './turn/turn-block'

export function MessageList({
  conversation,
  emptyNote,
  sessionId = null,
  userActions,
}: {
  conversation: ConversationState
  /** What an empty transcript says. The caller knows whether a session exists. */
  emptyNote: string
  /** Whose scroll position and find state these are. Null before the first send. */
  sessionId?: string | null
  /**
   * Per-message affordances — "edit and retry", which forks. Passed through to
   * the turn block, which owns the message it anchors on.
   */
  userActions?: (item: UserItem) => ReactNode
}) {
  const { items, delta, running, lastOutcome, pendingQuestionId } = conversation
  const turns = useMemo(() => buildTurns(items, { running }), [items, running])

  // A turn parked on a question is `running`, but nothing is arriving — and
  // "streaming" is what suppresses syntax highlighting. Left as plain `running`
  // the transcript stays unhighlighted for as long as the reader takes to
  // answer, which can be minutes.
  const streaming = running && pendingQuestionId === null

  const tail = (
    <>
      <StreamingPreview delta={delta} />
      {running && delta === null ? <WorkingLine /> : null}
      <TurnOutcomeNotice outcome={lastOutcome} running={running} />
    </>
  )

  return (
    <TranscriptSurface sessionId={sessionId} streaming={streaming}>
      {items.length === 0 && delta === null ? (
        <div className="flex flex-col items-center gap-3 py-16 text-center">
          <span
            aria-hidden="true"
            className="flex size-9 items-center justify-center rounded-xl bg-accent-soft"
          >
            <span className="size-2 rounded-full bg-accent" />
          </span>
          <p className="max-w-xs text-sm text-ink-3">{emptyNote}</p>
        </div>
      ) : null}
      {/* Turns are set further apart than the rows inside one, which is the
          whole visual claim of a turn-centric transcript. */}
      <div className="flex min-w-0 flex-col gap-6">
        {turns.map((block, index) => (
          <TurnBlockView
            key={block.key}
            block={block}
            footer={index === turns.length - 1 ? tail : undefined}
            userActions={userActions}
          />
        ))}
      </div>
      {turns.length === 0 ? tail : null}
    </TranscriptSurface>
  )
}

/**
 * The only sign of life on a provider that does not stream.
 *
 * `FakeLLMProvider` implements no streaming interface, so the whole mock path
 * emits zero deltas — which is deliberate and load-bearing for the backend
 * tests. Without this line the out-of-the-box experience is a frozen screen
 * between the send and the answer.
 */
function WorkingLine() {
  return (
    <div className="flex items-center gap-2 py-1 text-xs text-ink-3" data-testid="working">
      <span className="size-1.5 animate-pulse rounded-full bg-accent" aria-hidden="true" />
      Working…
    </div>
  )
}
