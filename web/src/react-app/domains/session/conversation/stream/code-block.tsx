/**
 * A fenced code block in the transcript.
 *
 * The whole point of this component is the gate: **while the turn is streaming
 * the block renders as plain text**, and the highlighter runs only once the
 * turn parks. Shiki's pass is async and per-block; running it on every
 * animation frame of a streaming answer re-tokenizes a growing string dozens of
 * times a second, and the result is a transcript that stutters exactly when the
 * user is reading it. The code is also still changing, so the work is thrown
 * away as fast as it lands.
 *
 * The highlighted markup is injected rather than rendered as elements because
 * that is what shiki produces. It is safe for two reasons worth stating: shiki
 * escapes the source text it was given, and the source text is model output the
 * transcript already renders verbatim elsewhere. It also keeps the highlighted
 * subtree outside React's reconciler, which is where `find` would otherwise be
 * rewriting nodes React owns — but `pre`/`code` is excluded from find anyway.
 *
 * The block is `overflow-x: auto` and marked `data-scrollable` so the scroll
 * controller does not read a wheel gesture inside it as the reader leaving the
 * bottom of the transcript.
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { cn } from '@/react-app/design-system'
import { highlightCode } from '@/react-app/infra/highlighter'
import { useStreamingActive } from './streaming-context'

/** Above this, highlighting costs more than it is worth. */
const MAX_HIGHLIGHT_CHARS = 40_000

/** How long the button shows a check after a copy before returning to the icon. */
const COPIED_RESET_MS = 2_000

function prefersDark(): boolean {
  return typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
}

export const CodeBlock = memo(function CodeBlock({
  code,
  lang = '',
  className,
}: {
  code: string
  /** The fence's info string. Anything shiki does not carry renders plain. */
  lang?: string
  className?: string
}) {
  const streaming = useStreamingActive()
  const [html, setHtml] = useState<string | null>(null)
  const normalized = lang.trim().toLowerCase()

  useEffect(() => {
    // The gate. Note it also *drops* whatever was highlighted before: a block
    // that starts streaming again (a retry re-running the same turn) must not
    // show stale colours over new text.
    if (streaming || normalized === '' || code.length > MAX_HIGHLIGHT_CHARS) {
      setHtml(null)
      return
    }
    let live = true
    void highlightCode({ code, lang: normalized, dark: prefersDark() }).then((result) => {
      if (live) setHtml(result)
    })
    return () => {
      live = false
    }
  }, [code, normalized, streaming])

  const shell = cn(
    'max-h-96 overflow-auto rounded-md border border-border bg-surface-2',
    'px-3 py-2.5 font-mono text-[13px] leading-relaxed',
    className,
  )

  // The copy button lives in a positioned wrapper *beside* the block, not
  // inside it: the highlighted branch renders through `dangerouslySetInnerHTML`,
  // which owns its subtree, so a child button there would be overwritten. The
  // block keeps its `data-*` contract untouched — the scroll machine and the
  // tests both key off the inner element.
  return (
    <div className="group relative my-1.5">
      <CopyButton code={code} />
      {html !== null ? (
        <div
          className={cn(shell, '[&_pre]:!bg-transparent [&_pre]:m-0')}
          data-scrollable="true"
          data-testid="code-block"
          data-highlighted="true"
          // See the module docstring: shiki escapes its input, and the subtree is
          // deliberately outside the reconciler.
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre
          className={cn(shell, 'whitespace-pre text-ink-2')}
          data-scrollable="true"
          data-testid="code-block"
          data-highlighted="false"
        >
          <code>{code}</code>
        </pre>
      )}
    </div>
  )
})

/**
 * Copy the block's source to the clipboard.
 *
 * Copies `code` — the raw model output the block was handed — not the rendered
 * DOM, so a highlighted block and a plain one copy the same bytes. Hidden until
 * the block is hovered, and shows a check for a beat after a copy so the click
 * has visible confirmation.
 */
function CopyButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<number | null>(null)

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current)
    },
    [],
  )

  const copy = useCallback(() => {
    void navigator.clipboard?.writeText(code).then(() => {
      setCopied(true)
      if (timer.current !== null) window.clearTimeout(timer.current)
      timer.current = window.setTimeout(() => setCopied(false), COPIED_RESET_MS)
    })
  }, [code])

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={copied ? 'Copied' : 'Copy code'}
      title={copied ? 'Copied' : 'Copy code'}
      className={cn(
        'absolute top-1.5 right-1.5 z-10 rounded-md border border-border bg-surface p-1',
        'text-ink-3 opacity-0 transition-opacity outline-none',
        'group-hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-accent',
        'hover:text-ink',
      )}
    >
      {copied ? (
        <Check className="size-3.5 text-accent" aria-hidden="true" />
      ) : (
        <Copy className="size-3.5" aria-hidden="true" />
      )}
    </button>
  )
}
