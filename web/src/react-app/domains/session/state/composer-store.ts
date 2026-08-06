/**
 * Composer interaction state: the draft, the model/effort the next turn will
 * run with, and whether a steer is in flight.
 *
 * Per session, because all three belong to the conversation they were typed
 * into — switching sessions mid-sentence and coming back to an empty box is
 * the kind of loss a user never reports and never forgives.
 *
 * The draft is **one plain string** on purpose, and Phase 4 keeps it that way:
 * slash commands, mentions, pasted-text chips and attachments are all encoded
 * as bracket tokens inside it with side tables for metadata, which is what
 * makes a draft persistable and renderable by the same parse. A structured
 * editor model here would be a shape Phase 4 has to undo.
 */

import { create } from 'zustand'
import type { LocalImage } from '@/app/images'
import { retainReferencedPastes } from '../composer/paste'
import type { PastedTextPart } from '../composer/paste'

/** The draft key for the surface that has no session yet — the first message
 *  of a project creates one, so its draft still needs somewhere to live. */
export const NEW_SESSION_DRAFT_KEY = '@new'

export function draftKey(sessionId: string | null): string {
  return sessionId ?? NEW_SESSION_DRAFT_KEY
}

/** A model/effort pair the user picked explicitly. Null means "use the default". */
export interface ModelChoice {
  model: string | null
  effort: string | null
}

const NO_CHOICE: ModelChoice = { model: null, effort: null }

const NO_IMAGES: readonly LocalImage[] = []

const NO_PASTES: readonly PastedTextPart[] = []

interface ComposerStoreState {
  drafts: Record<string, string>
  choices: Record<string, ModelChoice>
  steering: Record<string, boolean>
  /**
   * The two side tables the token grammar refers to.
   *
   * They exist because the draft is one plain string: `[pasted text L]` and an
   * attachment are *references*, and the bytes they refer to have to live
   * somewhere the string can point at. `pastes` is reconciled from the draft
   * text after every change rather than by a removal callback — Backspace
   * deletes a token and calls nothing — and `images` is deliberately *not*,
   * because an attachment has no token in the draft to be counted against.
   */
  images: Record<string, LocalImage[]>
  pastes: Record<string, PastedTextPart[]>
  setDraft: (key: string, draft: string) => void
  clearDraft: (key: string) => void
  addImages: (key: string, images: readonly LocalImage[]) => void
  removeImage: (key: string, id: string) => void
  clearImages: (key: string) => void
  /** Remember a collapsed paste so the token can be expanded at send time. */
  rememberPaste: (key: string, part: PastedTextPart) => void
  /** Picking a model clears the effort: an effort outside the new model's
   *  ladder is a 422, and the resolver would silently drop it anyway. */
  chooseModel: (key: string, model: string) => void
  chooseEffort: (key: string, effort: string) => void
  setSteering: (key: string, steering: boolean) => void
}

export const useComposerStore = create<ComposerStoreState>((set) => ({
  drafts: {},
  choices: {},
  steering: {},
  images: {},
  pastes: {},

  setDraft: (key, draft) =>
    set((state) => {
      const pastes = state.pastes[key]
      if (pastes === undefined || pastes.length === 0) {
        return { drafts: { ...state.drafts, [key]: draft } }
      }
      // Deleting the chip is what drops the paste. Derived from the text rather
      // than from a callback because Backspace removes a token and tells nobody.
      const kept = retainReferencedPastes(draft, pastes)
      return {
        drafts: { ...state.drafts, [key]: draft },
        pastes:
          kept.length === pastes.length ? state.pastes : { ...state.pastes, [key]: [...kept] },
      }
    }),
  clearDraft: (key) =>
    set((state) => (state.drafts[key] ? { drafts: { ...state.drafts, [key]: '' } } : state)),

  addImages: (key, images) =>
    set((state) =>
      images.length === 0
        ? state
        : { images: { ...state.images, [key]: [...(state.images[key] ?? []), ...images] } },
    ),
  removeImage: (key, id) =>
    set((state) => {
      const current = state.images[key] ?? []
      const next = current.filter((image) => image.id !== id)
      return next.length === current.length ? state : { images: { ...state.images, [key]: next } }
    }),
  clearImages: (key) =>
    set((state) =>
      (state.images[key] ?? []).length === 0 ? state : { images: { ...state.images, [key]: [] } },
    ),

  rememberPaste: (key, part) =>
    set((state) => ({ pastes: { ...state.pastes, [key]: [...(state.pastes[key] ?? []), part] } })),

  chooseModel: (key, model) =>
    set((state) => ({ choices: { ...state.choices, [key]: { model, effort: null } } })),
  chooseEffort: (key, effort) =>
    set((state) => ({
      choices: {
        ...state.choices,
        [key]: { model: (state.choices[key] ?? NO_CHOICE).model, effort },
      },
    })),

  setSteering: (key, steering) =>
    set((state) =>
      (state.steering[key] ?? false) === steering
        ? state
        : { steering: { ...state.steering, [key]: steering } },
    ),
}))

export function useDraft(key: string): string {
  return useComposerStore((state) => state.drafts[key] ?? '')
}

export function useModelChoice(key: string): ModelChoice {
  return useComposerStore((state) => state.choices[key] ?? NO_CHOICE)
}

export function useSteering(key: string): boolean {
  return useComposerStore((state) => state.steering[key] ?? false)
}

export function useComposerImages(key: string): readonly LocalImage[] {
  return useComposerStore((state) => state.images[key] ?? NO_IMAGES)
}

export function usePastedParts(key: string): readonly PastedTextPart[] {
  return useComposerStore((state) => state.pastes[key] ?? NO_PASTES)
}

export function composerActions() {
  return useComposerStore.getState()
}
