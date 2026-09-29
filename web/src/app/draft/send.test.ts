import { describe, expect, it } from 'vitest'
import type { MentionTable } from './tokens'
import { resolveDraft } from './send'

const FILES: MentionTable = { 'src/app.ts': 'file', 'a b.ts': 'file' }

describe('resolving a draft', () => {
  it('leaves an ordinary message exactly as typed, trimmed', () => {
    expect(resolveDraft('  plan the week  ')).toEqual({ text: 'plan the week', skills: [] })
  })

  it('sends a slash command as a pinned skill plus the rest as the goal', () => {
    expect(resolveDraft('/review look at the diff')).toEqual({
      text: 'look at the diff',
      skills: ['review'],
    })
  })

  it('tolerates extra spacing after the command name', () => {
    expect(resolveDraft('/review\t  the diff')).toEqual({
      text: 'the diff',
      skills: ['review'],
    })
  })

  it('resolves a bare command to no goal, so the composer withholds the send', () => {
    expect(resolveDraft('/review')).toEqual({ text: '', skills: ['review'] })
  })

  it('does not read a path as a command', () => {
    expect(resolveDraft('/usr/bin/env is on the path')).toEqual({
      text: '/usr/bin/env is on the path',
      skills: [],
    })
  })

  it('decodes the mentions it knows and only those', () => {
    expect(resolveDraft('open @a%20b.ts', FILES).text).toBe('open @a b.ts')
    // Not in the table: the user typed it, so it is prose and stays literal.
    expect(resolveDraft('give me 100%25 @nobody', FILES).text).toBe('give me 100%25 @nobody')
  })

  it('keeps a merged queue as one goal, with the first item’s command intact', () => {
    // The queue drains as one string joined by blank lines; `[ \t]+` after the
    // name is what stops the second message being read as arguments syntax.
    const merged = ['/review the diff', 'then run the tests'].join('\n\n')
    expect(resolveDraft(merged)).toEqual({
      text: 'the diff\n\nthen run the tests',
      skills: ['review'],
    })
  })

  it('resolves a queue with no command to the joined text', () => {
    expect(resolveDraft('first\n\nsecond')).toEqual({ text: 'first\n\nsecond', skills: [] })
  })
})
