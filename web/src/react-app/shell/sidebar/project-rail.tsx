/**
 * The sidebar's project surface: an elevated switcher for the open project, and
 * a plain list when none is open.
 *
 * The redesign's hierarchy claim lives here. A project and a session used to be
 * near-identical rows, so which was which read as a guess; now the *active*
 * project is a bordered card with an avatar and a tier badge — a distinct,
 * elevated object — and its sessions are the light list beneath it. The card is
 * new chrome, deliberately **not** a `SidebarLinkRow`: it carries none of the
 * lane attributes, so the two-rail geometry (and its test) is untouched.
 *
 * Active state still comes from the URL, never a store (D9): each row in the
 * dropdown is a `NavLink`, and the card reads the open project out of the same
 * route param the shell already matched.
 *
 * Creating a project is a **modal**, opened from the switcher's "New project"
 * item (and from the flat list on the home route). It is owned here rather than
 * on the home page because this is the surface a user reaches for to make one
 * while already inside a project — the case the old full-page form lost their
 * place on. A genuinely empty first run still lands on the home page's own
 * form; this modal is the has-projects path.
 *
 * On the home route (no `projectId`) there is no active project to elevate, so
 * this falls back to the flat list of links — the surface the user picks from.
 */

import { useState } from 'react'
import { NavLink, useParams } from 'react-router-dom'
import { Check, ChevronsUpDown, Plus } from 'lucide-react'
import { projectSessionRoute } from '@/app/routes'
import { Modal, cn } from '@/react-app/design-system'
import { useProjectIndex } from '@/react-app/domains/project/project-index'
import { CreateProjectForm } from '@/react-app/domains/project/create-project-form'
import { TIER_LABELS } from '@/react-app/domains/project/tier-copy'
import type { ProjectSummary } from '@/react-app/domains/project/project-index'

/** The square, monogram avatar every project row shares. */
function ProjectAvatar({ name, className }: { name: string; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'flex shrink-0 items-center justify-center rounded-md bg-accent-soft font-semibold text-accent uppercase',
        className,
      )}
    >
      {name.trim().charAt(0) || '·'}
    </span>
  )
}

/** The tier badge — the one project property with a safety consequence (D4). */
function TierBadge({ tier }: { tier: ProjectSummary['tier'] }) {
  return (
    <span
      className={cn(
        'shrink-0 rounded px-1 py-px text-[10px] tracking-wide uppercase',
        tier === 'local' ? 'bg-warn-soft text-warn' : 'bg-surface-3 text-ink-3',
      )}
    >
      {tier}
    </span>
  )
}

/** Three pulsing skeleton rows while the list loads. */
function ProjectSkeleton() {
  return (
    <div className="flex flex-col gap-1 px-1" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-8 animate-pulse rounded-md bg-surface-2" />
      ))}
    </div>
  )
}

/**
 * The elevated card + dropdown, shown when a project is open.
 *
 * The dropdown's open state is ephemeral local state (like the archived
 * section): "show me the other projects" is a momentary want, not something the
 * sidebar should reopen tomorrow.
 */
