"""`models.json` → the SDK's model catalog, so compaction is not silently off.

This module exists for one failure that is invisible until a long session dies.
`derive_compaction_config(model)` resolves the model through the SDK's
`CATALOG`; a model the catalog does not know returns "compaction off"
(`context_window=None`). A custom-gateway model therefore had **compaction
disabled entirely** — the context only ever grew, and the model eventually
emitted repeatedly truncated tool calls. Observed in a production trace, and
nothing looks wrong until it happens.

Two rules keep the fix from becoming a new problem:

- **Register every unknown model; fall back loudly, never silently.** An entry
  that declares `context_window` / `max_output_tokens` is registered with those
  values; one that omits them is still registered — with a conservative default
  and a `warning` — because a silently-unregistered model means compaction off
  *and* no output ceiling (the gateway's own low default truncates the answer).
  The default is a guess, so it is announced: declare the real values to make
  the warning go away. The guess leans small on purpose (it relies on the
  policy's passive-overflow safety net, which only fires below the real window).
- **Never override an SDK-authoritative row.** The SDK's rows are
  transcriptions of vendor pages; a hand-written `models.json` is not, and a
  bad number there must not silently redefine a real model's window. Pinned by
  object identity in the test suite.

Prices are 0.0: an internal gateway publishes none, and the SDK's own gateway
rows do the same.
"""
from __future__ import annotations

import logging
from collections.abc import Iterable

from noeta.agent.models_config import ModelDef

# The catalog is a plain module-level dict re-exported by `noeta.sdk.providers`,
# and the SDK's compaction derivation reads that same object — so registering a
# row means mutating it in place, not rebinding the name.
from noeta.sdk.providers import CATALOG, ModelSpec

logger = logging.getLogger(__name__)

# Conservative fallbacks for a model that omits the values in `models.json`.
# Both are guesses, applied only when the field is absent (`is None`), and every
# use is warned about — the honest number belongs in `models.json`. The window
# leans small (< most real windows) so the policy's passive-overflow net can
# still catch an over-guess; the output cap sits well above the gateway's stingy
# ~1000 default that would otherwise truncate the answer.
_DEFAULT_CONTEXT_WINDOW = 200_000
_DEFAULT_MAX_OUTPUT_TOKENS = 16_384


def register_model_specs(models: Iterable[ModelDef]) -> list[str]:
    """Register every model unknown to the SDK, defaulting missing fields.

    Returns the ids actually added, newly-registered first-seen order. A model
    already in the catalog (an SDK-authoritative row) is left untouched. A model
    that omits `context_window` / `max_output_tokens` is registered with a
    conservative default and a `warning`, rather than skipped — an unregistered
    model has compaction disabled *and* no output ceiling.

    Idempotent: a second call over the same models adds nothing, because the
    rows from the first call are now in the catalog and the "already known"
    guard covers them exactly as it covers the SDK's own.
    """
    added: list[str] = []
    for model in models:
        if model.id in CATALOG:
            continue
        # Distinguish "absent" (fall back) from an explicit value — including an
        # explicit 0, which is an operator error worth warning about rather than
        # silently rewriting to the default (`x or default` would hide it).
        if model.context_window is None:
            context_window = _DEFAULT_CONTEXT_WINDOW
            logger.warning(
                "model %s omits context_window; defaulting to %d — declare the "
                "real value in models.json to silence this",
                model.id,
                _DEFAULT_CONTEXT_WINDOW,
            )
        else:
            context_window = model.context_window
            if context_window <= 0:
                logger.warning(
                    "model %s has a non-positive context_window (%d); compaction "
                    "will behave as if disabled",
                    model.id,
                    context_window,
                )
        if model.max_output_tokens is None:
            max_output_tokens = _DEFAULT_MAX_OUTPUT_TOKENS
            logger.warning(
                "model %s omits max_output_tokens; defaulting to %d — declare "
                "the real value in models.json to silence this",
                model.id,
                _DEFAULT_MAX_OUTPUT_TOKENS,
            )
        else:
            max_output_tokens = model.max_output_tokens
            if max_output_tokens <= 0:
                logger.warning(
                    "model %s has a non-positive max_output_tokens (%d)",
                    model.id,
                    max_output_tokens,
                )
        CATALOG[model.id] = ModelSpec(
            real_model_id=model.id,
            context_window=context_window,
            max_output_tokens=max_output_tokens,
            input_price_per_mtok=0.0,
            output_price_per_mtok=0.0,
            cache_read_price_per_mtok=0.0,
            cache_write_price_per_mtok=0.0,
            is_reasoning=model.is_reasoning,
            supports_vision=model.supports_vision,
        )
        added.append(model.id)
    if added:
        logger.info("registered %d model spec(s) for compaction: %s", len(added), added)
    return added
