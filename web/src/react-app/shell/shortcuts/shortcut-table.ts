/**
 * The keyboard shortcut table.
 *
 * One table, one place. A binding declared next to the component that handles
 * it is a binding nobody can enumerate: it cannot be listed in a help view, it
 * cannot be checked for a collision, and the next one lands silently on top of
 * it. So every shortcut in the product is a row here — including the rows this
 * module does not dispatch. `owner` says which surface runs it, and `scope`
 * says whether the global listener or that surface does the matching.
 *
 * Three rules the table exists to hold:
 *
 * - **The IME guard is unconditional.** `matchShortcut` refuses to match while
 *   a composition is in flight, for every row rather than only the Enter ones.
 *   A Chinese or Japanese candidate is confirmed with Enter, and a table that
 *   reads that Enter as "submit" costs the user the sentence they were
 *   halfway through. Three signals are tested because none is reliable on its
 *   own across engines: `isComposing`, the legacy `keyCode === 229`, and the
 *   `"Process"` key that older Gecko and IE-era layouts report.
 * - **A binding states whether it may fire inside a text field.** Anything
 *   else and a global shortcut quietly eats a keystroke meant for the
 *   composer.
 * - **Combos the browser owns are absent on purpose.** `Mod+N`, `Mod+T`,
 *   `Mod+W` and most `Mod+Shift+<letter>` pairs cannot be `preventDefault`-ed
 *   from a page, so binding one advertises a shortcut that does something
 *   else. That is worse than having none.
 */

export type ShortcutId =
  | 'palette.toggle'
  | 'shortcuts.help'
  | 'palette.back'
  | 'palette.back-empty'
  | 'palette.run'
  | 'composer.send'
  | 'composer.newline'
  | 'composer.stop'

/**
 * `global` bindings are dispatched by `useGlobalShortcuts` off one window
 * listener. `surface` bindings are dispatched by the component that owns the
 * focus context they belong to — they are listed here so the table stays the
 * whole truth, not so this module can fire them.
 */
export type ShortcutScope = 'global' | 'surface'

export type ShortcutOwner = 'shell' | 'palette' | 'composer'

export interface ShortcutBinding {
  id: ShortcutId
  /** Matched against `event.key`, case-insensitively for letters. */
  key: string
  /** The command modifier: Cmd on a Mac, Ctrl everywhere else. */
  mod?: boolean
  shift?: boolean
  alt?: boolean
  scope: ShortcutScope
  owner: ShortcutOwner
  /** Heading this row sits under in the shortcuts view. */
  group: string
  /** User-visible description. */
  label: string
  /**
   * Whether the binding may fire while focus is inside an input, textarea or
   * contenteditable. Off by default: a shortcut that steals a keystroke from
   * the composer is a bug, and the exceptions should have to say so.
   */
  allowInEditable?: boolean
  /**
   * This binding commits something — the Enter-to-submit family. Nothing
   * branches on it at dispatch (the IME guard covers every row); it exists so
   * the guard is *enumerable*: a test can walk the submit rows and prove each
   * one is inert mid-composition.
   */
  submit?: true
}

export const SHORTCUTS: readonly ShortcutBinding[] = [
  {
    id: 'palette.toggle',
    key: 'k',
    mod: true,
    scope: 'global',
    owner: 'shell',
    group: 'Workbench',
    label: 'Open or close the command palette',
    // Deliberately live inside text fields: the palette is how you leave the
    // thing you are typing in, so needing to click out of it first defeats it.
    allowInEditable: true,
  },
  {
    id: 'shortcuts.help',
    key: '/',
    mod: true,
    scope: 'global',
    owner: 'shell',
    group: 'Workbench',
    label: 'Show keyboard shortcuts',
    allowInEditable: true,
  },
  {
    id: 'palette.back',
    key: 'Escape',
    scope: 'surface',
    owner: 'palette',
    group: 'Command palette',
    label: 'Go back one view, and close from the top view',
    allowInEditable: true,
  },
  {
    id: 'palette.back-empty',
    key: 'Backspace',
    scope: 'surface',
    owner: 'palette',
    group: 'Command palette',
    label: 'Go back one view when the search box is empty',
    allowInEditable: true,
  },
  {
    id: 'palette.run',
    key: 'Enter',
    scope: 'surface',
    owner: 'palette',
    group: 'Command palette',
    label: 'Run the highlighted command',
    allowInEditable: true,
    submit: true,
  },
  {
    id: 'composer.send',
    key: 'Enter',
    scope: 'surface',
    owner: 'composer',
    group: 'Composer',
    label: 'Send the message',
    allowInEditable: true,
    submit: true,
  },
  {
    id: 'composer.newline',
    key: 'Enter',
    shift: true,
    scope: 'surface',
    owner: 'composer',
    group: 'Composer',
    label: 'Insert a line break',
    allowInEditable: true,
  },
  {
    id: 'composer.stop',
    key: 'Escape',
    scope: 'surface',
    owner: 'composer',
    group: 'Composer',
    label: 'Press twice to stop the running turn',
    allowInEditable: true,
  },
]

