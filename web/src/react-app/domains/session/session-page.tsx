/**
 * The conversation surface: header, fork note, transcript, question panel,
 * composer.
 *
 * The page owns the wiring and nothing else. The stream is a hook, the fold is
 * pure and lives in `app/`, and every row is its own component — so the parts
 * that grow later attach without this file changing shape.
 *
 * Two slots exist because the layering forbids reaching sideways: the side
 * panel lives in the `panels` domain and the project directory it needs lives
 * in the `project` domain, so the **shell** composes those and hands this page
 * whatever chrome belongs in the header. A domain that imported a sibling to
 * get them would be the first crack in D9.
 *
 * `session === null` is the "project open, nothing selected" surface, not an
 * error: the composer is live, and the first message creates the session. While
 * that surface is still blank — no session id and not a frame in the
 * conversation — the composer is centred, like a fresh chat, rather than docked
 * at the bottom over an empty transcript. The first send navigates to the new
 * session's URL, so this centred state is only ever the untouched first screen.
 */

import { useEffect } from 'react'
import type { ReactNode } from 'react'
import { useParams } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { PaneHeader } from '@/react-app/design-system'
import { EditAndRetry } from './branch/edit-and-retry'
import { ForkNote } from './branch/fork-note'
import { UndoLastTurn } from './branch/undo-last-turn'
import { Composer } from './composer/composer'
import { MessageList } from './conversation/message-list'
import { TodoStrip } from './conversation/todo-strip'
import { QuestionPanel } from './question/question-panel'
import { sessionKeys } from './queries/session-queries'
import { useLatestTodos, useSessionRuntime } from './state/conversation-store'
import { useSessionStream } from './state/use-session-stream'
import type { SessionSummary } from './session-index'

/** What the header says about the stream. `null` is the quiet, healthy case. */
const CONNECTION_LABEL: Record<string, string | null> = {
  offline: null,
  connecting: 'Connecting…',
  live: null,
  retrying: 'Reconnecting…',
}

export function SessionPage({
  session,
  headerActions,
}: {
  session: SessionSummary | null
  /** Chrome the shell owns — today, the side-panel toggle. */
  headerActions?: ReactNode
}) {
  // Which project is open is a fact about the URL, never a store: the page is
  // mounted under `/project/:projectId/session/:sessionId?`.
  const { projectId = '' } = useParams()
  const sessionId = session?.id ?? null

  useSessionStream(sessionId)
  const runtime = useSessionRuntime(sessionId)
  const { conversation, connection } = runtime

  const streamTitle = conversation.title
  const queryClient = useQueryClient()
  useEffect(() => {
    // The title-generation thread pushes `session_meta` down the stream; the
    // sidebar reads its titles from the session index, which has no idea one
    // changed.
    if (streamTitle === null || projectId === '') return
    void queryClient.invalidateQueries({ queryKey: sessionKeys.list(projectId) })
  }, [streamTitle, projectId, queryClient])

  const title = streamTitle ?? session?.title ?? 'New session'
  const status = CONNECTION_LABEL[connection] ?? null
  const todos = useLatestTodos(sessionId)

  // The untouched first screen: no session yet, and not a frame has landed. The
  // send navigates away the moment it fires, so this can only ever be the blank
  // opener — which is why the composer is centred here and docked everywhere
  // else.
  const blank = sessionId === null && conversation.items.length === 0 && conversation.delta === null

  if (blank) {
    return (
      <>
        <PaneHeader>
          <span className="min-w-0 flex-1 truncate font-medium text-ink">{title}</span>
        </PaneHeader>
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center">
          <div className="w-full">
            <p className="mb-2 px-4 text-center text-lg font-medium text-ink-2">
              What would you like to do?
            </p>
            <Composer projectId={projectId} sessionId={sessionId} />
          </div>
        </div>
      </>
    )
  }

  return (
    <>
      <PaneHeader>
        <span className="min-w-0 flex-1 truncate font-medium text-ink">{title}</span>
        {status !== null ? <span className="shrink-0 text-xs text-ink-3">{status}</span> : null}
        {headerActions}
      </PaneHeader>

      {session?.parentSessionId != null ? (
        <ForkNote branchedAtSeq={session.branchedAtSeq} />
      ) : null}

      {/* The transcript fills the pane; the composer, question panel and todo
          strip float over its bottom edge rather than sitting in a solid band
          that eats vertical space. A top-fading gradient keeps text legible as
          it scrolls behind the dock, and the transparent upper region is
          click-through so the transcript underneath stays reachable. */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <MessageList
          conversation={conversation}
          sessionId={sessionId}
          // "Edit and retry" forks; "Undo last turn" rewinds in place. Both
          // are per-message and need a session to act in, so they appear only
          // once one exists. Undo is root-only for v1 (a fork child's history
          // is spliced from its parent).
          userActions={
            sessionId === null
              ? undefined
              : (item) => (
                  <>
                    <EditAndRetry projectId={projectId} sessionId={sessionId} item={item} />
                    <UndoLastTurn
                      sessionId={sessionId}
                      item={item}
                      isRoot={session?.parentSessionId == null}
                    />
                  </>
                )
          }
          emptyNote={
            sessionId === null
              ? 'Send a message to start a session in this project.'
              : 'No messages yet.'
          }
        />

        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-col bg-gradient-to-t from-bg via-bg to-transparent pt-10">
          <div className="pointer-events-auto">
            <QuestionPanel sessionId={sessionId} conversation={conversation} />
          </div>
          <div className="pointer-events-auto">
            <TodoStrip todos={todos} />
          </div>
          <div className="pointer-events-auto">
            <Composer projectId={projectId} sessionId={sessionId} />
          </div>
        </div>
      </div>
    </>
  )
}
