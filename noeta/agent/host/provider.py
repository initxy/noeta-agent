"""Which LLM the product talks to, and how a per-model gateway is reached.

`build_provider(settings)` is the entry point: it answers with the provider
object the `Client` is constructed around, the name `/health` reports, and the
per-request header hook — as one `ProviderBuild`, because those three are one
decision and wiring two of them from different places is how the mock ends up
with a gateway header.

Three things here are scars rather than choices:

- **`base_url` is the full responses endpoint**, gateway root + `/responses`.
  Passing the bare root silently 404s. Verified in a spike; it cost real time.
- **The reported name stays `"openai"` under routing.** `/health` and the
  `provider_headers` gate both read it, and routing is a transparent overlay
  on the gateway path, not a third provider.
- **`x-session-id` is wired only for the real gateway.** Some gateways key
  prompt-cache affinity on a stable per-task session id: pinning every turn of
  a task to the same backend account is what lets the KV cache be reused. The
  mock has no gateway and must not carry it.

`"auto"` resolving to the mock (see `Settings.effective_provider`) is what
makes a credential-free first run a working product, so the mock branch here is
a feature path, not a test path.
"""
from __future__ import annotations

import logging
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Callable, Optional

from noeta.agent.config import Settings
from noeta.agent.host.catalog import register_model_specs
from noeta.agent.models_config import ModelDef, get_models
from noeta.sdk import ContentRef, LLMRequest, LLMResponse, StreamDelta

logger = logging.getLogger(__name__)


class LateImageResolver:
    """The `ContentRef -> bytes` deref an image-bearing request needs, filled in
    after the provider is built.

    The seam exists for one ordering fact: `build_provider` runs before the
    `Client`, and the bytes live behind `client.get_content`. So the provider is
    handed this callable at construction and the runtime `bind`s the real getter
    once the client exists (see `build_runtime`). Two providers (primary +
    secondary) share one instance, so a single `bind` wires both gateways.

    Called before `bind` it raises rather than returning nothing: a turn only
    ever reaches a provider after `build_runtime` has bound this, so an unbound
    call is a wiring regression, and the SDK's own rule is to refuse rather than
    silently drop the image.
    """

    def __init__(self) -> None:
        self._fn: Optional[Callable[[ContentRef], bytes]] = None

    def bind(self, fn: Callable[[ContentRef], bytes]) -> None:
        self._fn = fn

    def __call__(self, ref: ContentRef) -> bytes:
        if self._fn is None:
            raise RuntimeError(
                "image_resolver called before the client was bound; a turn "
                "reached the provider before build_runtime finished wiring it"
            )
        return self._fn(ref)

#: Gateway name for the primary (and the default route). It is also the
#: provider name reported to `/health`, which is why routing does not invent
#: a third one.
PRIMARY_GATEWAY = "openai"

#: Gateway name for the optional second host, as written in `models.json`.
SECONDARY_GATEWAY = "secondary"

#: Per-gateway rewrite of the runtime-supplied request headers. No gateway
#: needs one today — both accept `x-session-id` unchanged — but the seam is
#: what keeps a future gateway's header dialect from leaking into the caller.
HeaderTransform = Callable[[Optional[dict[str, str]]], Optional[dict[str, str]]]


