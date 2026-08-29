"""What the `tracehub` Python package promises its consumers.

This package had no tests at all until 2026-08-29, and it showed: pyproject.toml
declared 0.1.0 while the module declared 0.2.0, and the retired Python/FastAPI
server rode along inside the client wheel for three months, importing FastAPI
that the package never listed as a dependency. Nothing failed, because nothing
asked. These tests ask.

The live consumer is kiberos-commander/checkpoint_logger.py, which does
`from tracehub.client import TraceHubClient` behind a try/ImportError — so a
break here is silent there. That import is the first thing checked below.
"""

import pathlib
import tomllib

import pytest

import tracehub


REPO = pathlib.Path(__file__).resolve().parent.parent
SRC = REPO / "src"


def test_the_suite_reads_this_tree_and_not_an_installed_copy():
    """Positive control on the suite itself, before anything it asserts."""
    imported_from = pathlib.Path(tracehub.__file__).resolve()
    assert SRC in imported_from.parents, (
        f"tracehub was imported from {imported_from}, outside {SRC}. The suite "
        f"is exercising an installed copy, so a green run says nothing about "
        f"this working tree. Check `pythonpath` in pyproject.toml."
    )


def test_the_consumers_import_keeps_working():
    """The exact line kiberos-commander runs, where failure is swallowed."""
    from tracehub.client import TraceEntry, TraceHubClient

    assert TraceHubClient is not None
    assert TraceEntry is not None


def test_everything_the_package_advertises_can_actually_be_reached():
    for name in tracehub.__all__:
        assert hasattr(tracehub, name), (
            f"__all__ promises {name!r} but the package does not provide it"
        )


def test_the_version_has_exactly_one_home():
    """pyproject must read the version from the module, never restate it."""
    config = tomllib.loads((REPO / "pyproject.toml").read_text())
    project = config["project"]

    assert "version" not in project, (
        "pyproject.toml declares its own version again. Two homes drift: this "
        "file said 0.1.0 while the module said 0.2.0. Keep `dynamic` instead."
    )
    assert "version" in project.get("dynamic", []), (
        "the version is neither declared nor dynamic — the build cannot know it"
    )
    assert config["tool"]["hatch"]["version"]["path"] == "src/tracehub/__init__.py"


def test_the_package_declares_every_dependency_it_imports():
    """The retired server shipped importing FastAPI, which was never declared."""
    config = tomllib.loads((REPO / "pyproject.toml").read_text())
    declared = {
        d.split(">")[0].split("=")[0].split("[")[0].strip().lower()
        for d in config["project"]["dependencies"]
    }

    third_party = set()
    for module in SRC.rglob("*.py"):
        for raw in module.read_text().splitlines():
            line = raw.strip()
            if not line.startswith(("import ", "from ")):
                continue
            name = line.split()[1].split(".")[0]
            if name in _STDLIB or name == "tracehub":
                continue
            third_party.add(name.lower())

    missing = third_party - declared
    assert not missing, (
        f"these packages are imported under {SRC} but not declared in "
        f"pyproject.toml dependencies: {sorted(missing)}. A consumer installing "
        f"this package would import something pip never brought in."
    )


def test_no_dependency_is_declared_that_nothing_imports():
    """pydantic sat here for years after the code that used it was retired."""
    config = tomllib.loads((REPO / "pyproject.toml").read_text())
    declared = {
        d.split(">")[0].split("=")[0].split("[")[0].strip().lower()
        for d in config["project"]["dependencies"]
    }
    sources = "\n".join(p.read_text() for p in SRC.rglob("*.py"))

    unused = {d for d in declared if d not in sources}
    assert not unused, (
        f"declared but imported nowhere under {SRC}: {sorted(unused)} — every "
        f"consumer pays to install it for nothing"
    )


_STDLIB = {
    "__future__", "abc", "argparse", "asyncio", "atexit", "base64",
    "collections", "contextlib", "csv", "dataclasses", "datetime", "enum",
    "functools", "hashlib", "hmac", "http", "importlib", "inspect", "io",
    "itertools", "json", "logging", "math", "os", "pathlib", "queue", "random",
    "re", "shutil", "signal", "socket", "sqlite3", "string", "subprocess",
    "sys", "tempfile", "threading", "time", "tomllib", "traceback", "types",
    "typing", "urllib", "uuid", "warnings", "weakref",
}


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(pytest.main([__file__, "-v"]))
