import { describe, expect, it, vi } from 'vitest'
import type { PasteFit } from '@/app/paste'
import {
  appendLinks,
  appendPastedTextToken,
  createPastedTextPart,
  expandPastedText,
  handleComposerPaste,
  pastedTextChipLabel,
  pastedTextToken,
  resolvePastedText,
  retainReferencedPastes,
} from './paste'

/** No editor to measure against, so the line count decides — as in a headless run. */
const FIT: PasteFit = { editor: null, maxHeightPx: 200 }

function paste(options: { files?: File[]; data?: Record<string, string> }) {
  const data = options.data ?? {}
  const preventDefault = vi.fn()
  const event = {
    clipboardData: {
      files: options.files ?? [],
      getData: (format: string) => data[format] ?? '',
    } as unknown as DataTransfer,
    preventDefault,
  }
  const targets = { attach: vi.fn(), links: vi.fn(), collapse: vi.fn() }
  const branch = handleComposerPaste(event, FIT, targets)
  return { branch, preventDefault, ...targets }
}

describe('the three branches, wired', () => {
  it('files → attach, and the event is consumed', () => {
    const result = paste({
      files: [new File(['x'], 'a.png', { type: 'image/png' })],
      data: { 'text/plain': 'a.png' },
    })
    expect(result.branch).toBe('files')
    expect(result.preventDefault).toHaveBeenCalledTimes(1)
    expect(result.attach).toHaveBeenCalledTimes(1)
    // Every file, not just the images: the intake reports *why* it refused a
    // non-image, and silently dropping it here would take that away.
    expect(result.attach.mock.calls[0][0]).toHaveLength(1)
    expect(result.links).not.toHaveBeenCalled()
    expect(result.collapse).not.toHaveBeenCalled()
  })

  it('text/uri-list → links, and the event is consumed', () => {
    const result = paste({ data: { 'text/uri-list': 'https://a.test/1\nfile:///tmp/b' } })
    expect(result.branch).toBe('links')
    expect(result.preventDefault).toHaveBeenCalledTimes(1)
    expect(result.links).toHaveBeenCalledWith(['https://a.test/1', 'file:///tmp/b'])
  })

  it('short plain text → the editor, and the event is NOT consumed', () => {
    const result = paste({ data: { 'text/plain': 'two\nlines' } })
    expect(result.branch).toBe('text')
    // The one that matters. Handling it ourselves is how newlines, the caret
    // position and the undo stack got lost.
    expect(result.preventDefault).not.toHaveBeenCalled()
    expect(result.collapse).not.toHaveBeenCalled()
  })

  it('long plain text → a chip, and the event is consumed', () => {
    const result = paste({ data: { 'text/plain': 'line\n'.repeat(40) } })
    expect(result.branch).toBe('collapsed')
    expect(result.preventDefault).toHaveBeenCalledTimes(1)
    expect(result.collapse.mock.calls[0][0].lines).toBe(41)
  })

  it('leaves a long standalone URL to the editor', () => {
    const url = `https://example.com/${'a'.repeat(4000)}`
    const result = paste({ data: { 'text/plain': url } })
    expect(result.branch).toBe('text')
    expect(result.preventDefault).not.toHaveBeenCalled()
  })
})

describe('pasted-text parts', () => {
  it('gives every chip a distinct label so two pastes cannot merge', () => {
    const first = createPastedTextPart('a\nb')
    const second = createPastedTextPart('a\nb')
    expect(first.label).not.toBe(second.label)
    expect(first.lines).toBe(2)
  })

  it('separates the identity key from the copy a person reads', () => {
    const part = createPastedTextPart('a\nb\nc')
    expect(pastedTextChipLabel(part)).toBe('Pasted · 3 lines')
    expect(pastedTextChipLabel(createPastedTextPart('one'))).toBe('Pasted · 1 line')
    expect(part.label).not.toBe(pastedTextChipLabel(part))
  })

  it('appends the token at the end of the draft, never at the caret', () => {
    const part = createPastedTextPart('body')
    expect(appendPastedTextToken('check this', part.label)).toBe(
      `check this ${pastedTextToken(part.label)} `,
    )
    expect(appendPastedTextToken('', part.label)).toBe(`${pastedTextToken(part.label)} `)
    expect(appendPastedTextToken('ends with newline\n', part.label)).toBe(
      `ends with newline\n${pastedTextToken(part.label)} `,
    )
  })

  it('resolves each token to its own body at send time', () => {
    const first = createPastedTextPart('FIRST')
    const second = createPastedTextPart('SECOND')
    const draft = `a ${pastedTextToken(first.label)} b ${pastedTextToken(second.label)}`
    expect(resolvePastedText(draft, [first, second])).toBe('a FIRST b SECOND')
  })

  it('leaves an unknown token standing rather than deleting visible text', () => {
    expect(resolvePastedText('a [pasted text 99 · 2 lines] b', [])).toBe(
      'a [pasted text 99 · 2 lines] b',
    )
  })

  it('reconciles the side table from the draft text', () => {
    // Backspace deletes the token and nothing else, so the side table has to
    // be derived from the text rather than from a removal callback.
    const kept = createPastedTextPart('kept')
    const gone = createPastedTextPart('gone')
    expect(retainReferencedPastes(pastedTextToken(kept.label), [kept, gone])).toEqual([kept])
  })

  it('expands a chip back into its own text in place', () => {
    const part = createPastedTextPart('one\ntwo')
    const draft = `before ${pastedTextToken(part.label)} after`
    expect(expandPastedText(draft, part)).toBe('before one\ntwo after')
  })
})

describe('appendLinks', () => {
  it('puts dropped links after what the user was writing, one per line', () => {
    expect(appendLinks('see', ['https://a.test', 'file:///tmp/b'])).toBe(
      'see\nhttps://a.test\nfile:///tmp/b',
    )
    expect(appendLinks('', ['https://a.test'])).toBe('https://a.test')
    expect(appendLinks('see\n', ['https://a.test'])).toBe('see\nhttps://a.test')
    expect(appendLinks('see', [])).toBe('see')
  })
})
