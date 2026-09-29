/**
 * The spreadsheet preview. **Read only, by design** (D12).
 *
 * There is no Save button and no editable cell, and the copy says so rather
 * than apologising for it: a `string[][]` model cannot represent a second
 * sheet, a formula, a merge or a number format, so writing one back is not a
 * limited save — it is silent data loss dressed as a feature. When this product
 * grows a workbook model that round-trips, the grid can grow a save path with
 * it.
 */

import { useMemo } from 'react'
import { CenteredNote } from '@/react-app/design-system'
import { parseSheet } from './spreadsheet-model'

export function SpreadsheetView({ path, text }: { path: string; text: string }) {
  const rows = useMemo(() => parseSheet(path, text), [path, text])
  if (rows.length === 1 && rows[0].length === 1 && rows[0][0] === '') {
    return <CenteredNote>This file is empty.</CenteredNote>
  }

  const [header, ...body] = rows

  return (
    <div className="flex h-full min-h-0 flex-col">
      <p className="shrink-0 border-b border-border px-3 py-1.5 text-xs text-ink-3">
        Read-only preview · {rows.length} rows
      </p>
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-max border-collapse text-xs">
          <thead className="sticky top-0 bg-surface-2">
            <tr>
              <th className="border border-border px-2 py-1 text-ink-3">#</th>
              {header.map((cell, index) => (
                <th
                  key={index}
                  className="min-w-28 border border-border px-2 py-1 text-left font-medium text-ink"
                >
                  {cell}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body.map((row, rowIndex) => (
              <tr key={rowIndex}>
                <td className="border border-border px-2 py-1 text-right text-ink-3 tabular-nums">
                  {rowIndex + 1}
                </td>
                {row.map((cell, cellIndex) => (
                  <td key={cellIndex} className="border border-border px-2 py-1 text-ink-2">
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
