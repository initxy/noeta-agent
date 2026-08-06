/**
 * What the execution tier actually means, in the words the user reads.
 *
 * These strings are shipped behaviour, not decoration. The `local` tier runs
 * the agent directly on the user's machine with permissions bypassed and no
 * approval prompt (D4) — a deliberate decision, and one the product is only
 * allowed to make because it says so plainly at the moment the choice is
 * offered. `LOCAL_TIER_WARNING` is therefore held here as a named constant and
 * asserted by a test, so that rewording it is a visible change rather than a
 * silent one.
 *
 * Three facts have to survive any future edit:
 *
 * 1. `local` has **no container isolation and no per-call approval**.
 * 2. File writes are fenced to the project directory; **`Bash` is not**.
 * 3. The tier is welded into a session when it starts, so changing it later
 *    applies to **new sessions only** (wire contract §5.2).
 */

import type { ExecutionTier } from '@/app/types'

export const EXECUTION_TIERS: readonly ExecutionTier[] = ['local', 'sandbox'] as const

export const TIER_LABELS: Record<ExecutionTier, string> = {
  local: 'Local',
  sandbox: 'Sandbox (Docker)',
}

export const TIER_SUMMARIES: Record<ExecutionTier, string> = {
  local: 'Runs the agent directly on this machine.',
  sandbox: 'Runs every turn inside a Docker container mounted on the project directory.',
}

/**
 * The safety statement for the `local` tier. Rendered whenever `local` is the
 * selected tier — on creation and in project settings alike.
 */
export const LOCAL_TIER_WARNING =
  'Local runs the agent on this machine with no container isolation and no ' +
  'per-call approval: every tool call executes immediately, as you. File ' +
  'writes are fenced to the project directory, but shell commands are not — a ' +
  'command it runs can read or change anything your user account can.'

/** What the sandbox tier needs in order to be usable at all. */
export const SANDBOX_TIER_NOTE =
  'Sandbox needs Docker running on this machine. The container mounts the ' +
  'project directory, so the agent still works on your real files — it just ' +
  'runs commands inside the container instead of on your machine.'

/** Shown when the backend reports that Docker is not reachable. */
export const SANDBOX_UNAVAILABLE_NOTE =
  'Docker is not reachable from the backend right now, so sessions in this ' +
  'project will not be able to start until it is.'

/**
 * The rule that makes the tier control honest in settings: it is not
 * retroactive. The tier is welded into a session at its first turn and every
 * later turn resolves it from there.
 */
export const TIER_CHANGE_NOTE =
  'Changing the tier applies to new sessions only. A session keeps the tier ' +
  'it was created with for its whole life.'

/**
 * D2's consequence, stated where the directory is chosen: every session in the
 * project works in this one directory, so two running at once can overwrite
 * each other. There is no locking, and this is why the product does not expose
 * `rewind` (D6).
 */
export const SHARED_DIRECTORY_NOTE =
  'Every session in this project works in this directory. Two sessions ' +
  'running at the same time can change the same files.'

export function tierWarning(tier: ExecutionTier): string {
  return tier === 'local' ? LOCAL_TIER_WARNING : SANDBOX_TIER_NOTE
}