function ProjectSwitcher({
  active,
  projects,
  onNewProject,
}: {
  active: ProjectSummary
  projects: ProjectSummary[]
  onNewProject: () => void
}) {
  const [open, setOpen] = useState(false)

  return (
    <div className="relative px-1">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Project: ${active.name}. Switch project`}
        title={`${active.directory} · ${TIER_LABELS[active.tier]}`}
        onClick={() => setOpen((current) => !current)}
        className={cn(
          'flex w-full items-center gap-2.5 rounded-lg border border-border bg-bg p-2 text-left',
          'outline-none transition-colors hover:border-border-strong hover:bg-surface-2',
          'focus-visible:ring-2 focus-visible:ring-accent',
        )}
      >
        <ProjectAvatar name={active.name} className="size-8 text-sm" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[13px] font-medium text-ink">{active.name}</span>
          <span className="mt-0.5 flex items-center gap-1.5">
            <TierBadge tier={active.tier} />
          </span>
        </span>
        <ChevronsUpDown className="size-3.5 shrink-0 text-ink-3" aria-hidden="true" />
      </button>

      {open ? (
        <>
          {/* A full-screen catcher so any outside click closes the menu. */}
          <button
            type="button"
            aria-hidden="true"
            tabIndex={-1}
            className="fixed inset-0 z-20 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div
            role="menu"
            className="absolute inset-x-1 top-full z-30 mt-1 flex flex-col rounded-lg border border-border bg-surface p-1 shadow-card"
          >
            {projects.map((project) => (
              <NavLink
                key={project.id}
                to={projectSessionRoute(project.id)}
                role="menuitem"
                title={`${project.directory} · ${TIER_LABELS[project.tier]}`}
                onClick={() => setOpen(false)}
                className={({ isActive }) =>
                  cn(
                    'flex items-center gap-2 rounded-md px-1.5 py-1.5 text-left text-[13px]',
                    'outline-none focus-visible:ring-2 focus-visible:ring-accent',
                    isActive ? 'bg-accent-soft text-ink' : 'text-ink-2 hover:bg-surface-2 hover:text-ink',
                  )
                }
              >
                <ProjectAvatar name={project.name} className="size-6 text-[11px]" />
                <span className="min-w-0 flex-1 truncate">{project.name}</span>
                {project.id === active.id ? (
                  <Check className="size-3.5 shrink-0 text-accent" aria-hidden="true" />
                ) : (
                  <TierBadge tier={project.tier} />
                )}
              </NavLink>
            ))}
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false)
                onNewProject()
              }}
              className="mt-0.5 flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left text-[13px] text-ink-3 outline-none hover:bg-surface-2 hover:text-ink focus-visible:ring-2 focus-visible:ring-accent"
            >
              <span className="flex size-6 items-center justify-center" aria-hidden="true">
                <Plus className="size-4" />
              </span>
              New project
            </button>
          </div>
        </>
      ) : null}
    </div>
  )
}

/** The flat list, shown on the home route when no project is open. */
function ProjectList({ projects, activeId }: { projects: ProjectSummary[]; activeId: string | null }) {
  return (
    <ul
      className="flex flex-col gap-0.5"
      style={{ listStyle: 'none', margin: 0, paddingInline: '0.25rem' }}
    >
      {projects.map((project) => (
        <li key={project.id}>
          <NavLink
            to={projectSessionRoute(project.id)}
            title={`${project.directory} · ${TIER_LABELS[project.tier]}`}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-2 rounded-md px-1.5 py-1.5 text-left text-[13px]',
                'outline-none focus-visible:ring-2 focus-visible:ring-accent',
                isActive || project.id === activeId
                  ? 'bg-accent-soft text-ink'
                  : 'text-ink-2 hover:bg-surface-2 hover:text-ink',
              )
            }
          >
            <ProjectAvatar name={project.name} className="size-6 text-[11px]" />
            <span className="min-w-0 flex-1 truncate">{project.name}</span>
            <TierBadge tier={project.tier} />
          </NavLink>
        </li>
      ))}
    </ul>
  )
}

export function ProjectRail() {
  const { projectId } = useParams()
  const { status, projects, error } = useProjectIndex()
  // Ephemeral local state (like the dropdown's own open flag): "make a project"
  // is a momentary want, not something the sidebar should reopen tomorrow.
  const [creating, setCreating] = useState(false)

  if (status === 'loading') return <ProjectSkeleton />
  if (error) {
    return (
      <p className="px-3 py-1 text-xs text-danger" title={error.message}>
        Projects unavailable
      </p>
    )
  }
  if (projects.length === 0) {
    return <p className="px-3 py-1 text-xs text-ink-3">No projects yet.</p>
  }

  const active = projectId ? projects.find((project) => project.id === projectId) ?? null : null

  // The modal is the switcher's creation path — the case a user hits while
  // *inside* a project, which the old full-page form lost their place on. On
  // the home route the home page owns creation, so the flat list stays a pure
  // picker and no second "New project" affordance competes with it.
  return active ? (
    <>
      <ProjectSwitcher active={active} projects={projects} onNewProject={() => setCreating(true)} />
      <Modal open={creating} onClose={() => setCreating(false)} title="New project">
        {/* The modal lives on the shell layout, which navigating to the new
            project does not unmount — so the form closes it explicitly on
            success. Cancel is the returnable path. */}
        <CreateProjectForm
          onCreated={() => setCreating(false)}
          onCancel={() => setCreating(false)}
        />
      </Modal>
    </>
  ) : (
    <ProjectList projects={projects} activeId={projectId ?? null} />
  )
}
