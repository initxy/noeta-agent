/**
 * The sandbox preview channel: a second origin, and the three paths it serves.
 *
 * `GET /sessions/{id}/preview` returns `{token, port, panels}`. **`panels` is
 * the server's answer, not a shape to reconstruct here** — each of the three
 * paths carries a quirk that was paid for once already against the live
 * container image (`LEDGER §6.1`):
 *
 * ```
 * browser : …/vnc/index.html?autoconnect=true&resize=scale&path=sandbox-preview/<token>/websockify
 * terminal: …/terminal        <- NO trailing slash
 * code    : …/code-server/    <- WITH one
 * ```
 *
 * noVNC's default websockify path is absolute and would escape the token
 * prefix; the terminal page resolves its PTY WebSocket *relative to its URL*,
 * so a trailing slash sends it one segment too deep; code-server's asset URLs
 * resolve one segment too high without one. Rebuilding those strings on the
 * client is three chances to get one of them wrong, so this module only joins
 * the origin to what the server already decided.
 *
 * There is deliberately **no file URL here.** The channel is a reverse proxy
 * onto the container and serves nothing of its own, so a workspace file is not
 * reachable through it. Agent-written HTML is framed from our own file surface
 * on an *opaque* origin instead, which is `§6.2`'s own answer for that case.
 */

import type { PreviewPayload, PreviewPanel } from '@/app/types/wire'

/** The origin the preview channel serves from, or `null` when it could not bind. */
export function previewOrigin(preview: PreviewPayload): string | null {
  if (preview.port === null) return null
  const { protocol, hostname } = window.location
  return `${protocol}//${hostname}:${preview.port}`
}

/**
 * One panel's absolute URL, or `null` when the channel has no origin to serve
 * it from — a bind failure costs the panels and never the conversation.
 */
export function previewPanelUrl(preview: PreviewPayload, panel: PreviewPanel): string | null {
  const origin = previewOrigin(preview)
  const path = preview.panels?.[panel]
  if (origin === null || typeof path !== 'string' || path === '') return null
  return `${origin}${path}`
}
