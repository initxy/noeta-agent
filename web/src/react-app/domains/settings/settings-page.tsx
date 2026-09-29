/**
 * The per-project settings surface: the tab chrome plus a slot.
 *
 * The slot is what keeps the layering honest. Some tabs are owned by other
 * domains (`connections` is the MCP surface), and a domain may not import a
 * sibling — so this renders whatever the shell hands it and falls back to its
 * own placeholder for the tabs it owns.
 */

import type { ReactNode } from 'react'
import { NavLink } from 'react-router-dom'
import { projectSettingsRoute } from '@/app/routes'
import { CenteredNote, PaneBody, PaneHeader, cn } from '@/react-app/design-system'
import { SETTINGS_TABS, SETTINGS_TAB_LABELS } from './settings-route'
import type { SettingsTab } from './settings-route'

export function SettingsPage({
  projectId,
  tab,
  children,
}: {
  projectId: string
  tab: SettingsTab
  children?: ReactNode
}) {
  return (
    <>
      <PaneHeader className="gap-1">
        {SETTINGS_TABS.map((candidate) => (
          <NavLink
            key={candidate}
            to={projectSettingsRoute(projectId, candidate)}
            replace
            className={cn(
              'rounded-md px-2 py-1 text-sm hover:bg-surface-2',
              candidate === tab ? 'bg-surface-2 text-ink' : 'text-ink-2',
            )}
          >
            {SETTINGS_TAB_LABELS[candidate]}
          </NavLink>
        ))}
      </PaneHeader>
      <PaneBody>
        {children ?? (
          <CenteredNote>
            {SETTINGS_TAB_LABELS[tab]} settings land with the project model in Phase 1.
          </CenteredNote>
        )}
      </PaneBody>
    </>
  )
}
