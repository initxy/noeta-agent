"""`SdkBrowserBackend` — the container browser wire, over the official SDK.

The product-layer replacement for the runtime's `AioBrowserBackend` (which
drives the container's `/mcp` browser server). It implements the same narrow
`BrowserBackend` surface — `navigate` / `click` / `type` / `extract` /
`screenshot` — so the noeta-owned browser tool schemas, and therefore the stable
prompt prefix, are unchanged; only the wire moves to the official
`agent-sandbox` `browser_page` REST client.

Three things about the mapping are load-bearing rather than incidental:

- **Elements are addressed by the numeric `index`** a prior `extract` (or
  `navigate`) handed the model. The SDK's `click` / `fill` take that index
  natively, so there is no selector bridge to keep in sync — and nothing the
  model says is ever interpolated into a selector.
- **`extract` = page markdown plus a `"# Interactive elements"` section.** That
  header string is kept byte-identical: it is the shape the model was trained
  on by prompt, and moving it silently degrades every browsing turn.
- **`screenshot` uses `browser_page.screenshot`** — the *page*. `browser
  .screenshot` captures the container's virtual display, which is the wrong
  artifact. It also *streams*, so the `b"".join(...)` has to run **inside** the
  error-mapping guard or an HTTP fault escapes unmapped.

Faults are re-raised as `AioBrowserError` (an `OSError`), which is what the
browser tools' `except OSError` sites turn into a clean
`ToolResult(success=False)` instead of a crashed worker.

This module and `sdk_sandbox_exec_env` are the only two exemptions to the
import boundary (`noeta.agent.*` may otherwise import only `noeta.sdk` /
`noeta.presets`), declared in `pyproject.toml`'s import-linter contract. They
exist because they extend concrete AIO adapters the SDK deliberately keeps off
its public surface. The exemption list may only shrink.
"""
from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Callable

import httpx
from agent_sandbox import Sandbox
from agent_sandbox.core.api_error import ApiError
from noeta.sdk import BrowserBackend, SandboxHandle

# The AIO browser error type is an SDK internal, NOT on the `noeta.sdk` public
# surface. This is one of the two import-linter exemptions (see the module
# docstring, and the contract in pyproject.toml).
from noeta.builtins.sandbox.impl.browser import AioBrowserError

__all__ = ["SdkBrowserBackend", "sdk_browser_factory"]

#: Kept byte-identical to the runtime adapter's own constant: the model was
#: trained on this exact heading by prompt, so it is contract, not formatting.
_INTERACTIVE_ELEMENTS_HEADER = "# Interactive elements"

_DEFAULT_BROWSER_TIMEOUT_S = 60.0


