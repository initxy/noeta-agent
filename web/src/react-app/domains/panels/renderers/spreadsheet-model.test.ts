import { describe, expect, it } from 'vitest'
import * as model from './spreadsheet-model'
import { isBinaryWorkbook, isDelimitedSheet, parseSheet } from './spreadsheet-model'

describe('the sheet model is read-only', () => {
  it('exports no serializer, no save, and no mutation', () => {
    // The reference's `string[][]` round trip destroys every sheet but the
    // first and all formatting. The absence of a write path is the feature;
    // this test is what makes adding one a deliberate act.
    const exported = Object.keys(model).sort()
    expect(exported.filter((name) => /serial|save|write|set|add|update/i.test(name))).toEqual([])
  })
})

describe('parsing', () => {
  it('reads a plain CSV', () => {
    expect(parseSheet('a.csv', 'a,b\n1,2\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })

  it('keeps a quoted delimiter, newline and escaped quote inside one cell', () => {
    expect(parseSheet('a.csv', 'x,"a,b\nc""d"\n')).toEqual([['x', 'a,b\nc"d']])
  })

  it('drops CR so a CRLF file does not grow a character per cell', () => {
    expect(parseSheet('a.csv', 'a,b\r\n1,2\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ])
  })

  it('splits a TSV on tabs', () => {
    expect(parseSheet('a.tsv', 'a\tb\n')).toEqual([['a', 'b']])
  })

  it('pads a ragged grid to the widest row', () => {
    expect(parseSheet('a.csv', 'a,b,c\n1\n')).toEqual([
      ['a', 'b', 'c'],
      ['1', '', ''],
    ])
  })

  it('always yields at least one row', () => {
    expect(parseSheet('a.csv', '')).toEqual([['']])
  })
})

describe('what gets a grid at all', () => {
  it('is delimited text only', () => {
    expect(isDelimitedSheet('data.csv')).toBe(true)
    expect(isDelimitedSheet('data.tsv')).toBe(true)
    expect(isDelimitedSheet('book.xlsx')).toBe(false)
  })

  it('routes a binary workbook to the download path instead of approximating it', () => {
    expect(isBinaryWorkbook('book.xlsx')).toBe(true)
    expect(isBinaryWorkbook('book.ods')).toBe(true)
    expect(isBinaryWorkbook('data.csv')).toBe(false)
  })
})
