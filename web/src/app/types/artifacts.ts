/**
 * The artifact vocabulary: what a candidate is, what the server may say about
 * it, and what "collectible" means.
 *
 * Two facts are encoded in the types rather than in prose, because they are
 * the two rules the whole surface rests on:
 *
 * 1. **A candidate is a guess.** `ArtifactCandidate` has no `exists`, no
 *    `size` and no `updatedAt` — the client scanning a transcript cannot know
 *    any of them, and a shape that let it claim one would make the guess look
 *    like a fact.
 * 2. **`exists: null` is a third state.** `ArtifactTarget.exists` is
 *    `boolean | null`, and `null` means "the server has not answered". Every
 *    collectibility test compares against `true`, so a target that was never
 *    resolved — or that fell outside the resolve batch — is never collectible.
 *    That is D12's two-stage trust as a type invariant instead of a habit.
 */

/** A file inside the project directory, or a URL the transcript mentioned. */
export type ArtifactKind = 'file' | 'url'

/**
 * How an artifact wants to be rendered. The client guesses this from the
 * extension; the server overwrites it on resolve, which is why the panel keys
 * its renderer off the *resolved* value.
 */
export type ArtifactPreview =
  | 'browser'
  | 'markdown'
  | 'sheet'
  | 'slides'
  | 'document'
  | 'image'
  | 'pdf'
  | 'html'
  | 'text'
  | 'external'

/**
 * The provenance ladder.
 *
 * A number, not an enum, because the dedup rule is an inequality: an incoming
 * candidate wins on `>=`, so a later mention of the same file at equal or
 * better provenance replaces the earlier one and a weaker mention never
 * downgrades a stronger one.
 *
 * | weight | source |
 * | --- | --- |
 * | 95 | a write tool's own path arguments, an `apply_patch` header, attachment metadata |
 * | 90 | a write tool's free-text output |
 * | 75 | any other non-discovery tool's payload — **URLs only** |
 * | 65 | assistant prose, and only past the artifact-verb gate for file paths |
 * | 40 | user text |
 *
 * Discovery tools (`glob` / `grep` / `search` / `find`) have no rung at all:
 * they are excluded from the scan wholesale. That single exclusion is what
 * stops one `grep` for `package.json` from putting four hundred entries in the
 * panel, and it is the reason the rest of the ladder can stay this permissive.
 */
export const ARTIFACT_CONFIDENCE = {
  /** A write tool told us the path in its own arguments. */
  writeMetadata: 95,
  /** A write tool said it in prose. */
  writeOutput: 90,
  /** Some other tool's payload mentioned a URL. */
  toolPayload: 75,
  /** The assistant said it. */
  assistantProse: 65,
  /** The user said it. */
  userText: 40,
} as const

export type ArtifactConfidence =
  (typeof ARTIFACT_CONFIDENCE)[keyof typeof ARTIFACT_CONFIDENCE]

/**
 * One thing the transcript pointed at.
 *
 * `id` is the dedup key and doubles as the panel tab id: `file:<lowercased
 * normalized path>` or `url:<cleaned url>`. Lowercasing the file id is what
 * makes `Reports/X.md` and `reports/x.md` one entry on a case-insensitive
 * filesystem; `value` keeps the original casing, because that is what the
 * server has to stat.
 */
export interface ArtifactCandidate {
  id: string
  kind: ArtifactKind
  /** The workspace-relative path, or the cleaned URL. */
  value: string
  /** Basename, for the tab label. */
  name: string
  preview: ArtifactPreview
  confidence: number
  /** Provenance label. Diagnostics and tests, never user-visible copy. */
  reason: string
}

/**
 * A candidate plus whatever the server said about it.
 *
 * The three resolution fields are `null` until `POST
 * /sessions/{id}/artifacts/resolve` answers. `preview` is *overwritten* by the
 * server rather than merged: the server knows the bytes, the client only knew
 * the extension.
 */
export interface ArtifactTarget extends ArtifactCandidate {
  /** `null` = unresolved. Only `true` is collectible. */
  exists: boolean | null
  size: number | null
  /** Opaque freshness token from the server; compared, never parsed. */
  updatedAt: string | null
}
