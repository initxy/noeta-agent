/**
 * The browser preview tab: the container's desktop, over noVNC.
 *
 * Nothing native and no tab model of its own. The desktop reference painted an
 * Electron `WebContentsView` over the window and needed a `requestAnimationFrame`
 * bounds loop, a `ResizeObserver`, a zoom-factor contract and an occluder check
 * to keep it aligned. A local web app has none of that to align: the preview
 * channel serves from its own origin, so an ordinary `<iframe>` frames it
 * without an `X-Frame-Options` fight and the whole bounds choreography is
 * deleted rather than ported.
 *
 * **`allow-same-origin` is granted here, and that is the point of the second
 * origin.** noVNC keeps settings in `localStorage` and code-server registers a
 * service worker, so these panels genuinely need same-origin access — to the
 * *channel's* origin, which serves nothing but `/sandbox-preview/*`: no API, no
 * SPA, no cookies of ours. Serving them from the main port instead would hand a
 * compromised container's JS this application's origin, which is exactly the
 * reversal `LEDGER §6.2` records and tells us not to undo.
 *
 * Agent-written HTML is a different case with a different answer — an opaque
 * origin, in `renderers/html-frame.tsx`. The two mechanisms coexist on purpose.
 *
 * What is lost with the native view is real and worth stating: no favicon, no
 * history, no back/forward. Those came from Electron, not from the page.
 */

import { useState } from 'react'
import { Button, CenteredNote } from '@/react-app/design-system'
import type { PreviewPayload } from '@/app/types/wire'
import { previewPanelUrl } from './preview-origin'

export function BrowserView({ preview }: { preview: PreviewPayload | null }) {
  const [nonce, setNonce] = useState(0)

  const url = preview === null ? null : previewPanelUrl(preview, 'browser')
  if (url === null) {
    return (
      <CenteredNote>
        This session has no sandbox container, so there is nothing to preview.
      </CenteredNote>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="truncate font-mono text-xs text-ink-3">{url}</span>
        <div className="ml-auto flex shrink-0 gap-1.5">
          <Button size="sm" variant="ghost" onClick={() => setNonce((n) => n + 1)}>
            Reload
          </Button>
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-7 items-center rounded-md px-2.5 text-xs font-medium text-ink-2 hover:bg-surface-2 hover:text-ink"
          >
            Open
          </a>
        </div>
      </div>
      <iframe
        key={nonce}
        title="Sandbox preview"
        src={url}
        sandbox="allow-scripts allow-forms allow-popups allow-same-origin"
        className="min-h-0 flex-1 border-0 bg-white"
      />
    </div>
  )
}
