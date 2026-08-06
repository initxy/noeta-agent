/**
 * A long text body that clips to a preview and expands on click.
 *
 * The single biggest source of wall-of-text on the trace surface is a resolved
 * blob — a clipped tool output, a thinking block, a system prompt. Rendering it
 * whole would bury the two interesting lines, so anything past the clip is one
 * click away rather than always open.
 */
import { useState } from 'react'
import { fmtSize } from './model'

/** Characters shown before the "expand" affordance appears. */
const CLIP_CHARS = 16 * 1024

export function ClampText({ text }: { text: string }) {
  const [full, setFull] = useState(false)
  const clipped = !full && text.length > CLIP_CHARS
  return (
    <div className="min-w-0">
      <pre className="whitespace-pre-wrap break-words font-mono text-[11.5px] leading-relaxed text-ink-2">
        {clipped ? text.slice(0, CLIP_CHARS) : text}
      </pre>
      {clipped ? (
        <button
          type="button"
          onClick={() => setFull(true)}
          className="mt-1 font-mono text-[10.5px] text-accent hover:underline"
        >
          Show all ({fmtSize(text.length)})
        </button>
      ) : null}
    </div>
  )
}
