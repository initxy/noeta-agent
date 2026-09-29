"""`app.db` bootstrap.

The product's own database, kept strictly separate from the engine's `noeta.db`.
Phase 1 lands the product tables as migration 1; what matters now is that an
empty database with only its version table is a valid, bootable state and that
bringing it up to date is idempotent.
"""
from __future__ import annotations

from noeta.agent.store import db


def test_bootstrap_is_idempotent(tmp_path):
    conn = db.connect(tmp_path / "app.db")
    try:
        # `bootstrap` creates the version table itself, so it is the entry
        # point on a fresh file; `schema_version` reads a schema that exists.
        first = db.bootstrap(conn)
        second = db.bootstrap(conn)

        assert first == second == db.schema_version(conn)
    finally:
        conn.close()


def test_connect_creates_the_parent_directory(tmp_path):
    """The data tree may not exist yet on a first run, and the database is one
    of the first things touched."""
    path = tmp_path / "nested" / "data" / "app.db"

    conn = db.connect(path)
    try:
        db.bootstrap(conn)
    finally:
        conn.close()

    assert path.is_file()


def test_rows_are_addressed_by_name_and_the_journal_is_wal(tmp_path):
    """WAL because the engine drives turns on worker threads while requests
    arrive on the event loop; `sqlite3.Row` so that appending a column never
    shifts a positional index out from under a caller."""
    conn = db.connect(tmp_path / "app.db")
    try:
        db.bootstrap(conn)
        mode = conn.execute("PRAGMA journal_mode").fetchone()

        assert mode["journal_mode"] == "wal"
    finally:
        conn.close()


def test_the_app_database_is_not_the_engine_database(settings):
    """Two files, never mixed: `app.db` is projects/sessions/connectors, and
    `noeta.db` belongs to the SDK storage adapters."""
    assert settings.app_db_path != settings.engine_db_path
    assert settings.app_db_path.name == "app.db"
    assert settings.engine_db_path.name == "noeta.db"