class SdkBrowserBackend:
    """`BrowserBackend` over the `agent-sandbox` `browser_page` client.

    An injected `client` is the test seam; production builds the real client on
    an httpx pool with `trust_env=False`, because the container is at 127.0.0.1
    and an ambient proxy would hang the loopback call rather than fail it."""

    def __init__(
        self,
        *,
        base_url: str,
        auth_headers: Callable[[], Mapping[str, str]] | None = None,
        timeout_s: float = _DEFAULT_BROWSER_TIMEOUT_S,
        client: Sandbox | None = None,
    ) -> None:
        if not base_url:
            raise AioBrowserError("aio browser base_url is empty")
        self._auth_headers = auth_headers
        # Kept only when this instance built (and therefore owns) the pool, so
        # `close` never touches an injected test client.
        self._httpx_client: httpx.Client | None = None
        if client is None:
            self._httpx_client = httpx.Client(timeout=timeout_s, trust_env=False)
            client = Sandbox(
                base_url=base_url.rstrip("/"), httpx_client=self._httpx_client
            )
        self._client: Sandbox = client

    def close(self) -> None:
        """Release the owned connection pool. Idempotent, never raises."""
        if self._httpx_client is not None:
            try:
                self._httpx_client.close()
            except Exception:  # noqa: BLE001 - teardown must not raise
                pass

    # -- request options and fault mapping --------------------------------- #

    def _request_options(self) -> dict[str, Any] | None:
        if self._auth_headers is None:
            return None
        headers = self._auth_headers()
        return {"additional_headers": dict(headers)} if headers else None

    def _guard(self, action: str, call: Callable[[], Any]) -> Any:
        """Run one SDK browser call, mapping every fault to `AioBrowserError`."""
        try:
            return call()
        except AioBrowserError:
            raise
        except ApiError as exc:
            raise AioBrowserError(f"{action}: {self._api_error_message(exc)}") from exc
        except httpx.TimeoutException as exc:
            raise AioBrowserError(f"{action}: timed out: {exc}") from exc
        except Exception as exc:  # noqa: BLE001 - any other transport fault
            raise AioBrowserError(f"{action}: transport error: {exc}") from exc

    @staticmethod
    def _api_error_message(exc: ApiError) -> str:
        body = exc.body
        if isinstance(body, Mapping):
            message = body.get("message")
            if isinstance(message, str) and message:
                return message
        if isinstance(body, str) and body:
            return body
        return f"browser request failed (status {exc.status_code})"

    # -- element-list shaping ---------------------------------------------- #

    def _elements_text(self) -> str:
        """The numbered interactive-element list the model addresses by index.

        One line per element: `[<index>] <<tag>> <text>`, with `(<href>)`
        appended only when there is one. Each element already carries the same
        `index` `click` and `type` take, so the model can act straight off this
        list."""
        result = self._guard(
            "get_elements",
            lambda: self._client.browser_page.get_elements(
                request_options=self._request_options()
            ),
        )
        elements = getattr(result, "data", None)
        if not isinstance(elements, list):
            return ""
        lines: list[str] = []
        for element in elements:
            if not isinstance(element, Mapping):
                continue
            index = element.get("index")
            tag = element.get("tag") or "element"
            text = (element.get("text") or element.get("placeholder") or "").strip()
            href = element.get("href")
            label = f"[{index}] <{tag}> {text}".rstrip()
            if href:
                label = f"{label} ({href})"
            lines.append(label)
        return "\n".join(lines)

    # -- BrowserBackend ---------------------------------------------------- #

    def navigate(self, url: str) -> str:
        self._guard(
            "navigate",
            lambda: self._client.browser_page.navigate(
                url=url, request_options=self._request_options()
            ),
        )
        # Hand back the element list inline, so the model can act on the freshly
        # loaded page without spending a second tool call on `extract`.
        return self._elements_text()

    def click(self, index: int) -> str:
        self._guard(
            "click",
            lambda: self._client.browser_page.click(
                index=index, request_options=self._request_options()
            ),
        )
        return f"clicked element {index}"

    def type(self, index: int, text: str, *, submit: bool = False) -> str:
        # There is no single container "type": fill the field, then optionally
        # press Enter.
        self._guard(
            "fill",
            lambda: self._client.browser_page.fill(
                text=text, index=index, request_options=self._request_options()
            ),
        )
        outcome = f"typed into element {index}"
        if submit:
            self._guard(
                "press_key",
                lambda: self._client.browser_page.press_key(
                    key="Enter", request_options=self._request_options()
                ),
            )
            outcome = f"{outcome}; pressed Enter"
        return outcome

    def extract(self) -> str:
        result = self._guard(
            "get_markdown",
            lambda: self._client.browser_page.get_markdown(
                request_options=self._request_options()
            ),
        )
        data = getattr(result, "data", None)
        markdown = str(data.get("markdown") or "") if isinstance(data, Mapping) else ""
        elements = self._elements_text()
        sections: list[str] = []
        if markdown:
            sections.append(markdown)
        if elements:
            sections.append(f"{_INTERACTIVE_ELEMENTS_HEADER}\n{elements}")
        return "\n\n".join(sections)

    def screenshot(self) -> bytes:
        # The PAGE endpoint, not `browser.screenshot` (the container's virtual
        # display — wrong artifact). It streams, so the join has to happen
        # INSIDE the guard: the HTTP fault surfaces during iteration, and a join
        # outside would let it escape unmapped.
        data = self._guard(
            "screenshot",
            lambda: b"".join(
                self._client.browser_page.screenshot(
                    request_options=self._request_options()
                )
            ),
        )
        if not data:
            raise AioBrowserError("screenshot: empty response")
        return data


def sdk_browser_factory(handle: SandboxHandle) -> BrowserBackend:
    """`HostConfig.sandbox_browser_factory` over this adapter.

    The handle's live `SandboxAuth` becomes the per-call header factory, so the
    credential rides only on the wire and is never recorded."""
    return SdkBrowserBackend(
        base_url=handle.base_url, auth_headers=handle.auth.connect_headers
    )
