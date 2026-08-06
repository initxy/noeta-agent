/**
 * The rows a turn is read for: what the user said, and what the agent said
 * back — plus the two muted forms of "said" (reasoning and auto-recall).
 *
 * Every row is memoized on its item. The fold reuses item references for
 * everything it did not touch, so appending a frame re-renders exactly the row
 * that changed; without `memo` a streaming turn re-renders the whole
 * transcript on every animation frame.
 *
 * **The user's words are never reinterpreted.** A user bubble is
 * `whitespace-pre-wrap` — it keeps their line breaks and never runs their text
 * through markdown, which would eat their asterisks and re-flow their breaks.
 * The one concession is wrapping: `break-keep` stops CJK runs from snapping mid
 * word inside the narrow bubble (a phrase like "中文回复我" would otherwise split
 * between any two characters), and `overflow-wrap: anywhere` is the escape hatch
 * so an unbroken URL or token still can't overflow the bubble. The agent's
 * answer *is* markdown — that is what the model writes — so it goes through a
 * renderer, and its fenced code goes through the block that knows to stop
 * highlighting while the turn is streaming.
 */

import { memo } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Components } from 'react-markdown'
import { contentUrl } from '@/app/api'
import type { AssistantItem, RecallItem, UserItem } from '@/app/fold'
import type { ImageRef } from '@/app/types'
import { cn } from '@/react-app/design-system'
import { Disclosure } from './disclosure'
import { CodeBlock } from './stream/code-block'

export const UserRow = memo(function UserRow({ item }: { item: UserItem }) {
  return (
    <div className="flex justify-end" data-item-kind="user">
      <div
        className={cn(
          'max-w-[85%] rounded-2xl bg-surface-2 px-3.5 py-2 text-sm leading-relaxed whitespace-pre-wrap break-keep [overflow-wrap:anywhere] text-ink',
          // The optimistic echo is dimmed, not hidden: the message is real, the
          // server just has not confirmed it yet.
          item.pending && 'opacity-60',
        )}
      >
        {item.images.length > 0 ? <ImageStrip images={item.images} /> : null}
        {item.content}
      </div>
    </div>
  )
})

function ImageStrip({ images }: { images: readonly ImageRef[] }) {
  return (
    <div className="mb-1.5 flex flex-wrap gap-1.5">
      {images.map((image) => (
        // The hash *is* the cache key, so the browser fetches each blob once
        // across every session that references it.
        <img
          key={image.hash}
          src={contentUrl(image.hash)}
          alt=""
          className="size-16 rounded-lg border border-border object-cover"
          loading="lazy"
          decoding="async"
        />
      ))}
    </div>
  )
}

/**
 * Markdown overrides.
 *
 * Only two, and both are about where the content goes rather than how it
 * looks: a fenced block becomes the streaming-aware `CodeBlock`, and a link
 * opens away from the workbench (the transcript is not a browser, and an
 * agent-written link navigating the app away from a running turn loses it).
 *
 * `pre` is unwrapped because `CodeBlock` renders its own; leaving the default
 * in place nests a `<pre>` inside a `<pre>`.
 */
const MARKDOWN_COMPONENTS: Components = {
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children, ...rest }) => {
    const text = String(children ?? '')
    const fence = /language-(\w+)/.exec(className ?? '')
    // No language *and* no newline is an inline span; everything else is a
    // block. Reading the fence alone would render an unlabelled ``` fence as
    // one long inline run.
    if (fence === null && !text.includes('\n')) {
      return (
        <code className="rounded bg-surface-2 px-1 py-px font-mono text-[0.9em]" {...rest}>
          {children}
        </code>
      )
    }
    return <CodeBlock code={text.replace(/\n$/, '')} lang={fence?.[1] ?? ''} />
  },
  a: ({ children, ...rest }) => (
    <a {...rest} target="_blank" rel="noopener noreferrer" className="text-accent underline">
      {children}
    </a>
  ),
}

export const AssistantRow = memo(function AssistantRow({ item }: { item: AssistantItem }) {
  return (
    <div className="prose-panel text-sm leading-relaxed text-ink" data-item-kind="assistant">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
        {item.text}
      </ReactMarkdown>
    </div>
  )
})

/**
 * Auto-recall: something the memory subsystem put in front of the model.
 *
 * Rendered as a chip and never as a user bubble — it arrives on the wire as an
 * `origin="memory"` user message, and showing it as something the user typed
 * is a lie the transcript would tell on every turn.
 */
export const RecallRow = memo(function RecallRow({ item }: { item: RecallItem }) {
  return (
    <Disclosure
      summary={
        <span className="flex items-center gap-1.5 text-xs text-ink-3">
          <span className="rounded-full bg-surface-2 px-1.5 py-0.5 text-[10px] tracking-wide text-ink-3 uppercase">
            Recalled
          </span>
          <span className="min-w-0 flex-1 truncate">{item.text}</span>
        </span>
      }
    >
      <div className="text-xs leading-relaxed whitespace-pre-wrap text-ink-3">{item.text}</div>
    </Disclosure>
  )
})
