"""The workspace file surface: listing, containment, reading, sniffing.

Reads go through the **host-side directory**, never through the container.
That is deliberate on three counts: it is faster, it works when the container
is stopped (or was never allocated, which is every `local` project), and it
needs no auth hop into the sandbox. The bind-mount source and the project
directory are the same tree, so there is nothing to reconcile.

`resolve_within` is the security boundary of the whole surface. It realpaths
**both** the candidate and the root before the containment check, which is what
catches the case a naive prefix test misses: a symlink *inside* the workspace
pointing outside it. `../` escapes and absolute paths are the easy half.

Nothing here imports the engine or the store; it is a file-system module and is
testable with a `tmp_path` alone.
"""
from __future__ import annotations

import logging
import os
import secrets
from dataclasses import dataclass
from pathlib import Path
from stat import S_ISREG
from typing import Optional
from urllib.parse import unquote, urlparse

logger = logging.getLogger(__name__)

#: Text reads are clipped here. Big enough for any source file a person edits,
#: small enough that the browser is not asked to render a database dump.
TEXT_CLIP_BYTES = 200 * 1024

#: Ceiling on one write. The editable artifact is a text file a human is
#: looking at; anything larger arriving as a JSON string body is a client bug,
#: and accepting it would mean holding it twice in memory to answer one save.
MAX_WRITE_BYTES = 5 * 1024 * 1024

#: Ceiling on one listing. A project directory with a `node_modules` in it is
#: not a pathological case, it is Tuesday, and an unbounded listing turns the
#: file panel into a several-megabyte JSON response.
LISTING_CAP = 2000

#: What a byte-sniffed type falls back to. Never guessed from the extension:
#: the extension is the agent's to choose and a `.png` holding text would be
#: served as an image the browser refuses to render.
DEFAULT_CONTENT_TYPE = "application/octet-stream"
TEXT_CONTENT_TYPE = "text/plain; charset=utf-8"


class InvalidPathError(ValueError):
    """A path that names nothing inside the workspace. The API maps it to 400."""


class FileConflictError(Exception):
    """The file changed since the client read it. The API maps it to 409.

    Not hypothetical: all sessions of a project share one directory, so a
    second conversation — or the agent of *this* one, mid-turn — can rewrite
    the file under an open editor. Detecting it is why the write path takes a
    base mtime at all."""

    def __init__(self, rel: str, base_mtime: float, current_mtime: float) -> None:
        super().__init__(
            f"{rel} changed on disk since it was read "
            f"(read at {base_mtime!r}, now {current_mtime!r}); re-read it before saving"
        )
        self.rel = rel
        self.base_mtime = base_mtime
        self.current_mtime = current_mtime


@dataclass(frozen=True)
class FileEntry:
    """One file, as the listing reports it. `mtime` is epoch seconds, which is
    also what a Phase 5 optimistic save compares against."""

    path: str
    size: int
    mtime: float


def resolve_within(root: Path | str, rel: str) -> Path:
    """`root / rel`, proven to stay inside `root`. Raises `InvalidPathError`.

    Both sides are realpath'd first. Resolving only the candidate would accept
    a root that is itself reached through a symlink; resolving only the root
    would accept `workspace/link -> /etc`, which is the case the container's
    own agent can create at any time.
    """
    if not rel or not rel.strip():
        raise InvalidPathError("path is required")
    if os.path.isabs(rel) or rel.startswith("~"):
        raise InvalidPathError(f"path must be relative to the workspace: {rel}")
    if "\x00" in rel:
        raise InvalidPathError("path contains a NUL byte")

    root_real = Path(os.path.realpath(str(root)))
    candidate = Path(os.path.realpath(os.path.join(str(root_real), rel)))
    try:
        candidate.relative_to(root_real)
    except ValueError as exc:
        raise InvalidPathError(f"path escapes the workspace: {rel}") from exc
    if candidate == root_real:
        raise InvalidPathError("path names the workspace root, not a file")
    return candidate


#: Where the workspace is mounted **inside** the container. Tool output from a
#: `sandbox` project names files by that path, so a derived candidate has to be
#: translated back before it can be stat'd on the host. It mirrors
#: `LocalDockerSandboxProvider(workdir=…)`; the two move together.
CONTAINER_WORKSPACE = "/workspace"

#: Longer than any real path, and the shape a bad guess takes: the derivation
#: scan matches prose, so a paragraph can arrive looking like a filename.
MAX_CANDIDATE_LENGTH = 500


