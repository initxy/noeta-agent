import { describe, expect, it } from 'vitest'
import { checkProjectDirectory, directorySlug, suggestProjectDirectory } from './directory'

describe('checkProjectDirectory', () => {
  it('accepts an absolute POSIX path', () => {
    expect(checkProjectDirectory('/home/you/code/app')).toEqual({
      ok: true,
      directory: '/home/you/code/app',
    })
  })

  it('accepts Windows and UNC absolute paths', () => {
    expect(checkProjectDirectory('C:\\code\\app')).toEqual({ ok: true, directory: 'C:\\code\\app' })
    expect(checkProjectDirectory('D:/code/app')).toEqual({ ok: true, directory: 'D:/code/app' })
    expect(checkProjectDirectory('\\\\host\\share')).toEqual({
      ok: true,
      directory: '\\\\host\\share',
    })
  })

  it('rejects a relative path before the request is made', () => {
    // The whole point of the client-side guard: a 422 for this arrives after
    // a round trip, and on a first run it is the product's first sentence.
    const result = checkProjectDirectory('code/app')
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.message).toContain('absolute path')
  })

  it('rejects "." and ".." as the relative paths they are', () => {
    expect(checkProjectDirectory('.').ok).toBe(false)
    expect(checkProjectDirectory('../sibling').ok).toBe(false)
  })

  it('rejects a ~ path, which the backend does not expand', () => {
    const result = checkProjectDirectory('~/code/app')
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.message).toContain('~')
  })

  it('rejects empty and whitespace-only input', () => {
    expect(checkProjectDirectory('').ok).toBe(false)
    expect(checkProjectDirectory('   ').ok).toBe(false)
  })

  it('trims surrounding whitespace and trailing slashes so one directory is one project', () => {
    expect(checkProjectDirectory('  /srv/app/  ')).toEqual({ ok: true, directory: '/srv/app' })
    expect(checkProjectDirectory('/srv/app///')).toEqual({ ok: true, directory: '/srv/app' })
  })

  it('keeps a bare root intact rather than trimming it to nothing', () => {
    expect(checkProjectDirectory('/')).toEqual({ ok: true, directory: '/' })
  })
})

describe('directorySlug', () => {
  it('lowercases and collapses punctuation into single hyphens', () => {
    expect(directorySlug('My  Great Project!!')).toBe('my-great-project')
  })

  it('strips leading and trailing separators', () => {
    expect(directorySlug('  --Alpha--  ')).toBe('alpha')
  })

  it('returns nothing when there is nothing usable to name a directory with', () => {
    expect(directorySlug('!!!')).toBe('')
    expect(directorySlug('项目')).toBe('')
  })

  it('caps the length so a pasted paragraph cannot become a directory name', () => {
    expect(directorySlug('a'.repeat(200))).toHaveLength(60)
  })
})

describe('suggestProjectDirectory', () => {
  it('joins the root and the slug', () => {
    expect(suggestProjectDirectory('/data/projects', 'My App')).toBe('/data/projects/my-app')
  })

  it('does not double the separator when the root has a trailing slash', () => {
    expect(suggestProjectDirectory('/data/projects/', 'My App')).toBe('/data/projects/my-app')
  })

  it('suggests nothing rather than half a path', () => {
    expect(suggestProjectDirectory('', 'My App')).toBe('')
    expect(suggestProjectDirectory('/data/projects', '!!!')).toBe('')
  })
})
