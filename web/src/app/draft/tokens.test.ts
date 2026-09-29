import { describe, expect, it } from 'vitest'
import {
  decodeMentionValue,
  encodeMentionValue,
  mentionToken,
  serializeDraft,
  skillToken,
  splitDraft,
} from './tokens'

/**
 * The draft grammar, and the one property everything above it depends on:
 * a draft survives the round trip through the parse unchanged.
 *
 * If that ever stops being true the failure is silent and total — the editor
 * rewrites what the user typed on every keystroke, and the send path posts
 * something they never wrote.
 */

const ROUND_TRIPS = [
  '',
  'plain words',
  '@src/app.ts',
  '[skill review]',
  '   ',
  '\n',
  'look at @src/a%20b.ts and @docs/x.md',
  'before [pasted text 12 lines] after',
  'a[attachment img-1]b',
  '@one@two',
  'bob@example.com',
  'trailing @',
  'multi\nline\n\ndraft with @a.ts',
  '100% @done',
]

describe('round trip', () => {
  for (const draft of ROUND_TRIPS) {
    it(`preserves ${JSON.stringify(draft)} byte for byte`, () => {
      expect(serializeDraft(splitDraft(draft))).toBe(draft)
    })
  }

  it('is empty for an empty draft rather than one empty segment', () => {
    expect(splitDraft('')).toEqual([])
  })

  it('is exactly one segment for a draft that is only a token', () => {
    expect(splitDraft('@src/app.ts')).toEqual([
      { kind: 'mention', text: '@src/app.ts', value: 'src/app.ts' },
    ])
    expect(splitDraft('[skill review]')).toEqual([
      { kind: 'skill', text: '[skill review]', value: 'review' },
    ])
  })
})

describe('splitting', () => {
  it('keeps text and tokens in order', () => {
    expect(splitDraft('read @a.ts then [skill review] ok')).toEqual([
      { kind: 'text', text: 'read ', value: 'read ' },
      { kind: 'mention', text: '@a.ts', value: 'a.ts' },
      { kind: 'text', text: ' then ', value: ' then ' },
      { kind: 'skill', text: '[skill review]', value: 'review' },
      { kind: 'text', text: ' ok', value: ' ok' },
    ])
  })

  it('classifies the two reserved shapes without giving them meaning', () => {
    expect(splitDraft('[pasted text 12 lines][attachment img-1]')).toEqual([
      { kind: 'pasted', text: '[pasted text 12 lines]', value: '12 lines' },
      { kind: 'attachment', text: '[attachment img-1]', value: 'img-1' },
    ])
  })

  it('decodes a mention value while keeping the source text encoded', () => {
    const [segment] = splitDraft('@a%20b%25c')
    expect(segment.text).toBe('@a%20b%25c')
    expect(segment.value).toBe('a b%c')
  })

  it('stops a mention at whitespace and at a second @', () => {
    expect(splitDraft('@a b').map((s) => s.text)).toEqual(['@a', ' b'])
    // `@[^\s@]+` is what keeps a mention one token: two adjacent mentions are
    // two segments, never one that swallows the pair.
    expect(splitDraft('@a@b').map((s) => s.text)).toEqual(['@a', '@b'])
    expect(splitDraft('@a@b').every((s) => s.kind === 'mention')).toBe(true)
  })

  it('does not treat an unterminated bracket as a token', () => {
    expect(splitDraft('[skill review').map((s) => s.kind)).toEqual(['text'])
  })
})

describe('mention encoding', () => {
  it('escapes % before spaces so a literal %20 survives', () => {
    const literal = 'a %20 b'
    expect(decodeMentionValue(encodeMentionValue(literal))).toBe(literal)
    expect(encodeMentionValue(literal)).toBe('a%20%2520%20b')
  })

  it('escapes nothing else — a path stays readable in the raw draft', () => {
    expect(mentionToken('src/app/routes.ts')).toBe('@src/app/routes.ts')
  })

  it('spells a skill token the split regex can find again', () => {
    expect(splitDraft(skillToken('review'))).toEqual([
      { kind: 'skill', text: '[skill review]', value: 'review' },
    ])
  })
})
