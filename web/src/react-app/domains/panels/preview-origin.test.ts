import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PreviewPayload } from '@/app/types/wire'
import { previewOrigin, previewPanelUrl } from './preview-origin'

/**
 * The one client file that has to agree with the preview gateway.
 *
 * What is pinned here is that it agrees by *joining* rather than by
 * reconstructing: every quirk in the three paths (`?path=…/websockify`, no
 * trailing slash on the terminal, one on code-server) is the server's, and a
 * client that rebuilt them would be a second place for them to be wrong.
 */

const PANELS: PreviewPayload['panels'] = {
  browser:
    '/sandbox-preview/tok/vnc/index.html?autoconnect=true&resize=scale&path=sandbox-preview/tok/websockify',
  terminal: '/sandbox-preview/tok/terminal',
  code: '/sandbox-preview/tok/code-server/',
}

const payload = (over: Partial<PreviewPayload> = {}): PreviewPayload => ({
  token: 'tok',
  port: 8899,
  panels: PANELS,
  ...over,
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('the preview channel origin', () => {
  it('is the app hostname on the channel port, never the app port', () => {
    expect(previewOrigin(payload())).toBe('http://localhost:8899')
  })

  it('is null when the origin could not bind, so the panels hide themselves', () => {
    // A busy port must cost the panels and never the conversation.
    expect(previewOrigin(payload({ port: null }))).toBeNull()
    expect(previewPanelUrl(payload({ port: null }), 'browser')).toBeNull()
  })
})

describe('panel URLs', () => {
  it('joins the origin to the path the server decided, byte for byte', () => {
    expect(previewPanelUrl(payload(), 'browser')).toBe(`http://localhost:8899${PANELS.browser}`)
    // No trailing slash: the page resolves its PTY WebSocket relative to this
    // URL, and one more segment sends it somewhere the container does not serve.
    expect(previewPanelUrl(payload(), 'terminal')).toBe('http://localhost:8899/sandbox-preview/tok/terminal')
    // With one, or code-server's asset URLs resolve one segment too high.
    expect(previewPanelUrl(payload(), 'code')).toBe(
      'http://localhost:8899/sandbox-preview/tok/code-server/',
    )
  })

  it('carries the explicit websockify path noVNC would otherwise get wrong', () => {
    expect(previewPanelUrl(payload(), 'browser')).toContain(
      'path=sandbox-preview/tok/websockify',
    )
  })

  it('is null for a panel the server did not offer', () => {
    expect(previewPanelUrl(payload({ panels: {} }), 'terminal')).toBeNull()
  })
})
