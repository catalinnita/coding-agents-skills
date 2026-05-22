"""Dry-run tests — dryRun: true must never write files."""
from __future__ import annotations
import json
from pathlib import Path
import pytest
from helpers import run_mode, load_plan, FIXTURES_DIR

CSS = (FIXTURES_DIR / "happy-path__full-config.css").read_text()


def test_dry_run_produces_plan_without_writing_vars_file(tmp_path):
    (tmp_path / "s.css").write_text(CSS)
    vars_file = tmp_path / "variables.css"
    run_mode("extract", tmp_path, config={"dryRun": True})
    # Plan file may be created (it's a temp artifact, not a user-visible write)
    # But the variables file must not exist
    assert not vars_file.exists()


def test_dry_run_plan_matches_non_dry_run_plan(tmp_path):
    (tmp_path / "s.css").write_text(CSS)

    run_mode("extract", tmp_path, config={"dryRun": False})
    plan_normal = load_plan(tmp_path)

    run_mode("extract", tmp_path, config={"dryRun": True})
    plan_dry = load_plan(tmp_path)

    assert plan_normal["variables"] == plan_dry["variables"]


def test_dry_run_does_not_modify_source_files(tmp_path):
    src = tmp_path / "s.css"
    src.write_text(CSS)
    original_content = src.read_text()
    run_mode("extract", tmp_path, config={"dryRun": True})
    assert src.read_text() == original_content
