/**
 * The escape from a long transcript, as a floating pill.
 *
 * **Jump to latest** appears only when the reader is not already at the bottom;
 * an affordance that is always there stops being read, so the moment the
 * transcript is stuck to the bottom the pill is gone. It is lifted clear of the
 * composer, which floats over the transcript's bottom edge.
 *
 * The shell is `pointer-events-none` so the pill never eats a click aimed at
 * the transcript underneath it; only the button takes pointer events.
 */

import { cn } from '@/react-app/design-system'
import type { ConversationScroll } from './use-conversation-scroll'

export function ScrollOverlay({ scroll }: { scroll: ConversationScroll }) {
  const showLatest = scroll.mode !== 'sticky'
  if (!showLatest) return null

  return (
    <div className="pointer-events-none absolute bottom-28 left-1/2 z-30 -translate-x-1/2">
      <div
        className={cn(
          'pointer-events-auto flex items-center gap-1 rounded-full border border-border',
          'bg-surface/95 p-1 shadow-card backdrop-blur-md',
        )}
        data-testid="scroll-overlay"
      >
        <button
          type="button"
          onClick={scroll.jumpToLatest}
          className="rounded-full px-3 py-1.5 text-xs text-ink-2 hover:bg-surface-2 hover:text-ink"
        >
          Jump to latest
        </button>
      </div>
    </div>
  )
}