class RoutingProvider:
    """Dispatches each call to a per-gateway sub-provider by `request.model`.

    A deep module: toward the runtime this is an ordinary provider
    (`complete` / `complete_with_headers` / `complete_streaming`); the
    model→gateway map, the sub-providers and their header transforms are all
    interior.

    **Why it has to exist at the provider layer.** The `Client` is built once
    at process startup and bound to a single provider; per turn only the model
    string changes (`model_selector`). Pointing two models at two hosts
    therefore cannot happen above this line — it has to be a dispatch on
    `request.model` inside the provider.

    Declaring all three methods is deliberate: the runtime probes
    `StreamingProvider` / `HeaderAwareProvider` by `isinstance`, so a router
    that implemented only `complete` would silently downgrade every model to
    the batch path. Each method then degrades step by step for a sub-provider
    that lacks the richer entry point.

    With a single gateway registered this class is one dict lookup more than
    calling the sub-provider directly, which is why the single-gateway
    deployment does not need a different code path.
    """

    def __init__(
        self,
        routes: dict[str, tuple[Any, Optional[HeaderTransform]]],
        default_gateway: str,
    ) -> None:
        if default_gateway not in routes:
            raise ValueError(f"default_gateway {default_gateway!r} not in routes")
        self._routes = routes
        self._default = default_gateway
        self._model_to_gateway: dict[str, str] = {}

    def register_model(self, model_id: str, gateway: str) -> None:
        """Record which gateway serves `model_id`.

        A gateway name nothing is configured for falls back to the default
        with a warning rather than raising: `models.json` is user-editable
        configuration, and a typo there must degrade to "served by the primary"
        instead of refusing to boot."""
        if gateway not in self._routes:
            logger.warning(
                "model %s declares unconfigured gateway %s, falling back to %s",
                model_id,
                gateway,
                self._default,
            )
            gateway = self._default
        self._model_to_gateway[model_id] = gateway

    @property
    def gateways(self) -> dict[str, str]:
        """The model→gateway map, copied. A read surface for diagnostics and
        the tests; the live map stays interior."""
        return dict(self._model_to_gateway)

    def _route(self, model: str) -> tuple[Any, Optional[HeaderTransform]]:
        """The sub-provider for `model`. An unregistered model — an internal
        call, or a selector the config does not mention — lands on the
        default gateway rather than failing."""
        return self._routes[self._model_to_gateway.get(model, self._default)]

    # -- LLMProvider / HeaderAwareProvider / StreamingProvider --------------

    def complete(self, request: LLMRequest) -> LLMResponse:
        provider, _ = self._route(request.model)
        return provider.complete(request)

    def complete_with_headers(
        self,
        request: LLMRequest,
        request_headers: Optional[dict[str, str]],
    ) -> LLMResponse:
        provider, transform = self._route(request.model)
        headers = transform(request_headers) if transform else request_headers
        if hasattr(provider, "complete_with_headers"):
            return provider.complete_with_headers(request, headers)
        return provider.complete(request)

    def complete_streaming(
        self,
        request: LLMRequest,
        on_delta: Callable[[StreamDelta], None],
        request_headers: Optional[dict[str, str]] = None,
    ) -> LLMResponse:
        provider, transform = self._route(request.model)
        headers = transform(request_headers) if transform else request_headers
        # This class declares complete_streaming, so the runtime takes the
        # streaming path for every model — including one served by a
        # sub-provider that cannot stream. Degrade in two steps rather than
        # assuming the richer entry point exists; the returned LLMResponse is
        # the same shape either way, so nothing above notices.
        if hasattr(provider, "complete_streaming"):
            return provider.complete_streaming(request, on_delta, headers)
        if hasattr(provider, "complete_with_headers"):
            return provider.complete_with_headers(request, headers)
        return provider.complete(request)


@dataclass(frozen=True)
class ProviderBuild:
    """What the host needs to construct the `Client`, decided in one place.

    `name` is the provider identity `/health` reports — `"openai"` or
    `"mock"`, never `"routing"`. `provider_headers` goes straight onto
    `HostConfig.provider_headers` and is `None` for the mock, which is the
    whole gate: it must not be re-derived at the wiring site.

    `image_binder` is the deferred image-deref seam: `None` for the mock (no
    gateway, no image wire), and otherwise the `LateImageResolver` the two
    gateway providers share. The runtime `bind`s it to `client.get_content`
    once the client exists — until then an image-bearing turn cannot be served,
    but no turn runs before that binding."""

    provider: Any
    name: str
    provider_headers: Optional[Callable[[Any], Mapping[str, str]]]
    image_binder: Optional[LateImageResolver] = None


def _responses_endpoint(root: str) -> str:
    """A gateway root → its responses endpoint.

    The adapter POSTs `base_url` verbatim and appends nothing, so the bare
    root silently 404s. This one-liner exists to make that impossible to
    forget at either call site."""
    return root.rstrip("/") + "/responses"


def _session_affinity_headers(ctx: Any) -> dict[str, str]:
    """Per-request headers for a gateway turn: the task id as a session id.

    Prompt-cache affinity: a gateway that shards by session id keeps every
    turn of one task on the same backend account, which is what makes the KV
    cache reusable across a long conversation."""
    return {"x-session-id": ctx.task_id}


def _build_primary(settings: Settings, image_resolver: LateImageResolver) -> Any:
    """The primary gateway: Anthropic `/v1/messages`, `Authorization: Bearer` auth.

    The gateway speaks the Anthropic Messages protocol, and this path exists for
    one reason the OpenAI Responses path could not deliver: **prompt caching**.
    The relay only honours `cache_control` breakpoints on the `/v1/messages`
    endpoint — the `/v1/responses` endpoint it also serves returns
    `cached_tokens: 0` for every request, so a long agent turn re-billed its
    whole growing prefix each round. `AnthropicProvider` puts the breakpoints on
    the wire body and the relay reuses the KV cache across turns.

    Two gateway-specific scars:

    - **`base_url` drops a trailing `/v1`.** `AnthropicProvider` appends
      `/v1/messages` itself, so `settings.llm_base_url` (which ends in `/v1` for
      the Responses path's benefit) would POST to `/v1/v1/messages` → 404.
      Verified against the live relay.
    - **`Authorization: Bearer`, and `x-api-key` must be the real key too.**
      The relay authenticates on `Authorization`, but it *also* validates the
      `x-api-key` header the constructor always sends and 401s on a bogus one —
      so the credential is passed as `api_key` (populating `x-api-key`) *and*
      mirrored into `extra_headers` as the Bearer token. Verified against the
      live relay: Bearer-only or Bearer+matching-x-api-key both 200; a
      placeholder x-api-key 401s.

    Note: the relay routes the default model id `model_hub/es1_orange_o48` to
    `claude-opus-4-8` on this endpoint (it is es1 only on `/v1/responses`). This
    is a deliberate, accepted trade: caching in exchange for the relay's
    server-side model substitution, which the product cannot override."""
    from noeta.sdk.providers import AnthropicProvider

    return AnthropicProvider(
        api_key=settings.llm_api_key,
        base_url=settings.llm_base_url.removesuffix("/v1"),
        timeout_seconds=settings.llm_request_timeout,
        extra_headers={"Authorization": f"Bearer {settings.llm_api_key}"},
        image_resolver=image_resolver,
    )


