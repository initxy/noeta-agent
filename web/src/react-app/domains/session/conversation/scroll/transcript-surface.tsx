/**
 * The scrolling transcript surface: scroll machine, overlay and find bar, in
 * one component.
 *
 * It exists so the transcript adopts all three at once. Each is a hook or a
 * component of its own and could be wired separately, but they share exactly
 * two DOM nodes — the scroll container and the content column — and every one
 * of them needs both. Handing a caller three refs to thread correctly is how
 * one of them ends up attached to the wrong element and silently does nothing.
 *
 * The caller supplies rows and nothing else:
 *
 * ```tsx
 * <TranscriptSurface sessionId={sessionId} streaming={conversation.running}>
 *   {rows}
 * </TranscriptSurface>
 * ```
 *
 * `streaming` is passed down as context and read by the code block, which is
 * where syntax highlighting is gated off for the duration of a turn.
 *
 * Rows should carry `data-message-key` so "jump to the start of the newest
 * message" can find them, and any nested scroll area should carry
 * `data-scrollable` so scrolling it does not detach the transcript from the
 * bottom. Both degrade to nothing when absent.
 */

import type { ReactNode } from 'react'
import { cn } from '@/react-app/design-system'
import { FindBar } from '../find/find-bar'
import { useFind } from '../find/use-find'
import { StreamingProvider } from '../stream/streaming-context'
import { ScrollOverlay } from './scroll-overlay'
import { useConversationScroll } from './use-conversation-scroll'

export function TranscriptSurface({
  sessionId,
  streaming,
  children,
}: {
  sessionId: string | null
  streaming: boolean
  children: ReactNode
}) {
  const scroll = useConversationScroll(sessionId)
  // Find tells the scroll controller before it jumps, so growth re-anchoring
  // treats the move as the reader's and does not drag them back to the bottom.
  const find = useFind(sessionId, scroll.containerRef, scroll.markGesture)

  return (
    <div className="relative min-h-0 flex-1">
      <div
        {...scroll.containerProps}
        className="absolute inset-0 overflow-y-auto overscroll-y-contain"
        data-testid="transcript"
      >
        <div
          ref={scroll.contentRef}
          className={cn(
            // The composer floats over the bottom edge, so the transcript
            // reserves room for it to scroll clear of rather than sit under.
            'mx-auto flex w-full max-w-[46rem] flex-col gap-2 px-4 pb-32',
            // The find bar floats; without the extra room it covers the first
            // row of a short conversation.
            find.open ? 'pt-16' : 'pt-4',
          )}
        >
          <StreamingProvider streaming={streaming}>{children}</StreamingProvider>
        </div>
      </div>

      <ScrollOverlay scroll={scroll} />
      <FindBar find={find} />
    </div>
  )
}
