/**
 * The artifact derivation engine.
 *
 * One pure function over the folded transcript. No React, no fetch, no store —
 * which is what lets the whole provenance ladder be tested as a table and what
 * lets a second surface (the in-conversation file strip) reuse it without
 * inheriting the panel.
 *
 * The engine is a **provenance-weighted scan**, not a heuristic pile. Each
 * source contributes candidates at a fixed weight (see `ARTIFACT_CONFIDENCE`),
 * candidates are deduped by id with higher-or-equal confidence winning, and the
 * result is sorted by confidence. What makes it work is not the ladder but the
 * exclusion beneath it:
 *
 * **Discovery tools are excluded wholesale.** A `glob`, `grep`, `search` or
 * `find` contributes nothing at any rung — not its paths, not its URLs. Their
 * entire output is a list of files the agent is *looking at*, not files it
 * *produced*, and one `grep` for an import turns the panel into a directory
 * listing. Every other rule in this file is tuning; this one is structural.
 *
 * What is deliberately not scanned:
 *
 * - **thinking**, because it is the model's scratchpad and names paths it is
 *   still deciding about;
 * - **recall**, because a memory hit is a quote from another conversation and
 *   its files are not this session's artifacts;
 * - **tool arguments of non-write tools**, for paths — a `read` names the file
 *   it read, and scanning those would put every file the agent merely glanced
 *   at in the panel.
 */

import { candidateFromFile } from './classify'
import { fileMetadataValues, mentionsArtifact, patchFileValues, scanText } from './scan'
import { ARTIFACT_CONFIDENCE } from '../types/artifacts'
import type { ArtifactCandidate } from '../types/artifacts'
import type { ConversationItem, StepItem } from '../fold/items'

/**
 * Tools whose arguments name a file the agent is writing. Matched after
 * `normalizedToolName` lower-cases the name, so the reference builtins
 * (`Write`, `Edit`) match their lowercase entries here; the rest are the names
 * MCP servers conventionally use for the same operation.
 */
export const WRITE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'apply_patch',
  'edit',
  'edit_file',
  'multi_edit',
  'multiedit',
  'patch',
  'str_replace_editor',
  'write',
  'write_file',
])

/**
 * The exclusion. Exactly the four names, matched after normalisation.
 *
 * Deliberately not widened to "anything containing `search`": a name-substring
 * rule would swallow a legitimate `web_search` result set that a user does want
 * as links, and widening a *silencing* rule on a guess is how a surface starts
 * losing things nobody can explain. Add a name here when a real tool floods the
 * panel, not before.
 */
export const DISCOVERY_TOOL_NAMES: ReadonlySet<string> = new Set([
  'glob',
  'grep',
  'search',
  'find',
])

/**
 * The cap on one resolve batch.
 *
 * The derivation itself is unbounded — it is a pure pass over a list already in
 * memory — but the round trip that turns guesses into facts stats a file per
 * entry, so it takes the top of the ladder and stops.
 */
export const ARTIFACT_RESOLVE_CAP = 80

/** Strip the wrapper prefixes providers put in front of a tool's real name. */
export function normalizedToolName(name: string): string {
  return name.trim().toLowerCase().replace(/^functions[._-]/, '')
}

export interface DeriveOptions {
  /**
   * The project directory. Absolute paths under it become workspace-relative;
   * absolute paths outside it are dropped. Without it, a `local` project — where
   * the agent sees and prints real host paths — derives almost nothing.
   */
  workspaceRoot?: string | null
  /**
   * Scan user text for file paths too. Off by default and off in production:
   * a user pasting a stack trace would otherwise fill the panel with files they
   * were complaining about.
   */
  includeUserFileMentions?: boolean
}

/**
 * Dedup by id, higher-or-equal confidence winning.
 *
 * `>=` rather than `>` so a later mention at the same rung replaces the earlier
 * one — the later one is the more recent statement about the same file. `Map`
 * keeps the first-seen insertion order across a replace, so the sort below can
 * stay stable on first mention.
 */
function addCandidate(map: Map<string, ArtifactCandidate>, candidate: ArtifactCandidate): void {
  const existing = map.get(candidate.id)
  if (existing && candidate.confidence < existing.confidence) return
  map.set(candidate.id, candidate)
}

