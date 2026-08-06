/**
 * The session domain's server state.
 *
 * Reads are TanStack Query; writes are mutations that carry their target as a
 * variable rather than closing over it, because the create-then-send path knows
 * the session id only *after* the first mutation resolves.
 *
 * The conversation itself is deliberately absent: it is a stream projection, it
 * lives in `state/conversation-store`, and the one thing a query cache could
 * add — refetching — is spelled "reconnect" and already handled.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { UseQueryResult } from '@tanstack/react-query'
import {
  answerQuestion,
  createSession,
  deleteSession,
  listSessions,
  sendMessage,
} from '@/app/api'
import type {
  AcceptedTask,
  AnswerRequest,
  SendMessageRequest,
  SessionDetail,
  SessionRow,
} from '@/app/types'

export const sessionKeys = {
  all: ['sessions'] as const,
  list: (projectId: string) => ['sessions', 'list', projectId] as const,
}

export function useSessionRows(projectId: string): UseQueryResult<SessionRow[], Error> {
  return useQuery({
    queryKey: sessionKeys.list(projectId),
    queryFn: ({ signal }) => listSessions(projectId, signal),
    enabled: projectId !== '',
  })
}

export interface CreateSessionVariables {
  projectId: string
  title?: string
}

/**
 * Create a session, and put it in the index before anything navigates to it.
 *
 * The write into the cache is not an optimisation: the session route resolves
 * its id against the index, so navigating to a session the index has not
 * refetched yet would render the not-found card for as long as the round trip
 * takes.
 */
export function useCreateSession() {
  const queryClient = useQueryClient()
  return useMutation<SessionDetail, Error, CreateSessionVariables>({
    mutationFn: ({ projectId, title }) => createSession(projectId, title ? { title } : {}),
    onSuccess: (session, { projectId }) => {
      queryClient.setQueryData<SessionRow[]>(sessionKeys.list(projectId), (rows) => [
        session,
        ...(rows ?? []).filter((row) => row.id !== session.id),
      ])
      void queryClient.invalidateQueries({ queryKey: sessionKeys.list(projectId) })
    },
  })
}

export interface DeleteSessionVariables {
  projectId: string
  sessionId: string
}

/**
 * Delete a session.
 *
 * The row leaves the index immediately, before the refetch: the caller is
 * about to navigate away from it, and a list that still contains a session the
 * server has dropped resolves the route it just left to a real conversation
 * for one frame.
 *
 * **The project directory is not touched.** Under D2 the directory belongs to
 * the project and its sibling sessions are still working in it; deleting the
 * files of one session would delete another's work. The backend pins this.
 */
export function useDeleteSession() {
  const queryClient = useQueryClient()
  return useMutation<void, Error, DeleteSessionVariables>({
    mutationFn: ({ sessionId }) => deleteSession(sessionId),
    onSuccess: (_void, { projectId, sessionId }) => {
      queryClient.setQueryData<SessionRow[]>(sessionKeys.list(projectId), (rows) =>
        (rows ?? []).filter((row) => row.id !== sessionId),
      )
      void queryClient.invalidateQueries({ queryKey: sessionKeys.list(projectId) })
    },
  })
}

export interface SendMessageVariables {
  projectId: string
  sessionId: string
  body: SendMessageRequest
}

/**
 * Send one turn.
 *
 * Nothing is written into the transcript here. The durable `user_message` frame
 * arrives on the stream and replaces the optimistic bubble the composer already
 * appended; a second write would render the message twice for one frame.
 *
 * The *index* is refetched, though, and that is not decoration: a send changes
 * two things on the row this session is listed by — its status, and, on the
 * first message, its title. Neither reaches an index that is only invalidated
 * by `session_meta`, because the create-then-send path sends before its stream
 * is open and that frame is synthetic (never replayed). Refetching on the
 * acknowledgement is the one moment both facts are known to have changed.
 */
export function useSendMessage() {
  const queryClient = useQueryClient()
  return useMutation<AcceptedTask, Error, SendMessageVariables>({
    mutationFn: ({ sessionId, body }) => sendMessage(sessionId, body),
    onSuccess: (_task, { projectId }) => {
      void queryClient.invalidateQueries({ queryKey: sessionKeys.list(projectId) })
    },
  })
}

export interface AnswerVariables {
  sessionId: string
  body: AnswerRequest
}

export function useAnswerQuestion() {
  return useMutation<void, Error, AnswerVariables>({
    mutationFn: ({ sessionId, body }) => answerQuestion(sessionId, body),
  })
}
