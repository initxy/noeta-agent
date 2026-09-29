/**
 * The `/project/:projectId/session/:sessionId?` route.
 *
 * The route renders one session pane bound directly to the URL: which
 * conversation you are reading is a fact about the address bar (D9), and there
 * is nothing beside it to remember — no retained tabs, no split. Switching
 * sessions is the sidebar's job, and it navigates.
 *
 * Resolution — unknown session, sessionless project — belongs to the pane, so
 * a pasted link answers "this session is gone" the same way a click would. An
 * unknown session renders a card and does **not** navigate: the URL the user
 * opened stays in the address bar, which is what makes a pasted session link
 * worth trusting. That is the deliberate asymmetry with `project-route.tsx`,
 * which does redirect — a project id is a container the user did not choose
 * from this URL, a session id is one they did.
 */

import { useParams } from 'react-router-dom'
import { WorkbenchSessionPane } from './workbench/session-pane'

export function SessionRoute() {
  const { projectId = '', sessionId } = useParams()
  return <WorkbenchSessionPane projectId={projectId} sessionId={sessionId ?? null} />
}
