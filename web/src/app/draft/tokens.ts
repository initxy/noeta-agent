/**
 * The composer draft: **one plain string**, and the grammar that gives it chips.
 *
 * Everything rich a user can put in the box — a file mention, a pinned skill, a
 * collapsed paste, an attachment — is a bracket token embedded in that one
 * string, with side tables supplying the metadata a token cannot carry. That is
 * the whole design, and it is chosen for four consequences rather than for
 * elegance:
 *
 * - a draft is **persistable** as a string, with no editor model to version;
 * - a draft is **seedable** across the new-task → session handoff, because the
 *   surface that receives it only has to receive a string;
 *   (the composer already keys drafts by session for exactly this reason);
 * - drafts are **mergeable**: the queue drains as one message, and joining two
 *   token strings is string concatenation;
 * - the queued panel **renders the same chips as the editor** by running the
 *   same split, with no second renderer to drift.
 *
 * The editor is a *view* over this string. Its only job is rehydrating tokens
 * into chips, which is why the parse lives here — pure, react-free, and shared
 * by the editor, the send path and anything that has to show a draft it is not
 * editing.
 *
 * ## The grammar
 *
 * ```
 * @<percent-encoded value>   mention chip; the kind is looked up in a side table
 * [skill <name>]             a skill pinned for the turn
 * [pasted text <label>]      a collapsed paste          (reserved)
 * [attachment <id>]          an attachment thumbnail    (reserved)
 * /<name> <rest>             a slash command, draft-initial only (see ./triggers)
 * ```
 *
 * The two **reserved** shapes are in the master regex and are classified, but
 * nothing produces them yet and the send path passes them through untouched:
 * they belong to the paste/attachment work. Declaring them here now means that
 * work adds metadata and a chip, not a second parser — and a parser that only
 * half of the product agrees with is exactly how a draft stops round-tripping.
 *
 * ## The invariant everything else rests on
 *
 * `serializeDraft(splitDraft(s)) === s` for **every** string, including the
 * empty draft and a draft that is nothing but a token. Segments carry their
 * exact source text, so serialization is a join and cannot re-encode anything.
 */

/** What a mention refers to. Only files today; the table exists so the editor
 *  can refuse to render a chip for an `@word` the user merely typed. */
export type MentionKind = 'file'

/**
 * Decoded mention value → kind, for the mentions a draft is known to carry.
 *
 * Additive by design: a value stays in the table after the draft that
 * introduced it is cleared, because a queued draft is a bare string and its
 * chips have to survive until the queue drains.
 */
export type MentionTable = Readonly<Record<string, MentionKind>>

export type DraftSegmentKind = 'text' | 'mention' | 'skill' | 'pasted' | 'attachment'

export interface DraftSegment {
  kind: DraftSegmentKind
  /** The exact source text. Joining these back yields the draft, byte for byte. */
  text: string
  /**
   * The kind's payload: a **decoded** mention value, a skill name, a paste
   * label, an attachment id — and, for plain text, the text itself.
   */
  value: string
}

/**
 * The one split regex.
 *
 * Written once and exported because the editor, the queued panel and the send
 * path must agree on where a token begins; three copies of this pattern is
 * three chances for a chip to render in one place and not another.
 *
 * The bracket alternatives come first: `[^\]]+` cannot cross a `]`, so the
 * longest-first ordering that a naive alternation would need is not required,
 * but keeping them ahead of `@` keeps the intent readable. `@[^\s@]+` is what
 * makes a mention a single token — it is also why the value encoding below
 * escapes spaces and nothing else.
 */
export const DRAFT_TOKEN_RE =
  /(\[attachment [^\]]+\]|\[pasted text [^\]]+\]|\[skill [^\]]+\]|@[^\s@]+)/

const SKILL_PREFIX = '[skill '
const PASTED_PREFIX = '[pasted text '
const ATTACHMENT_PREFIX = '[attachment '

/**
 * Escape a mention value so it survives as one `@token`.
 *
 * `%` first and `%20` last is not stylistic: doing it the other way round turns
 * a literal `%20` the user typed into a space on the way back.
 */
export function encodeMentionValue(value: string): string {
  return value.replaceAll('%', '%25').replaceAll(' ', '%20')
}

export function decodeMentionValue(value: string): string {
  return value.replaceAll('%20', ' ').replaceAll('%25', '%')
}

function classifyToken(token: string): DraftSegment {
  if (token.startsWith('@')) {
    return { kind: 'mention', text: token, value: decodeMentionValue(token.slice(1)) }
  }
  const inner = (prefix: string) => token.slice(prefix.length, -1)
  if (token.startsWith(SKILL_PREFIX)) {
    return { kind: 'skill', text: token, value: inner(SKILL_PREFIX) }
  }
  if (token.startsWith(PASTED_PREFIX)) {
    return { kind: 'pasted', text: token, value: inner(PASTED_PREFIX) }
  }
  return { kind: 'attachment', text: token, value: inner(ATTACHMENT_PREFIX) }
}

/**
 * Split a draft into text and tokens, in order.
 *
 * Classification is by **position**, not by re-testing the piece: `split` with
 * one capture group alternates text, separator, text, separator, so odd indices
 * are tokens by construction. Re-testing would be a second implementation of
 * the same decision, and the two would eventually disagree on an edge the
 * regex already settled.
 *
 * Empty pieces are dropped — a leading or trailing token produces them — which
 * costs nothing, because joining `''` back in changes no string.
 */
export function splitDraft(draft: string): DraftSegment[] {
  const segments: DraftSegment[] = []
  draft.split(DRAFT_TOKEN_RE).forEach((piece, index) => {
    if (piece === '') return
    segments.push(
      index % 2 === 1 ? classifyToken(piece) : { kind: 'text', text: piece, value: piece },
    )
  })
  return segments
}

/** The inverse of {@link splitDraft}, exactly. */
export function serializeDraft(segments: readonly DraftSegment[]): string {
  return segments.map((segment) => segment.text).join('')
}

/** The token spelling of a mention, ready to be embedded in a draft. */
export function mentionToken(value: string): string {
  return `@${encodeMentionValue(value)}`
}

/** The token spelling of a pinned skill. */
export function skillToken(name: string): string {
  return `${SKILL_PREFIX}${name}]`
}
