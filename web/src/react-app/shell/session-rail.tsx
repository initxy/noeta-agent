/**
 * The sidebar's session rail for the open project.
 *
 * It lives in the shell rather than in a domain because it is a join: the
 * project comes from the route, the sessions come from the session domain's
 * read model, and clicking one navigates. Cross-domain wiring is what the
 * shell is for.
 *
 * Three product decisions are visible here rather than in layout:
 *
 * - **A row carries one signal, never two.** Activity on the glyph lane,
 *   outcome on the trailing edge, and `row-signals.ts` owns which — so a row
 *   cannot end up shouting twice about the same turn.
 * - **Opening a session reads it.** `visit` runs on the click, *before* the
 *   navigation, so the mark clears whether or not the route resolves.
 * - **"New session" opens the blank surface, it does not create.** The button
 *   navigates to the session-less URL, where the composer is live and the first
 *   message creates the session (titled by that turn). Creating an empty session
 *   up front would leave a titleless, streamless row behind every time the user
 *   changed their mind, so the session is made only once there is something to
 *   say.
 *
 * Pin and archive are optimistic: the row moves on click and the server is
 * reconciled afterwards, by version rather than by arrival
 * (`sidebar/organisation-protocol.ts`).
 */

import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Archive, ArchiveRestore, ChevronRight, Pin, PinOff, Plus, Trash2 } from 'lucide-react'
import { projectSessionRoute } from '@/app/routes'
import { cn } from '@/react-app/design-system'
import { SessionDotMatrix, SessionStateSlot } from './sidebar/activity-indicators'
import { sidebarSectionStyle } from './sidebar/lane-metrics'
import { rowSignals, rowStateLabel } from './sidebar/row-signals'
import {
  SidebarButtonRow,
  SidebarLinkRow,
  SidebarRowList,
  SidebarSection,
} from './sidebar/sidebar-row'
import type { SidebarSection as SessionSection, SidebarSessionEntry } from './sidebar/session-sections'
import { useSessionOrganisation } from './sidebar/use-session-organisation'
import type { SessionOrganisationView } from './sidebar/use-session-organisation'

/**
 * The "start a session" affordance, on the sidebar's own lanes.
 *
 * A `SidebarButtonRow` rather than a bare `Button` so its label lands on the
 * label lane (44px) and its `+` on the glyph lane — the same two rails every
 * session title below it sits on. A one-off button with its own padding is the
 * one thing that reads as crooked next to a list that is not.
 *
 * It navigates to the session-less URL rather than creating anything: the blank
 * surface's composer creates the session on the first message (see the module
 * docstring), so the button is a plain link disguised as a row.
 */
export function NewSessionButton({ projectId }: { projectId: string }) {
  const navigate = useNavigate()

  return (
    <SidebarButtonRow
      glyph={<Plus className="size-3.5" aria-hidden="true" />}
      label="New session"
      onClick={() => navigate(projectSessionRoute(projectId))}
    />
  )
}

/**
 * One row's hover cluster.
 *
 * Outside the link rather than inside it: a button nested in an anchor is
 * invalid, and clicking pin would navigate before the click could be stopped.
 * Revealed by hover *or* focus-within, so the actions are reachable from the
 * keyboard on a row that is never hovered.
 */
