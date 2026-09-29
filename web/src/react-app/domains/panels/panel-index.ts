/**
 * The panels domain's entry point.
 *
 * **Mount contract.** `PanelDock` takes the transcript as a prop rather than
 * reading it, because the conversation lives in a sibling domain and the
 * layering forbids reaching across. The shell composes them:
 *
 * ```tsx
 * const conversation = useConversation(sessionId)
 * <PanelDock
 *   sessionId={sessionId}
 *   items={conversation.items}
 *   workspaceRoot={project.directory}
 *   onClose={() => panelActions().setOpen(sessionId, false)}
 * />
 * ```
 *
 * `workspaceRoot` is the project's `directory`. Without it a `local` project
 * derives almost nothing, because its tools print absolute host paths that no
 * workspace-relative endpoint can resolve.
 *
 * Everything else here is for the surfaces outside the panel that need the same
 * facts: the in-conversation file chips and the command palette both want the
 * resolved target list, and both must apply the same collectibility test rather
 * than inventing a second one.
 */

export { PanelDock } from './panel-dock'
export type { PanelDockProps } from './panel-dock'

export {
  panelActions,
  usePanelOpen,
  usePanelTargets,
  usePanelTabStore,
} from './state/panel-tab-store'

export { usePanelWidth, PANEL_DEFAULT_PX, PANEL_MIN_PX } from './state/use-panel-width'

export { panelKeys, usePreviewChannel, useResolvedArtifacts } from './queries/artifact-queries'
