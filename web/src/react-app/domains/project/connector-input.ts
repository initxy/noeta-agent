/**
 * Parsing the two free-text fields of the connector form.
 *
 * They are free text rather than a repeating key/value widget because an MCP
 * connector is configured once, usually by pasting from a README, and a
 * paste-shaped input beats six clicks. The cost is that the parse has to be
 * total: whatever the user pastes must produce *something* sendable, and the
 * parts it cannot read must be dropped rather than sent as garbage the
 * backend stores verbatim.
 *
 * Pure functions, kept out of the component so they can be pinned directly —
 * a credential separated on the wrong character is not a bug you want to find
 * by watching an MCP server fail to authenticate.
 */

/**
 * `key=value` lines → an object.
 *
 * Split on the **first** `=`, because a value routinely contains one (a token,
 * a base64 blob, a query string). Blank lines and `#` comments are skipped so
 * a pasted `.env` fragment works as-is.
 */
export function parseKeyValueLines(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const index = trimmed.indexOf('=')
    // `<= 0` also rejects a line starting with `=`, which has no key.
    if (index <= 0) continue
    out[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim()
  }
  return out
}

/**
 * A command line → argv.
 *
 * Quoting is supported because paths have spaces and an MCP stdio server is
 * routinely pointed at one. This is deliberately *not* a shell: there is no
 * escaping, no expansion and no operators, because the argv goes straight to
 * `exec` and pretending otherwise would invite a user to write `&&`.
 */
export function parseArgv(text: string): string[] {
  const matches = text.match(/"[^"]*"|'[^']*'|\S+/g) ?? []
  return matches.map((token) =>
    (token.startsWith('"') && token.endsWith('"') && token.length >= 2) ||
    (token.startsWith("'") && token.endsWith("'") && token.length >= 2)
      ? token.slice(1, -1)
      : token,
  )
}
