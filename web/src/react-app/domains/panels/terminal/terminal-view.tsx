/**
 * The terminal tab: the container's own terminal page, framed.
 *
 * **Not an xterm client of ours, deliberately.** The preview channel is a
 * reverse proxy and serves nothing of its own: `panels.terminal` is a page
 * inside the container, and that page opens its own PTY WebSocket *relative to
 * its URL* — which is why the path must carry no trailing slash (`LEDGER
 * §6.1`) and why the gateway implements a WebSocket proxy at all. A hand-rolled
 * client here would have to invent a frame protocol the container does not
 * speak, so reconnect, scrollback and heartbeat belong to the page, on the
 * socket it owns, rather than to a bridge sitting beside it.
 *
 * `allow-same-origin` is granted for the same reason as the browser panel: the
 * channel is a blank second origin whose whole content is `/sandbox-preview/*`.
 */

import { useState } from 'react'
import { Button, CenteredNote } from '@/react-app/design-system'
import type { PreviewPayload } from '@/app/types/wire'
import { previewPanelUrl } from '../preview-origin'

export function TerminalView({ preview }: { preview: PreviewPayload | null }) {
  const [nonce, setNonce] = useState(0)

  const url = preview === null ? null : previewPanelUrl(preview, 'terminal')
  if (url === null) {
    return (
      <CenteredNote>
        This session has no sandbox container, so there is no terminal to attach to.
      </CenteredNote>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="truncate font-mono text-xs text-ink-3">{url}</span>
        {/* Remounting the frame is the reconnect: the page re-dials its own
            PTY, which is the only thing that knows how. */}
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto shrink-0"
          onClick={() => setNonce((n) => n + 1)}
        >
          Reconnect
        </Button>
      </div>
      <iframe
        key={nonce}
        title="Sandbox terminal"
        src={url}
        sandbox="allow-scripts allow-forms allow-same-origin"
        className="min-h-0 flex-1 border-0"
      />
    </div>
  )
}
