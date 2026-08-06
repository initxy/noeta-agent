"""Static product metadata: the model list behind the model + effort picker."""
from __future__ import annotations

from fastapi import APIRouter, Request

from noeta.agent.models_config import get_models

router = APIRouter(tags=["meta"])


@router.get("/models")
async def models(request: Request) -> dict:
    settings = request.app.state.settings
    return {
        "models": [m.to_api() for m in get_models(settings)],
        "provider": settings.effective_provider,
    }
