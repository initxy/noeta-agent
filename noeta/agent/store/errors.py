"""What the store refuses to do, as named exceptions.

One base class so an API handler can catch the family, and one subclass per
refusal so it can map each to its own HTTP status without string-matching a
message. Vocabulary violations (an unknown tier, status or transport) are
plain `ValueError`s instead: they are caller bugs, and the API validates them
against a `Literal` long before they reach here.
"""
from __future__ import annotations


class StoreError(Exception):
    """Base class for every refusal the store issues."""


class InvalidDirectoryError(StoreError):
    """A project directory that is not usable as one: empty, or relative.

    Writes reject it; reads never do. `find_project_by_directory` answers
    "no project" for anything it cannot match, because it is called from the
    execution-tier decision on a hot path where raising would be a worse
    failure than a miss."""


class DuplicateDirectoryError(StoreError):
    """A second project on a directory that already has one.

    A conflict, not a duplicate: two projects over one directory would share
    a workspace root, a memory pool and a container name."""

    def __init__(self, directory: str) -> None:
        super().__init__(f"a project already exists for {directory}")
        self.directory = directory


class UnknownProjectError(StoreError):
    """A session (or connector) addressed to a project that does not exist."""

    def __init__(self, project_id: str) -> None:
        super().__init__(f"no such project: {project_id}")
        self.project_id = project_id


class UnknownSessionError(StoreError):
    """A task stream bound to a session that does not exist."""

    def __init__(self, session_id: str) -> None:
        super().__init__(f"no such session: {session_id}")
        self.session_id = session_id


class DuplicateAliasError(StoreError):
    """A second connector under an alias the project already uses.

    Aliases name tools to the model (`mcp__<alias>__<tool>`), so overwriting
    one silently would re-point a name the agent has already been told about."""

    def __init__(self, project_id: str, alias: str) -> None:
        super().__init__(f"connector alias already in use: {alias}")
        self.project_id = project_id
        self.alias = alias


class DuplicateTaskStreamError(StoreError):
    """An engine task bound to a second session.

    The reverse index is single-valued by construction — a task stream belongs
    to exactly one session — so this is a caller bug rather than a race to
    absorb."""

    def __init__(self, task_id: str) -> None:
        super().__init__(f"task stream already bound: {task_id}")
        self.task_id = task_id
