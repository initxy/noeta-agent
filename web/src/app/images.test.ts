import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ALLOWED_IMAGE_TYPES,
  IMAGE_COMPRESS_THRESHOLD_BYTES,
  IMAGE_JPEG_QUALITY,
  IMAGE_MAX_EDGE_PX,
  MAX_IMAGE_BYTES,
  compressImageFile,
  dataUrlToBase64,
  imageFilesFromDataTransfer,
  intakeImageFile,
  isAllowedImageType,
  normalizeMediaType,
  rejectImageFile,
  toImageAttachment,
  toImageAttachments,
} from './images'

const local = (overrides: Record<string, unknown> = {}) => ({
  id: 'local-1',
  mediaType: 'image/png',
  dataUrl: 'data:image/png;base64,QUJD',
  filename: 'shot.png',
  ...overrides,
})

/** A file with a declared size, so the 5 MB boundary costs no 5 MB allocation. */
function sized(name: string, type: string, size: number): File {
  const file = new File([new Uint8Array(4)], name, { type })
  Object.defineProperty(file, 'size', { value: size, configurable: true })
  return file
}

/** Stand in for the encode pipeline jsdom does not have. */
function stubEncoder(options: {
  width: number
  height: number
  outBytes: number
  drawn?: { width: number; height: number; quality: number }[]
}) {
  const drawn = options.drawn ?? []
  vi.stubGlobal(
    'createImageBitmap',
    vi.fn(async () => ({ width: options.width, height: options.height, close: vi.fn() })),
  )
  vi.stubGlobal(
    'OffscreenCanvas',
    class {
      width: number
      height: number
      constructor(width: number, height: number) {
        this.width = width
        this.height = height
      }
      getContext() {
        return { drawImage: () => {} }
      }
      async convertToBlob(init: { type: string; quality: number }) {
        drawn.push({ width: this.width, height: this.height, quality: init.quality })
        const blob = new Blob([new Uint8Array(4)], { type: init.type })
        Object.defineProperty(blob, 'size', { value: options.outBytes, configurable: true })
        return blob
      }
    },
  )
  return drawn
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('toImageAttachment', () => {
  it('sends exactly {media_type, data_base64}', () => {
    const payload = toImageAttachment(local())
    expect(payload).toEqual({ media_type: 'image/png', data_base64: 'QUJD' })
    // The local id, the data URL and the filename are client bookkeeping;
    // sending the data URL alongside the base64 sent the same bytes twice.
    expect(Object.keys(payload).sort()).toEqual(['data_base64', 'media_type'])
  })

  it('drops an image whose bytes did not parse', () => {
    expect(
      toImageAttachments([local(), local({ dataUrl: 'https://example.com/a.png' })]),
    ).toEqual([{ media_type: 'image/png', data_base64: 'QUJD' }])
  })
})

describe('dataUrlToBase64', () => {
  it('returns the payload of a base64 data URL', () => {
    expect(dataUrlToBase64('data:image/jpeg;base64,/9j/4AA')).toBe('/9j/4AA')
    expect(dataUrlToBase64('data:;base64,QQ==')).toBe('QQ==')
  })

  it('returns "" rather than throwing for anything else', () => {
    // A paste handler that throws mid-gesture fails invisibly inside an event
    // listener, and the paste simply does nothing.
    expect(dataUrlToBase64('data:image/png,notbase64')).toBe('')
    expect(dataUrlToBase64('https://example.com/a.png')).toBe('')
    expect(dataUrlToBase64('')).toBe('')
    expect(dataUrlToBase64(undefined as unknown as string)).toBe('')
  })
})

describe('imageFilesFromDataTransfer', () => {
  it('yields [] for a null DataTransfer', () => {
    expect(imageFilesFromDataTransfer(null)).toEqual([])
  })

  it('keeps only image files', () => {
    const files = [
      new File(['a'], 'a.png', { type: 'image/png' }),
      new File(['b'], 'b.txt', { type: 'text/plain' }),
    ]
    const transfer = { files } as unknown as DataTransfer
    expect(imageFilesFromDataTransfer(transfer).map((file) => file.name)).toEqual(['a.png'])
  })

  it('tolerates a DataTransfer with no files list', () => {
    expect(imageFilesFromDataTransfer({} as DataTransfer)).toEqual([])
  })
})

describe('the allowlist and the cap are the server’s', () => {
  it('names the same four types as noeta/agent/api/images.py', () => {
    expect([...ALLOWED_IMAGE_TYPES].sort()).toEqual([
      'image/gif',
      'image/jpeg',
      'image/png',
      'image/webp',
    ])
  })

  it('names the same cap, and it is inclusive', () => {
    expect(MAX_IMAGE_BYTES).toBe(5 * 1024 * 1024)
    // Exactly 5 MB passes; one byte more does not. Same boundary as the
    // server's, so an attachment is never accepted here and refused there.
    expect(rejectImageFile(sized('a.png', 'image/png', 5 * 1024 * 1024))).toBeNull()
    expect(rejectImageFile(sized('a.png', 'image/png', 5 * 1024 * 1024 + 1))).toBe('size')
  })

  it('normalizes the media type the way the server does', () => {
    expect(normalizeMediaType('  IMAGE/PNG  ')).toBe('image/png')
    expect(normalizeMediaType('image/jpeg; charset=binary')).toBe('image/jpeg')
    expect(normalizeMediaType(undefined)).toBe('')
    expect(isAllowedImageType(' Image/WebP ')).toBe(true)
    expect(isAllowedImageType('image/svg+xml')).toBe(false)
  })
})

describe('the three reject verdicts', () => {
  it('says missing when there is no file, or no bytes', () => {
    expect(rejectImageFile(null)).toBe('missing')
    expect(rejectImageFile(undefined)).toBe('missing')
    expect(rejectImageFile(sized('empty.png', 'image/png', 0))).toBe('missing')
  })

  it('says type for anything outside the allowlist', () => {
    expect(rejectImageFile(sized('a.svg', 'image/svg+xml', 10))).toBe('type')
    expect(rejectImageFile(sized('a.bin', '', 10))).toBe('type')
  })

  it('judges type before size, as the server does', () => {
    // A 40 MB video is refused for being a video, not for being large — and
    // the server's allowlist likewise rejects before anything is decoded.
    expect(rejectImageFile(sized('clip.mov', 'video/quicktime', 40 * 1024 * 1024))).toBe('type')
  })

  it('says nothing at all when the file may be sent', () => {
    expect(rejectImageFile(sized('a.gif', 'image/gif', 1024))).toBeNull()
  })
})

describe('compressImageFile — the decision tree', () => {
  it('skips GIF entirely, however large', () => {
    stubEncoder({ width: 4000, height: 4000, outBytes: 10 })
    const gif = sized('loop.gif', 'image/gif', 4 * 1024 * 1024)
    return expect(compressImageFile(gif)).resolves.toBe(gif)
  })

  it('skips anything at or below 1.5 MB', async () => {
    stubEncoder({ width: 4000, height: 4000, outBytes: 10 })
    expect(IMAGE_COMPRESS_THRESHOLD_BYTES).toBe(1_500_000)
    const small = sized('a.png', 'image/png', IMAGE_COMPRESS_THRESHOLD_BYTES)
    await expect(compressImageFile(small)).resolves.toBe(small)
  })

  it('scales the longest edge to 2048 and encodes JPEG at q=0.82', async () => {
    const drawn = stubEncoder({ width: 4096, height: 2048, outBytes: 1000 })
    const big = sized('shot.png', 'image/png', 3_000_000)
    const out = await compressImageFile(big)

    expect(drawn).toEqual([{ width: IMAGE_MAX_EDGE_PX, height: 1024, quality: IMAGE_JPEG_QUALITY }])
    expect(out).not.toBe(big)
    expect(out.type).toBe('image/jpeg')
    expect(out.name).toBe('shot.jpg')
  })

  it('re-encodes without scaling when the dimensions already fit', async () => {
    // The win for a 3 MB 800x600 PNG is the codec, not the scale.
    const drawn = stubEncoder({ width: 800, height: 600, outBytes: 1000 })
    await compressImageFile(sized('a.png', 'image/png', 3_000_000))
    expect(drawn).toEqual([{ width: 800, height: 600, quality: IMAGE_JPEG_QUALITY }])
  })

  it('keeps the original when the re-encode is not smaller', async () => {
    // Re-encoding an already-optimal JPEG routinely inflates it, and the user
    // pays for that twice: once uploading, once in the model's context.
    stubEncoder({ width: 1000, height: 1000, outBytes: 3_000_000 })
    const already = sized('photo.jpg', 'image/jpeg', 3_000_000)
    await expect(compressImageFile(already)).resolves.toBe(already)
  })

  it('keeps the original when the image cannot be decoded', async () => {
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(async () => {
        throw new Error('corrupt')
      }),
    )
    const broken = sized('a.png', 'image/png', 3_000_000)
    // Compression is an optimization; failing it must never lose the attachment.
    await expect(compressImageFile(broken)).resolves.toBe(broken)
  })

  it('keeps the original where there is no decoder at all', async () => {
    vi.stubGlobal('createImageBitmap', undefined)
    const file = sized('a.png', 'image/png', 3_000_000)
    await expect(compressImageFile(file)).resolves.toBe(file)
  })
})

