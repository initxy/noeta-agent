/**
 * Turning a pasted or dropped image into the two fields the wire accepts, and
 * deciding — before it ever leaves the browser — whether it may travel at all.
 *
 * The composer holds more than the wire wants — a local id to key the preview
 * list, the data URL it renders from, the original filename. Exactly two of
 * those fields may travel: `media_type` and `data_base64`. Sending the data
 * URL alongside the base64 meant the same bytes crossed the wire twice, and
 * the local id meant the request body differed between two clients that had
 * attached the identical image.
 *
 * **The allowlist and the cap are stated on both sides.** `noeta/agent/api/
 * images.py` names the same `{png, jpeg, gif, webp}` and the same
 * `5 * 1024 * 1024`, and the cap is inclusive on both — exactly 5 MB passes.
 * Duplicating a constant is normally a smell; here it is the point. A client
 * that guessed low would refuse attachments the server would have taken, and a
 * client that guessed high would let the user wait through an upload that ends
 * in a 400. Both sides name the literals so a drift is a test failure rather
 * than an attachment nobody can explain.
 *
 * The client says *why* it refused — `type`, `size` or `missing` — because it
 * is the only side that can say it before the user has waited for anything.
 *
 * Framework-agnostic despite touching `DataTransfer`, `File` and canvases:
 * those are DOM types, not React ones, and the policy they feed is worth
 * testing without a component.
 */

import type { ImageAttachment } from './types/wire'

/** An attachment as the composer holds it, before the wire trims it. */
export interface LocalImage {
  /** Client-side identity for the preview list. Never sent. */
  id: string
  mediaType: string
  /** `data:<media-type>;base64,<payload>`. Never sent — only its payload is. */
  dataUrl: string
  /** Never sent. */
  filename?: string
}

const BASE64_DATA_URL = /^data:[^;,]*;base64,/

/**
 * The formats the vision models actually accept. Mirrors
 * `noeta.agent.api.images.ALLOWED_MEDIA_TYPES`.
 */
export const ALLOWED_IMAGE_TYPES: readonly string[] = [
  'image/gif',
  'image/jpeg',
  'image/png',
  'image/webp',
]

/**
 * Inclusive, exactly as the server's `MAX_IMAGE_BYTES` is: 5 MB passes, one
 * byte more does not.
 */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024

/**
 * Why an attachment was refused.
 *
 * Three verdicts and not one boolean, because the three have three different
 * remedies: pick another format, shrink it, or pick a file that has bytes.
 */
export type ImageRejection = 'type' | 'size' | 'missing'

/** Trimmed, lowercased, parameters dropped — the same normalization the server applies. */
export function normalizeMediaType(mediaType: string | null | undefined): string {
  if (typeof mediaType !== 'string') return ''
  const semicolon = mediaType.indexOf(';')
  return (semicolon === -1 ? mediaType : mediaType.slice(0, semicolon)).trim().toLowerCase()
}

export function isAllowedImageType(mediaType: string | null | undefined): boolean {
  return ALLOWED_IMAGE_TYPES.includes(normalizeMediaType(mediaType))
}

/**
 * The verdict on one file, or `null` when it may be sent.
 *
 * Type is checked before size, mirroring the server, where the allowlist
 * rejects before anything is decoded or measured. It also gives the better
 * message: a 40 MB video is refused for being a video, not for being large.
 */
export function rejectImageFile(file: File | null | undefined): ImageRejection | null {
  if (!file || file.size === 0) return 'missing'
  if (!isAllowedImageType(file.type)) return 'type'
  if (file.size > MAX_IMAGE_BYTES) return 'size'
  return null
}

/**
 * The base64 payload of a data URL, or `""` when it is not one.
 *
 * Returning empty rather than throwing is the point: a `data:` URL with a
 * different encoding, or a plain `http:` URL that reached this function by
 * accident, must degrade to "nothing to attach" and never take down the paste
 * handler mid-gesture.
 */
export function dataUrlToBase64(dataUrl: string): string {
  if (typeof dataUrl !== 'string' || !BASE64_DATA_URL.test(dataUrl)) return ''
  return dataUrl.slice(dataUrl.indexOf(',') + 1)
}

/**
 * The wire payload for one local image: exactly `{media_type, data_base64}`.
 */
export function toImageAttachment(image: LocalImage): ImageAttachment {
  return { media_type: image.mediaType, data_base64: dataUrlToBase64(image.dataUrl) }
}

/** The wire payload for a list, dropping any image whose bytes did not parse. */
export function toImageAttachments(images: readonly LocalImage[]): ImageAttachment[] {
  return images.map(toImageAttachment).filter((image) => image.data_base64 !== '')
}

/**
 * The image files carried by a paste or drop.
 *
 * A null `DataTransfer` yields `[]`. Browsers hand one to `paste` events that
 * carry nothing droppable, and a handler that assumed an object there threw
 * inside an event listener — where the exception is invisible and the paste
 * simply does nothing.
 */
export function imageFilesFromDataTransfer(transfer: DataTransfer | null): File[] {
  if (!transfer) return []
  const files = transfer.files ? Array.from(transfer.files) : []
  return files.filter((file) => file.type.startsWith('image/'))
}

// ---------------------------------------------------------------------------
// Compression
// ---------------------------------------------------------------------------

