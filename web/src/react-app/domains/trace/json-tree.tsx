/**
 * A collapsible view of one payload.
 *
 * Recursive by node rather than by a single pretty-printed blob, so every
 * container carries its own open state and the reader decides what to look
 * into. The size policy lives in `json-value.ts`; this file is the rendering.
 *
 * `ContentRef`s are recognised here rather than at the payload's top level
 * because they appear at arbitrary depth — `output_ref`, `arguments_ref`,
 * `questions_ref`, an image block's `source`. A ref renders as a chip that
 * fetches nothing until it is clicked.
 */

import { useState } from 'react'
import { ContentRefChip } from './content-ref-chip'
import { asContentRef } from './raw-envelope'
import { entriesOf, formatScalar, isCollapsible, shouldAutoExpand, summarize } from './json-value'

export function JsonTree({ value }: { value: unknown }) {
  return (
    <div className="font-mono text-xs leading-relaxed break-words text-ink">
      <JsonNode value={value} depth={0} />
    </div>
  )
}

function JsonNode({ name, value, depth }: { name?: string; value: unknown; depth: number }) {
  const contentRef = asContentRef(value)
  if (contentRef) {
    return (
      <div className="flex flex-wrap items-baseline gap-1.5">
        {name === undefined ? null : <NodeName name={name} />}
        <ContentRefChip contentRef={contentRef} />
      </div>
    )
  }

  if (!isCollapsible(value)) {
    return (
      <div className="flex flex-wrap items-baseline gap-1.5">
        {name === undefined ? null : <NodeName name={name} />}
        <Scalar value={value} />
      </div>
    )
  }

  return <CollapsibleNode name={name} value={value} depth={depth} />
}

function CollapsibleNode({ name, value, depth }: { name?: string; value: unknown; depth: number }) {
  // The initial state is computed once, from the value's size. Recomputing it
  // on every render would slam a node shut again the moment anything above it
  // re-rendered, which on a live-polling page is constantly.
  const [open, setOpen] = useState(() => shouldAutoExpand(value, depth))
  const entries = entriesOf(value)

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="flex w-full items-baseline gap-1.5 text-left hover:bg-surface-2"
      >
        <span aria-hidden className="w-3 shrink-0 text-ink-3">
          {open ? '▾' : '▸'}
        </span>
        {name === undefined ? null : <NodeName name={name} />}
        <span className="truncate text-ink-3">{open ? openBracket(value) : summarize(value)}</span>
      </button>

      {open ? (
        <div className="ml-1.5 border-l border-border pl-2.5">
          {typeof value === 'string' ? (
            <span className="whitespace-pre-wrap text-accent">{value}</span>
          ) : (
            entries.map(([key, child]) => (
              <JsonNode key={key} name={key} value={child} depth={depth + 1} />
            ))
          )}
        </div>
      ) : null}
    </div>
  )
}

function openBracket(value: unknown): string {
  if (typeof value === 'string') return 'text'
  return Array.isArray(value) ? '[' : '{'
}

function NodeName({ name }: { name: string }) {
  return <span className="shrink-0 text-ink-2">{name}:</span>
}

function Scalar({ value }: { value: unknown }) {
  const text = formatScalar(value)
  if (value === null || value === undefined) {
    return <span className="text-ink-3">{text}</span>
  }
  if (typeof value === 'string') {
    return <span className="whitespace-pre-wrap text-accent">{text}</span>
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return <span className="text-warn">{text}</span>
  }
  // Whatever this is, it still prints. An envelope the page cannot classify is
  // the one it exists to show.
  return <span className="text-ink-2">{text}</span>
}