def normalize_candidate(value: str, root: Path | str) -> str:
    """A derived artifact candidate as a workspace-relative path, or `""`.

    `""` means "this names nothing in this workspace" and the caller reports it
    as `exists: false` — never as an error. The derivation scan is a *guess*
    over prose and tool payloads, so junk is the expected input, and one bad
    candidate must not fail the batch it arrived in.

    Absolute paths get two chances, one per execution tier: a host path inside
    the project directory (what a `local` project's tools print) is made
    relative, and a container path under the mount target (what a `sandbox`
    project's tools print) has that prefix stripped. Everything else that is
    absolute names something outside the workspace and is dropped here rather
    than being handed to the containment check as an attempted escape.
    """
    text = value.strip().strip("`\"'").strip()
    if not text or len(text) > MAX_CANDIDATE_LENGTH or "\x00" in text:
        return ""
    if text.startswith("file://"):
        text = unquote(urlparse(text).path)
    while text.startswith("./"):
        text = text[2:]
    if not os.path.isabs(text):
        return text.lstrip("/") if text not in (".", "..") else ""

    root_real = os.path.realpath(str(root))
    for base in (root_real, str(root), CONTAINER_WORKSPACE):
        prefix = base.rstrip("/") + "/"
        if text.startswith(prefix):
            return text[len(prefix) :]
    return ""


def _is_hidden(name: str) -> bool:
    return name.startswith(".")


def list_files(
    root: Path | str,
    *,
    exclude_top_level: tuple[str, ...] = (),
    cap: int = LISTING_CAP,
) -> list[FileEntry]:
    """Every visible file under `root`, sorted by path.

    Four behaviours are pinned by tests, and each is a report from the field:

    - **hidden entries are pruned at any depth**, which is also what keeps the
      engine's own `.noeta` metadata out of the user's file panel;
    - **symlinks are never followed** (`followlinks=False`), so a link to a
      mounted tree cannot turn a listing into a filesystem crawl;
    - **a per-file `stat` failure skips that file** rather than failing the
      whole listing — concurrent deletion from inside the container and
      dangling symlinks are both normal;
    - **a missing directory is `[]`**, not an error. A project directory that
      was deleted out from under us is a listing with nothing in it, not a 500.
    """
    base = Path(root)
    if not base.is_dir():
        return []

    entries: list[FileEntry] = []
    for dirpath, dirnames, filenames in os.walk(base, followlinks=False):
        rel_dir = os.path.relpath(dirpath, base)
        depth_top = rel_dir == "."
        # Pruned in place, which is what stops os.walk descending into them.
        dirnames[:] = sorted(
            name
            for name in dirnames
            if not _is_hidden(name)
            and not (depth_top and name in exclude_top_level)
        )
        for name in filenames:
            if _is_hidden(name):
                continue
            if depth_top and name in exclude_top_level:
                continue
            full = Path(dirpath) / name
            try:
                stat = full.stat()
            except OSError:
                # Deleted between the walk and the stat, or a dangling link.
                continue
            rel = name if depth_top else os.path.join(rel_dir, name)
            entries.append(
                FileEntry(path=rel.replace(os.sep, "/"), size=stat.st_size, mtime=stat.st_mtime)
            )
            if len(entries) >= cap:
                entries.sort(key=lambda e: e.path)
                return entries
    entries.sort(key=lambda e: e.path)
    return entries


@dataclass(frozen=True)
class TextRead:
    path: str
    content: str
    truncated: bool
    mtime: float


def read_text(path: Path, *, rel: str, clip: int = TEXT_CLIP_BYTES) -> TextRead:
    """A file as text, clipped, with its mtime from the same `stat`.

    The mtime rides along deliberately: the read path used to recover it by
    running the whole listing a second time, which is an N+1 over the entire
    project tree to answer one field.
    """
    stat = path.stat()
    raw = path.read_bytes()
    truncated = len(raw) > clip
    body = raw[:clip] if truncated else raw
    return TextRead(
        path=rel,
        # `replace` rather than `strict`: a file the agent wrote in a different
        # encoding must render as mostly-readable text, not as a 500.
        content=body.decode("utf-8", errors="replace"),
        truncated=truncated,
        mtime=stat.st_mtime,
    )


@dataclass(frozen=True)
class WriteResult:
    """What a save reports back. `mtime` is the new base for the next save."""

    path: str
    size: int
    mtime: float


