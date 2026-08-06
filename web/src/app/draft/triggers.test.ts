import { describe, expect, it } from 'vitest'
import {
  commitMention,
  draftTrigger,
  leadingSlashCommand,
  slashCommandDraft,
} from './triggers'

/**
 * The triggers, and — at least as important — what they refuse.
 *
 * A trigger that fires too eagerly is not a cosmetic defect: the menu steals
 * Enter, so an over-eager `@` turns "send this message" into "insert the file
 * I happened to be hovering".
 */

describe('the slash trigger', () => {
  it('fires only when the draft is nothing but the query', () => {
    expect(draftTrigger('/')).toEqual({ kind: 'slash', query: '' })
    expect(draftTrigger('/rev')).toEqual({ kind: 'slash', query: 'rev' })
    expect(draftTrigger('/re-view_2')).toEqual({ kind: 'slash', query: 're-view_2' })
  })

  it('does NOT fire on a mid-word or mid-draft slash', () => {
    expect(draftTrigger('cd /usr')).toBeNull()
    expect(draftTrigger('a/b')).toBeNull()
    expect(draftTrigger('look at src/app.ts')).toBeNull()
  })

  it('closes the moment the query ends', () => {
    expect(draftTrigger('/review ')).toBeNull()
    expect(draftTrigger('/review the diff')).toBeNull()
    expect(draftTrigger('/rev!')).toBeNull()
  })
})

describe('the mention trigger', () => {
  it('fires at the end of the draft, on a word boundary', () => {
    expect(draftTrigger('@')).toEqual({ kind: 'mention', query: '' })
    expect(draftTrigger('@src')).toEqual({ kind: 'mention', query: 'src' })
    expect(draftTrigger('read @src/app')).toEqual({ kind: 'mention', query: 'src/app' })
    expect(draftTrigger('line one\n@a')).toEqual({ kind: 'mention', query: 'a' })
  })

  it('does NOT fire on an email-looking @', () => {
    expect(draftTrigger('mail bob@example.com')).toBeNull()
    expect(draftTrigger('bob@')).toBeNull()
  })

  it('does NOT fire away from the end of the draft', () => {
    expect(draftTrigger('@src/app.ts and then')).toBeNull()
  })

  it('closes on a space, and on a second @ with no boundary before it', () => {
    expect(draftTrigger('@src ')).toBeNull()
    // The reference reopens here on an empty query. The boundary rule says no,
    // and that is the same rule that keeps an email address quiet.
    expect(draftTrigger('@src@')).toBeNull()
    expect(draftTrigger('@src @')).toEqual({ kind: 'mention', query: '' })
  })
})

describe('committing', () => {
  it('replaces the WHOLE draft with the slash command', () => {
    // Safe precisely because the trigger established the draft was the query.
    expect(slashCommandDraft('review')).toBe('/review ')
  })

  it('replaces only the trailing @query of a mention', () => {
    expect(commitMention('read @src/ap', 'src/app.ts')).toBe('read @src/app.ts ')
    expect(commitMention('@', 'a b.ts')).toBe('@a%20b.ts ')
    expect(commitMention('line one\nsee @x', 'src/x.ts')).toBe('line one\nsee @src/x.ts ')
  })

  it('leaves an already-committed mention alone', () => {
    const draft = 'read @src/a.ts and @src/b'
    expect(commitMention(draft, 'src/b.ts')).toBe('read @src/a.ts and @src/b.ts ')
  })
})

describe('the committed command chip', () => {
  it('appears once the name is followed by whitespace', () => {
    expect(leadingSlashCommand('/review ')).toBe('review')
    expect(leadingSlashCommand('/review the diff')).toBe('review')
    expect(leadingSlashCommand('/review\nthe diff')).toBe('review')
  })

  it('does not appear while the name is still being typed', () => {
    // The menu is open on this draft; a chip here would fight the query.
    expect(leadingSlashCommand('/review')).toBeNull()
    expect(leadingSlashCommand('/')).toBeNull()
  })

  it('does not appear on a path that merely starts with a slash', () => {
    expect(leadingSlashCommand('/usr/bin/env is here')).toBeNull()
  })
})
