/**
 * The `/project/:projectId/settings/:tab` route.
 *
 * This is where the shell earns its "may import anything" privilege: the tab
 * chrome belongs to the settings domain and every panel inside it belongs to
 * the project domain, and pairing them here is what keeps either from
 * importing the other.
 *
 * Every tab is filled. `SettingsPage` renders its own placeholder when it is
 * handed nothing, so a tab with no panel would be a URL that renders an
 * apology — the mapping below is exhaustive over `SettingsTab` by
 * construction, and TypeScript checks it.
 */

import type { ReactNode } from 'react'
import { Navigate, useParams } from 'react-router-dom'
import { projectSettingsRoute } from '@/app/routes'
import { ConnectorList } from '@/react-app/domains/project/connector-list'
import {
  ProjectAdvancedSettings,
  ProjectAgentSettings,
  ProjectGeneralSettings,
  ProjectMemorySettings,
} from '@/react-app/domains/project/project-settings'
import { SettingsPage } from '@/react-app/domains/settings/settings-page'
import { parseSettingsTab } from '@/react-app/domains/settings/settings-route'
import type { SettingsTab } from '@/react-app/domains/settings/settings-route'

const PANELS: Record<SettingsTab, (props: { projectId: string }) => ReactNode> = {
  general: ProjectGeneralSettings,
  agent: ProjectAgentSettings,
  connections: ConnectorList,
  memory: ProjectMemorySettings,
  advanced: ProjectAdvancedSettings,
}

export function SettingsRoute() {
  const { projectId = '', tab } = useParams()
  const parsed = parseSettingsTab(tab)

  // An unrecognised tab is rewritten before anything renders, so the bad URL
  // never enters history.
  if (parsed.redirect) {
    return <Navigate to={projectSettingsRoute(projectId, parsed.tab)} replace />
  }

  const Panel = PANELS[parsed.tab]
  return (
    <SettingsPage projectId={projectId} tab={parsed.tab}>
      <Panel projectId={projectId} />
    </SettingsPage>
  )
}
