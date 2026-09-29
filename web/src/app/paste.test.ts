import { describe, expect, it } from 'vitest'
import {
  MAX_INLINE_PASTE_LINES,
  classifyPaste,
  countPastedLines,
  isStandaloneHttpUrl,
  measurePastedText,
  parseUriList,
  renderedHeightPx,
  shouldCollapsePaste,
} from './paste'

function transfer(options: {
  files?: File[]
  data?: Record<string, string>
  noGetData?: boolean
}): DataTransfer {
  const data = options.data ?? {}
  const shape: Record<string, unknown> = { files: options.files ?? [] }
  if (options.noGetData !== true) shape.getData = (format: string) => data[format] ?? ''
  return shape as unknown as DataTransfer
}

const measure = (lines: number, heightPx = 0, maxHeightPx = 200) => ({ lines, heightPx, maxHeightPx })

describe('the three paste branches', () => {
  it('routes files first, even when text rides along', () => {
    const intent = classifyPaste(
      transfer({
        files: [new File(['x'], 'shot.png', { type: 'image/png' })],
        data: { 'text/plain': 'shot.png', 'text/uri-list': 'file:///tmp/shot.png' },
      }),
    )
    expect(intent.kind).toBe('files')
    // Files carry both a filename and a uri-list on most platforms. Deciding
    // by text first would attach nothing and paste the filename instead.
    expect(intent.kind === 'files' && intent.files.map((file) => file.name)).toEqual(['shot.png'])
  })

  it('routes text/uri-list to links when there are no files', () => {
    const intent = classifyPaste(
      transfer({ data: { 'text/uri-list': 'https://example.com/a\nfile:///tmp/b', 'text/plain': 'https://example.com/a' } }),
    )
    expect(intent).toEqual({ kind: 'links', links: ['https://example.com/a', 'file:///tmp/b'] })
  })

  it('routes everything else to plain text', () => {
    expect(classifyPaste(transfer({ data: { 'text/plain': 'hello\nworld' } }))).toEqual({
      kind: 'text',
      text: 'hello\nworld',
    })
  })

  it('does not guess: text that merely looks like a path is still text', () => {
    // The bug this policy replaced hijacked any paste containing an absolute
    // path, so pasting a stack trace silently attached nothing and inserted
    // nothing.
    const intent = classifyPaste(transfer({ data: { 'text/plain': '  File "/Users/me/app.py", line 3' } }))
    expect(intent.kind).toBe('text')
  })

  it('falls back to empty text for a null or featureless DataTransfer', () => {
    expect(classifyPaste(null)).toEqual({ kind: 'text', text: '' })
    expect(classifyPaste(undefined)).toEqual({ kind: 'text', text: '' })
    // An exception inside a paste listener is invisible; the paste just stops
    // working.
    expect(classifyPaste(transfer({ noGetData: true }))).toEqual({ kind: 'text', text: '' })
  })
})

describe('parseUriList', () => {
  it('keeps file: and http(s): lines, in order, without duplicates', () => {
    expect(
      parseUriList('# comment\n\nhttps://a.test/1\nfile:///tmp/x\nhttps://a.test/1\nmailto:me@a.test'),
    ).toEqual(['https://a.test/1', 'file:///tmp/x'])
  })

  it('percent-encodes spaces without breaking the scheme separator', () => {
    expect(parseUriList('file:///tmp/my file.txt')).toEqual(['file:///tmp/my%20file.txt'])
  })

  it('is empty for blank input', () => {
    expect(parseUriList('')).toEqual([])
    expect(parseUriList('   \n\n')).toEqual([])
  })
})

describe('the standalone-URL exemption', () => {
  it('recognises a single whitespace-free http(s) URL, however long', () => {
    expect(isStandaloneHttpUrl(`https://example.com/${'a'.repeat(4000)}`)).toBe(true)
    expect(isStandaloneHttpUrl('  http://example.com/x  ')).toBe(true)
  })

  it('rejects anything with whitespace or another scheme', () => {
    expect(isStandaloneHttpUrl('see https://example.com')).toBe(false)
    expect(isStandaloneHttpUrl('https://a.test\nhttps://b.test')).toBe(false)
    expect(isStandaloneHttpUrl('file:///tmp/x')).toBe(false)
    expect(isStandaloneHttpUrl('')).toBe(false)
  })

  it('never collapses a standalone URL, whatever the measurement says', () => {
    // A pasted link should stay a link. Long URLs are exactly the ones that
    // trip an overflow threshold, and a chip hides the only part that matters.
    const url = `https://example.com/${'a'.repeat(4000)}`
    expect(shouldCollapsePaste(url, measure(1, 900))).toBe(false)
  })
})

describe('the collapse threshold is measured, not counted', () => {
  it('collapses on rendered height when layout answered', () => {
    expect(shouldCollapsePaste('one line, but it wraps a lot', measure(1, 480, 200))).toBe(true)
    expect(shouldCollapsePaste('one line, but it wraps a lot', measure(1, 120, 200))).toBe(false)
  })

  it('never uses a character count', () => {
    // 4000 characters on one short-rendering line stays inline; 11 short lines
    // do not. A character threshold would get both backwards.
    expect(shouldCollapsePaste('x'.repeat(4000), measure(1, 40, 200))).toBe(false)
    expect(shouldCollapsePaste('ab\n'.repeat(11), measure(12, 40, 200))).toBe(true)
  })

  it('falls back to the line count when height could not be measured', () => {
    // heightPx 0 means "no answer" — under jsdom, in a hidden panel, before
    // first paint. Treating 0 as "fits" would disable collapsing entirely.
    expect(shouldCollapsePaste('l\n'.repeat(MAX_INLINE_PASTE_LINES + 1), measure(MAX_INLINE_PASTE_LINES + 2, 0))).toBe(true)
    expect(shouldCollapsePaste('l\n'.repeat(2), measure(3, 0))).toBe(false)
  })

  it('never collapses a blank paste', () => {
    expect(shouldCollapsePaste('   ', measure(1, 900))).toBe(false)
  })
})

describe('countPastedLines', () => {
  it('counts as a person does, tolerating CRLF', () => {
    expect(countPastedLines('a')).toBe(1)
    expect(countPastedLines('a\nb')).toBe(2)
    expect(countPastedLines('a\r\nb\r\nc')).toBe(3)
    expect(countPastedLines('a\n')).toBe(2)
  })
})

describe('renderedHeightPx', () => {
  it('returns 0 rather than throwing when there is nothing to measure', () => {
    expect(renderedHeightPx('anything', null)).toBe(0)
    // A detached element, and jsdom generally, report a zero width.
    expect(renderedHeightPx('anything', document.createElement('div'))).toBe(0)
  })

  it('leaves no probe behind in the document', () => {
    const editor = document.createElement('div')
    Object.defineProperty(editor, 'clientWidth', { value: 400, configurable: true })
    document.body.appendChild(editor)
    const before = document.body.childElementCount
    renderedHeightPx('a\nb\nc', editor)
    expect(document.body.childElementCount).toBe(before)
    editor.remove()
  })
})

describe('measurePastedText', () => {
  it('carries the editor budget through so the decision is one comparison', () => {
    expect(measurePastedText('a\nb', { editor: null, maxHeightPx: 200 })).toEqual({
      lines: 2,
      heightPx: 0,
      maxHeightPx: 200,
    })
  })
})
