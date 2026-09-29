/**
 * The project directory, checked before it is sent.
 *
 * A project *is* a directory (D2), so this is the field the create form
 * really turns on. The backend rejects a non-absolute path with a 422 and the
 * client could simply render that — but the round trip is the wrong place to
 * learn it: the user has already committed the form, the message arrives after
 * a network hop, and on a first run it is the very first thing the product
 * says. Checking here makes the answer immediate and the request never happen.
 *
 * This is a *guard*, not a substitute: the backend's check is the real one
 * (it also owns "does it exist", "is it already a project", and the race
 * between the two), and it stays authoritative. What is duplicated here is
 * only the rule that is knowable without the filesystem.
 *
 * Pure string work, no `path` module: this runs in a browser, and the paths it
 * validates belong to the machine the *backend* runs on.
 */

/** Absolute on POSIX (`/srv/x`), on Windows (`C:\x`, `C:/x`) or UNC (`\\host\share`). */
const ABSOLUTE = /^(\/|[A-Za-z]:[\\/]|\\\\)/

export type DirectoryCheck =
  | { ok: true; directory: string }
  | { ok: false; message: string }

export const DIRECTORY_HINT = 'for example /home/you/code/my-project'

/**
 * Validate and normalise a typed project directory.
 *
 * Trailing slashes are trimmed so `/srv/app` and `/srv/app/` cannot become
 * two projects on one directory — the backend treats the directory as the
 * project's identity, and the duplicate would only be caught by whichever
 * spelling was stored first.
 */
export function checkProjectDirectory(raw: string): DirectoryCheck {
  const value = raw.trim()

  if (!value) {
    return { ok: false, message: `Enter the project directory as an absolute path — ${DIRECTORY_HINT}.` }
  }
  if (value.startsWith('~')) {
    // The backend does not expand `~` for a user-supplied project directory,
    // so a path that looks right here would land as a literal directory named
    // "~" next to wherever the server was started.
    return {
      ok: false,
      message: `A path starting with ~ is not expanded. Write it out in full — ${DIRECTORY_HINT}.`,
    }
  }
  if (!ABSOLUTE.test(value)) {
    return {
      ok: false,
      message: `The directory must be an absolute path — ${DIRECTORY_HINT}.`,
    }
  }

  // Keep a bare root as itself: trimming "/" to "" would turn a legal (if
  // unwise) path into an empty one.
  const trimmed = value.length > 1 ? value.replace(/[\\/]+$/, '') : value
  return { ok: true, directory: trimmed || value }
}

/**
 * A directory name derived from the project name.
 *
 * Deliberately conservative — lowercase, ASCII letters, digits and single
 * hyphens — because the result becomes a real directory on someone's disk and
 * then a path in every shell command the agent runs. A name that is entirely
 * punctuation or non-Latin yields nothing, and the caller falls back rather
 * than creating a directory called `---`.
 */
export function directorySlug(name: string): string {
  return name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

/**
 * The path "create the directory for me" proposes: `<root>/<slug>`.
 *
 * Empty when there is no root to hang it on or no usable slug — the form then
 * shows no suggestion instead of a half-built path the user has to repair.
 */
export function suggestProjectDirectory(root: string, name: string): string {
  const base = root.trim().replace(/[\\/]+$/, '')
  const slug = directorySlug(name)
  if (!base || !slug) return ''
  return `${base}/${slug}`
}
