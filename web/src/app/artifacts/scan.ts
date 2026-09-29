/**
 * The text scanner: one string in, candidates out.
 *
 * Every global regex here is walked with `matchAll`, which clones the pattern
 * rather than advancing its `lastIndex`. Module-level `/g` regexes shared
 * between call sites and driven with `.exec` are a classic source of "the
 * second file in the same message is invisible", and the clone is what makes
 * these functions safe to call in any order.
 */

import {
  ARTIFACT_VERB_PATTERN,
  FILE_PATTERN,
  MARKDOWN_LINK_PATTERN,
  PATCH_FILE_PATTERN,
  PATCH_MOVE_TO_PATTERN,
  SOCKET_PATTERN,
  URL_PATTERN,
  basename,
  candidateFromFile,
  candidateFromUrl,
} from './classify'
import type { ArtifactCandidate } from '../types/artifacts'

export interface ScanOptions {
  confidence: number
  reason: string
  /**
   * Whether file paths are collected at all. URLs always are — a URL in text
   * is unambiguous, a path is not.
   */
  includeFiles: boolean
  /** The project directory, used to relativise absolute paths. */
  root?: string | null
}

const HTTP_LINK_PATTERN = /^(?:https?|wss?):\/\//i

/** Does this prose pass the artifact-verb gate? */
export function mentionsArtifact(text: string): boolean {
  return ARTIFACT_VERB_PATTERN.test(text)
}

/**
 * Rewrite `[label](href)` to `[](href)` when the label is just the href's
 * basename.
 *
 * The "one target, not two" rule. `[native-link.txt](reports/native-link.txt)`
 * is one mention written twice and must yield one candidate;
 * `[summary.md](reports/native-link.txt)` names two different things and
 * genuinely is two mentions.
 */
export function withoutRedundantLinkLabels(text: string): string {
  return text.replace(MARKDOWN_LINK_PATTERN, (match, label: string, href: string) =>
    label.trim() === basename(href.trim()) ? `[](${href})` : match,
  )
}

export function scanText(text: string, options: ScanOptions): ArtifactCandidate[] {
  if (!text) return []
  const { confidence, reason, includeFiles, root } = options
  const found: ArtifactCandidate[] = []
  const push = (candidate: ArtifactCandidate | null) => {
    if (candidate) found.push(candidate)
  }

  // Markdown links run against the RAW text: the rewrite below removes the
  // label, and the label is what tells a link apart from a second mention.
  for (const match of text.matchAll(MARKDOWN_LINK_PATTERN)) {
    const href = match[2]
    if (HTTP_LINK_PATTERN.test(href)) {
      push(candidateFromUrl(href, confidence, reason))
    } else if (includeFiles) {
      push(candidateFromFile(href, confidence, reason, root))
    }
  }

  const scanValue = includeFiles ? withoutRedundantLinkLabels(text) : text

  for (const match of scanValue.matchAll(URL_PATTERN)) {
    push(candidateFromUrl(match[0], confidence, reason))
  }
  for (const match of scanValue.matchAll(SOCKET_PATTERN)) {
    push(candidateFromUrl(match[0], confidence, reason))
  }

  if (!includeFiles) return found

  for (const match of scanValue.matchAll(FILE_PATTERN)) {
    push(candidateFromFile(match[1], confidence, reason, root))
  }
  return found
}

// ---------------------------------------------------------------------------
// Structured sources
// ---------------------------------------------------------------------------

/** Argument keys a write tool uses to name its target. */
const FILE_METADATA_KEYS = ['path', 'file', 'filePath', 'filepath', 'file_path']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The paths a write tool named in its own arguments.
 *
 * This is the 95 rung and the reason it is the top of the ladder: the tool is
 * not describing a file, it is being told which file to write. No regex, no
 * prose, no ambiguity.
 */
export function fileMetadataValues(payload: unknown): string[] {
  if (!isRecord(payload)) return []
  const values: string[] = []
  for (const key of FILE_METADATA_KEYS) {
    const value = payload[key]
    if (typeof value === 'string' && value) values.push(value)
  }
  const files = payload.files
  if (Array.isArray(files)) {
    for (const entry of files) {
      if (typeof entry === 'string' && entry) values.push(entry)
    }
  }
  return values
}

/**
 * The files an `apply_patch` body touches, read from its headers.
 *
 * A patch names its targets in a format the tool itself parses, so these are
 * as trustworthy as an argument — and they are the only way to learn the
 * second and third file of a multi-file patch, whose `path` argument names
 * none of them.
 */
export function patchFileValues(payload: unknown): string[] {
  if (!isRecord(payload)) return []
  const body =
    (typeof payload.patchText === 'string' && payload.patchText) ||
    (typeof payload.patch === 'string' && payload.patch) ||
    (typeof payload.diff === 'string' && payload.diff) ||
    ''
  if (!body) return []

  const values: string[] = []
  for (const match of body.matchAll(PATCH_FILE_PATTERN)) values.push(match[1].trim())
  for (const match of body.matchAll(PATCH_MOVE_TO_PATTERN)) values.push(match[1].trim())
  return values
}
