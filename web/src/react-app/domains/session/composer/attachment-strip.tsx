/**
 * What is going to ride the next message as an image.
 *
 * An attachment is the one thing in the draft with **no token in the string**:
 * a mention, a skill and a collapsed paste are all spelled inside the text, so
 * deleting the chip deletes the reference, but an image has nowhere in a plain
 * string to live. It therefore needs its own strip and its own remove button —
 * without them the only way to un-attach a mis-pasted screenshot is to send it.
 */

import { CloseButton } from '@/react-app/design-system'
import type { LocalImage } from '@/app/images'

export function AttachmentStrip({
  images,
  onRemove,
}: {
  images: readonly LocalImage[]
  onRemove: (id: string) => void
}) {
  if (images.length === 0) return null

  return (
    <ul aria-label="Attachments" className="flex flex-wrap gap-2">
      {images.map((image) => (
        <li key={image.id} className="relative">
          <img
            src={image.dataUrl}
            alt={image.filename || 'Attachment'}
            className="size-14 rounded-md border border-border object-cover"
          />
          <CloseButton
            aria-label={`Remove ${image.filename || 'attachment'}`}
            onClick={() => onRemove(image.id)}
            className="absolute -top-1.5 -right-1.5 size-5 rounded-full border border-border bg-surface text-ink-2 hover:bg-surface-2"
            iconClassName="size-3"
          />
        </li>
      ))}
    </ul>
  )
}