describe('intakeImageFile', () => {
  it('judges size on the compressed result, not the original', async () => {
    // A 9 MB screenshot that compresses to 400 KB is the whole point; refusing
    // it for a size it was never going to be sent at reads as broken.
    stubEncoder({ width: 4096, height: 4096, outBytes: 400_000 })
    const huge = sized('screen.png', 'image/png', 9 * 1024 * 1024)
    Object.defineProperty(huge, 'size', { value: 9 * 1024 * 1024, configurable: true })
    const result = await intakeImageFile(huge)
    expect(result.ok).toBe(true)
    expect(result.ok === true && result.image.mediaType).toBe('image/jpeg')
  })

  it('still refuses a file that stays over the cap', async () => {
    vi.stubGlobal('createImageBitmap', undefined)
    const result = await intakeImageFile(sized('big.png', 'image/png', 6 * 1024 * 1024))
    expect(result).toEqual({ ok: false, reason: 'size', filename: 'big.png' })
  })

  it('judges type on the original, before any compression', async () => {
    const result = await intakeImageFile(sized('notes.pdf', 'application/pdf', 10))
    expect(result).toEqual({ ok: false, reason: 'type', filename: 'notes.pdf' })
  })

  it('reports missing for nothing at all', async () => {
    expect(await intakeImageFile(null)).toEqual({ ok: false, reason: 'missing', filename: '' })
  })

  it('produces a LocalImage whose wire payload is the two fields', async () => {
    const png = new File([new Uint8Array([1, 2, 3])], 'tiny.png', { type: 'image/png' })
    const result = await intakeImageFile(png)
    expect(result.ok).toBe(true)
    if (result.ok !== true) return
    expect(result.image.mediaType).toBe('image/png')
    expect(result.image.dataUrl.startsWith('data:image/png;base64,')).toBe(true)
    expect(Object.keys(toImageAttachment(result.image)).sort()).toEqual([
      'data_base64',
      'media_type',
    ])
  })
})
