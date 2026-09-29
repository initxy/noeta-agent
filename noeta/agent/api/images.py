"""Composer attachments: validated before anything is written.

The order of operations is the whole module. An attachment is checked for
type, then decoded, then measured — and only once **every** image in the
request has passed all three does a single byte reach the ContentStore. A
request that fails leaves the session exactly as it was: `idle`, with no turn
seeded and no orphan blob.

Four constants and one rule, each pinned by a test:

- the whitelist is `{png, jpeg, gif, webp}` and rejection happens **before**
  any store write;
- the cap is **5 MB inclusive** — exactly 5 MB passes, one byte more does not;
- `media_type` is normalized (trimmed, lowercased) before it is stored;
- base64 is decoded with `validate=True`, so padding and stray characters are
  a refusal rather than silent truncation;
- every failure is a **400**, and an empty message with no images is a 422 —
  the first says "this attachment is wrong", the second says "there is nothing
  to send".
"""
from __future__ import annotations

import base64
import binascii
from collections.abc import Sequence
from dataclasses import dataclass

from noeta.agent.api.errors import APIError

#: The formats the vision models actually accept. The frontend applies the
#: same list before upload; both sides name it so a mismatch is a test failure
#: rather than a rejected attachment nobody can explain.
ALLOWED_MEDIA_TYPES = frozenset({"image/png", "image/jpeg", "image/gif", "image/webp"})

#: Inclusive. 5 MB exactly is accepted.
MAX_IMAGE_BYTES = 5 * 1024 * 1024


@dataclass(frozen=True)
class DecodedImage:
    body: bytes
    media_type: str


def _reject(message: str) -> APIError:
    return APIError(400, "invalid_image", message)


def decode_images(items: Sequence[object]) -> list[DecodedImage]:
    """Every attachment, decoded and validated. Raises `APIError` (400).

    Returns rather than stores: the caller does the ContentStore write, and it
    only reaches that line once this function has returned for the whole
    batch. That ordering is what makes "a rejected image writes nothing" true
    for a request whose *second* attachment is the bad one.
    """
    decoded: list[DecodedImage] = []
    for index, item in enumerate(items):
        media_type = str(getattr(item, "media_type", "") or "").strip().lower()
        if media_type not in ALLOWED_MEDIA_TYPES:
            raise _reject(
                f"image {index}: unsupported media type {media_type or '(missing)'}; "
                f"allowed: {', '.join(sorted(ALLOWED_MEDIA_TYPES))}"
            )
        payload = str(getattr(item, "data_base64", "") or "")
        try:
            body = base64.b64decode(payload, validate=True)
        except (binascii.Error, ValueError) as exc:
            raise _reject(f"image {index}: not valid base64 ({exc})") from exc
        if not body:
            raise _reject(f"image {index}: empty")
        if len(body) > MAX_IMAGE_BYTES:
            raise _reject(
                f"image {index}: {len(body)} bytes exceeds the "
                f"{MAX_IMAGE_BYTES} byte limit"
            )
        decoded.append(DecodedImage(body=body, media_type=media_type))
    return decoded
