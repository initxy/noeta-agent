"""`/api/v1/models` and the model config behind it.

Two rules carry the weight here: the wire serialization hides the backend-only
fields, and a broken config file degrades instead of taking the process with it.
"""
from __future__ import annotations

import json

import httpx
import pytest

from noeta.agent.models_config import (
    ModelValidationError,
    get_default_model,
    get_models,
    validate_model,
)

# Backend-only: `gateway` picks which gateway serves the model, the two token
# counts drive compaction, and the capability flags feed the SDK's model spec.
# None is the frontend's business, and a gateway name on the wire is a small
# information leak about the deployment.
BACKEND_ONLY_FIELDS = (
    "gateway",
    "context_window",
    "max_output_tokens",
    "supports_vision",
    "is_reasoning",
)

# The `/models` field order is part of the contract, so a contract test can
# compare whole objects rather than key sets.
API_FIELDS = ["id", "label", "default", "efforts", "default_effort"]


def _write_models(path, models: list[dict]) -> None:
    path.write_text(json.dumps({"models": models}), encoding="utf-8")


def test_models_returns_the_configured_models(http):
    payload = http.get("/api/v1/models").json()

    assert payload["provider"] == "mock"
    assert [m["id"] for m in payload["models"]] == [
        "model_hub/es1_orange_o48",
        "model_api/experimental_0723",
        "auto_model/alwaysday1_max",
    ]
    assert [m["default"] for m in payload["models"]] == [True, False, False]


def test_models_serialization_hides_the_backend_only_fields(
    tmp_path, make_settings, serve
):
    config = tmp_path / "models.json"
    _write_models(
        config,
        [
            {
                "id": "m-1",
                "label": "M One",
                "default": True,
                "efforts": ["low", "high"],
                "default_effort": "high",
                "gateway": "secondary",
                "context_window": 200_000,
                "max_output_tokens": 32_000,
            }
        ],
    )
    server = serve(make_settings(models_config=str(config)))

    with httpx.Client(base_url=server.base_url, timeout=10.0) as client:
        models = client.get("/api/v1/models").json()["models"]

    assert models == [
        {
            "id": "m-1",
            "label": "M One",
            "default": True,
            "efforts": ["low", "high"],
            "default_effort": "high",
        }
    ]
    assert list(models[0]) == API_FIELDS, "the field order is part of the contract"
    for field in BACKEND_ONLY_FIELDS:
        assert field not in models[0]


def test_missing_config_still_boots_and_serves_one_model(tmp_path, make_settings, serve):
    """First run has no `models.json`. Never crash over model config."""
    server = serve(make_settings(models_config=str(tmp_path / "absent.json")))

    with httpx.Client(base_url=server.base_url, timeout=10.0) as client:
        assert client.get("/api/v1/health").status_code == 200
        models = client.get("/api/v1/models").json()["models"]

    assert len(models) == 1
    assert models[0]["default"] is True
    assert models[0]["efforts"], "the fallback model still offers an effort ladder"


@pytest.mark.parametrize(
    ("name", "content"),
    [
        ("unparseable", "{not json"),
        ("empty-list", '{"models": []}'),
        ("no-models-key", "{}"),
    ],
)
def test_broken_config_degrades_to_the_fallback(
    name, content, tmp_path, make_settings
):
    config = tmp_path / f"{name}.json"
    config.write_text(content, encoding="utf-8")

    models = get_models(make_settings(models_config=str(config)))

    assert len(models) == 1
    assert models[0].default is True


def test_only_the_first_default_counts(tmp_path, make_settings):
    """`/models` must never advertise two defaults; the extras are demoted
    rather than the file being rejected."""
    config = tmp_path / "models.json"
    _write_models(
        config,
        [
            {"id": "a", "label": "A", "default": True},
            {"id": "b", "label": "B", "default": True},
        ],
    )
    settings = make_settings(models_config=str(config))

    assert [m.default for m in get_models(settings)] == [True, False]
    assert get_default_model(settings).id == "a"


def test_unknown_model_and_unknown_effort_are_rejected(make_settings):
    """`validate_model` raises; the API's `ContractRoute` maps
    `ModelValidationError` to 422 `invalid_model`, so an unknown model never
    reaches the provider."""
    settings = make_settings()

    assert (
        validate_model(settings, "model_hub/es1_orange_o48", "high").id
        == "model_hub/es1_orange_o48"
    )

    with pytest.raises(ModelValidationError, match="unknown model"):
        validate_model(settings, "no-such-model")

    with pytest.raises(ModelValidationError, match="unknown effort"):
        validate_model(settings, "model_hub/es1_orange_o48", "supreme")
