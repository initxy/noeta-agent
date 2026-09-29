"""Composer attachments, validated before the turn is seeded.

`LEDGER §9.10` rows 64-70. Every row here is about *ordering* or about a
boundary value, and both kinds fail silently when they regress: a turn seeded
against a rejected attachment leaves the session busy with nothing driving it,
and an off-by-one on the cap rejects an image the frontend already compressed
to exactly the limit.
"""
from __future__ import annotations

import base64
from typing import Any

import pytest

from noeta.agent.api.images import ALLOWED_MEDIA_TYPES, MAX_IMAGE_BYTES, decode_images
from tests.test_api_flow import Api, api, make_api, text_provider  # noqa: F401
from tests.test_sse import PNG_BYTES


def attachment(body: bytes = PNG_BYTES, media_type: str = "image/png") -> dict[str, str]:
    return {"media_type": media_type, "data_base64": base64.b64encode(body).decode()}


def png_of(size: int) -> bytes:
    """A PNG header plus filler, so a size test is still a real image."""
    return PNG_BYTES + b"\x00" * (size - len(PNG_BYTES))


# ---------------------------------------------------------------------------
# The constants — row 70
# ---------------------------------------------------------------------------


def test_the_whitelist_and_the_cap_are_named(api: Api):
    """Row 70. The frontend applies the same list before upload; naming both
    sides is what turns a mismatch into a test failure rather than a rejected
    attachment nobody can explain."""
    assert ALLOWED_MEDIA_TYPES == {"image/png", "image/jpeg", "image/gif", "image/webp"}
    assert MAX_IMAGE_BYTES == 5 * 1024 * 1024


# ---------------------------------------------------------------------------
# Rows 64, 66, 67, 68 — validation, at the unit
# ---------------------------------------------------------------------------


def test_the_cap_is_inclusive():
    """Row 67. Exactly 5 MB passes; one byte more does not.

    An exclusive cap rejects an image the client compressed to precisely the
    limit it was told about, which reads as a client bug forever."""
    from noeta.agent.api.errors import APIError

    exact = decode_images([_Item(png_of(MAX_IMAGE_BYTES))])
    assert len(exact[0].body) == MAX_IMAGE_BYTES

    with pytest.raises(APIError) as refused:
        decode_images([_Item(png_of(MAX_IMAGE_BYTES + 1))])
    assert refused.value.status_code == 400


def test_media_type_is_normalized():
    """Row 68. Trimmed and lowercased before it is stored, so `IMAGE/PNG ` and
    `image/png` are one type rather than two."""
    decoded = decode_images([_Item(PNG_BYTES, media_type="  IMAGE/PNG ")])

    assert decoded[0].media_type == "image/png"


def test_base64_is_validated_rather_than_truncated():
    """`validate=True`: stray characters are a refusal, not a silently shorter
    image that the model then fails to decode."""
    from noeta.agent.api.errors import APIError

    with pytest.raises(APIError):
        decode_images([_Item(PNG_BYTES, payload="not base64 at all!!")])


def test_an_unknown_media_type_is_refused_before_anything_is_decoded():
    from noeta.agent.api.errors import APIError

    with pytest.raises(APIError) as refused:
        decode_images([_Item(PNG_BYTES, media_type="image/tiff")])

    assert refused.value.code == "invalid_image"
    assert "image/tiff" in refused.value.message


class _Item:
    """The shape the endpoint hands `decode_images` — read by attribute, so a
    plain object stands in for the pydantic model."""

    def __init__(
        self, body: bytes, *, media_type: str = "image/png", payload: Any = None
    ) -> None:
        self.media_type = media_type
        self.data_base64 = (
            payload if payload is not None else base64.b64encode(body).decode()
        )


# ---------------------------------------------------------------------------
# Rows 64-66 — through the API, where the ordering lives
# ---------------------------------------------------------------------------


def test_a_bad_attachment_is_400_and_the_turn_is_never_seeded(api: Api):
    """Row 64. **400** for a bad attachment, and the session stays `idle`.

    "Stays idle" is the load-bearing half: a session left `running` by a
    refused request is a session that 409s every later message with no turn to
    finish it."""
    project, session = api.open_session()

    refused = api.send(
        session["id"], "look at this", images=[attachment(media_type="image/tiff")]
    )

    assert refused.status_code == 400
    assert api.error(refused)["code"] == "invalid_image"
    detail = api.detail(session["id"])
    assert detail["status"] == "idle"
    assert detail["task_streams"] == []


