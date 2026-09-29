"""Application settings — the whole configuration surface of the product.

Environment-only: `.env` in the working directory plus real environment
variables, which win. `.env.example` is the authoritative key list; every key
is optional, and with all of them empty the workbench boots fully offline
against the mock provider (no Docker, no credentials, no login).

Three rules this module exists to keep:

- **Settings are constructed and injected, never read on first touch.**
  Anything that parses the developer's `.env` at import time contaminates
  every test that imports the app. `get_settings()` is for the real entry
  point only; `create_app()` takes an injected instance, and anything that
  must be immune to the machine it runs on builds its own with
  `Settings(_env_file=None, …)`.
- **`extra="ignore"` is load-bearing.** A stale `.env` carrying retired keys
  must not break boot. In particular there is no global sandbox switch any
  more — the execution tier is a per-project property, so a leftover
  `SANDBOX_ENABLED=true` is simply ignored.
- **Relative paths resolve against the process working directory**, not the
  package location: an installed wheel's package directory is inside
  `site-packages`, which is the wrong place to keep a user's data. The two
  module-location anchors below exist only for finding files that ship *with*
  the code.
"""
from __future__ import annotations

from functools import lru_cache
from importlib.metadata import PackageNotFoundError, version as _dist_version
from pathlib import Path
from typing import Literal
from urllib.parse import unquote

from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict

# The installed package directory (`noeta/agent`). Always correct — it is
# derived from this file — and therefore the first place to look for bundled
# assets such as the built SPA.
PACKAGE_DIR = Path(__file__).resolve().parent

# The repo checkout root, valid only under an editable install; in a wheel it
# degenerates to `site-packages`. Anything using it must treat it as a
# *second* candidate behind PACKAGE_DIR and tolerate its absence.
APP_DIR = PACKAGE_DIR.parents[1]

# The stock open-source AIO Sandbox image, used when SANDBOX_IMAGE is blank.
# Deployments that need extra tooling inside the container build their own
# image on top and point the key at it.
DEFAULT_SANDBOX_IMAGE = "ghcr.io/agent-infra/sandbox:latest"


def _package_version() -> str:
    """The installed distribution version, reported by `/health`.

    A local-first product is routinely run from more than one checkout, so
    "which build is this tab talking to" is a real question. Read from the
    installed metadata rather than duplicated here, and degraded to
    `"unknown"` rather than raised: a missing dist-info means someone is
    running from a source tree, which is a fine way to run and a terrible
    reason to refuse to report health."""
    try:
        return _dist_version("noeta-agent")
    except PackageNotFoundError:
        return "unknown"


VERSION = _package_version()


