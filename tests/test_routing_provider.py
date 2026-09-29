"""Provider assembly: gateway routing and catalog registration.

Two failures live here, and both are silent.

**Routing** decides which host a model's request reaches. Getting it wrong
does not raise — it sends the request to the other gateway, which answers with
a plausible-looking 404 or an authentication error attributed to the wrong
credential.

**Catalog registration** decides whether compaction runs at all. A model the
SDK's catalog does not know derives "compaction off", so the host registers
every unknown model — with declared values, or a warned-about default when they
are omitted — so its context does not grow forever and die on truncated tool
calls, with nothing wrong-looking until it does.

Every settings object here **clears the secondary-gateway keys explicitly**.
A developer machine may have a real secondary configured, and the routing
branch it selects is a different one; the baseline must come from this file,
not from the machine.
"""
from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path
from typing import Any, Iterator, Protocol, runtime_checkable

import pytest

from noeta.agent.config import Settings
from noeta.agent.host.provider import (
    PRIMARY_GATEWAY,
    SECONDARY_GATEWAY,
    LateImageResolver,
    ProviderBuild,
    RoutingProvider,
    build_provider,
)
from noeta.sdk import LLMRequest, LLMResponse, StreamingProvider, TextBlock
from noeta.sdk.providers import CATALOG
from noeta.sdk.providers import AnthropicProvider


@runtime_checkable
class _HeaderAware(Protocol):
    """A local mirror of the runtime's `HeaderAwareProvider`.

    The runtime probes provider capability with `isinstance` against its own
    Protocol, which `noeta.sdk` does not re-export (unlike `StreamingProvider`).
    A `runtime_checkable` Protocol matches structurally on method presence, so
    this mirror answers exactly what the runtime's probe answers — and the test
    does not pin an unexported name."""

    def complete_with_headers(
        self, request: Any, request_headers: dict[str, str] | None
    ) -> Any: ...


# ---------------------------------------------------------------------------
# Doubles
# ---------------------------------------------------------------------------


def _request(model: str) -> LLMRequest:
    return LLMRequest(model=model, messages=[])


def _response(tag: str) -> LLMResponse:
    return LLMResponse(stop_reason="end_turn", content=[TextBlock(text=tag)])


class _FullSub:
    """A sub-provider implementing all three entry points, recording which one
    was taken and with what headers — the response body carries its own tag so
    an assertion can tell which gateway answered."""

    def __init__(self, tag: str) -> None:
        self.tag = tag
        self.calls: list[tuple[str, dict[str, str] | None]] = []

    def complete(self, request: LLMRequest) -> LLMResponse:
        self.calls.append(("complete", None))
        return _response(self.tag)

    def complete_with_headers(
        self, request: LLMRequest, request_headers: dict[str, str] | None
    ) -> LLMResponse:
        self.calls.append(("headers", request_headers))
        return _response(self.tag)

    def complete_streaming(
        self,
        request: LLMRequest,
        on_delta: Any,
        request_headers: dict[str, str] | None = None,
    ) -> LLMResponse:
        self.calls.append(("stream", request_headers))
        return _response(self.tag)


class _MinimalSub:
    """A sub-provider with only the mandatory `complete`."""

    def __init__(self, tag: str) -> None:
        self.tag = tag
        self.calls: list[str] = []

    def complete(self, request: LLMRequest) -> LLMResponse:
        self.calls.append("complete")
        return _response(self.tag)


def _mark_headers(headers: dict[str, str] | None) -> dict[str, str]:
    """Stand-in for a per-gateway header rewrite. No gateway needs one today,
    so the mechanism is covered with a local transform rather than left
    untested until the first one does."""
    out = dict(headers or {})
    out["x-transformed"] = "yes"
    return out


def _router() -> tuple[RoutingProvider, _FullSub, _FullSub]:
    primary, secondary = _FullSub("primary"), _FullSub("secondary")
    router = RoutingProvider(
        {
            PRIMARY_GATEWAY: (primary, None),
            SECONDARY_GATEWAY: (secondary, _mark_headers),
        },
        default_gateway=PRIMARY_GATEWAY,
    )
    router.register_model("gpt-x", PRIMARY_GATEWAY)
    router.register_model("sec-model", SECONDARY_GATEWAY)
    return router, primary, secondary


# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------


