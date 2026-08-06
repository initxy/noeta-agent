/**
 * One file's read-only preview: the renderer chain, shared by both surfaces
 * that show a file.
 *
 * The chain is ordered and the order is behaviour: a `.csv` is a sheet before
 * it is text. HTML is source here — read, highlighted, never rendered; the
 * container's own pages have the Preview tab for that. Each branch keys off the
 * *resolved* preview kind — the server saw the bytes, the client only saw the
 * extension.
 *
 * Two things this component deliberately does not do:
 *
 * - **It does not fetch.** `useArtifactText` is a hook, and a hook cannot be
 *   called from inside a branch. So the owning surface calls it and hands the
 *   result down as `text`; this component only chooses how to draw what it was
 *   given. That is also why `wantsText` arrives as a prop rather than being
 *   recomputed here — the caller needs it to decide whether to enable the
 *   query at all.
 * - **It does not edit or download.** The panel is a read surface; the source
 *   branch highlights, the binary branches stream through `src`, and there is
 *   no write path anywhere beneath it.
 */

import { memo, useEffect, useState } from 'react'
import type { UseQueryResult } from '@tanstack/react-query'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { CenteredNote, cn } from '@/react-app/design-system'
import { highlightCode } from '@/react-app/infra/highlighter'
import { useTheme } from '@/react-app/kernel/theme'
import { extensionOf } from '@/app/artifacts/classify'
import type { ArtifactTarget } from '@/app/types/artifacts'
import type { FileTextPayload } from '@/app/types/wire'
import { SpreadsheetView } from './spreadsheet-view'
import { isBinaryWorkbook, isDelimitedSheet } from './spreadsheet-model'

/**
 * Which previews are fetched as text at all. A workbook never is — it is binary
 * and goes nowhere near `useArtifactText`.
 */
export function isTextPreview(target: ArtifactTarget): boolean {
  if (isBinaryWorkbook(target.value)) return false
  return (
    target.preview === 'markdown' ||
    target.preview === 'text' ||
    target.preview === 'html' ||
    (target.preview === 'sheet' && isDelimitedSheet(target.value))
  )
}

export interface FilePreviewProps {
  target: ArtifactTarget
  /** The file's raw bytes URL, for the branches that stream through `src`. */
  rawUrl: string
  /** The text query, owned by the caller. Only meaningful when `wantsText`. */
  text: UseQueryResult<FileTextPayload, Error>
  wantsText: boolean
}

export function FilePreview({ target, rawUrl, text, wantsText }: FilePreviewProps) {
  if (wantsText) {
    if (text.isLoading) return <CenteredNote>Loading…</CenteredNote>
    if (text.isError) return <CenteredNote>{text.error.message}</CenteredNote>
    if (!text.data) return <CenteredNote>Nothing to show.</CenteredNote>

    if (target.preview === 'sheet') {
      return <SpreadsheetView path={target.value} text={text.data.content} />
    }
    if (target.preview === 'markdown') {
      return (
        <div className="h-full overflow-auto px-6 py-5">
          <div className="prose-panel mx-auto max-w-[46rem] text-sm leading-relaxed text-ink">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{text.data.content}</ReactMarkdown>
          </div>
          {text.data.truncated ? (
            <p className="mx-auto mt-4 max-w-[46rem] text-xs text-ink-3">
              Truncated — showing the beginning of the file.
            </p>
          ) : null}
        </div>
      )
    }
    // Everything else — source, markdown-that-wasn't, and HTML — reads as
    // highlighted text. HTML is deliberately source here, not a rendered page:
    // the container's own pages get the Preview tab, and an agent's `.html` is
    // something you read like any other file it wrote.
    return <SourceView value={target.value} file={text.data} />
  }

  if (target.preview === 'image') {
    // Through `<img src>` and never inlined: an SVG classifies as an image and
    // an inlined one executes inside this document.
    return (
      <div className="flex h-full items-center justify-center overflow-auto bg-surface-2 p-4">
        <img src={rawUrl} alt={target.name} className="max-h-full max-w-full object-contain" />
      </div>
    )
  }

  if (target.preview === 'pdf') {
    return <embed src={rawUrl} type="application/pdf" className="h-full w-full" />
  }

  return <CenteredNote>No preview available for this file type.</CenteredNote>
}

// ---------------------------------------------------------------------------
// Source text, syntax-highlighted
// ---------------------------------------------------------------------------

/** Above this, highlighting costs more than it is worth (same gate as the
 *  transcript's code blocks). The server also clips reads; this bounds the
 *  tokenizer regardless of where that cap sits. */
const MAX_HIGHLIGHT_CHARS = 40_000

/**
 * File extension → the language id shiki's web bundle carries.
 *
 * A miss here — or a language the web bundle does not ship (`toml`, `go`,
 * `rust`, …) — is not a problem: `highlightCode` returns `null` for an unknown
 * id and the source renders as plain text. So this map only needs the common
 * cases, not exhaustiveness.
 */
const SHIKI_LANG_BY_EXTENSION: Record<string, string> = {
  ts: 'typescript',
  tsx: 'tsx',
  cts: 'typescript',
  mts: 'typescript',
  js: 'javascript',
  jsx: 'jsx',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  pyi: 'python',
  json: 'json',
  json5: 'json5',
  jsonc: 'jsonc',
  yaml: 'yaml',
  yml: 'yaml',
  css: 'css',
  scss: 'scss',
  sass: 'sass',
  less: 'less',
  html: 'html',
  htm: 'html',
  xml: 'xml',
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'mdx',
  sh: 'bash',
  bash: 'bash',
  zsh: 'zsh',
  sql: 'sql',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  hxx: 'cpp',
  java: 'java',
  php: 'php',
  r: 'r',
  jl: 'julia',
  vue: 'vue',
  svelte: 'svelte',
  astro: 'astro',
  graphql: 'graphql',
  gql: 'graphql',
  coffee: 'coffee',
}

const SourceView = memo(function SourceView({
  value,
  file,
}: {
  value: string
  file: FileTextPayload
}) {
  const theme = useTheme()
  const [html, setHtml] = useState<string | null>(null)
  const lang = SHIKI_LANG_BY_EXTENSION[extensionOf(value)] ?? ''
  const code = file.content

  useEffect(() => {
    if (lang === '' || code.length > MAX_HIGHLIGHT_CHARS) {
      setHtml(null)
      return
    }
    let live = true
    void highlightCode({ code, lang, dark: theme === 'dark' }).then((result) => {
      if (live) setHtml(result)
    })
    return () => {
      live = false
    }
  }, [code, lang, theme])

  const truncated = file.truncated ? (
    <p className="shrink-0 border-b border-border bg-surface-2 px-3 py-1 text-xs text-warn">
      Truncated — showing the beginning of the file.
    </p>
  ) : null

  if (html !== null) {
    return (
      <div className="flex h-full min-h-0 flex-col bg-surface-2">
        {truncated}
        <div
          className="min-h-0 flex-1 overflow-auto px-4 py-3 text-xs [&_pre]:!bg-transparent [&_pre]:m-0"
          // shiki escapes its input; the source is bytes the server read and
          // the transcript renders verbatim elsewhere.
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface-2">
      {truncated}
      <pre
        className={cn(
          'min-h-0 flex-1 overflow-auto px-4 py-3 font-mono text-xs whitespace-pre text-ink-2',
        )}
      >
        <code>{code}</code>
      </pre>
    </div>
  )
})
