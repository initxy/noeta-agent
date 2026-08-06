/**
 * A `ContentRef` inside a payload, and the button that resolves it.
 *
 * The chip renders from the reference alone — hash, media type, size — so a
 * list of envelopes costs zero content requests. One click resolves one blob.
 */

import { useEffect, useRef, useState } from 'react'
import { Button } from '@/react-app/design-system'
import { derefContent } from './content-deref'
import type { DerefedContent } from './content-deref'
import type { ContentRefInfo } from './raw-envelope'
import { formatBytes } from '@/app/format/bytes'

type Load =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'loaded'; content: DerefedContent }
  | { state: 'error'; message: string }

export function ContentRefChip({ contentRef }: { contentRef: ContentRefInfo }) {
  const [load, setLoad] = useState<Load>({ state: 'idle' })
  const abortRef = useRef<AbortController | null>(null)

  // One in-flight request per chip, cancelled when the row goes away — a trace
  // list is long enough that scrolling through it while blobs load would
  // otherwise leave a queue of requests nobody is waiting for.
  useEffect(() => () => abortRef.current?.abort(), [])

  const resolve = () => {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    setLoad({ state: 'loading' })
    derefContent(contentRef.hash, controller.signal).then(
      (content) => {
        if (!controller.signal.aborted) setLoad({ state: 'loaded', content })
      },
      (error: unknown) => {
        if (controller.signal.aborted) return
        setLoad({ state: 'error', message: error instanceof Error ? error.message : String(error) })
      },
    )
  }

  const size = formatBytes(contentRef.size)

  return (
    <div className="my-0.5 inline-flex max-w-full flex-col gap-1 align-top">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="rounded bg-accent-soft px-1.5 py-0.5 text-[11px] font-medium text-accent">
          {contentRef.tag}
        </span>
        <span className="truncate font-mono text-xs text-ink-2" title={contentRef.hash}>
          {contentRef.hash.slice(0, 12)}…
        </span>
        {contentRef.mediaType ? (
          <span className="text-[11px] text-ink-3">{contentRef.mediaType}</span>
        ) : null}
        {size ? <span className="text-[11px] text-ink-3">{size}</span> : null}
        {load.state === 'loaded' ? null : (
          <Button size="sm" variant="ghost" onClick={resolve} disabled={load.state === 'loading'}>
            {load.state === 'loading' ? 'Resolving…' : 'Resolve'}
          </Button>
        )}
      </div>

      {load.state === 'error' ? (
        <p className="text-xs text-danger">{load.message}</p>
      ) : null}

      {load.state === 'loaded' ? (
        <ContentBody content={load.content} />
      ) : null}
    </div>
  )
}

function ContentBody({ content }: { content: DerefedContent }) {
  if (content.text === null) {
    return (
      <img
        src={content.url}
        alt={`content ${content.hash.slice(0, 12)}`}
        className="max-h-64 max-w-full rounded border border-border"
      />
    )
  }
  return (
    <div className="max-w-full">
      <pre className="max-h-64 overflow-auto rounded border border-border bg-surface-2 p-2 text-xs whitespace-pre-wrap text-ink-2">
        {content.text}
      </pre>
      {content.truncated ? (
        <p className="mt-1 text-[11px] text-ink-3">
          Showing the first {content.text.length} characters of {content.byteLength} bytes.{' '}
          <a className="text-accent underline" href={content.url} target="_blank" rel="noreferrer">
            Open the whole body
          </a>
        </p>
      ) : null}
    </div>
  )
}
