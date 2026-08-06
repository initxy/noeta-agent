"""`SdkBrowserBackend` — the container browser wire over the official SDK.

Pins the mapping the backend is coded against: which `browser_page` call each
`BrowserBackend` method issues, that elements are addressed by the numeric index
natively (no selector bridge), the exact element-line and `extract` shapes the
model was trained on by prompt, and that every fault lands as an
`AioBrowserError` so the browser tools' `except OSError` turns it into a clean
failed tool result instead of a crashed worker.

Nothing here opens a socket: the SDK client is a fake exposing `.browser_page`.
"""
from __future__ import annotations

from typing import Any

import pytest
from agent_sandbox.core.api_error import ApiError
from noeta.builtins.sandbox.impl.browser import AioBrowserError

from noeta.agent.host.sdk_browser_backend import SdkBrowserBackend

BASE = "http://127.0.0.1:54321"

ELEMENTS = [
    {"index": 0, "tag": "a", "text": "Learn more", "href": "https://x/y"},
    {"index": 1, "tag": "button", "text": "Go"},
]


class Resp:
    def __init__(self, data: Any) -> None:
        self.data = data


class FakeBrowserPage:
    def __init__(
        self,
        *,
        elements: list[dict[str, Any]] | None = None,
        markdown: str = "",
        png: bytes = b"\x89PNG\r\n",
        fail_on: str | None = None,
        timeout_on: str | None = None,
    ) -> None:
        self._elements = elements or []
        self._markdown = markdown
        self._png = png
        self._fail_on = fail_on
        self._timeout_on = timeout_on
        self.navigated: str | None = None
        self.clicked: int | None = None
        self.filled: tuple[int | None, str] | None = None
        self.keys: list[str] = []
        self.options: list[tuple[str, Any]] = []

    def _enter(self, name: str, request_options: Any) -> None:
        self.options.append((name, request_options))
        if self._timeout_on == name:
            import httpx

            raise httpx.ReadTimeout("read deadline")
        if self._fail_on == name:
            raise ApiError(status_code=500, headers={}, body={"message": "boom"})

    def navigate(self, *, url: str, request_options: Any = None) -> Resp:
        self._enter("navigate", request_options)
        self.navigated = url
        return Resp({})

    def get_elements(self, *, request_options: Any = None) -> Resp:
        self._enter("get_elements", request_options)
        return Resp(self._elements)

    def get_markdown(self, *, request_options: Any = None) -> Resp:
        self._enter("get_markdown", request_options)
        return Resp({"title": "T", "markdown": self._markdown})

    def click(self, *, index: int | None = None, request_options: Any = None) -> Resp:
        self._enter("click", request_options)
        self.clicked = index
        return Resp({})

    def fill(
        self, *, text: str, index: int | None = None, request_options: Any = None
    ) -> Resp:
        self._enter("fill", request_options)
        self.filled = (index, text)
        return Resp({})

    def press_key(self, *, key: str, request_options: Any = None) -> Resp:
        self._enter("press_key", request_options)
        self.keys.append(key)
        return Resp({})

    def screenshot(self, *, request_options: Any = None):
        # The PAGE endpoint. `browser.screenshot` would capture the container's
        # virtual display instead — the wrong artifact — and this fake exposes
        # only `browser_page`, so reaching for it is a loud AttributeError.
        self._enter("screenshot", request_options)
        yield self._png[: len(self._png) // 2]
        yield self._png[len(self._png) // 2 :]


class FakeSandbox:
    def __init__(self, page: FakeBrowserPage) -> None:
        self.browser_page = page


def _backend(page: FakeBrowserPage, **kwargs: Any) -> SdkBrowserBackend:
    return SdkBrowserBackend(base_url=BASE, client=FakeSandbox(page), **kwargs)


# --------------------------------------------------------------------------
# Construction
# --------------------------------------------------------------------------


def test_an_empty_base_url_is_refused_at_construction() -> None:
    with pytest.raises(AioBrowserError):
        SdkBrowserBackend(base_url="", client=FakeSandbox(FakeBrowserPage()))


# --------------------------------------------------------------------------
# 100 — navigate, click, type: index-addressed, no selector bridge
# --------------------------------------------------------------------------


def test_navigate_hands_back_the_element_list_inline() -> None:
    """So the model can act on the freshly loaded page without spending a
    second tool call on `extract`."""
    page = FakeBrowserPage(elements=ELEMENTS)

    out = _backend(page).navigate("https://example.com")

    assert page.navigated == "https://example.com"
    assert out.splitlines() == [
        "[0] <a> Learn more (https://x/y)",
        "[1] <button> Go",
    ]


def test_the_element_line_carries_an_href_only_when_there_is_one() -> None:
    page = FakeBrowserPage(
        elements=[
            {"index": 3, "tag": "input", "placeholder": "Search"},
            {"index": 4},
        ]
    )

    lines = _backend(page).navigate("https://x").splitlines()

    # A field with no text falls back to its placeholder; an element with
    # neither still gets a line, because its index is what the model needs.
    assert lines == ["[3] <input> Search", "[4] <element>"]


def test_click_passes_the_index_natively() -> None:
    """The SDK takes the numeric index a prior extract handed the model, so
    there is no selector to build — and nothing the model says is interpolated
    into one."""
    page = FakeBrowserPage()

    out = _backend(page).click(1)

    assert page.clicked == 1
    assert "1" in out


def test_type_fills_and_only_presses_enter_when_asked_to() -> None:
    page = FakeBrowserPage()
    backend = _backend(page)

    backend.type(2, "hello", submit=False)
    assert page.filled == (2, "hello")
    assert page.keys == []

    backend.type(2, "query", submit=True)
    assert page.filled == (2, "query")
    assert page.keys == ["Enter"]


# --------------------------------------------------------------------------
# 100 — extract's shape
# --------------------------------------------------------------------------


def test_extract_joins_page_markdown_and_the_element_list_under_the_header() -> None:
    """The header string is contract: the model was trained on it by prompt, so
    a reworded heading silently degrades every browsing turn."""
    page = FakeBrowserPage(elements=ELEMENTS, markdown="# Example\nbody")

    out = _backend(page).extract()

    assert out == (
        "# Example\nbody\n\n"
        "# Interactive elements\n"
        "[0] <a> Learn more (https://x/y)\n"
        "[1] <button> Go"
    )


def test_extract_omits_an_empty_section_rather_than_leaving_a_bare_header() -> None:
    page = FakeBrowserPage(elements=[], markdown="# Only text")

    assert _backend(page).extract() == "# Only text"

    page = FakeBrowserPage(elements=ELEMENTS, markdown="")
    assert _backend(page).extract().startswith("# Interactive elements\n")


# --------------------------------------------------------------------------
# 100 — screenshot: the page, joined, and non-empty
# --------------------------------------------------------------------------


def test_screenshot_joins_the_streamed_page_chunks() -> None:
    assert _backend(FakeBrowserPage(png=b"\x89PNGdata")).screenshot() == b"\x89PNGdata"


def test_an_empty_screenshot_raises_rather_than_returning_zero_bytes() -> None:
    with pytest.raises(AioBrowserError):
        _backend(FakeBrowserPage(png=b"")).screenshot()


def test_a_screenshot_fault_is_mapped_even_though_the_body_streams() -> None:
    """The HTTP fault surfaces during iteration, so the `b"".join` has to run
    INSIDE the guard — outside it, the raw SDK error escapes unmapped and the
    browser tool's `except OSError` never sees it."""
    with pytest.raises(AioBrowserError):
        _backend(FakeBrowserPage(fail_on="screenshot")).screenshot()


# --------------------------------------------------------------------------
# Fault mapping across the surface
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("action", "call"),
    [
        ("navigate", lambda b: b.navigate("https://x")),
        ("click", lambda b: b.click(1)),
        ("fill", lambda b: b.type(1, "x")),
        ("get_markdown", lambda b: b.extract()),
        ("get_elements", lambda b: b.navigate("https://x")),
    ],
)
def test_every_action_maps_an_api_error_to_a_browser_error(action, call) -> None:
    backend = _backend(FakeBrowserPage(fail_on=action))

    with pytest.raises(AioBrowserError, match="boom"):
        call(backend)


def test_a_timeout_is_mapped_too() -> None:
    backend = _backend(FakeBrowserPage(timeout_on="navigate"))

    with pytest.raises(AioBrowserError, match="timed out"):
        backend.navigate("https://x")


def test_auth_headers_ride_as_a_per_call_request_option() -> None:
    page = FakeBrowserPage(elements=ELEMENTS)

    _backend(page, auth_headers=lambda: {"X-AIO-API-Key": "secret"}).navigate("https://x")

    assert [name for name, _ in page.options] == ["navigate", "get_elements"]
    assert all(
        options == {"additional_headers": {"X-AIO-API-Key": "secret"}}
        for _, options in page.options
    )


# --------------------------------------------------------------------------
# close
# --------------------------------------------------------------------------


def test_close_is_a_no_op_for_an_injected_client_and_is_idempotent() -> None:
    backend = _backend(FakeBrowserPage())

    backend.close()
    backend.close()


# --------------------------------------------------------------------------
# The factory the host config takes
# --------------------------------------------------------------------------


def test_the_factory_matches_the_seam_and_wires_auth_off_the_handle(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The handle's `SandboxAuth` is a live strategy: wiring `connect_headers`
    rather than its result is what keeps the credential off the adapter."""
    from noeta.sdk import SandboxHandle, StaticApiKeyAuth

    from noeta.agent.host.sdk_browser_backend import sdk_browser_factory

    handle = SandboxHandle(
        base_url=BASE,
        sandbox_id="noeta-sbx-p1",
        auth=StaticApiKeyAuth("SANDBOX_KEY_UNDER_TEST"),
        workdir="/workspace",
    )

    backend = sdk_browser_factory(handle)
    try:
        assert isinstance(backend, SdkBrowserBackend)
        monkeypatch.setenv("SANDBOX_KEY_UNDER_TEST", "rotated")
        assert backend._request_options() == {
            "additional_headers": {"X-AIO-API-Key": "rotated"}
        }
    finally:
        backend.close()