def test_dispatch_is_keyed_on_the_request_model() -> None:
    router, _primary, _secondary = _router()
    assert router.complete(_request("gpt-x")).content[0].text == "primary"
    assert router.complete(_request("sec-model")).content[0].text == "secondary"


def test_unregistered_model_falls_to_the_default_gateway() -> None:
    """An internal call or a selector `models.json` does not mention still has
    to reach a gateway."""
    router, _primary, _secondary = _router()
    assert router.complete(_request("never-configured")).content[0].text == "primary"


def test_unconfigured_gateway_name_falls_back_instead_of_raising() -> None:
    """`models.json` is user-editable: a typo degrades to the primary rather
    than refusing to boot."""
    router, _primary, _secondary = _router()
    router.register_model("weird", "no-such-gateway")
    assert router.gateways["weird"] == PRIMARY_GATEWAY
    assert router.complete(_request("weird")).content[0].text == "primary"


def test_header_transform_applies_only_to_the_route_that_registered_one() -> None:
    router, primary, secondary = _router()
    headers = {"x-session-id": "task-1"}

    router.complete_streaming(_request("sec-model"), lambda _d: None, headers)
    router.complete_streaming(_request("gpt-x"), lambda _d: None, headers)

    transformed = {"x-session-id": "task-1", "x-transformed": "yes"}
    assert secondary.calls == [("stream", transformed)]
    # The untransformed route's headers pass through byte-identical.
    assert primary.calls == [("stream", headers)]


def test_header_path_routes_and_transforms() -> None:
    router, _primary, secondary = _router()
    router.complete_with_headers(_request("sec-model"), {"x-session-id": "s"})
    transformed = {"x-session-id": "s", "x-transformed": "yes"}
    assert secondary.calls == [("headers", transformed)]


def test_router_satisfies_both_optional_provider_protocols() -> None:
    """The runtime probes capability by `isinstance`. A router that declared
    only `complete` would silently downgrade every model to the batch path."""
    router, _primary, _secondary = _router()
    assert isinstance(router, StreamingProvider)
    assert isinstance(router, _HeaderAware)


def test_streaming_degrades_step_by_step_for_a_minimal_sub_provider() -> None:
    """The router advertises streaming for every model, including one served
    by a sub-provider that cannot stream."""
    minimal = _MinimalSub("minimal")
    router = RoutingProvider({PRIMARY_GATEWAY: (minimal, None)}, PRIMARY_GATEWAY)

    streamed = router.complete_streaming(_request("m"), lambda _d: None, {"h": "1"})
    with_headers = router.complete_with_headers(_request("m"), {"h": "1"})

    assert streamed.content[0].text == "minimal"
    assert with_headers.content[0].text == "minimal"
    assert minimal.calls == ["complete", "complete"]


def test_default_gateway_must_exist() -> None:
    with pytest.raises(ValueError):
        RoutingProvider({PRIMARY_GATEWAY: (_FullSub("p"), None)}, "nowhere")


# ---------------------------------------------------------------------------
# build_provider
# ---------------------------------------------------------------------------


def _models_file(tmp_path: Path, entries: list[dict[str, Any]]) -> str:
    path = tmp_path / "models.json"
    path.write_text(json.dumps({"models": entries}), encoding="utf-8")
    return str(path)


_TWO_GATEWAY_MODELS: list[dict[str, Any]] = [
    {"id": "gpt-x", "label": "GPT X", "default": True},
    {"id": "custom/60b", "label": "Custom 60B", "gateway": SECONDARY_GATEWAY},
]


@pytest.fixture
def gateway_settings(
    make_settings: Callable[..., Settings], tmp_path: Path
) -> Callable[..., Settings]:
    """Settings with the primary gateway configured and the secondary
    explicitly empty. The models file defaults to the two-gateway pair."""

    def _build(
        *, models: list[dict[str, Any]] | None = None, **overrides: Any
    ) -> Settings:
        baseline: dict[str, Any] = {
            "llm_provider": "auto",
            "llm_base_url": "https://gateway.test/api",
            "llm_api_key": "gw-key",
            "secondary_llm_base_url": "",
            "secondary_llm_api_key": "",
            "models_config": _models_file(tmp_path, models or _TWO_GATEWAY_MODELS),
        }
        baseline.update(overrides)
        return make_settings(**baseline)

    return _build