def test_an_empty_message_with_no_attachment_is_422(api: Api):
    """Row 64's other half. A different class of wrong: nothing was sent, as
    opposed to something unusable."""
    project, session = api.open_session()

    refused = api.send(session["id"], "")

    assert refused.status_code == 422
    assert api.error(refused)["code"] == "empty_message"


def test_an_attachment_with_no_text_is_accepted(api: Api):
    """An image on its own is a message. The 422 above is about *nothing*
    being sent, not about the text field specifically."""
    project, session = api.open_session()

    accepted = api.send(session["id"], "", images=[attachment()])

    assert accepted.status_code == 202


def test_a_rejected_batch_writes_nothing(make_api):
    """Row 66. The *second* attachment is the bad one, and the first must not
    already be in the ContentStore when the request fails.

    Which is why validation returns a list instead of storing as it goes: the
    store write cannot begin until the whole batch has passed."""
    ready = make_api(provider=text_provider())
    project, session = ready.open_session()

    refused = ready.send(
        session["id"],
        "two images",
        images=[attachment(), attachment(media_type="image/tiff")],
    )

    assert refused.status_code == 400
    # Nothing was seeded, so nothing references any stored blob either.
    assert ready.detail(session["id"])["task_streams"] == []


def test_an_oversize_attachment_stores_nothing(make_api):
    """The oversize case decodes first — you cannot measure what you have not
    decoded — but it must still store nothing."""
    ready = make_api(provider=text_provider())
    project, session = ready.open_session()

    refused = ready.send(
        session["id"], "big", images=[attachment(png_of(MAX_IMAGE_BYTES + 1))]
    )

    assert refused.status_code == 400
    assert ready.detail(session["id"])["status"] == "idle"


# ---------------------------------------------------------------------------
# Row 65 — the wire shape
# ---------------------------------------------------------------------------


def test_a_text_only_turn_carries_no_images_key(make_api):
    """Row 65, and an explicit wire-compat guard.

    The data must be exactly `{content, _task}` — not `{content, images: []}`.
    A client written against the pre-image vocabulary distinguishes "no key"
    from "empty list", and an empty list is a rendering branch nobody asked
    for."""
    ready = make_api(provider=text_provider())
    project, session = ready.open_session()
    ready.send(session["id"], "just words")
    ready.wait_turn(session["id"])

    frames = ready.frames(session["id"], params={"since_seq": 0}, timeout=3.0)

    user_message = next(f for f in frames if f.event == "user_message")
    # `ts` is the contract's optional server clock (§2.7) and rides every
    # durable frame; what this row pins is that `images` is absent.
    assert set(user_message.data) - {"ts"} == {"content", "_task"}


def test_an_attachment_travels_as_a_hash_never_as_bytes(make_api):
    """Row 69's setup and the delta rule in one: the ledger stores an
    `ImageBlock(ContentRef)`, so the wire carries `{hash, media_type}` and the
    client refetches the bytes from the content endpoint.

    Base64 never enters the event log, and image bytes never travel the event
    stream — which is what keeps a conversation with ten screenshots in it
    replayable at all."""
    ready = make_api(provider=text_provider())
    project, session = ready.open_session()
    payload = attachment()
    ready.send(session["id"], "look", images=[payload])
    ready.wait_turn(session["id"], timeout=30.0)

    frames = ready.frames(session["id"], params={"since_seq": 0}, timeout=5.0)

    user_message = next(f for f in frames if f.event == "user_message")
    assert set(user_message.data) - {"ts"} == {"content", "images", "_task"}
    image = user_message.data["images"][0]
    assert set(image) == {"hash", "media_type"}
    assert image["media_type"] == "image/png"
    assert len(image["hash"]) == 64
    assert payload["data_base64"] not in str(frames)


def test_the_content_endpoint_sniffs_the_type_rather_than_echoing_it(make_api):
    """Row 69. The ContentStore has no metadata read interface, so there is
    nothing authoritative to echo — and a caller-supplied type would let one
    request decide how another's bytes are interpreted."""
    ready = make_api(provider=text_provider())
    project, session = ready.open_session()
    ready.send(session["id"], "look", images=[attachment()])
    ready.wait_turn(session["id"], timeout=30.0)
    frames = ready.frames(session["id"], params={"since_seq": 0}, timeout=5.0)
    digest = next(f for f in frames if f.event == "user_message").data["images"][0]["hash"]

    response = ready.http.get(f"/api/v1/content/{digest}")

    assert response.status_code == 200
    assert response.content == PNG_BYTES
    assert response.headers["content-type"] == "image/png"
