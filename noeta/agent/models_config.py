"""Model definitions: the available models and their effort ladders, read
from `models.json` (MODELS_CONFIG).

Deep module: callers touch only `get_models` / `get_default_model` /
`validate_model`; file parsing, the fallback, and path resolution hide behind
it.

Two policies worth stating out loud:

- **Never crash over model config.** Missing, unparseable, or empty file
  degrades to a single hard-coded model with a warning. This is what keeps a
  first run — no config of any kind — a working product.
- **`gateway` / `context_window` / `max_output_tokens` never reach the
  frontend.** They are routing and compaction internals; `to_api()` is the
  whole wire contract and its field order is stable.
"""
from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

from noeta.agent.config import Settings

# The effort ladder is the engine's, not ours — take it from the public
# surface rather than re-declaring it here.
from noeta.sdk import effort_modes

logger = logging.getLogger(__name__)

# Single-model fallback for a missing / unparseable / empty config file.
_FALLBACK_ID = "model_hub/es1_orange_o48"
_FALLBACK_LABEL = "ES1 Orange O48"
_FALLBACK_EFFORT = "high"


class ModelValidationError(ValueError):
    """An unknown model or an effort the model does not offer. The API maps
    this to 422."""


class ModelDef(BaseModel):
    id: str
    label: str
    default: bool = False
    efforts: list[str] = Field(default_factory=list)
    default_effort: str | None = None
    # Which gateway serves this model: "openai" (primary) | "secondary".
    # Backend routing only — one Client is bound to one provider at startup,
    # so per-model base URL / auth is dispatched inside the provider layer.
    gateway: str = "openai"
    # Context window / output reservation, in tokens. Compaction is derived
    # from the SDK's model catalog; a custom-gateway model the SDK does not
    # know is registered by `register_model_specs`. None = not declared here,
    # so the host registers the model with a conservative default (and warns);
    # declare the real values to get accurate compaction + output ceiling.
    context_window: int | None = None
    max_output_tokens: int | None = None
    # Capability flags forwarded to the registered ModelSpec. `supports_vision`
    # is load-bearing: the Responses adapter's vision guard blocks ImageBlock
    # requests to a model whose spec has it False. `is_reasoning` has no SDK
    # consumer today (effort is driven by the request), kept for future parity.
    supports_vision: bool = False
    is_reasoning: bool = False

    def to_api(self) -> dict[str, Any]:
        """The `/models` serialization. Stable field order; the routing and
        compaction fields are deliberately absent."""
        return {
            "id": self.id,
            "label": self.label,
            "default": self.default,
            "efforts": list(self.efforts),
            "default_effort": self.default_effort,
        }


def _fallback() -> list[ModelDef]:
    return [
        ModelDef(
            id=_FALLBACK_ID,
            label=_FALLBACK_LABEL,
            default=True,
            efforts=list(effort_modes()),
            default_effort=_FALLBACK_EFFORT,
        )
    ]


def _load(path: Path) -> list[ModelDef]:
    if not path.is_file():
        logger.warning("models config missing, degrading to a single model: %s", path)
        return _fallback()
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        defs = [ModelDef(**m) for m in raw.get("models", [])]
    except Exception:  # noqa: BLE001 - any parse error degrades, never crashes
        logger.warning(
            "models config unparseable, degrading to a single model: %s",
            path,
            exc_info=True,
        )
        return _fallback()
    if not defs:
        logger.warning("models config empty, degrading to a single model: %s", path)
        return _fallback()
    # With several default=true entries only the first counts; the rest are
    # demoted so /models never advertises two defaults.
    seen_default = False
    for d in defs:
        if d.default and not seen_default:
            seen_default = True
        elif d.default:
            d.default = False
    return defs


def get_models(settings: Settings) -> list[ModelDef]:
    """Every configured model, in file order. Read per call: the file is tiny
    and editing it should not need a restart."""
    return _load(settings.models_config_path)


def get_default_model(settings: Settings) -> ModelDef:
    models = get_models(settings)
    for m in models:
        if m.default:
            return m
    return models[0]


def validate_model(
    settings: Settings, model_id: str, effort: str | None = None
) -> ModelDef:
    """The requested model (and effort), or `ModelValidationError`."""
    for m in get_models(settings):
        if m.id != model_id:
            continue
        if effort is not None and effort not in m.efforts:
            raise ModelValidationError(
                f"unknown effort for model {model_id}: {effort}"
            )
        return m
    raise ModelValidationError(f"unknown model: {model_id}")
