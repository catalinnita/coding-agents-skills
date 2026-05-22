"""Idempotency tests — a second run must produce no changes."""
from __future__ import annotations
import json
from pathlib import Path
import pytest
from helpers import run_mode, load_plan, FIXTURES_DIR

CSS = (FIXTURES_DIR / "happy-path__full-config.css").read_text()


def _full_pipeline(tmp_path, config=None):
    (tmp_path / "s.css").write_text(CSS)
    run_mode("extract", tmp_path, config=config)
    run_mode("write-variables", tmp_path, variables_file=tmp_path / "variables.css", config=config)
    run_mode("replace", tmp_path, config=config)


def test_second_extract_on_fresh_source_produces_same_plan(tmp_path):
    # Run on a fresh copy so plan counts are stable across two independent extractions
    (tmp_path / "s.css").write_text(CSS)
    run_mode("extract", tmp_path)
    plan_first = load_plan(tmp_path)

    (tmp_path / "s.css").write_text(CSS)  # restore original
    run_mode("extract", tmp_path)
    plan_second = load_plan(tmp_path)

    assert len(plan_second["variables"]) == len(plan_first["variables"])


def test_second_write_variables_does_not_append(tmp_path):
    _full_pipeline(tmp_path)
    vars_file = tmp_path / "variables.css"
    content_after_first = vars_file.read_text()

    run_mode("extract", tmp_path)
    run_mode("write-variables", tmp_path, variables_file=vars_file)
    content_after_second = vars_file.read_text()

    assert content_after_first == content_after_second


def test_second_replace_does_not_double_wrap(tmp_path):
    _full_pipeline(tmp_path)
    after_first = (tmp_path / "s.css").read_text()

    run_mode("extract", tmp_path)
    run_mode("replace", tmp_path)
    after_second = (tmp_path / "s.css").read_text()

    assert "var(var(" not in after_second
    assert after_first == after_second


def test_already_replaced_file_unchanged(tmp_path):
    already = (FIXTURES_DIR / "idempotency__already-replaced.css").read_text()
    src = tmp_path / "s.css"
    src.write_text(already)
    original = src.read_text()

    run_mode("extract", tmp_path, config={"threshold": 1})
    run_mode("replace", tmp_path)

    assert src.read_text() == original
