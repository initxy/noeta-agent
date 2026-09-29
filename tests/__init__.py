"""Makes `tests` a package, so intra-suite imports are absolute and unambiguous.

Three modules pull shared helpers out of `conftest.py` and `_docker_fake.py` by
name (`from tests.conftest import …`, `from tests._docker_fake import …`).
Being a package is what makes those resolve the same way from any working
directory: pytest then prepends the checkout root rather than `tests/` itself,
and no test module occupies a top-level name where two same-named files in
different subdirectories would collide.

`import noeta.agent` does **not** depend on this. `noeta` is a PEP 420 namespace
split across this dist and noeta-runtime, and this dist's editable install
contributes a `.pth` pointing at the checkout. If that import ever fails from
outside the repo root, the editable install is stale rather than absent: uv
caches the editable build against `pyproject.toml`, so changing only the package
tree — deleting and recreating `noeta/agent/**` — does not invalidate it.
`uv sync --reinstall-package noeta-agent` rebuilds it.
"""
