"""Boundary tests — edges of numeric and enumerable inputs."""
from __future__ import annotations
import json
from pathlib import Path
import pytest
from helpers import run_mode, load_plan, FIXTURES_DIR

SINGLE = (FIXTURES_DIR / "boundary__single-occurrence.css").read_text()
AT_THRESHOLD = (FIXTURES_DIR / "boundary__at-threshold.css").read_text()


def test_threshold_2_skips_single_occurrences(tmp_path):
    (tmp_path / "s.css").write_text(SINGLE)
    run_mode("extract", tmp_path, config={"threshold": 2})
    plan = load_plan(tmp_path)
    assert len(plan["variables"]) == 0
    assert len(plan["skipped"]) > 0


def test_threshold_1_extracts_single_occurrences(tmp_path):
    (tmp_path / "s.css").write_text(SINGLE)
    run_mode("extract", tmp_path, config={"threshold": 1})
    plan = load_plan(tmp_path)
    assert len(plan["variables"]) > 0


def test_threshold_at_exact_count_extracts(tmp_path):
    (tmp_path / "s.css").write_text(AT_THRESHOLD)
    run_mode("extract", tmp_path, config={"threshold": 2})
    plan = load_plan(tmp_path)
    assert len(plan["variables"]) > 0


def test_threshold_above_count_skips_all(tmp_path):
    (tmp_path / "s.css").write_text(AT_THRESHOLD)
    run_mode("extract", tmp_path, config={"threshold": 999})
    plan = load_plan(tmp_path)
    assert len(plan["variables"]) == 0


def test_empty_directory_produces_empty_plan(tmp_path):
    run_mode("extract", tmp_path)
    plan = load_plan(tmp_path)
    assert plan["variables"] == []


def test_scan_empty_directory_returns_empty_list(tmp_path):
    import json as _json
    stdout, _, code = run_mode("scan", tmp_path)
    assert code == 0
    assert _json.loads(stdout) == []


def test_single_file_single_declaration_below_threshold(tmp_path):
    (tmp_path / "s.css").write_text(".a { color: #fff; }")
    run_mode("extract", tmp_path, config={"threshold": 2})
    plan = load_plan(tmp_path)
    assert len(plan["variables"]) == 0


def test_colors_only_type_ignores_spacing(tmp_path):
    css = ".a { color: #3a86ff; color: #3a86ff; padding: 8px; padding: 8px; }"
    (tmp_path / "s.css").write_text(css)
    run_mode("extract", tmp_path, config={"types": ["colors"]})
    plan = load_plan(tmp_path)
    assert all(v["type"] == "colors" for v in plan["variables"])
    assert not any(v["type"] == "spacing" for v in plan["variables"])


def test_spacing_only_type_ignores_colors(tmp_path):
    css = ".a { color: #3a86ff; color: #3a86ff; padding: 8px; padding: 8px; }"
    (tmp_path / "s.css").write_text(css)
    run_mode("extract", tmp_path, config={"types": ["spacing"]})
    plan = load_plan(tmp_path)
    assert not any(v["type"] == "colors" for v in plan["variables"])


def test_custom_prefix_applied_to_all_variables(tmp_path):
    css = ".a { color: #3a86ff; color: #3a86ff; }"
    (tmp_path / "s.css").write_text(css)
    run_mode("extract", tmp_path, config={"prefix": "--xyz"})
    plan = load_plan(tmp_path)
    for var in plan["variables"]:
        assert var["name"].startswith("--xyz-")


def test_empty_prefix_still_produces_valid_names(tmp_path):
    css = ".a { color: #3a86ff; color: #3a86ff; }"
    (tmp_path / "s.css").write_text(css)
    run_mode("extract", tmp_path, config={"prefix": "--"})
    plan = load_plan(tmp_path)
    for var in plan["variables"]:
        assert var["name"].startswith("--")
