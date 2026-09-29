/**
 * The sidebar rail.
 *
 * Mounted by the shell layout, *above* the routes, which is what makes the
 * not-found rules work: a URL naming a session that does not exist still
 * renders this, so the user can pick another one instead of hitting a dead
 * page (D9).
 *
 * Everything in it is composed from the two-rail primitives in `sidebar/`, and
 * that is the point of the directory: a glyph lane at 20px and a label lane at
 * 44px only hold if every row is built the same way. A row that brings its own
 * padding looks fine in a diff and is visibly crooked on screen.
 *
 * Which project is open and which session is selected both come from the URL
 * rather than from a store — a sidebar with its own idea of either is the
 * classic way for the two to drift.
 */

import { useState } from 'react'
import { Link, useMatch, useParams } from 'react-router-dom'
import { PanelLeft, PanelLeftClose } from 'lucide-react'
import { HOME_ROUTE, ROUTE_PATTERNS } from '@/app/routes'
import { Logo, SidebarRail, cn } from '@/react-app/design-system'
import { readStored, writeStored } from '@/react-app/kernel/route-memory'
import { SessionRail } from './session-rail'
import { ProjectRail } from './sidebar/project-rail'
import { SidebarSection } from './sidebar/sidebar-row'
import { ThemeToggle } from './theme-toggle'

const COLLAPSED_KEY = 'noeta.sidebar.collapsed'

export function Sidebar() {
  // Route params, never a store: which project is open is a fact about the URL.
  const { projectId } = useParams()
  // Matched against the canonical pattern rather than read out of the params
  // of a layout route, so the answer does not depend on where in the route
  // tree this component happens to be mounted.
  const selectedSessionId = useMatch(ROUTE_PATTERNS.projectSession)?.params.sessionId ?? null

  // Whether the rail is a strip is a workspace preference, not a URL fact — a
  // reader who collapsed it wants it collapsed next boot too.
  const [collapsed, setCollapsed] = useState(() => readStored(COLLAPSED_KEY) === '1')
  const toggle = () => {
    setCollapsed((value) => {
      const next = !value
      writeStored(COLLAPSED_KEY, next ? '1' : null)
      return next
    })
  }

  // Collapsed: a strip that is only the 52px header — the same hairline the
  // pane headers share — with a single control to bring the rail back. Nothing
  // below it renders, so the projects and sessions do not paint off-screen.
  if (collapsed) {
    return (
      <SidebarRail collapsed>
        <div className="flex h-[52px] shrink-0 items-center justify-center border-b border-border">
          <button
            type="button"
            onClick={toggle}
            title="Expand sidebar"
            aria-label="Expand sidebar"
            aria-expanded={false}
            className="rounded-md p-1.5 text-ink-3 outline-none transition-colors hover:bg-surface-2 hover:text-ink focus-visible:ring-2 focus-visible:ring-accent"
          >
            <PanelLeft className="size-4" aria-hidden="true" />
          </button>
        </div>
      </SidebarRail>
    )
  }

  return (
    <SidebarRail>
      <div className="flex h-[52px] shrink-0 items-center gap-2 border-b border-border px-4">
        <Link
          to={HOME_ROUTE}
          className="min-w-0 flex-1 rounded-md outline-none focus-visible:ring-2 focus-visible:ring-accent"
          aria-label="Noeta home"
        >
          <Logo className="text-sm" />
        </Link>
        <ThemeToggle />
        <button
          type="button"
          onClick={toggle}
          title="Collapse sidebar"
          aria-label="Collapse sidebar"
          aria-expanded
          className={cn(
            'shrink-0 rounded-md p-1.5 text-ink-3 outline-none transition-colors',
            'hover:bg-surface-2 hover:text-ink focus-visible:ring-2 focus-visible:ring-accent',
          )}
        >
          <PanelLeftClose className="size-4" aria-hidden="true" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <SidebarSection title="Projects">
          <ProjectRail />
        </SidebarSection>
        {projectId ? (
          <SessionRail projectId={projectId} selectedSessionId={selectedSessionId} />
        ) : null}
      </div>
    </SidebarRail>
  )
}
