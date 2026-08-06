/**
 * A turn's reasoning, folded into one line.
 *
 * A thinking model narrates before nearly every call, so a turn's process grows
 * a "Thought" disclosure between every pair of steps — a stutter the reader did
 * not ask to read. The fold (`buildTurns`) lifts every reasoning item out of the
 * step timeline and hands them here as one list; this collapses them to a single
 * "Thought · N" the reader opens on purpose.
 *
 * **Collapsed by default, always** — even while the turn is live. Reasoning is
 * available rather than imposed, and the live turn already narrates itself
 * through the streaming preview above the transcript; opening the group here
 * would only double it. The reader opens the group when they want the record.
 *
 * Built on `Disclosure` so it inherits the find contract: collapsed reasoning
 * stays in the DOM behind `until-found`, and a Ctrl-F hit inside it opens the
 * group around the match.
 */

import type { ThinkingItem } from '@/app/fold'
import { Disclosure } from './disclosure'

export function ThinkingGroup({ items }: { items: readonly ThinkingItem[] }) {
  if (items.length === 0) return null

  const label = items.length === 1 ? 'Thought' : `Thought · ${items.length}`

  return (
    <Disclosure
      summary={<span className="text-xs text-ink-3">{label}</span>}
      className="text-ink-3"
    >
      <div className="flex flex-col gap-2 border-l-2 border-border pl-2.5">
        {items.map((item) => (
          <p key={item.key} className="text-xs leading-relaxed whitespace-pre-wrap text-ink-3">
            {item.text}
          </p>
        ))}
      </div>
    </Disclosure>
  )
}