def _build_secondary(settings: Settings, image_resolver: LateImageResolver) -> Any:
    """The optional second gateway: same adapter, different host and auth.

    Two deliberate differences from the primary:

    - **`Authorization: Bearer` through `extra_headers`, `api_key=""`.** The
      adapter still sends an empty `api-key` header; this gateway
      authenticates on `Authorization` and ignores it.
    - **`reasoning_continuation="off"`.** Per-turn `reasoning.effort` is
      verified to work there, but cross-turn replay of encrypted reasoning
      (`include: [reasoning.encrypted_content]`) is not, and a model outside
      the primary's catalog may reject it. Each turn still carries its own
      effort; the only loss is reusing the previous turn's reasoning.
    """
    from noeta.sdk.providers import OpenAIResponsesProvider

    return OpenAIResponsesProvider(
        base_url=_responses_endpoint(settings.secondary_llm_base_url),
        api_key="",
        timeout_seconds=settings.llm_request_timeout,
        extra_headers={"Authorization": f"Bearer {settings.secondary_llm_api_key}"},
        reasoning_continuation="off",
        image_resolver=image_resolver,
    )


def _build_router(
    settings: Settings, models: list[ModelDef], image_resolver: LateImageResolver
) -> RoutingProvider:
    routes: dict[str, tuple[Any, Optional[HeaderTransform]]] = {
        PRIMARY_GATEWAY: (_build_primary(settings, image_resolver), None),
        SECONDARY_GATEWAY: (_build_secondary(settings, image_resolver), None),
    }
    router = RoutingProvider(routes, default_gateway=PRIMARY_GATEWAY)
    for model in models:
        router.register_model(model.id, model.gateway)
    return router


def build_provider(settings: Settings) -> ProviderBuild:
    """The provider this process talks to, from configuration alone.

    `"auto"` has already resolved by the time this runs (see
    `Settings.effective_provider`): anything that is not the gateway is the
    mock, which is a working offline product rather than a degraded one.
    """
    if settings.effective_provider != PRIMARY_GATEWAY:
        from noeta.agent.host.mock_llm import build_mock_provider

        logger.info("LLM provider: mock (offline, no gateway)")
        # No provider_headers: there is no gateway to key a cache on, and
        # wiring one anyway would make the mock path differ from what it
        # simulates.
        return ProviderBuild(build_mock_provider(), "mock", None)

    models = get_models(settings)
    # Before any provider exists: register every configured model the SDK
    # catalog does not already know, so it has a real (or defaulted) context
    # window and output ceiling instead of compaction-off + gateway truncation.
    # Deliberately not done on the mock path — that path never reaches a
    # gateway, and keeping it free of global mutation keeps the offline suite's
    # catalog identical to the SDK's.
    register_model_specs(models)

    # One resolver shared by every gateway provider: `build_runtime` binds it to
    # `client.get_content` once the client exists, and an image-bearing request
    # derefs its `ImageBlock` bytes through it. Unbound it raises, so a wiring
    # regression surfaces instead of a silently dropped image.
    image_binder = LateImageResolver()

    if not settings.secondary_gateway_configured:
        logger.info(
            "LLM provider: anthropic (Messages) endpoint=%s/v1/messages",
            settings.llm_base_url.removesuffix("/v1"),
        )
        return ProviderBuild(
            _build_primary(settings, image_binder),
            PRIMARY_GATEWAY,
            _session_affinity_headers,
            image_binder,
        )

    router = _build_router(settings, models, image_binder)
    logger.info(
        "LLM provider: routing (primary + secondary) secondary_endpoint=%s models=%s",
        _responses_endpoint(settings.secondary_llm_base_url),
        router.gateways,
    )
    # Still "openai": routing is an overlay on the gateway path, and both
    # /health and the header gate read this name.
    return ProviderBuild(
        router, PRIMARY_GATEWAY, _session_affinity_headers, image_binder
    )