export const GLOBAL_SHORTCUTS: readonly ShortcutBinding[] = SHORTCUTS.filter(
  (binding) => binding.scope === 'global',
)

export function shortcutsOwnedBy(owner: ShortcutOwner): readonly ShortcutBinding[] {
  return SHORTCUTS.filter((binding) => binding.owner === owner)
}

export function shortcutById(id: ShortcutId): ShortcutBinding {
  const binding = SHORTCUTS.find((candidate) => candidate.id === id)
  // Unreachable through the exported types; throwing rather than returning
  // undefined keeps every call site free of a null check for a table that is
  // a compile-time constant.
  if (binding === undefined) throw new Error(`unknown shortcut: ${id}`)
  return binding
}

/**
 * The subset of a keyboard event the matcher reads.
 *
 * Structural rather than `KeyboardEvent` so the matcher is testable without a
 * DOM, and so a React synthetic event's `nativeEvent` passes unchanged — which
 * is the only place `isComposing` actually lives.
 */
export interface ShortcutEvent {
  key: string
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  isComposing?: boolean
  keyCode?: number
}

/**
 * Is this keystroke part of an in-flight IME composition?
 *
 * Exported because surfaces that do their own Enter handling (the composer,
 * anything with a submit-on-Enter field) need exactly this test, and a second
 * hand-rolled copy is how one of them ends up guarding two signals instead of
 * three.
 */
export function isImeComposing(event: ShortcutEvent): boolean {
  return event.isComposing === true || event.keyCode === 229 || event.key === 'Process'
}

/** Is focus somewhere that a bare keystroke belongs to the user's text? */
export function isEditableTarget(target: unknown): boolean {
  if (target === null || typeof target !== 'object') return false
  const element = target as { tagName?: unknown; isContentEditable?: unknown }
  if (element.isContentEditable === true) return true
  const tagName = typeof element.tagName === 'string' ? element.tagName.toUpperCase() : ''
  return tagName === 'INPUT' || tagName === 'TEXTAREA' || tagName === 'SELECT'
}

export interface MatchOptions {
  isMac: boolean
  /** Focus is inside a text field; bindings must opt in to fire. */
  inEditable?: boolean
}

/**
 * The one place a keystroke becomes a binding.
 *
 * Returns the first matching row, or null. The IME guard runs before anything
 * else and applies to every row — see the module docstring for why that is not
 * negotiable.
 */
export function matchShortcut(
  event: ShortcutEvent,
  bindings: readonly ShortcutBinding[],
  options: MatchOptions,
): ShortcutBinding | null {
  if (isImeComposing(event)) return null

  const key = event.key.toLowerCase()
  // On a Mac, Ctrl is not the command modifier — treating it as one turns
  // Ctrl+K (delete-to-end-of-line, a system-wide binding) into a palette.
  const modPressed = options.isMac ? event.metaKey : event.ctrlKey
  const otherModPressed = options.isMac ? event.ctrlKey : event.metaKey

  for (const binding of bindings) {
    if (binding.key.toLowerCase() !== key) continue
    if ((binding.mod === true) !== modPressed) continue
    if (otherModPressed) continue
    if ((binding.shift === true) !== event.shiftKey) continue
    if ((binding.alt === true) !== event.altKey) continue
    if (options.inEditable === true && binding.allowInEditable !== true) continue
    return binding
  }
  return null
}

const MAC_KEY_LABELS: Record<string, string> = {
  Escape: 'esc',
  Enter: '↵',
  Backspace: '⌫',
}

const KEY_LABELS: Record<string, string> = {
  Escape: 'Esc',
  Enter: 'Enter',
  Backspace: 'Backspace',
}

/**
 * How a binding is written in a hint or a help row.
 *
 * Mac convention is glyphs run together (`⌘K`); everywhere else it is words
 * joined with `+` (`Ctrl+K`). Rendering both the same way is the sort of
 * detail that makes a shortcut list read as foreign on one of the two.
 */
export function shortcutHint(binding: ShortcutBinding, isMac: boolean): string {
  const parts: string[] = []
  if (binding.mod === true) parts.push(isMac ? '⌘' : 'Ctrl')
  if (binding.shift === true) parts.push(isMac ? '⇧' : 'Shift')
  if (binding.alt === true) parts.push(isMac ? '⌥' : 'Alt')
  const labels = isMac ? MAC_KEY_LABELS : KEY_LABELS
  parts.push(labels[binding.key] ?? (binding.key.length === 1 ? binding.key.toUpperCase() : binding.key))
  return parts.join(isMac ? '' : '+')
}
