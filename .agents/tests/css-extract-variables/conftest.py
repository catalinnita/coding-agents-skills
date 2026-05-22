"""Pytest fixtures — imports helpers so test files can use 'from helpers import ...'."""
from __future__ import annotations
import sys
from pathlib import Path
import pytest

# Make tests/ directory importable so test files can do `from helpers import ...`
sys.path.insert(0, str(Path(__file__).parent))

from helpers import SKILL_DIR, FIXTURES_DIR, CONFIGS_DIR  # noqa: E402


@pytest.fixture
def skill_dir() -> Path:
    return SKILL_DIR


@pytest.fixture
def fixtures_dir() -> Path:
    return FIXTURES_DIR


@pytest.fixture
def configs_dir() -> Path:
    return CONFIGS_DIR
