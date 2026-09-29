/**
 * Restore memory for the route — and nothing more than memory.
 *
 * The URL is authoritative: which project is open is a fact about the address
 * bar, never about a store (D9). What is left over is a smaller question — "a
 * URL named a project that no longer exists, so where should the user land?"
 * — and answering it with the first project in the list throws away the one
 * thing the user already told us. That is all this module holds.
 *
 * Two rules keep it from growing into a second source of truth:
 *
 * - It is read **only** when the URL has nothing usable, and the value is
 *   discarded when it names something that no longer exists.
 * - There is deliberately **no last-session memory.** A cold start with no
 *   session in the URL lands on the empty project surface, not on whatever
 *   was open last time; restoring it would make a bookmark and a fresh boot
 *   disagree about what the address bar means.
 *
 * Storage access goes through `readStored`/`writeStored` because
 * `localStorage` is not merely absent under SSR and in tests — Safari's
 * private mode throws on write, and a shell that cannot remember a project id
 * must still render.
 */

const LAST_PROJECT_KEY = 'noeta.route.lastProject'

function storage(): Storage | null {
  try {
    if (typeof localStorage === 'undefined') return null
    return localStorage
  } catch {
    return null
  }
}

export function readStored(key: string): string | null {
  try {
    return storage()?.getItem(key) ?? null
  } catch {
    return null
  }
}

export function writeStored(key: string, value: string | null): void {
  try {
    const store = storage()
    if (!store) return
    if (value === null || value === '') store.removeItem(key)
    else store.setItem(key, value)
  } catch {
    // A browser that refuses to persist is a browser that forgets. That is a
    // degraded experience, not a failure worth surfacing.
  }
}

/** The last project the user actually had open. Fallback only. */
export function readLastProjectId(): string | null {
  const value = readStored(LAST_PROJECT_KEY)
  return value && value.trim() ? value : null
}

export function writeLastProjectId(projectId: string | null): void {
  writeStored(LAST_PROJECT_KEY, projectId)
}