function RowActions({
  entry,
  selected,
  onPin,
  onArchive,
  onDelete,
}: {
  entry: SidebarSessionEntry
  selected: boolean
  onPin: (sessionId: string, pinned: boolean) => void
  onArchive: (sessionId: string, archived: boolean) => void
  onDelete: (sessionId: string) => void
}) {
  // Two clicks, not a dialog. Deletion is irreversible and a modal for it in a
  // hover cluster would be heavier than the action; arming the button in place
  // keeps the pointer where it already is and still refuses the stray click.
  const [armed, setArmed] = useState(false)
  const iconClass =
    'flex size-5 items-center justify-center rounded-md text-ink-3 hover:bg-surface-2 hover:text-ink'
  return (
    <span
      className={cn(
        'absolute inset-y-0 end-1 flex items-center gap-0.5',
        'pointer-events-none opacity-0 transition-opacity',
        'group-hover/item:pointer-events-auto group-hover/item:opacity-100',
        'group-focus-within/item:pointer-events-auto group-focus-within/item:opacity-100',
      )}
    >
      <button
        type="button"
        className={iconClass}
        aria-label={entry.pinned ? 'Unpin session' : 'Pin session'}
        title={entry.pinned ? 'Unpin session' : 'Pin session'}
        onClick={() => onPin(entry.row.id, !entry.pinned)}
      >
        {entry.pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
      </button>
      <button
        type="button"
        className={iconClass}
        aria-label={entry.archived ? 'Unarchive session' : 'Archive session'}
        title={entry.archived ? 'Unarchive session' : 'Archive session'}
        onClick={() => onArchive(entry.row.id, !entry.archived)}
      >
        {entry.archived ? (
          <ArchiveRestore className="size-3.5" />
        ) : (
          <Archive className="size-3.5" />
        )}
      </button>
      <button
        type="button"
        className={cn(iconClass, armed && 'bg-danger-soft text-danger hover:bg-danger-soft')}
        aria-label={armed ? 'Confirm delete session' : 'Delete session'}
        title={
          armed
            ? 'Click again to delete. The project directory and its files are kept.'
            : 'Delete session'
        }
        onBlur={() => setArmed(false)}
        onClick={() => {
          if (!armed) {
            setArmed(true)
            return
          }
          setArmed(false)
          onDelete(entry.row.id)
        }}
      >
        <Trash2 className="size-3.5" />
      </button>
      {armed && selected ? <span className="sr-only">This session is open.</span> : null}
    </span>
  )
}

function SessionRow({
  projectId,
  entry,
  selected,
  view,
  onDelete,
}: {
  projectId: string
  entry: SidebarSessionEntry
  selected: boolean
  view: SessionOrganisationView
  onDelete: (sessionId: string) => void
}) {
  const { row } = entry
  const signals = rowSignals({ status: row.status, unread: entry.unread, selected })
  const stateLabel = rowStateLabel(signals, row.status)
  const title = row.title || 'Untitled session'
  // A fork's row is indented under its source and titled with its lineage, so
  // "where did this come from" reads without opening it. `branched_at_seq` is
  // the message it was forked at; a fork with no anchor recorded still reads as
  // a fork.
  const forkTitle =
    entry.depth > 0
      ? row.branched_at_seq != null
        ? `Forked at message ${row.branched_at_seq} — shares the workspace with its source`
        : 'Forked — shares the workspace with its source'
      : undefined

  return (
    <li className="group/item relative">
      <SidebarLinkRow
        to={projectSessionRoute(projectId, row.id)}
        depth={entry.depth}
        glyph={signals.activity ? <SessionDotMatrix label={stateLabel} /> : undefined}
        label={title}
        // Reading is opening: clearing here rather than on arrival means a
        // session whose route ends up not-found is still marked read.
        onClick={() => view.visit(row.id)}
        aria-label={signals.outcome || signals.activity ? `${title}, ${stateLabel}` : title}
        title={forkTitle}
        className={cn(
          'pe-7 group-hover/item:pe-16',
          entry.unread && !selected && 'text-ink',
        )}
        trailing={
          <SessionStateSlot
            outcome={signals.outcome}
            label={stateLabel}
            // The glyph is already announcing this row; two accessible names
            // on one row is worse than one.
            silent={signals.activity}
          />
        }
      />
      <RowActions
        entry={entry}
        selected={selected}
        onPin={view.setPinned}
        onArchive={view.setArchived}
        onDelete={onDelete}
      />
    </li>
  )
}

function SessionList({
  projectId,
  entries,
  selectedSessionId,
  view,
  onDelete,
}: {
  projectId: string
  entries: SidebarSessionEntry[]
  selectedSessionId: string | null
  view: SessionOrganisationView
  onDelete: (sessionId: string) => void
}) {
  return (
    <SidebarRowList>
      {entries.map((entry) => (
        <SessionRow
          key={entry.row.id}
          projectId={projectId}
          entry={entry}
          selected={entry.row.id === selectedSessionId}
          view={view}
          onDelete={onDelete}
        />
      ))}
    </SidebarRowList>
  )
}

/**
 * The archived section, collapsed by default and **not persisted**.
 *
 * Local state on purpose: "show me what I filed away" is a thing a user wants
 * for a minute, and a sidebar that reopens tomorrow with a long archive
 * expanded has made a decision on their behalf.
 */
function ArchivedSection({
  projectId,
  section,
  selectedSessionId,
  view,
  onDelete,
}: {
  projectId: string
  section: SessionSection
  selectedSessionId: string | null
  view: SessionOrganisationView
  onDelete: (sessionId: string) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <SidebarButtonRow
        label={section.title}
        expanded={open}
        onClick={() => setOpen((current) => !current)}
        glyph={
          <ChevronRight
            className={cn('size-3.5 transition-transform', open && 'rotate-90')}
            aria-hidden="true"
          />
        }
        trailing={
          <span className="min-w-4 rounded-full bg-surface-2 px-1.5 py-px text-center text-[11px] tabular-nums text-ink-3">
            {section.entries.length}
          </span>
        }
        className="text-[11px] font-semibold tracking-wide text-ink-3 uppercase"
      />
      {open ? (
        <SessionList
          projectId={projectId}
          entries={section.entries}
          selectedSessionId={selectedSessionId}
          view={view}
          onDelete={onDelete}
        />
      ) : null}
    </>
  )
}

function SessionsBody({
  projectId,
  view,
  selectedSessionId,
  onDelete,
}: {
  projectId: string
  view: SessionOrganisationView
  selectedSessionId: string | null
  onDelete: (sessionId: string) => void
}) {
  if (view.status === 'loading') {
    return (
      <div className="mt-1 flex flex-col gap-1 px-1" aria-hidden="true">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="h-7 animate-pulse rounded-md bg-surface-2" />
        ))}
      </div>
    )
  }
  if (view.error) {
    return (
      <p className="px-3 py-1 text-xs text-danger" title={view.error.message}>
        Sessions unavailable
      </p>
    )
  }
  if (view.total === 0) {
    return <p className="px-3 py-1 text-xs text-ink-3">No sessions yet.</p>
  }

  const active = view.sections.find((section) => section.id === 'sessions')
  const archived = view.sections.find((section) => section.id === 'archived')

  return (
    <>
      {active && active.entries.length > 0 ? (
        <SessionList
          projectId={projectId}
          entries={active.entries}
          selectedSessionId={selectedSessionId}
          view={view}
onDelete={onDelete}
        />
      ) : null}
      {archived ? (
        <ArchivedSection
          projectId={projectId}
          section={archived}
          selectedSessionId={selectedSessionId}
          view={view}
          onDelete={onDelete}
        />
      ) : null}
    </>
  )
}

