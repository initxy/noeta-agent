/**
 * Agent-generated HTML, rendered where it cannot reach this application.
 *
 * The reference frames it with `sandbox="allow-scripts allow-same-origin"`.
 * Those two together are, in a browser, **no sandbox at all** for a same-origin
 * document: the frame gets script execution *and* our origin, which means our
 * storage, our cookies and our DOM. Electron contained the damage; a browser
 * does not. This product must never ship that pair, and the rule is enforced
 * here rather than remembered at each call site: this component is the only
 * place an artifact `<iframe>` is constructed.
 *
 * The isolation is an **opaque origin**: the file is loaded from our own file
 * surface and framed *without* `allow-same-origin`, so the document gets a
 * unique origin of its own. It can still run scripts inside its own frame; it
 * can reach nothing of ours. That is `LEDGER §6.2`'s own answer for generic
 * model-written HTML, and it is used for every project, both tiers — the
 * sandbox preview channel is a reverse proxy onto the container and serves no
 * workspace file, so it is not an option here even when one exists.
 *
 * The channel's *own* panels (noVNC, the terminal, code-server) do grant
 * `allow-same-origin`, because they need it and the channel's origin is blank
 * by construction. Two mechanisms, two cases, on purpose.
 *
 * SVG never comes through here at all: it classifies as an image and is
 * rendered through `<img src>`, because an inlined SVG executes in *our*
 * document.
 */

import { ShieldCheck } from 'lucide-react'

export function HtmlFrame({ url, title }: { url: string; title: string }) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <p className="flex shrink-0 items-center gap-1.5 border-b border-border px-3 py-1.5 text-[11px] text-ink-3">
        <ShieldCheck className="size-3 shrink-0" aria-hidden="true" />
        Isolated frame. Scripts run here but cannot reach this app.
      </p>
      <iframe
        title={title}
        src={url}
        // Never `allow-same-origin`. See the module comment; this is the whole
        // point of the component.
        sandbox="allow-scripts allow-forms allow-popups"
        referrerPolicy="no-referrer"
        className="min-h-0 flex-1 border-0 bg-white"
      />
    </div>
  )
}