/** The longest edge a re-encoded image may keep. */
export const IMAGE_MAX_EDGE_PX = 2048

/** JPEG quality for a re-encode. Visually lossless on screenshots, ~5x smaller. */
export const IMAGE_JPEG_QUALITY = 0.82

/** Under this, re-encoding costs more than it saves. */
export const IMAGE_COMPRESS_THRESHOLD_BYTES = 1_500_000

function jpegName(filename: string): string {
  const dot = filename.lastIndexOf('.')
  const stem = dot > 0 ? filename.slice(0, dot) : filename
  return `${stem || 'image'}.jpg`
}

async function encodeJpeg(bitmap: ImageBitmap, width: number, height: number): Promise<Blob | null> {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height)
    const context = canvas.getContext('2d')
    if (context) {
      context.drawImage(bitmap, 0, 0, width, height)
      return await canvas.convertToBlob({ type: 'image/jpeg', quality: IMAGE_JPEG_QUALITY })
    }
  }
  if (typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) return null
  context.drawImage(bitmap, 0, 0, width, height)
  return await new Promise<Blob | null>((resolve) => {
    canvas.toBlob((blob) => resolve(blob), 'image/jpeg', IMAGE_JPEG_QUALITY)
  })
}

/**
 * A large image, re-encoded smaller — or the original, unchanged.
 *
 * The decision tree, in order, and every early return hands back the file it
 * was given:
 *
 * 1. **GIF is skipped entirely.** Re-encoding one to JPEG keeps the first
 *    frame and throws the animation away. A user who attaches a GIF attached
 *    the motion.
 * 2. **≤1.5 MB is skipped.** Below that the re-encode is a lossy round trip
 *    for a saving nobody notices.
 * 3. Anything that cannot decode — no `createImageBitmap`, a corrupt file, no
 *    2d context — is skipped. Compression is an optimization; failing it must
 *    never lose the attachment.
 * 4. Otherwise: longest edge down to 2048 px if it exceeds that, JPEG at
 *    q=0.82.
 * 5. **A result that is not smaller is discarded.** Re-encoding an
 *    already-optimal JPEG, or a flat-colour PNG, routinely *inflates* it —
 *    and the user pays for that twice, once uploading and once in the model's
 *    context. Strictly smaller or it did not happen.
 *
 * Note that step 4 re-encodes even an image whose dimensions are already
 * small: for a 3 MB 800x600 PNG the win is the codec, not the scale.
 */
export async function compressImageFile(file: File): Promise<File> {
  if (normalizeMediaType(file.type) === 'image/gif') return file
  if (file.size <= IMAGE_COMPRESS_THRESHOLD_BYTES) return file
  if (typeof createImageBitmap !== 'function') return file

  let bitmap: ImageBitmap | null = null
  try {
    bitmap = await createImageBitmap(file)
    const longest = Math.max(bitmap.width, bitmap.height)
    const scale = longest > IMAGE_MAX_EDGE_PX ? IMAGE_MAX_EDGE_PX / longest : 1
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))
    const blob = await encodeJpeg(bitmap, width, height)
    if (!blob || blob.size >= file.size) return file
    return new File([blob], jpegName(file.name), { type: 'image/jpeg' })
  } catch {
    return file
  } finally {
    bitmap?.close()
  }
}

// ---------------------------------------------------------------------------
// Intake
// ---------------------------------------------------------------------------

export type ImageIntake =
  | { ok: true; image: LocalImage }
  | { ok: false; reason: ImageRejection; filename: string }

let intakeCounter = 0

function nextImageId(): string {
  intakeCounter += 1
  return `img-${Date.now().toString(36)}-${intakeCounter.toString(36)}`
}

function readDataUrl(file: File): Promise<string> {
  return new Promise((resolve) => {
    if (typeof FileReader !== 'function') {
      resolve('')
      return
    }
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '')
    reader.onerror = () => resolve('')
    reader.onabort = () => resolve('')
    reader.readAsDataURL(file)
  })
}

/**
 * One dropped, pasted or picked file, all the way to something sendable.
 *
 * The order matters and is the reason this is one function rather than three
 * the caller composes. Type is judged on the **original** — compressing a PDF
 * is nonsense — but size is judged on the **compressed** result, because the
 * whole point of compression is that a 9 MB screenshot becomes a 400 KB one
 * the server will happily take. Refusing it up front for a size it was never
 * going to be sent at is the kind of "correct" that reads as broken.
 */
export async function intakeImageFile(file: File | null | undefined): Promise<ImageIntake> {
  const filename = file?.name ?? ''
  if (!file || file.size === 0) return { ok: false, reason: 'missing', filename }
  if (!isAllowedImageType(file.type)) return { ok: false, reason: 'type', filename }

  const prepared = await compressImageFile(file)
  if (prepared.size > MAX_IMAGE_BYTES) return { ok: false, reason: 'size', filename }

  const dataUrl = await readDataUrl(prepared)
  if (dataUrlToBase64(dataUrl) === '') return { ok: false, reason: 'missing', filename }

  return {
    ok: true,
    image: {
      id: nextImageId(),
      mediaType: normalizeMediaType(prepared.type),
      dataUrl,
      filename: prepared.name,
    },
  }
}