def test_single_gateway_build_is_not_a_router(gateway_settings) -> None:
    build = build_provider(gateway_settings())
    assert isinstance(build, ProviderBuild)
    assert build.name == PRIMARY_GATEWAY
    assert not isinstance(build.provider, RoutingProvider)
    # The primary speaks the Anthropic Messages protocol: it is the only relay
    # endpoint that honours cache_control prompt-cache breakpoints (the
    # /responses endpoint returns cached_tokens:0). AnthropicProvider appends
    # /v1/messages to base_url itself, so the settings base (which may end in
    # /v1 for other tooling) has that suffix stripped to avoid /v1/v1/messages.
    assert isinstance(build.provider, AnthropicProvider)
    assert str(build.provider._client.base_url).rstrip("/") == "https://gateway.test/api"
    # The relay authenticates on `Authorization: Bearer` but also validates the
    # `x-api-key` header the constructor always sends, so the real key rides
    # both: as api_key (→ x-api-key) and mirrored into the Bearer header.
    assert build.provider._client.headers["authorization"] == "Bearer gw-key"
    assert build.provider._client.headers["x-api-key"] == "gw-key"


def test_secondary_configured_builds_a_router_still_named_openai(
    gateway_settings,
) -> None:
    """`/health` and the `provider_headers` gate both read the name, and
    routing is an overlay on the gateway path — not a third provider."""
    build = build_provider(
        gateway_settings(
            secondary_llm_base_url="https://secondary.test/v1",
            secondary_llm_api_key="sec-key",
        )
    )
    assert build.name == PRIMARY_GATEWAY
    assert isinstance(build.provider, RoutingProvider)
    assert build.provider.gateways == {
        "gpt-x": PRIMARY_GATEWAY,
        "custom/60b": SECONDARY_GATEWAY,
    }


def test_secondary_adapter_carries_bearer_auth_and_no_reasoning_replay(
    gateway_settings,
) -> None:
    """The second gateway differs from the first in exactly two ways, and both
    are load-bearing: `Authorization: Bearer` with an empty `api-key`, and no
    cross-turn replay of encrypted reasoning."""
    build = build_provider(
        gateway_settings(
            secondary_llm_base_url="https://secondary.test/v1",
            secondary_llm_api_key="sec-key",
        )
    )
    secondary = build.provider._routes[SECONDARY_GATEWAY][0]
    assert secondary._endpoint == "https://secondary.test/v1/responses"
    assert secondary._reasoning_continuation == "off"
    assert secondary._client.headers["authorization"] == "Bearer sec-key"
    assert secondary._client.headers["api-key"] == ""


def test_no_primary_credentials_is_mock_even_with_a_secondary(gateway_settings) -> None:
    build = build_provider(
        gateway_settings(
            llm_base_url="",
            llm_api_key="",
            secondary_llm_base_url="https://secondary.test/v1",
            secondary_llm_api_key="sec-key",
        )
    )
    assert build.name == "mock"
    assert not isinstance(build.provider, RoutingProvider)


def test_session_affinity_headers_are_wired_for_the_gateway_only(
    gateway_settings,
) -> None:
    """Some gateways key prompt-cache affinity on a stable per-task session
    id. The mock has no gateway, so it must not carry the header."""
    gateway = build_provider(gateway_settings())
    assert gateway.provider_headers is not None
    ctx = type("Ctx", (), {"task_id": "task-42"})()
    assert gateway.provider_headers(ctx) == {"x-session-id": "task-42"}

    mock = build_provider(gateway_settings(llm_base_url="", llm_api_key=""))
    assert mock.provider_headers is None


# ---------------------------------------------------------------------------
# Image resolver — the deferred ContentRef→bytes deref
# ---------------------------------------------------------------------------


class _Ref:
    """The shape the resolver reads: an `ImageBlock.source` has a `.hash`."""

    def __init__(self, digest: str) -> None:
        self.hash = digest


def test_unbound_resolver_raises_rather_than_dropping_the_image() -> None:
    """Called before `build_runtime` binds it, the resolver refuses. A turn
    only ever reaches a provider after wiring is done, so an unbound call is a
    regression — and the SDK's own rule is to raise, never silently drop."""
    resolver = LateImageResolver()
    with pytest.raises(RuntimeError):
        resolver(_Ref("a" * 64))


def test_bound_resolver_derefs_by_hash() -> None:
    """After `bind`, the ref's hash is what reaches the getter, and its bytes
    come straight back — this is the adapter the runtime installs over
    `client.get_content`."""
    resolver = LateImageResolver()
    resolver.bind(lambda ref: b"PNGDATA" if ref.hash == "d" * 64 else b"")
    assert resolver(_Ref("d" * 64)) == b"PNGDATA"