function addAll(map: Map<string, ArtifactCandidate>, candidates: readonly ArtifactCandidate[]) {
  for (const candidate of candidates) addCandidate(map, candidate)
}

function jsonPayload(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    // Circular or otherwise unserialisable arguments are not worth a throw
    // that would take the whole panel down with them.
    return ''
  }
}

function scanStep(
  map: Map<string, ArtifactCandidate>,
  step: StepItem,
  root: string | null | undefined,
): void {
  const tool = normalizedToolName(step.toolName)
  if (DISCOVERY_TOOL_NAMES.has(tool)) return

  if (WRITE_TOOL_NAMES.has(tool)) {
    for (const value of fileMetadataValues(step.args)) {
      const candidate = candidateFromFile(
        value,
        ARTIFACT_CONFIDENCE.writeMetadata,
        'write tool metadata',
        root,
      )
      if (candidate) addCandidate(map, candidate)
    }
    for (const value of patchFileValues(step.args)) {
      const candidate = candidateFromFile(
        value,
        ARTIFACT_CONFIDENCE.writeMetadata,
        'patch metadata',
        root,
      )
      if (candidate) addCandidate(map, candidate)
    }
    // A write tool's own prose is the second-best evidence there is: it is
    // describing what it just did, so paths are in scope here and nowhere else
    // below 95.
    const options = {
      confidence: ARTIFACT_CONFIDENCE.writeOutput,
      reason: 'write tool output',
      includeFiles: true,
      root,
    }
    addAll(map, scanText(step.summary ?? '', options))
    addAll(map, scanText(step.output ?? '', options))
    return
  }

  // Every other tool: URLs only. A server that just started, a page that was
  // fetched, a preview link — those are real. Its file paths are not, because
  // naming a file is not producing one.
  const options = {
    confidence: ARTIFACT_CONFIDENCE.toolPayload,
    reason: 'tool payload',
    includeFiles: false,
    root,
  }
  const output = `${step.summary ?? ''}\n${step.output ?? ''}`.trim()
  addAll(map, scanText(output || jsonPayload(step.args), options))
}

/**
 * Scan a whole transcript.
 *
 * Returns candidates sorted by confidence, ties in first-mention order. Nothing
 * here is a fact yet: every entry is a guess the server has to confirm before
 * the panel will collect it (D12).
 */
export function deriveArtifactCandidates(
  items: readonly ConversationItem[],
  options: DeriveOptions = {},
): ArtifactCandidate[] {
  const root = options.workspaceRoot ?? null
  const includeUserFiles = options.includeUserFileMentions === true
  const map = new Map<string, ArtifactCandidate>()

  for (const item of items) {
    switch (item.kind) {
      case 'user':
        addAll(
          map,
          scanText(item.content, {
            confidence: ARTIFACT_CONFIDENCE.userText,
            reason: 'user message',
            includeFiles: includeUserFiles,
            root,
          }),
        )
        break

      case 'assistant':
        addAll(
          map,
          scanText(item.text, {
            confidence: ARTIFACT_CONFIDENCE.assistantProse,
            reason: 'assistant message',
            includeFiles: mentionsArtifact(item.text),
            root,
          }),
        )
        break

      case 'subtask':
        // A subagent's summary is the only place its work is described on the
        // main stream — its own tool calls never reach the parent transcript.
        if (item.summary) {
          addAll(
            map,
            scanText(item.summary, {
              confidence: ARTIFACT_CONFIDENCE.assistantProse,
              reason: 'subtask summary',
              includeFiles: mentionsArtifact(item.summary),
              root,
            }),
          )
        }
        break

      case 'step':
        scanStep(map, item, root)
        break

      default:
        break
    }
  }

  return [...map.values()].sort((a, b) => b.confidence - a.confidence)
}

/**
 * The change key for a derived set.
 *
 * The resolve round trip fires when this changes and not when the transcript
 * does — a streaming turn re-derives on every frame and would otherwise POST
 * per token.
 */
export function artifactFingerprint(candidates: readonly ArtifactCandidate[]): string {
  return candidates.map((c) => `${c.kind}:${c.value}:${c.confidence}`).join('|')
}
