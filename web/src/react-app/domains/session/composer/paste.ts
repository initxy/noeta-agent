/**
 * Paste, as the composer sees it: the policy in `@/app/paste` wired to the
 * three things a composer can do about it.
 *
 * ```
 * files            → preventDefault, hand them to the attachment intake
 * text/uri-list    → preventDefault, append the links to the draft as text
 * plain text       → collapse to a chip if it is long, otherwise DO NOTHING
 * ```
 *
 * That last "do nothing" is the load-bearing one. A short plain-text paste is
 * not prevented, not re-inserted and not normalized — the browser puts it in
 * the box. Every bug this module exists to prevent came from a handler that
 * decided it could do the insertion better and lost the newlines, the caret
 * position, or the undo stack doing it.
 *
 * A collapsed paste becomes a **bracket token inside the draft string**
 * (`[pasted text <label>]`) plus an entry in a side table. The draft stays one
 * plain string, which is what lets it be persisted, restored across the
 * new-task→session handoff, merged in the queue and re-rendered from nothing
 * but its own text.
 */

import { classifyPaste, measurePastedText, shouldCollapsePaste } from '@/app/paste'
import type { PasteFit } from '@/app/paste'

/** The full text behind one collapsed-paste chip. */
export interface PastedTextPart {
  /**
   * The token's identity key — unique, stable for as long as the chip lives,
   * and the React key the chip renders under. Not user-facing copy;
   * `pastedTextChipLabel` is.
   */
  label: string
  text: string
  lines: number
}

/** Matches every `[pasted text <label>]` token in a draft. */
const PASTED_TEXT_TOKEN = /\[pasted text ([^\]]+)\]/g

let pasteCounter = 0

export function pastedTextToken(label: string): string {
  return `[pasted text ${label}]`
}

/** What the chip shows a person: the count, not the key. */
export function pastedTextChipLabel(part: PastedTextPart): string {
  return `Pasted · ${part.lines} ${part.lines === 1 ? 'line' : 'lines'}`
}

export function createPastedTextPart(text: string): PastedTextPart {
  pasteCounter += 1
  const lines = text.split(/\r?\n/).length
  // A counter and not a random suffix: two chips sharing a label would make
  // `resolvePastedText` substitute the same body twice and lose one paste.
  return { label: `${pasteCounter.toString(36)} · ${lines} lines`, text, lines }
}

/**
 * The token goes at the **end** of the draft, never at the caret.
 *
 * A chip dropped mid-sentence splits the sentence around a body of text the
 * user cannot see. Appending keeps the instruction they are writing readable
 * and puts the material after it, which is the order a person would have
 * typed anyway.
 */
export function appendPastedTextToken(draft: string, label: string): string {
  const token = pastedTextToken(label)
  if (draft === '') return `${token} `
  return `${draft}${draft.endsWith(' ') || draft.endsWith('\n') ? '' : ' '}${token} `
}

/** Dropped links, one per line, after whatever the user was already writing. */
export function appendLinks(draft: string, links: readonly string[]): string {
  if (links.length === 0) return draft
  const body = links.join('\n')
  if (draft === '') return body
  return `${draft}${draft.endsWith('\n') ? '' : '\n'}${body}`
}

/** The draft as the model should see it: every chip replaced by its body. */
export function resolvePastedText(draft: string, parts: readonly PastedTextPart[]): string {
  if (parts.length === 0) return draft
  const byLabel = new Map(parts.map((part) => [part.label, part]))
  // An unknown label is left standing rather than deleted. It can only appear
  // through a bug, and dropping text the user can see is the worse failure.
  return draft.replace(PASTED_TEXT_TOKEN, (token, label: string) => byLabel.get(label)?.text ?? token)
}

/** Every label the draft still mentions — the side table reconciled to the text. */
export function referencedPasteLabels(draft: string): Set<string> {
  const labels = new Set<string>()
  for (const match of draft.matchAll(PASTED_TEXT_TOKEN)) labels.add(match[1])
  return labels
}

/**
 * The parts still referenced by the draft.
 *
 * Called after every draft change: deleting a chip with Backspace removes the
 * token and nothing else, so the side table has to be reconciled *from* the
 * text rather than by a removal callback that a keystroke can bypass.
 */
export function retainReferencedPastes(
  draft: string,
  parts: readonly PastedTextPart[],
): PastedTextPart[] {
  const labels = referencedPasteLabels(draft)
  return parts.filter((part) => labels.has(part.label))
}

/** Expand: the chip becomes its own text, in place. */
export function expandPastedText(draft: string, part: PastedTextPart): string {
  return draft.replace(pastedTextToken(part.label), part.text)
}

/** Which branch a paste took. Returned so callers and tests can assert it. */
export type PasteBranch = 'files' | 'links' | 'collapsed' | 'text'

export interface PasteEventLike {
  clipboardData: DataTransfer | null
  preventDefault: () => void
}

export interface PasteTargets {
  /** Every file on the clipboard, images or not — the intake decides and reports why. */
  attach: (files: readonly File[]) => void
  /** A `text/uri-list` drop, already parsed and deduped. */
  links: (links: readonly string[]) => void
  /** A paste too big for the box. */
  collapse: (part: PastedTextPart) => void
}

/**
 * Route one paste. Prevents the default event only on the branches it consumes.
 */
export function handleComposerPaste(
  event: PasteEventLike,
  fit: PasteFit,
  targets: PasteTargets,
): PasteBranch {
  const intent = classifyPaste(event.clipboardData)

  if (intent.kind === 'files') {
    event.preventDefault()
    targets.attach(intent.files)
    return 'files'
  }

  if (intent.kind === 'links') {
    event.preventDefault()
    targets.links(intent.links)
    return 'links'
  }

  if (shouldCollapsePaste(intent.text, measurePastedText(intent.text, fit))) {
    event.preventDefault()
    targets.collapse(createPastedTextPart(intent.text))
    return 'collapsed'
  }

  // Deliberately untouched: no preventDefault, no insertion of our own.
  return 'text'
}
