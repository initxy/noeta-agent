/**
 * One session pane: a session id in, a conversation and its side panel out.
 *
 * The resolution is the session route's own (`resolveSessionRoute`), reused
 * rather than re-derived, because a bookmark and a pasted URL must answer "this
 * session is gone" the same way — a pane that renders an empty conversation
 * where the route would have said *not found* is how a deleted session looks
 * like a broken one.
 *
 * **This is where the panel dock is composed, and it has to be.** The dock
 * lives in the `panels` domain, the transcript in `session`, and the project
 * directory it resolves paths against in `project`; a domain may not import a
 * sibling, so the shell is the only layer that can see all three. That is the
 * constraint working, not an obstacle: the derivation engine is a pure function
 * of an item list, so the dock takes the list as a prop and knows nothing about
 * how a conversation is folded.
 */

import { useMemo } from 'react'
import { Activity, PanelRight } from 'lucide-react'
import { traceRoute } from '@/app/routes'
import { Button, CenteredNote, NotFoundCard, cn } from '@/react-app/design-system'
import { PanelDock, panelActions, usePanelOpen, usePanelWidth } from '@/react-app/domains/panels/panel-index'
import { useProjects } from '@/react-app/domains/project/project-queries'
import { resolveSessionRoute } from '@/react-app/domains/session/route-resolution'
import { useSessionIndex } from '@/react-app/domains/session/session-index'
import { SessionPage } from '@/react-app/domains/session/session-page'
import type { SessionSummary } from '@/react-app/domains/session/session-index'
import { useConversation } from '@/react-app/domains/session/state/conversation-store'

export function WorkbenchSessionPane({
  projectId,
  sessionId,
}: {
  projectId: string
  /** `null` is the project-open-nothing-selected surface, not an error. */
  sessionId: string | null
}) {
  const index = useSessionIndex(projectId)
  const resolution = resolveSessionRoute({ ...index, routeSessionId: sessionId })

  if (resolution.kind === 'loading') return <CenteredNote>Loading session…</CenteredNote>
  if (resolution.kind === 'not-found') {
    return <NotFoundCard title="Session not found" message={resolution.message} />
  }
  return (
    <SessionSurface
      projectId={projectId}
      session={resolution.kind === 'ok' ? resolution.session : null}
    />
  )
}

function SessionSurface({
  projectId,
  session,
}: {
  projectId: string
  session: SessionSummary | null
}) {
  const sessionId = session?.id ?? null

  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <SessionPage
          session={session}
          headerActions={
            sessionId === null ? undefined : (
              <>
                <TraceLink sessionId={sessionId} />
                <PanelToggle sessionId={sessionId} />
              </>
            )
          }
        />
      </div>
      {sessionId === null ? null : <SessionPanels projectId={projectId} sessionId={sessionId} />}
    </div>
  )
}

/**
 * A link to this session's trace, opened in a new tab.
 *
 * The trace page lives outside the workbench shell (`app-root.tsx`) on purpose,
 * "opened beside the conversation it explains" — so this is a real anchor with
 * `target="_blank"` rather than an in-app navigation that would leave the
 * workbench. Styled to match a small ghost button.
 */
function TraceLink({ sessionId }: { sessionId: string }) {
  return (
    <a
      href={traceRoute(sessionId)}
      target="_blank"
      rel="noreferrer"
      title="Open the raw event trace for this session (new tab)"
      className={cn(
        'inline-flex h-7 shrink-0 items-center justify-center gap-1.5 rounded-md px-2.5 text-xs font-medium',
        'text-ink-2 transition-colors outline-none hover:bg-surface-2 hover:text-ink',
        'focus-visible:ring-2 focus-visible:ring-accent',
      )}
    >
      <Activity className="size-3.5" aria-hidden="true" />
      Trace
    </a>
  )
}

function PanelToggle({ sessionId }: { sessionId: string }) {
  const open = usePanelOpen(sessionId)
  return (
    <Button
      size="sm"
      variant={open ? 'ghost' : 'outline'}
      aria-pressed={open}
      className="shrink-0 gap-1.5"
      title="Files, preview and terminal for this session"
      onClick={() => panelActions().setOpen(sessionId, !open)}
    >
      <PanelRight className="size-3.5" aria-hidden="true" />
      {open ? 'Hide files' : 'Files & preview'}
    </Button>
  )
}

/**
 * The dock, mounted only while it is open.
 *
 * Mounting it closed would run the derivation scan and the resolve round trip
 * for every session the workbench keeps open, which is exactly the cost D12's
 * "a human always clicks" rule exists to avoid paying by default.
 */
function SessionPanels({ projectId, sessionId }: { projectId: string; sessionId: string }) {
  const open = usePanelOpen(sessionId)
  const conversation = useConversation(sessionId)
  const projects = useProjects()
  const panelWidth = usePanelWidth()
  // The project directory is what an absolute path from a `local` project's
  // tool output is made relative to; without it almost nothing resolves.
  const workspaceRoot = useMemo(
    () => projects.data?.find((candidate) => candidate.id === projectId)?.directory ?? null,
    [projects.data, projectId],
  )

  if (!open) return null

  return (
    <div style={{ width: `${panelWidth.width}px` }} className="shrink-0">
      <PanelDock
        sessionId={sessionId}
        items={conversation.items}
        workspaceRoot={workspaceRoot}
        onClose={() => panelActions().setOpen(sessionId, false)}
        onResizePointerDown={panelWidth.onHandlePointerDown}
        resizing={panelWidth.dragging}
        className="h-full"
      />
    </div>
  )
}