def test_single_gateway_wires_an_image_resolver(gateway_settings) -> None:
    """The whole bug: a gateway provider built without an `image_resolver`
    fatals on the first `ImageBlock`. The binder is present and the provider
    holds it, so an image-bearing turn has a deref to reach for."""
    build = build_provider(gateway_settings())
    assert build.image_binder is not None
    assert build.provider._image_resolver is build.image_binder


def test_both_gateways_share_one_binder(gateway_settings) -> None:
    """Under routing, primary and secondary must deref through the *same*
    binder, so the runtime's single `bind` wires both hosts at once."""
    build = build_provider(
        gateway_settings(
            secondary_llm_base_url="https://secondary.test/v1",
            secondary_llm_api_key="sec-key",
        )
    )
    assert build.image_binder is not None
    primary = build.provider._routes[PRIMARY_GATEWAY][0]
    secondary = build.provider._routes[SECONDARY_GATEWAY][0]
    assert primary._image_resolver is build.image_binder
    assert secondary._image_resolver is build.image_binder


def test_mock_build_has_no_image_binder(gateway_settings) -> None:
    """No gateway means no image wire: the mock leaves the binder None, which
    is the gate the runtime reads to skip binding."""
    build = build_provider(gateway_settings(llm_base_url="", llm_api_key=""))
    assert build.name == "mock"
    assert build.image_binder is None


def test_runtime_binds_the_resolver_to_the_content_store(
    gateway_settings, monkeypatch
) -> None:
    """The end-to-end weld: `build_runtime` builds the gateway provider before
    the client, then binds the deferred resolver to `client.get_content`. A
    blob put through the client must deref back through the *same* binder the
    provider holds — which is exactly the path an `ImageBlock` takes at
    wire-assembly time.

    Reaches for a real store and client but never a gateway: building the client
    makes no network call, and no turn runs. `sandbox=None` keeps it off Docker.
    Capturing the `ProviderBuild` is how the test holds the binder the provider
    was handed, rather than guessing at the client's internal layout.
    """
    from noeta.agent.api import runtime as runtime_module
    from noeta.agent.store import db

    real_build = runtime_module.provider_module.build_provider
    captured: dict[str, Any] = {}

    def _capture(settings: Settings) -> Any:
        build = real_build(settings)
        captured["build"] = build
        return build

    monkeypatch.setattr(
        runtime_module.provider_module, "build_provider", _capture
    )

    settings = gateway_settings()
    settings.ensure_data_dirs()
    store = db.connect(settings.app_db_path)
    db.bootstrap(store)
    runtime = runtime_module.build_runtime(settings, store, sandbox=None)
    try:
        binder = captured["build"].image_binder
        assert binder is not None
        ref = runtime.host.client.put_content(b"PNGDATA", media_type="image/png")
        # The binder is what the SDK calls with `block.source`; a bound binder
        # derefs the stored bytes, an unbound one would raise.
        assert binder(ref) == b"PNGDATA"
    finally:
        runtime.close()
        store.close()


# ---------------------------------------------------------------------------
# Catalog registration
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def catalog_guard() -> Iterator[None]:
    """Restore the SDK catalog. It is a process-wide dict and registration
    mutates it in place — which is the point, and also why a test that adds a
    row has to take it back out. Autouse: `build_provider` now registers every
    unknown model (the default `custom/60b` included), so any test that builds a
    provider mutates the catalog, not only the ones that assert on it."""
    before = dict(CATALOG)
    try:
        yield
    finally:
        CATALOG.clear()
        CATALOG.update(before)


def _derive_compaction_config(model: str):
    """The SDK's compaction derivation.

    Reached through the internal module because the SDK publishes neither the
    function nor `CompactionConfig` (`noeta.sdk.providers` exports only
    `CATALOG` / `ModelSpec` / the adapters). Asserting only on the row this
    product writes would pin nothing: the whole reason to write it is what the
    SDK's own derivation does with it afterwards.
    """
    from noeta.builtins.providers.impl.catalog import derive_compaction_config

    return derive_compaction_config(model)


