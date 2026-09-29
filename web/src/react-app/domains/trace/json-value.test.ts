import { describe, expect, it } from 'vitest'
import {
  AUTO_EXPAND_DEPTH,
  LARGE_NODE_ENTRIES,
  approxSize,
  entriesOf,
  formatScalar,
  isCollapsible,
  shouldAutoExpand,
  summarize,
} from './json-value'

/**
 * The size policy behind the payload tree. It is a judgement about how much a
 * reader can take in, so it lives apart from the rendering and is pinned here:
 * the failure it prevents — a page of envelopes printed as one wall of JSON —
 * is invisible to a type checker and obvious to anyone using the page.
 */

describe('what is collapsible', () => {
  it('treats containers and long strings as collapsible, scalars as not', () => {
    expect(isCollapsible({ a: 1 })).toBe(true)
    expect(isCollapsible([1, 2])).toBe(true)
    expect(isCollapsible('x'.repeat(400))).toBe(true)
    expect(isCollapsible('short')).toBe(false)
    expect(isCollapsible(42)).toBe(false)
    expect(isCollapsible(null)).toBe(false)
  })

  it('walks a container into name/value pairs and everything else into nothing', () => {
    expect(entriesOf({ a: 1, b: 2 })).toEqual([
      ['a', 1],
      ['b', 2],
    ])
    expect(entriesOf(['x', 'y'])).toEqual([
      ['0', 'x'],
      ['1', 'y'],
    ])
    expect(entriesOf('text')).toEqual([])
  })
})

describe('what opens on its own', () => {
  it('opens a small container near the top', () => {
    expect(shouldAutoExpand({ call_id: 'c1', tool_name: 'read_file' }, 0)).toBe(true)
    expect(shouldAutoExpand([], 0)).toBe(true)
  })

  it('stops opening below the depth limit, however small the node', () => {
    expect(shouldAutoExpand({ a: 1 }, AUTO_EXPAND_DEPTH - 1)).toBe(true)
    expect(shouldAutoExpand({ a: 1 }, AUTO_EXPAND_DEPTH)).toBe(false)
  })

  it('keeps a large body collapsed', () => {
    const manyEntries = Object.fromEntries(
      Array.from({ length: LARGE_NODE_ENTRIES + 1 }, (_, i) => [`k${i}`, i]),
    )
    expect(shouldAutoExpand(manyEntries, 0)).toBe(false)

    const longValue = { output: 'x'.repeat(2000) }
    expect(shouldAutoExpand(longValue, 0)).toBe(false)
  })

  it('never opens a long string for you', () => {
    expect(shouldAutoExpand('x'.repeat(400), 0)).toBe(false)
  })

  it('treats an unserializable value as large rather than small', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular

    expect(approxSize(circular)).toBe(Number.POSITIVE_INFINITY)
    expect(shouldAutoExpand(circular, 0)).toBe(false)
  })

  it('reports a scalar as already open — there is nothing to reveal', () => {
    expect(shouldAutoExpand(7, 5)).toBe(true)
  })
})

describe('the collapsed stand-in', () => {
  it('says how much a container is hiding', () => {
    expect(summarize([])).toBe('[]')
    expect(summarize([1])).toBe('[…] 1 item')
    expect(summarize([1, 2, 3])).toBe('[…] 3 items')
    expect(summarize({})).toBe('{}')
    expect(summarize({ call_id: 1, tool_name: 2 })).toBe('{ call_id, tool_name }')
  })

  it('previews a long string and states its real length', () => {
    const line = summarize('y'.repeat(500))

    expect(line).toMatch(/^"y+…" · 500 chars$/)
    expect(line.length).toBeLessThan(120)
  })
})

describe('formatScalar', () => {
  it('prints as JSON reads', () => {
    expect(formatScalar(null)).toBe('null')
    expect(formatScalar(undefined)).toBe('undefined')
    expect(formatScalar('hi')).toBe('"hi"')
    expect(formatScalar(3)).toBe('3')
    expect(formatScalar(false)).toBe('false')
  })
})
