/**
 * "Is this transcript streaming right now?", as one context read.
 *
 * Threaded through context rather than passed down because the components that
 * need it are the cheapest leaves in the tree — a code block, a hover bar — and
 * routing a boolean through every intermediate row would put the prop on
 * components that have no other reason to know a turn is in flight.
 *
 * What reads it:
 *
 * - **Syntax highlighting is disabled while streaming.** Shiki tokenizes on a
 *   worker-free async pass; running it per keystroke-sized update thrashes the
 *   main thread for output that is about to change anyway. Highlighting comes
 *   back the moment the turn parks, which is also the moment the code stops
 *   moving.
 * - Hover affordances stay hidden while a turn is live.
 *
 * Default `false`: a component rendered outside a session surface (a test, a
 * panel preview) highlights normally rather than silently degrading.
 */

import { createContext, use } from 'react'
import type { ReactNode } from 'react'

const StreamingContext = createContext(false)

export function StreamingProvider({
  streaming,
  children,
}: {
  streaming: boolean
  children: ReactNode
}) {
  return <StreamingContext value={streaming}>{children}</StreamingContext>
}

export function useStreamingActive(): boolean {
  return use(StreamingContext)
}
