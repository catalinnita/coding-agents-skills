"""Happy-path tests — representative valid inputs for each mode."""
from __future__ import annotations
import json
from pathlib import Path
import pytest
from helpers import run_mode, load_plan, FIXTURES_DIR, CONFIGS_DIR

CSS = (FIXTURES_DIR / "happy-path__full-config.css").read_text()


def setup_css(tmp_path: Path) -> None:
    (tmp_path / "styles.css").write_text(CSS)


def test_scan_mode_returns_file_list(tmp_path):
    setup_css(tmp_path)
    stdout, stderr, code = run_mode("scan", tmp_path)
    assert code == 0
    files = json.loads(stdout)
    assert isinstance(files, list)
    assert any("styles.css" in f for f in files)


def test_extract_mode_produces_plan(tmp_path):
    setup_css(tmp_path)
    stdout, stderr, code = run_mode("extract", tmp_path)
    assert code == 0
    plan = load_plan(tmp_path)
    assert "variables" in plan
    assert "skipped" in plan
    assert "warnings" in plan


def test_extract_mode_finds_colors(tmp_path):
    setup_css(tmp_path)
    run_mode("extract", tmp_path)
    plan = load_plan(tmp_path)
    color_vars = [v for v in plan["variables"] if v["type"] == "colors"]
    assert len(color_vars) >= 1


def test_extract_mode_finds_spacing(tmp_path):
    setup_css(tmp_path)
    run_mode("extract", tmp_path)
    plan = load_plan(tmp_path)
    spacing_vars = [v for v in plan["variables"] if v["type"] == "spacing"]
    assert len(spacing_vars) >= 1


def test_write_variables_creates_file(tmp_path):
    setup_css(tmp_path)
    run_mode("extract", tmp_path)
    vars_file = tmp_path / "variables.css"
    stdout, stderr, code = run_mode("write-variables", tmp_path, variables_file=vars_file)
    assert code == 0
    assert vars_file.exists()
    assert ":root" in vars_file.read_text()


def test_write_variables_contains_extracted_names(tmp_path):
    setup_css(tmp_path)
    run_mode("extract", tmp_path)
    plan = load_plan(tmp_path)
    vars_file = tmp_path / "variables.css"
    run_mode("write-variables", tmp_path, variables_file=vars_file)
    content = vars_file.read_text()
    for var in plan["variables"]:
        assert var["name"] in content


def test_replace_mode_rewrites_source(tmp_path):
    setup_css(tmp_path)
    run_mode("extract", tmp_path)
    run_mode("write-variables", tmp_path, variables_file=tmp_path / "variables.css")
    original = (tmp_path / "styles.css").read_text()
    run_mode("replace", tmp_path)
    replaced = (tmp_path / "styles.css").read_text()
    assert "var(--" in replaced


def test_full_config_uses_prefix(tmp_path):
    setup_css(tmp_path)
    config = json.loads((CONFIGS_DIR / "full.json").read_text())
    run_mode("extract", tmp_path, config=config)
    plan = load_plan(tmp_path)
    for var in plan["variables"]:
        assert var["name"].startswith("--brand-")


@pytest.mark.parametrize("mode", ["scan", "extract", "write-variables", "replace"])
def test_mode_exits_zero_on_valid_input(tmp_path, mode):
    setup_css(tmp_path)
    if mode in ("write-variables", "replace"):
        run_mode("extract", tmp_path)
    _, _, code = run_mode(mode, tmp_path)
    assert code == 0