def _resolve(value: str) -> Path:
    """A user-supplied path: `~` expanded, relative resolved against the
    working directory."""
    return Path(value).expanduser().resolve()


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    # --- server ---
    host: str = "127.0.0.1"
    port: int = 8000
    log_level: str = "INFO"
    # Empty = no CORS middleware at all. Only a separately-served frontend
    # (vite dev) needs it; the packaged app serves the SPA same-origin.
    cors_origins: str = ""

    # --- storage ---
    # Derives workspaces/, memories/, app.db and noeta.db underneath.
    data_dir: str = "data"
    # Default parent directory for "create a new project directory for me".
    # Empty = DATA_DIR/projects.
    projects_dir: str = ""

    # --- LLM gateway (OpenAI Responses-compatible) ---
    llm_provider: Literal["auto", "openai", "mock"] = "auto"
    # The gateway ROOT; the provider appends /responses itself.
    llm_base_url: str = ""
    llm_api_key: str = ""
    # Optional secondary gateway for models tagged "gateway": "secondary" in
    # models.json. Both keys are required; the secondary never stands alone.
    secondary_llm_base_url: str = ""
    secondary_llm_api_key: str = ""
    models_config: str = "models.json"
    llm_request_timeout: float = 300.0
    llm_max_tokens: int = 8192
    # Must be a NON-reasoning model: the title call sends reasoning effort
    # "none". Empty = fall back to the default chat model.
    title_model: str = ""
    # Model for the compaction summarize round-trip only (every decide turn
    # still uses the per-turn model). That call is issued non-streaming, and a
    # model that returns an empty body on the non-streaming path fails the whole
    # turn with `compaction_summary_failed` the moment a long session compacts —
    # so this must be a model that answers on the non-streaming path. Empty =
    # fall back to the per-turn model (the SDK default, `compaction_model=None`).
    compaction_model: str = ""

    # --- sandbox execution tier (requires Docker) ---
    # These configure the container used by projects that choose the sandbox
    # tier. There is no global on/off switch: the tier is stored per project.
    # Empty image = DEFAULT_SANDBOX_IMAGE (see effective_sandbox_image).
    sandbox_image: str = ""
    sandbox_memory: str = "2g"
    sandbox_cpus: str = "2"
    # The NAME of the env var holding the sandbox key — never the value
    # itself, which is read at provisioning time and never recorded.
    sandbox_api_key_env: str = "SANDBOX_API_KEY"
    # 0 = ephemeral, discovered at boot. Pin it when behind a firewall.
    sandbox_preview_port: int = 0
    # Two-stage idle reclamation: stop (reclaims memory/cpu, the container
    # stays attachable) then remove (reclaims disk, unattachable afterwards).
    # 0 disables that stage; both 0 = no reaper thread.
    sandbox_idle_stop_hours: float = 1.0
    sandbox_idle_remove_hours: float = 24.0
    sandbox_idle_check_interval_hours: float = 0.1

    # --- agent capabilities ---
    memory_consolidation: bool = True
    memory_consolidation_debounce_hours: float = 24.0
    # Resident engine worker threads: turns of different sessions run
    # concurrently, turns within one session stay serialized by the engine.
    agent_num_workers: int = 4

    # --- observability (OTLP trace export, opt-in) ---
    # The full OTLP/HTTP traces URL. Empty = no export. The ambient
    # OTel-standard OTEL_EXPORTER_OTLP_ENDPOINT is deliberately NOT honored as
    # an enable switch: a shared shell or k8s operator injecting it for other
    # apps must not silently start this process exporting.
    otlp_endpoint: str = ""
    # Extra headers on every export request. OTEL_EXPORTER_OTLP_HEADERS *is*
    # honored as a fallback here — headers never enable anything by
    # themselves, and only apply when otlp_endpoint is set.
    otlp_headers: str = Field(
        default="",
        validation_alias=AliasChoices("otlp_headers", "otel_exporter_otlp_headers"),
    )

    # ------------------------------------------------------------------
    # Derived paths. Properties, not env keys: the layout under DATA_DIR is
    # a convention of this product, not something a deployment re-arranges.

    @property
    def data_path(self) -> Path:
        return _resolve(self.data_dir)

    @property
    def workspaces_path(self) -> Path:
        """Scratch/fallback workspace root. A project's sessions use the
        project's own directory as their workspace; this is only for what has
        no project directory to live in."""
        return self.data_path / "workspaces"

    @property
    def memories_path(self) -> Path:
        """Agent memory root: `memories/<project_id>/` is one pool per
        project, plus `memories/_quarantine` for tasks whose project cannot be
        resolved — better no memory than another project's memory."""
        return self.data_path / "memories"

    @property
    def projects_path(self) -> Path:
        """Where "create a directory for me" puts a new project."""
        return _resolve(self.projects_dir) if self.projects_dir else self.data_path / "projects"

    @property
    def app_db_path(self) -> Path:
        """This product's own database: projects, sessions, connectors."""
        return self.data_path / "app.db"

    @property
    def engine_db_path(self) -> Path:
        """The engine's database (EventLog + ContentStore), owned by the SDK
        storage adapters. Never mixed with app.db."""
        return self.data_path / "noeta.db"

    @property
    def models_config_path(self) -> Path:
        return _resolve(self.models_config)

    # ------------------------------------------------------------------

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def effective_provider(self) -> str:
        """What "auto" resolves to: the gateway when credentials are present,
        otherwise the offline mock."""
        if self.llm_provider == "auto":
            return "openai" if (self.llm_base_url and self.llm_api_key) else "mock"
        return self.llm_provider

    @property
    def secondary_gateway_configured(self) -> bool:
        """Whether the secondary gateway is usable: base URL + key both set.
        It only ever stacks on top of an active primary."""
        return bool(self.secondary_llm_base_url and self.secondary_llm_api_key)

    @property
    def effective_sandbox_image(self) -> str:
        return self.sandbox_image or DEFAULT_SANDBOX_IMAGE

    @property
    def otlp_header_items(self) -> tuple[tuple[str, str], ...]:
        """Parsed export headers: `k=v,k2=v2` with values percent-decoded (the
        OTel spec defines them as W3C-baggage encoded, e.g.
        `authorization=Bearer%20token`). Malformed pairs are dropped."""
        out: dict[str, str] = {}
        for pair in self.otlp_headers.split(","):
            key, sep, value = pair.partition("=")
            if sep and key.strip():
                out[key.strip()] = unquote(value.strip())
        return tuple(out.items())

    # ------------------------------------------------------------------

    def validate_for_boot(self) -> None:
        """Fail fast on a configuration that cannot serve a turn.

        Only the explicit case is an error: `auto` is allowed to degrade to
        the mock silently — that is what makes a credential-free first run
        work — but asking for the gateway by name and not supplying it is a
        typo, not a fallback."""
        if self.llm_provider == "openai" and not (self.llm_base_url and self.llm_api_key):
            raise RuntimeError(
                "LLM_PROVIDER=openai requires LLM_BASE_URL and LLM_API_KEY. "
                "Set both, or leave LLM_PROVIDER=auto to run offline against "
                "the mock provider."
            )

    def ensure_data_dirs(self) -> None:
        """Create the data tree. Called at startup, never at import: building
        a Settings object must not touch the filesystem."""
        self.data_path.mkdir(parents=True, exist_ok=True)
        self.workspaces_path.mkdir(parents=True, exist_ok=True)
        self.memories_path.mkdir(parents=True, exist_ok=True)


@lru_cache
def get_settings() -> Settings:
    """The process-wide Settings, for the real entry point only.

    Everything else takes Settings as an argument. This is the single place
    allowed to read the developer's `.env`."""
    return Settings()