def test_registration_flips_compaction_to_the_declared_window(
    gateway_settings, catalog_guard
) -> None:
    """Registration installs the model's *declared* window, overriding the
    SDK's conservative fallback. 0.6.1 no longer derives "off" (a None window)
    for an unknown model — an uncatalogued id falls back to a 128K/16384 guess
    — so the observable win is that a declared `models.json` row replaces the
    guess with the real numbers, not that it turns compaction from off to on."""
    model_id = "custom/60b"
    assert model_id not in CATALOG
    # Before registration: the SDK's conservative fallback, not the real window.
    assert _derive_compaction_config(model_id).context_window == 128_000

    build_provider(
        gateway_settings(
            models=[
                {"id": "gpt-x", "label": "GPT X", "default": True},
                {
                    "id": model_id,
                    "label": "Custom 60B",
                    "gateway": SECONDARY_GATEWAY,
                    "context_window": 200_000,
                    "max_output_tokens": 32_000,
                },
            ]
        )
    )

    assert CATALOG[model_id].context_window == 200_000
    config = _derive_compaction_config(model_id)
    assert config.context_window == 200_000
    assert config.max_output_tokens == 32_000
    # A usable window of (context - max_output - buffer) leaves a non-empty
    # protected tail; a zero tail budget would mean "on" in name only.
    assert config.tail_token_budget and config.tail_token_budget > 0


def test_registration_never_clobbers_an_sdk_authoritative_row(
    gateway_settings, catalog_guard
) -> None:
    """The SDK's rows are transcriptions of vendor pages; `models.json` is
    hand-written. A bad number there must not redefine a real model."""
    model_id = "gpt-5.5-2026-04-24"
    before = CATALOG[model_id]

    build_provider(
        gateway_settings(
            models=[
                {
                    "id": model_id,
                    "label": "GPT 5.5",
                    "default": True,
                    "context_window": 123,  # deliberately absurd
                }
            ]
        )
    )

    assert CATALOG[model_id] is before


def test_models_without_a_context_window_are_registered_with_a_default(
    gateway_settings, catalog_guard
) -> None:
    """A model that omits its window is registered anyway, with a conservative
    default, so compaction is on and the answer is not truncated by the
    gateway's own low default. The honest number belongs in `models.json`; the
    default only keeps an omission from silently disabling compaction."""
    from noeta.agent.host.catalog import (
        _DEFAULT_CONTEXT_WINDOW,
        _DEFAULT_MAX_OUTPUT_TOKENS,
    )

    model_id = "custom/nospec"
    build_provider(
        gateway_settings(
            models=[
                {"id": "gpt-x", "label": "GPT X", "default": True},
                {"id": model_id, "label": "NoSpec", "gateway": SECONDARY_GATEWAY},
            ]
        )
    )
    assert model_id in CATALOG
    assert CATALOG[model_id].context_window == _DEFAULT_CONTEXT_WINDOW
    assert CATALOG[model_id].max_output_tokens == _DEFAULT_MAX_OUTPUT_TOKENS
    # Defaulted, but compaction is genuinely on: a non-empty protected tail.
    config = _derive_compaction_config(model_id)
    assert config.context_window == _DEFAULT_CONTEXT_WINDOW
    assert config.tail_token_budget and config.tail_token_budget > 0


def test_explicit_zero_is_not_rewritten_to_the_default(
    gateway_settings, catalog_guard
) -> None:
    """An explicit 0 is an operator error, not "unset". It is registered as-is
    (not silently bumped to the default) so the mistake is visible rather than
    masked — `is None`, not `x or default`."""
    model_id = "custom/zero"
    build_provider(
        gateway_settings(
            models=[
                {"id": "gpt-x", "label": "GPT X", "default": True},
                {
                    "id": model_id,
                    "label": "Zero",
                    "gateway": SECONDARY_GATEWAY,
                    "context_window": 0,
                    "max_output_tokens": 0,
                },
            ]
        )
    )
    assert CATALOG[model_id].context_window == 0
    assert CATALOG[model_id].max_output_tokens == 0


def test_mock_boot_does_not_touch_the_catalog(gateway_settings, catalog_guard) -> None:
    """The offline path never reaches a gateway, so it leaves the process-wide
    catalog exactly as the SDK shipped it."""
    before = dict(CATALOG)
    build_provider(
        gateway_settings(
            llm_base_url="",
            llm_api_key="",
            models=[
                {
                    "id": "custom/60b",
                    "label": "Custom 60B",
                    "default": True,
                    "context_window": 200_000,
                }
            ],
        )
    )
    assert CATALOG == before
