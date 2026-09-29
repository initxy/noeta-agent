import { describe, expect, it } from 'vitest'
import { parseArgv, parseKeyValueLines } from './connector-input'

describe('parseKeyValueLines', () => {
  it('reads one pair per line', () => {
    expect(parseKeyValueLines('A=1\nB=2')).toEqual({ A: '1', B: '2' })
  })

  it('splits on the first = so a token containing one survives intact', () => {
    // The failure this pins: an Authorization header truncated at the first
    // `=` authenticates as nothing, and the MCP server just says no.
    expect(parseKeyValueLines('Authorization=Bearer a=b=c')).toEqual({
      Authorization: 'Bearer a=b=c',
    })
  })

  it('trims around the separator', () => {
    expect(parseKeyValueLines('  A =  1  ')).toEqual({ A: '1' })
  })

  it('skips blank lines and comments so a pasted .env fragment works', () => {
    expect(parseKeyValueLines('# a comment\n\nA=1\n   \n')).toEqual({ A: '1' })
  })

  it('drops a line with no key rather than storing an empty one', () => {
    expect(parseKeyValueLines('=orphan\nnoequals\nA=1')).toEqual({ A: '1' })
  })

  it('is empty for empty input', () => {
    expect(parseKeyValueLines('')).toEqual({})
  })
})

describe('parseArgv', () => {
  it('splits on whitespace', () => {
    expect(parseArgv('-y  server  /srv/data')).toEqual(['-y', 'server', '/srv/data'])
  })

  it('keeps a quoted argument whole and strips the quotes', () => {
    expect(parseArgv('--root "/srv/my data" --flag')).toEqual([
      '--root',
      '/srv/my data',
      '--flag',
    ])
    expect(parseArgv("--root '/srv/my data'")).toEqual(['--root', '/srv/my data'])
  })

  it('leaves an unbalanced quote as a literal token rather than swallowing the rest', () => {
    expect(parseArgv('--root "/srv/data')).toEqual(['--root', '"/srv/data'])
  })

  it('is empty for empty and whitespace-only input', () => {
    expect(parseArgv('')).toEqual([])
    expect(parseArgv('   \n ')).toEqual([])
  })
})
