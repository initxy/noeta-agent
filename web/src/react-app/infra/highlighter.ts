/**
 * The syntax highlighter, behind one lazy async call.
 *
 * Shiki carries a TextMate grammar per language and a WASM regex engine; it is
 * by far the largest thing the transcript can pull in, and a conversation that
 * never shows fenced code should never pay for it. So it is a **dynamic
 * import**, resolved once per process and reused, and every failure path ends
 * in `null` — an unhighlighted code block is a fine outcome, a transcript that
 * throws is not.
 *
 * `shiki/bundle/web` rather than the full bundle: it carries the languages an
 * agent actually emits in a chat window, and the full bundle is several times
 * the size for grammars nobody will hit here.
 *
 * This module exists as its own file so the component that renders code can be
 * tested without loading any of it.
 */

/** Themes are picked to sit on the product's own surfaces, not shiki's. */
const LIGHT_THEME = 'github-light'
// High-contrast on purpose: `github-dark` sits its keywords as dim red/blue on
// a near-black ground, and on this product's own darker `--surface-2` ground
// they wash out to the point of being unreadable. The high-contrast variant
// brightens the tokens without changing the palette's family.
const DARK_THEME = 'github-dark-high-contrast'

export interface HighlightRequest {
  code: string
  /** The fence's info string, already lowercased. Empty means "no language". */
  lang: string
  dark: boolean
}

type Shiki = typeof import('shiki/bundle/web')

let loading: Promise<Shiki | null> | null = null

function load(): Promise<Shiki | null> {
  loading ??= import('shiki/bundle/web').catch(() => null)
  return loading
}

/**
 * Highlight one block, or return `null` when it cannot be done.
 *
 * `null` covers every uninteresting case in one value: no language, a language
 * shiki does not carry, the bundle failing to load, and the grammar throwing.
 * The caller renders plain text for all four.
 */
export async function highlightCode({ code, lang, dark }: HighlightRequest): Promise<string | null> {
  if (lang === '') return null
  const shiki = await load()
  if (shiki === null) return null
  if (!Object.hasOwn(shiki.bundledLanguages, lang)) return null
  try {
    return await shiki.codeToHtml(code, {
      lang: lang as keyof typeof shiki.bundledLanguages,
      theme: dark ? DARK_THEME : LIGHT_THEME,
    })
  } catch {
    return null
  }
}
