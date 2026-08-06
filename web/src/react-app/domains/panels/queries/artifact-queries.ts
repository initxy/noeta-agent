/**
 * The panel's server state.
 *
 * Three deliberate departures from the reference, each of them a bug it
 * shipped:
 *
 * 1. **No `staleTime: Infinity` on artifact content.** Under D2 every session
 *    of a project shares one directory, so the agent rewriting a file while
 *    its tab is open is the normal case, not a race. Content is refetched on
 *    focus, and the resolve pass explicitly invalidates a target whose
 *    freshness fields moved.
 * 2. **`base_mtime` comes from the read that produced the bytes**, never from
 *    the artifact's resolve-time metadata. Locking against a stat from an
 *    unrelated moment is how an editor "checks" and still clobbers.
 * 3. **Binary previews are `src` URLs, not ArrayBuffers.** An image or a PDF
 *    goes straight into `<img>` / `<embed>` and the browser streams it; the
 *    reference fetched every byte into memory and built an object URL it then
 *    had to remember to revoke.
 */

import { useCallback } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { UseQueryResult } from '@tanstack/react-query'
import {
  fetchPreviewChannel,
  resolveArtifacts,
} from '@/app/api/artifacts'
import { listFiles, readFileText } from '@/app/api/files'
import {
  applyResolution,
  artifactChanged,
  degradeUnresolved,
  resolvablePaths,
} from '@/app/artifacts/resolve'
import { artifactFingerprint } from '@/app/artifacts/derive'
import type { ArtifactCandidate, ArtifactTarget } from '@/app/types/artifacts'
import type { FileTextPayload, PreviewPayload, WorkspaceFile } from '@/app/types/wire'

export const panelKeys = {
  resolve: (sessionId: string, fingerprint: string) =>
    ['artifacts', 'resolve', sessionId, fingerprint] as const,
  content: (sessionId: string, path: string) =>
    ['artifacts', 'content', sessionId, path] as const,
  preview: (sessionId: string) => ['artifacts', 'preview', sessionId] as const,
  files: (sessionId: string) => ['artifacts', 'files', sessionId] as const,
}

/** The project directory's listing — the Files tab, and a second source of
 *  server-confirmed targets. */
export function useWorkspaceFiles(
  sessionId: string,
  enabled: boolean,
): UseQueryResult<WorkspaceFile[], Error> {
  return useQuery({
    queryKey: panelKeys.files(sessionId),
    queryFn: ({ signal }) => listFiles(sessionId, signal),
    enabled: enabled && sessionId !== '',
    staleTime: 5_000,
  })
}

/**
 * Confirm a derived candidate set against the file surface.
 *
 * Keyed on the fingerprint rather than on the transcript: a streaming turn
 * re-derives on every frame, and keying on the derived *set* is what stops one
 * POST per token. A failed resolve degrades to "nothing confirmed" rather than
 * throwing — the panel's honest rendering of a server it cannot reach is an
 * empty panel, not an error page.
 */
export function useResolvedArtifacts(
  sessionId: string,
  candidates: readonly ArtifactCandidate[],
): UseQueryResult<ArtifactTarget[], Error> {
  const fingerprint = artifactFingerprint(candidates)
  return useQuery({
    queryKey: panelKeys.resolve(sessionId, fingerprint),
    queryFn: async ({ signal }) => {
      try {
        const resolved = await resolveArtifacts(sessionId, resolvablePaths(candidates), signal)
        return applyResolution(candidates, resolved)
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') throw error
        return degradeUnresolved(candidates)
      }
    },
    enabled: sessionId !== '',
    // The file system moves under us; a confirmation older than a few seconds
    // is a guess again.
    staleTime: 5_000,
  })
}

/**
 * Invalidate the content of every target whose bytes changed since the last
 * resolve.
 *
 * This is the fix for the staleness bug the reference has: its transcript diff
 * compared ids and positions only, so a file rewritten in place looked
 * identical and the open tab kept rendering the bytes it was opened with.
 */
export function useArtifactFreshness(sessionId: string) {
  const queryClient = useQueryClient()
  // Stable across renders so the effect that calls it can depend on it honestly
  // rather than omitting it from a dependency array.
  return useCallback(
    (previous: readonly ArtifactTarget[], next: readonly ArtifactTarget[]) => {
      if (previous.length === 0) return
      const before = new Map(previous.map((target) => [target.id, target]))
      for (const target of next) {
        const old = before.get(target.id)
        if (old && artifactChanged(old, target)) {
          void queryClient.invalidateQueries({
            queryKey: panelKeys.content(sessionId, target.value),
          })
        }
      }
    },
    [queryClient, sessionId],
  )
}

/** One artifact's text. Binary previews never come through here. */
export function useArtifactText(
  sessionId: string,
  path: string | null,
): UseQueryResult<FileTextPayload, Error> {
  return useQuery({
    queryKey: panelKeys.content(sessionId, path ?? ''),
    queryFn: ({ signal }) => readFileText(sessionId, path as string, signal),
    enabled: sessionId !== '' && path !== null,
    refetchOnWindowFocus: true,
  })
}

/**
 * The sandbox preview channel, or `null` when the session has no container.
 *
 * `null` is a normal answer — every `local` project has one — and the panel
 * hides the tabs that ride the channel rather than showing them broken.
 */
export function usePreviewChannel(sessionId: string): UseQueryResult<PreviewPayload | null, Error> {
  return useQuery({
    queryKey: panelKeys.preview(sessionId),
    queryFn: ({ signal }) => fetchPreviewChannel(sessionId, signal),
    enabled: sessionId !== '',
    staleTime: 30_000,
    retry: false,
  })
}
