/**
 * The route table.
 *
 * The canonical URLs (D9), and only these:
 *
 *   /                                          the landing surface
 *   /project/:projectId/session/:sessionId     a session in a project
 *   /project/:projectId/settings/:tab          per-project settings
 *   /trace/:sessionId                          the standalone trace page
 *
 * Two sessionless shapes exist beside them — `/project/:projectId` and
 * `/project/:projectId/session` — because "project open, nothing selected" is
 * a real state that needs a URL; the first redirects to the second.
 *
 * There is no catch-all redirect. An unrecognised path renders a card inside
 * the shell, so a mistyped or stale link says what happened instead of
 * silently landing somewhere else.
 */

import { Navigate, Route, Routes } from 'react-router-dom'
import { NotFoundCard } from '@/react-app/design-system'
import { HomePage } from '@/react-app/domains/project/home-page'
import { TracePage } from '@/react-app/domains/trace/trace-page'
import { DEFAULT_SETTINGS_TAB } from '@/react-app/domains/settings/settings-route'
import { ProjectRoute } from './project-route'
import { SessionRoute } from './session-route'
import { SettingsRoute } from './settings-route'
import { ShellLayout } from './shell-layout'

export function AppRoot() {
  return (
    <Routes>
      <Route element={<ShellLayout />}>
        <Route index element={<HomePage />} />
        <Route path="project/:projectId" element={<ProjectRoute />}>
          <Route index element={<Navigate to="session" replace />} />
          <Route path="session" element={<SessionRoute />} />
          <Route path="session/:sessionId" element={<SessionRoute />} />
          <Route path="settings" element={<Navigate to={DEFAULT_SETTINGS_TAB} replace />} />
          <Route path="settings/:tab" element={<SettingsRoute />} />
        </Route>
        <Route
          path="*"
          element={
            <NotFoundCard
              title="Page not found"
              message="That URL does not match anything in the workbench."
            />
          }
        />
      </Route>
      {/* Outside the shell on purpose: a debug surface, opened beside the
          conversation it explains rather than inside it. */}
      <Route path="trace/:sessionId" element={<TracePage />} />
    </Routes>
  )
}
