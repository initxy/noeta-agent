/**
 * The in-flight preview of the assistant's current LLM call.
 *
 * Not part of the transcript. A delta never enters the event log, is never
 * replayed, and the `MessagesAppended` that follows carries the same bytes as a
 * durable frame — so the preview's job is to disappear the moment that frame
 * lands. The fold does exactly that by clearing `delta` on `assistant_text`,
 * `thinking`, `question`, `turn_finished` and `error`, which is why this
 * component holds no state of its own.
 *
 * Rendered from `renderDeltaBlocks`, which drops empty blocks and sorts by
 * index: a preview bubble that flickers in and out on a delta carrying no
 * characters is worse than no preview.
 *
 * **`data-find-skip` is load-bearing, not decoration.** Find rewrites matching
 * text nodes into `<mark>` elements in the DOM. Every other row in the
 * transcript is memoized on an immutable item and its text nodes are therefore
 * settled, but this one's are replaced on every animation frame of a live
 * turn — and React updates a text node by writing `nodeValue` on the node it
 * created, which find has by then detached. Excluding the live region is what
 * keeps a search running during a stream from freezing the preview on stale
 * bytes.
 */

import { renderDeltaBlocks } from '@/app/fold'
import type { DeltaState } from '@/app/fold'
import { cn } from '@/react-app/design-system'

export function StreamingPreview({ delta }: { delta: DeltaState | null }) {
  const blocks = renderDeltaBlocks(delta)
  if (blocks === null) return null

  return (
    <div className="flex flex-col gap-2" data-testid="streaming-preview" data-find-skip="true">
      {blocks.map((block, index) => (
        <div
          // Index is the stable identity here: blocks are keyed by their
          // position in the LLM's block list, and that is what `index` is.
          key={index}
          className={cn(
            'text-sm leading-relaxed whitespace-pre-wrap',
            block.kind === 'thinking'
              ? 'border-l-2 border-border pl-2.5 text-xs text-ink-3'
              : 'text-ink',
          )}
        >
          {block.text}
        </div>
      ))}
    </div>
  )
}
