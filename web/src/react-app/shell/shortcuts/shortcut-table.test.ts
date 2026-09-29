import { describe, expect, it } from 'vitest'
import {
  GLOBAL_SHORTCUTS,
  SHORTCUTS,
  isEditableTarget,
  isImeComposing,
  matchShortcut,
  shortcutById,
  shortcutHint,
  shortcutsOwnedBy,
  type ShortcutEvent,
} from './shortcut-table'

/**
 * The table's own invariants.
 *
 * The IME assertions are the point of the file. They are written as a walk
 * over the table rather than as a handful of cases, so a binding added later
 * is covered the moment it is added — the failure mode being guarded against
 * is not "this Enter is unguarded" but "the next Enter will be".
 */

function press(overrides: Partial<ShortcutEvent> & { key: string }): ShortcutEvent {
  return {
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...overrides,
  }
}

/** The same keystroke a binding wants, so a match is the expected outcome. */
function keystrokeFor(id: (typeof SHORTCUTS)[number]['id']): ShortcutEvent {
  const binding = shortcutById(id)
  return press({
    key: binding.key,
    metaKey: binding.mod === true,
    shiftKey: binding.shift === true,
    altKey: binding.alt === true,
  })
}

describe('the table itself', () => {
  it('has no two bindings competing for one keystroke inside one surface', () => {
    const seen = new Map<string, string>()
    for (const binding of SHORTCUTS) {
      const signature = [
        binding.owner,
        binding.key.toLowerCase(),
        binding.mod === true,
        binding.shift === true,
        binding.alt === true,
      ].join('|')
      expect(seen.get(signature), `${binding.id} collides with ${seen.get(signature)}`).toBe(
        undefined,
      )
      seen.set(signature, binding.id)
    }
  })

  it('binds nothing the browser owns outright', () => {
    // A page cannot preventDefault these, so a row here would advertise a
    // shortcut that opens a browser window instead.
    const reserved = new Set(['n', 't', 'w', 'q'])
    for (const binding of GLOBAL_SHORTCUTS) {
      expect(binding.mod === true && reserved.has(binding.key.toLowerCase())).toBe(false)
    }
  })

  it('marks every submit binding as an Enter binding', () => {
    for (const binding of SHORTCUTS) {
      if (binding.submit === true) expect(binding.key).toBe('Enter')
    }
  })
})

describe('the IME guard', () => {
  const composing: Partial<ShortcutEvent>[] = [
    { isComposing: true },
    { keyCode: 229 },
    { key: 'Process' },
  ]

  it('holds for every Enter-to-submit binding in the table', () => {
    const submits = SHORTCUTS.filter((binding) => binding.submit === true)
    // If this ever reads 0 the assertions below are vacuous.
    expect(submits.length).toBeGreaterThan(0)

    for (const binding of submits) {
      for (const signal of composing) {
        const event = { ...keystrokeFor(binding.id), ...signal }
        expect(
          matchShortcut(event, SHORTCUTS, { isMac: true }),
          `${binding.id} fired mid-composition on ${JSON.stringify(signal)}`,
        ).toBe(null)
      }
    }
  })

  it('holds for every binding, not only the Enter ones', () => {
    for (const binding of SHORTCUTS) {
      for (const signal of composing) {
        const event = { ...keystrokeFor(binding.id), ...signal }
        expect(matchShortcut(event, SHORTCUTS, { isMac: true })).toBe(null)
      }
    }
  })

  it('recognises all three signals and nothing else', () => {
    expect(isImeComposing(press({ key: 'Enter', isComposing: true }))).toBe(true)
    expect(isImeComposing(press({ key: 'Enter', keyCode: 229 }))).toBe(true)
    expect(isImeComposing(press({ key: 'Process' }))).toBe(true)
    expect(isImeComposing(press({ key: 'Enter', keyCode: 13 }))).toBe(false)
  })
})

describe('matching', () => {
  it('resolves the palette toggle on the platform modifier only', () => {
    const cmdK = press({ key: 'k', metaKey: true })
    const ctrlK = press({ key: 'k', ctrlKey: true })

    expect(matchShortcut(cmdK, GLOBAL_SHORTCUTS, { isMac: true })?.id).toBe('palette.toggle')
    // Ctrl+K on a Mac is delete-to-end-of-line; claiming it would break a
    // system-wide binding inside every text field.
    expect(matchShortcut(ctrlK, GLOBAL_SHORTCUTS, { isMac: true })).toBe(null)
    expect(matchShortcut(ctrlK, GLOBAL_SHORTCUTS, { isMac: false })?.id).toBe('palette.toggle')
    expect(matchShortcut(cmdK, GLOBAL_SHORTCUTS, { isMac: false })).toBe(null)
  })

  it('does not match a binding with an extra modifier held', () => {
    const cmdShiftK = press({ key: 'k', metaKey: true, shiftKey: true })
    expect(matchShortcut(cmdShiftK, GLOBAL_SHORTCUTS, { isMac: true })).toBe(null)
  })

  it('separates the two Enter bindings the composer owns by the modifier', () => {
    const composer = shortcutsOwnedBy('composer')
    expect(matchShortcut(press({ key: 'Enter' }), composer, { isMac: true })?.id).toBe(
      'composer.send',
    )
    expect(
      matchShortcut(press({ key: 'Enter', shiftKey: true }), composer, { isMac: true })?.id,
    ).toBe('composer.newline')
    // Cmd/Ctrl+Enter is no longer a composer binding — it falls through to an
    // ordinary send rather than queueing.
    expect(
      matchShortcut(press({ key: 'Enter', metaKey: true }), composer, { isMac: true }),
    ).toBe(null)
  })

  it('keeps a non-editable binding out of a text field', () => {
    const bindings = [
      { ...shortcutById('palette.toggle'), allowInEditable: undefined },
    ] as const
    const cmdK = press({ key: 'k', metaKey: true })

    expect(matchShortcut(cmdK, bindings, { isMac: true, inEditable: true })).toBe(null)
    expect(matchShortcut(cmdK, bindings, { isMac: true, inEditable: false })?.id).toBe(
      'palette.toggle',
    )
    // The real row opts in, because the palette is how you leave the field.
    expect(matchShortcut(cmdK, GLOBAL_SHORTCUTS, { isMac: true, inEditable: true })?.id).toBe(
      'palette.toggle',
    )
  })
})

describe('editable detection', () => {
  it('covers the three shapes a caret can live in', () => {
    expect(isEditableTarget({ tagName: 'INPUT' })).toBe(true)
    expect(isEditableTarget({ tagName: 'textarea' })).toBe(true)
    expect(isEditableTarget({ tagName: 'DIV', isContentEditable: true })).toBe(true)
    expect(isEditableTarget({ tagName: 'DIV' })).toBe(false)
    expect(isEditableTarget(null)).toBe(false)
  })
})

describe('hints', () => {
  it('writes Mac glyphs run together and everything else joined', () => {
    expect(shortcutHint(shortcutById('palette.toggle'), true)).toBe('⌘K')
    expect(shortcutHint(shortcutById('palette.toggle'), false)).toBe('Ctrl+K')
    expect(shortcutHint(shortcutById('composer.newline'), false)).toBe('Shift+Enter')
    expect(shortcutHint(shortcutById('palette.back'), false)).toBe('Esc')
  })
})
