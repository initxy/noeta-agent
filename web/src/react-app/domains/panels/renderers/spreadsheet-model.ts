/**
 * Delimited-text parsing for the spreadsheet preview. **Read only.**
 *
 * There is no serializer in this file and that is the design, not an omission.
 * The reference models a sheet as `string[][]` — flat, first sheet, every cell
 * stringified — and then writes it back through `aoa_to_sheet` into a brand new
 * one-sheet workbook. Saving an `.xlsx` that way destroys every other sheet,
 * every formula and all formatting, silently, in a product whose whole promise
 * is that the agent and the user are working on the same files. A grid that can
 * only read is the correct scope for a model this thin; a grid that can write
 * is a data-loss bug with a toolbar.
 *
 * Binary workbooks (`.xlsx` / `.xls` / `.ods`) are not parsed at all — the
 * `xlsx` dependency is deliberately not adopted (D10) — so they render as a
 * download rather than as a lossy approximation of themselves.
 */

/** A parsed grid. Always at least one row, so a renderer never special-cases. */
export type SheetRows = string[][]

const BINARY_WORKBOOK_PATTERN = /\.(?:xlsx|xls|ods)$/i

/** Can this path be shown as a grid at all? */
export function isDelimitedSheet(path: string): boolean {
  return /\.(?:csv|tsv)$/i.test(path)
}

export function isBinaryWorkbook(path: string): boolean {
  return BINARY_WORKBOOK_PATTERN.test(path)
}

export function delimiterFor(path: string): string {
  return /\.tsv$/i.test(path) ? '\t' : ','
}

/**
 * Parse RFC-4180-ish delimited text.
 *
 * Hand-rolled rather than pulled from a package because the rules that matter
 * are four lines long: a quoted field may contain the delimiter and newlines,
 * `""` inside quotes is a literal quote, and a bare `\r` is dropped so CRLF
 * files do not grow a trailing character in every cell.
 */
export function parseDelimited(text: string, delimiter: string): SheetRows {
  const rows: SheetRows = []
  let row: string[] = []
  let field = ''
  let quoted = false

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]

    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 1
        } else {
          quoted = false
        }
      } else {
        field += char
      }
      continue
    }

    if (char === '"') {
      quoted = true
    } else if (char === delimiter) {
      row.push(field)
      field = ''
    } else if (char === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else if (char !== '\r') {
      field += char
    }
  }

  row.push(field)
  rows.push(row)

  // A trailing newline is a line terminator, not an empty final row.
  if (rows.length > 1) {
    const last = rows[rows.length - 1]
    if (last.length === 1 && last[0] === '') rows.pop()
  }
  return normalizeShape(rows)
}

/** Pad every row to the widest, so the table has no ragged right edge. */
export function normalizeShape(rows: SheetRows): SheetRows {
  const width = Math.max(1, ...rows.map((row) => row.length))
  return rows.map((row) =>
    row.length === width ? row : [...row, ...Array<string>(width - row.length).fill('')],
  )
}

export function parseSheet(path: string, text: string): SheetRows {
  return parseDelimited(text, delimiterFor(path))
}