def write_text(
    path: Path,
    *,
    rel: str,
    content: str,
    base_mtime: Optional[float] = None,
) -> WriteResult:
    """Save text to a workspace file, optimistically locked on `base_mtime`.

    ## Writes go to the host directory, not through the container's `ExecEnv`

    Stated explicitly because it is a real fork in the road and the other
    branch is defensible. The host path wins on three counts:

    - it works for a `local` project, which has **no container at all**, and
      for a `sandbox` project whose container is idle-stopped. Routing writes
      through the container would make the editor dead exactly when the panel
      is most useful — reading already works in both of those states, and a
      surface that can read but not write is worse than one that does neither;
    - the bind-mount source and the project directory are the same tree, so
      there is nothing to reconcile: a host write *is* a container write;
    - it is one `write + rename` instead of an authenticated round trip into a
      container, on the interactive path of a person pressing Save.

    The cost is real and is paid here rather than ignored: the container runs
    as uid 1000 and this process does not necessarily. So when the file already
    exists its **mode and ownership are carried onto the replacement**, which
    keeps a file the agent created writable by the agent. A new file gets this
    process's defaults — there is nothing to inherit — and on the local tier
    that is the user's own uid, which is correct by construction.

    The replacement is atomic (`write temp + os.replace` in the same
    directory). The agent may be reading this file from inside the container at
    the same moment, and a truncate-then-write would hand it half a file.
    """
    try:
        before = path.stat()
    except FileNotFoundError:
        before = None
    except OSError as exc:
        raise InvalidPathError(f"cannot write {rel}: {exc}") from exc

    # A first write to a file that is not there always wins, and so does a
    # client that sends no base — "I know this is new" and "I am not tracking
    # versions" are both legitimate, and neither can be a conflict.
    if before is not None and base_mtime is not None and before.st_mtime != base_mtime:
        raise FileConflictError(rel, base_mtime, before.st_mtime)

    data = content.encode("utf-8")
    path.parent.mkdir(parents=True, exist_ok=True)
    # Hidden and random: the same directory (so `os.replace` stays atomic),
    # invisible to the listing while it exists, and unique so two concurrent
    # saves cannot clobber each other's temp.
    tmp = path.parent / f".{path.name}.{secrets.token_hex(6)}.tmp"
    try:
        with open(tmp, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        if before is not None:
            _inherit_metadata(tmp, before)
        os.replace(tmp, path)
    finally:
        # Only reachable when the replace never happened.
        tmp.unlink(missing_ok=True)

    after = path.stat()
    return WriteResult(path=rel, size=after.st_size, mtime=after.st_mtime)


def _inherit_metadata(tmp: Path, original: os.stat_result) -> None:
    """Carry the replaced file's mode and ownership onto its replacement.

    Best-effort on both counts. `chown` to another uid needs privileges this
    process usually does not have, and failing the save over it would be worse
    than writing a file the container's uid cannot overwrite — the user would
    lose the edit either way, and this way they keep it."""
    try:
        os.chmod(tmp, original.st_mode & 0o7777)
    except OSError:
        logger.debug("could not carry mode onto %s", tmp, exc_info=True)
    try:
        os.chown(tmp, original.st_uid, original.st_gid)
    except (OSError, AttributeError):
        logger.debug("could not carry ownership onto %s", tmp, exc_info=True)


@dataclass(frozen=True)
class FileStat:
    """One artifact as the server sees it — the half of a candidate the client
    is not allowed to guess."""

    exists: bool
    size: int
    mtime: Optional[float]


def stat_file(path: Path) -> FileStat:
    """`exists / size / mtime` for one path.

    `exists` is true only for a **regular file**: a directory that happens to
    share a name with a derived candidate is not an artifact, and reporting it
    as one gives the client a tab it can never render."""
    try:
        stat = path.stat()
    except OSError:
        # A missing file, a dangling symlink and a permission failure are one
        # answer: not an artifact of this workspace.
        return FileStat(exists=False, size=0, mtime=None)
    if not S_ISREG(stat.st_mode):
        return FileStat(exists=False, size=0, mtime=None)
    return FileStat(exists=True, size=stat.st_size, mtime=stat.st_mtime)


#: extension -> preview kind. The **server** owns this table: the client
#: guesses so it can render something immediately, and the guess is overwritten
#: by the resolve round trip. Two kinds behave differently downstream and it is
#: deliberate — `text` and `external` are openable but never *collectible*, so
#: a `.ts` or a `.lockfile` never claims a panel tab of its own.
PREVIEW_BY_EXTENSION: dict[str, str] = {
    **dict.fromkeys((".md", ".markdown", ".mdx"), "markdown"),
    **dict.fromkeys((".csv", ".tsv", ".xlsx", ".xls", ".ods"), "sheet"),
    **dict.fromkeys(
        (".ppt", ".pptx", ".pptm", ".pot", ".potx", ".odp", ".key", ".sxi"), "slides"
    ),
    **dict.fromkeys((".docx",), "document"),
    **dict.fromkeys((".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"), "image"),
    **dict.fromkeys((".pdf",), "pdf"),
    **dict.fromkeys((".html", ".htm"), "html"),
    **dict.fromkeys(
        (
            ".txt", ".log", ".json", ".jsonc", ".yaml", ".yml", ".toml", ".xml",
            ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".css", ".scss",
            ".py", ".rs", ".go", ".sh", ".sql", ".ini", ".cfg", ".env",
        ),
        "text",
    ),
}

#: Anything the table does not name.
DEFAULT_PREVIEW = "external"


def preview_for_path(rel: str) -> str:
    """The preview kind for a workspace path, from its extension alone."""
    return PREVIEW_BY_EXTENSION.get(Path(rel).suffix.lower(), DEFAULT_PREVIEW)


#: Magic-byte prefixes, longest first where two share a lead. The ContentStore
#: has no metadata read interface, so a stored blob's type is only knowable
#: from its bytes — echoing a client-supplied type back would let one session
#: label another's bytes.
_MAGIC: tuple[tuple[bytes, str], ...] = (
    (b"\x89PNG\r\n\x1a\n", "image/png"),
    (b"\xff\xd8\xff", "image/jpeg"),
    (b"GIF87a", "image/gif"),
    (b"GIF89a", "image/gif"),
    (b"%PDF-", "application/pdf"),
    (b"\x1f\x8b", "application/gzip"),
    (b"PK\x03\x04", "application/zip"),
)


def sniff_content_type(data: bytes) -> str:
    """The `Content-Type` for a blob, decided from its bytes alone."""
    for prefix, media_type in _MAGIC:
        if data.startswith(prefix):
            return media_type
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    head = data[:1024].lstrip()
    if head.startswith(b"<svg") or (head.startswith(b"<?xml") and b"<svg" in data[:1024]):
        # SVG can embed scripts, so it gets two rules rather than one type.
        # `image/svg+xml` is what makes `<img src>` render it — and inside an
        # `<img>` the SVG spec's secure static mode applies, so no script and
        # no external reference ever runs. It must therefore **never** be
        # inlined into the DOM, where none of that holds. The remaining hole is
        # a human opening the raw URL directly, which would run the script in
        # *this* origin; `svg_is_scriptable` is what the read path uses to shut
        # that door.
        return "image/svg+xml"
    try:
        data.decode("utf-8")
    except UnicodeDecodeError:
        return DEFAULT_CONTENT_TYPE
    return TEXT_CONTENT_TYPE


def raw_headers(rel: str, media_type: str) -> dict[str, str]:
    """The response headers a raw read needs to be safe to hand a browser.

    `nosniff` on everything: the type here is decided from the bytes, and a
    browser second-guessing it would undo that.

    `Content-Security-Policy: sandbox` on SVG specifically. Served as
    `image/svg+xml` an SVG renders in `<img>` without scripting, but a person
    who opens the URL in a tab gets a *document* — and a scripted SVG would
    then run in this API's origin. `sandbox` with no `allow-scripts` puts that
    document in an opaque origin with scripting off, which costs the `<img>`
    path nothing because CSP does not apply to image subresources."""
    headers = {
        "Content-Disposition": content_disposition(rel),
        "X-Content-Type-Options": "nosniff",
    }
    if media_type == "image/svg+xml":
        headers["Content-Security-Policy"] = "sandbox"
    return headers


def content_disposition(rel: str) -> str:
    """An inline disposition carrying the file's own name.

    Inline because every consumer is a preview pane; the name is what a
    "download" from that pane ends up called."""
    name = Path(rel).name.replace('"', "")
    return f'inline; filename="{name}"'


def workspace_root(directory: Optional[str]) -> Optional[Path]:
    """The listing root for a project directory, or `None` when it is gone."""
    if not directory:
        return None
    path = Path(directory)
    return path if path.is_dir() else None
