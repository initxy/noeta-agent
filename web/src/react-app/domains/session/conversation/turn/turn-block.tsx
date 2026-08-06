/**
 * One turn: the message, the work, the answer.
 *
 * **The conversation is turn-centric, not message-centric.** A turn is one user
 * message and everything the agent did until it parked, and the block — not the
 * message — owns the chrome: the work, the outcome notice, and (Phase 5) the
 * files strip and the action bar. Consecutive assistant messages are one turn,
 * however many frames the engine split them into.
 *
 * **The work and the answer share one column.** There is no "process" region
 * fenced off from a "result" region — no bordered rail, no indent step. The
 * work rows and the answer flow down one left edge in the order they happened,
 * the work reading quietly (muted, one line each) and the answer reading as
 * prose. Each step row and the thinking group still carry their own
 * disclosures, so a single call's detail is one click away; the reader no
 * longer opens a whole process fold to see any of it. A live turn's heartbeat
 * is the streaming preview and the working line beneath the transcript.
 */

import type { ReactNode } from 'react'
import type { TurnBlock } from '@/app/fold/aggregate'
import type { UserItem } from '@/app/fold'
import { UserRow } from '../message-rows'
import { ThinkingGroup } from '../thinking-group'
import { TurnRows } from './turn-rows'

export function TurnBlockView({
  block,
  footer,
  userActions,
}: {
  block: TurnBlock
  /**
   * What hangs off the end of the turn: the outcome notice today, the files
   * strip and the action bar in Phase 5. A slot rather than a fixed list,
   * because the turn owns them but does not know what they are.
   */
  footer?: ReactNode
  /**
   * What may be done to the message that opened the turn — "edit and retry",
   * which forks.
   *
   * A slot for the same reason: a fork needs a message to anchor on, so the
   * affordance belongs here, but branching is the branch domain's subject and
   * this component has no business knowing how it works.
   */
  userActions?: (item: UserItem) => ReactNode
}) {
  const steps = <TurnRows rows={block.steps} />

  return (
    <section
      className="flex flex-col gap-2"
      data-turn={block.key}
      // The transcript's row identity: a turn is the unit "jump to the start of
      // the newest message" means, now that a turn is what a reader sees.
      data-message-key={block.key}
      data-live={block.live ? 'true' : undefined}
    >
      {block.user !== null ? (
        <div className="flex flex-col items-end gap-1">
          <UserRow item={block.user} />
          {userActions?.(block.user)}
        </div>
      ) : null}

      {block.steps.length === 0 && block.thinking.length === 0 ? null : (
        // The work is one column flush with the answer below it — no rail, no
        // indent step, so a step row and a paragraph of the reply share the
        // same left edge. The tight `gap-1.5` holds the run of work together;
        // the section's own `gap-2` sets it apart from the answer that follows.
        <div className="flex min-w-0 flex-col gap-1.5">
          {block.thinking.length > 0 ? <ThinkingGroup items={block.thinking} /> : null}
          {steps}
        </div>
      )}

      {block.answer.length > 0 ? (
        <div className="flex min-w-0 flex-col gap-2">
          <TurnRows rows={block.answer} />
        </div>
      ) : null}

      {footer}
    </section>
  )
}
