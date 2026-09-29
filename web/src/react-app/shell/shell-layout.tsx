/**
 * The workbench frame every in-app route renders inside: sidebar rail on the
 * left, routed pane on the right.
 *
 * A layout route rather than a wrapper each page composes, so the sidebar is
 * mounted *above* the routes and survives navigation, a not-found card and a
 * redirect alike.
 */

import { Outlet } from 'react-router-dom'
import { AppFrame, MainPane } from '@/react-app/design-system'
import { CommandPalette } from './command-palette'
import { Sidebar } from './sidebar'

export function ShellLayout() {
  return (
    <AppFrame>
      <Sidebar />
      <MainPane>
        <Outlet />
      </MainPane>
      <CommandPalette />
    </AppFrame>
  )
}
