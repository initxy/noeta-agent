/**
 * Two-stage trust: the client guesses, the server decides (D12).
 *
 * The derivation engine produces candidates from a transcript. Nothing in this
 * product can tell from a transcript whether a file exists — under the
 * `sandbox` tier the bytes live inside a container, and under `local` the agent
 * may have written, moved or deleted them since. So a candidate stays
 * `exists: null` until `POST /sessions/{id}/artifacts/resolve` stats it, and
 * every collectibility test compares against `true`.
 *
 * That is why the failure path degrades the way it does: a resolve that never
 * answered leaves every file target unresolved and therefore uncollectible. An
 * empty panel is the correct rendering of "we do not know"; a panel full of
 * entries that 404 on click is not.
 */

import { ARTIFACT_RESOLVE_CAP } from './derive'
import { basename, classifyPreview, fileId } from './classify'
import { ARTIFACT_CONFIDENCE } from '../types/artifacts'
import type { ArtifactCandidate, ArtifactPreview, ArtifactTarget } from '../types/artifacts'
import type { ResolvedArtifact, WorkspaceFile } from '../types/wire'

/**
 * The previews worth a panel tab.
 *
 * `text` and `external` are openable — a click downloads them or hands them to
 * the OS — but they never become a tab. A `.ts` is source, not an artifact, and
 * putting every one the agent touched in the panel is what the whole ladder
 * exists to avoid.
 */
export const COLLECTIBLE_PREVIEWS: ReadonlySet<ArtifactPreview> = new Set<ArtifactPreview>([
  'markdown',
  'sheet',
  'slides',
  'document',
  'image',
  'pdf',
  'html',
])

const KNOWN_PREVIEWS: ReadonlySet<string> = new Set<ArtifactPreview>([
  'browser',
  'markdown',
  'sheet',
  'slides',
  'document',
  'image',
  'pdf',
  'html',
  'text',
  'external',
])

/** Schemes a URL candidate may carry. Anything else is not a link we offer. */
const ALLOWED_URL_PROTOCOLS: ReadonlySet<string> = new Set([
  'http:',
  'https:',
  'ws:',
  'wss:',
])

/** A candidate, before anyone has confirmed anything about it. */
export function unresolvedTarget(candidate: ArtifactCandidate): ArtifactTarget {
  return { ...candidate, exists: null, size: null, updatedAt: null }
}

/**
 * A URL's own resolution, decided here rather than round-tripped.
 *
 * A URL has nothing on disk to stat; the only check that means anything is its
 * scheme, and asking the backend to run it would be a request whose answer the
 * client already holds. This never makes a URL *collectible* — that requires
 * `kind === 'file'` — it only makes it openable.
 */
function resolveUrl(candidate: ArtifactCandidate): ArtifactTarget {
  let exists = false
  try {
    exists = ALLOWED_URL_PROTOCOLS.has(new URL(candidate.value).protocol)
  } catch {
    exists = false
  }
  return { ...candidate, exists, size: null, updatedAt: null }
}

/** The file paths a resolve request should carry, best provenance first. */
export function resolvablePaths(
  candidates: readonly ArtifactCandidate[],
  cap: number = ARTIFACT_RESOLVE_CAP,
): string[] {
  const paths: string[] = []
  for (const candidate of candidates) {
    if (candidate.kind !== 'file') continue
    paths.push(candidate.value)
    if (paths.length >= cap) break
  }
  return paths
}

/**
 * Fold the server's verdict into the candidate list.
 *
 * The server's `preview` overwrites the client's guess: the client classified
 * by extension, the server saw the bytes. A candidate the response does not
 * mention — because it fell outside the batch cap, or because the server
 * declined it — keeps `exists: null` and stays uncollectible. Silence is not
 * consent.
 */
export function applyResolution(
  candidates: readonly ArtifactCandidate[],
  resolved: readonly ResolvedArtifact[],
): ArtifactTarget[] {
  const byPath = new Map(resolved.map((entry) => [entry.path, entry]))
  return candidates.map((candidate) => {
    if (candidate.kind === 'url') return resolveUrl(candidate)
    const answer = byPath.get(candidate.value)
    if (!answer) return unresolvedTarget(candidate)
    const preview =
      answer.preview && KNOWN_PREVIEWS.has(answer.preview)
        ? (answer.preview as ArtifactPreview)
        : candidate.preview
    return {
      ...candidate,
      preview,
      exists: answer.exists,
      size: answer.size,
      updatedAt: answer.updatedAt,
    }
  })
}

/**
 * What to show when the resolve request itself failed.
 *
 * URLs survive — their resolution never depended on the server. Files do not:
 * they stay unresolved, which means the panel shows nothing rather than showing
 * guesses it cannot back up.
 */
export function degradeUnresolved(candidates: readonly ArtifactCandidate[]): ArtifactTarget[] {
  return candidates.map((candidate) =>
    candidate.kind === 'url' ? resolveUrl(candidate) : unresolvedTarget(candidate),
  )
}

/**
 * A target built from the file listing rather than from the transcript.
 *
 * This is not a hole in two-stage trust, it is the other end of it: the
 * listing *is* the server's answer about that file, produced by the same stat
 * the resolve endpoint runs. A file the user picked out of the listing has
 * been confirmed by definition, so it arrives already resolved and the panel
 * can open it without a second round trip.
 */
export function targetFromWorkspaceFile(file: WorkspaceFile): ArtifactTarget {
  return {
    id: fileId(file.path.toLowerCase()),
    kind: 'file',
    value: file.path,
    name: basename(file.path),
    preview: classifyPreview(file.path, 'file'),
    confidence: ARTIFACT_CONFIDENCE.writeMetadata,
    reason: 'file listing',
    exists: true,
    size: file.size,
    updatedAt: String(file.mtime),
  }
}

/** Worth a panel tab: a file that exists, of a kind this product can render. */
export function isCollectibleArtifact(target: ArtifactTarget): boolean {
  return (
    target.kind === 'file' && target.exists === true && COLLECTIBLE_PREVIEWS.has(target.preview)
  )
}

/** Worth a click: a file that exists, whatever it is. Download or hand off. */
export function isOpenableArtifact(target: ArtifactTarget): boolean {
  return target.kind === 'file' && target.exists === true
}

/** A URL pointing at something the sandbox itself is serving. */
export function isLocalhostArtifact(target: ArtifactTarget): boolean {
  return (
    target.kind === 'url' &&
    /^(?:https?|wss?):\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::|\/|$)/i.test(
      target.value,
    )
  )
}

/**
 * Which artifact opens on its own. None, ever.
 *
 * Kept as a function rather than left unwritten so the decision is visible and
 * pinned by a test. An agent that writes six files mid-turn would otherwise
 * yank the panel open six times over a conversation the user is still reading.
 * A human always clicks.
 */
export function selectAutoOpenArtifact(_targets: readonly ArtifactTarget[]): null {
  return null
}

/**
 * Has the bytes behind this target changed since we last looked?
 *
 * The reference compared transcript target lists by id and position only, so a
 * file rewritten under an open tab kept rendering the bytes it was opened with
 * and then failed its next save. Comparing the freshness fields is what turns
 * that into a refetch.
 */
export function artifactChanged(before: ArtifactTarget, after: ArtifactTarget): boolean {
  return (
    before.exists !== after.exists ||
    before.size !== after.size ||
    before.updatedAt !== after.updatedAt
  )
}