/**
 * Pinned above, sessions below, archived folded away at the bottom.
 *
 * The pinned section is only rendered when something is in it: a heading for
 * an empty set is a label for a feature, not for content.
 *
 * The main list carries **no "Sessions" heading**. The rail sits directly under
 * the "Projects" section and the open project's name, so what the list is is
 * already said; a second all-caps label above "New session" was a title for the
 * obvious. The rows still live inside a section wrapper so they keep the same
 * 8px edge every lane is measured from.
 */
export function SessionRail({
  projectId,
  selectedSessionId = null,
}: {
  projectId: string
  selectedSessionId?: string | null
}) {
  const navigate = useNavigate()
  const view = useSessionOrganisation(projectId, selectedSessionId)
  const pinned = view.sections.find((section) => section.id === 'pinned')

  /**
   * Delete, then land the user somewhere real.
   *
   * The navigation is here rather than in the read model because where focus
   * goes is a fact about the URL, and the URL is the shell's (D9). Deleting a
   * session that is not the one on screen changes no route at all.
   */
  const onDelete = (sessionId: string) => {
    void view.remove(sessionId).then((next) => {
      if (sessionId !== selectedSessionId) return
      navigate(projectSessionRoute(projectId, next ?? undefined), { replace: true })
    })
  }

  return (
    <>
      {pinned ? (
        <SidebarSection title={pinned.title} glyph={<Pin className="size-3.5" aria-hidden="true" />}>
          <SessionList
            projectId={projectId}
            entries={pinned.entries}
            selectedSessionId={selectedSessionId}
            view={view}
            onDelete={onDelete}
          />
        </SidebarSection>
      ) : null}
      <section className="py-2" style={sidebarSectionStyle()}>
        {/* At the top of the list, where it is found without reading the list
            first. It opens the blank surface; the composer there creates the
            session. */}
        <NewSessionButton projectId={projectId} />
        <div className="mt-0.5 flex flex-col gap-0.5">
          <SessionsBody
            projectId={projectId}
            view={view}
            selectedSessionId={selectedSessionId}
            onDelete={onDelete}
          />
        </div>
      </section>
    </>
  )
}
