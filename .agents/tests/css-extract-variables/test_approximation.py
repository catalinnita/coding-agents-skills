"""Approximation tests — one test per snapping rule and algorithm step."""
from __future__ import annotations
import json
from pathlib import Path
import pytest
from helpers import run_mode, load_plan, FIXTURES_DIR

GRID_SNAP    = (FIXTURES_DIR / "approximation__grid-snap.css").read_text()
COLOR_MERGE  = (FIXTURES_DIR / "approximation__color-merge.css").read_text()
ALPHA_GUARD  = (FIXTURES_DIR / "approximation__alpha-guard.css").read_text()


def _run(tmp_path, css, approx_cfg, threshold=2):
    (tmp_path / "s.css").write_text(css)
    run_mode("extract", tmp_path, config={"threshold": threshold, "approximate": approx_cfg})
    return load_plan(tmp_path)


def test_grid_snap_collapses_nearby_values(tmp_path):
    (tmp_path / "s.css").write_text(GRID_SNAP)
    run_mode("extract", tmp_path, config={
        "threshold": 2,
        "approximate": {"spacing": {"enabled": True, "mode": "grid", "step": 4, "unit": "px"}},
    })
    plan = load_plan(tmp_path)
    spacing_vars = [v for v in plan["variables"] if v["type"] == "spacing"]
    # 13px, 14px, 15px, 16px with step=4 should all snap to 12px or 16px
    assert len(spacing_vars) <= 2


def test_grid_snap_round_mode(tmp_path):
    css = ".a { padding: 14px; padding: 14px; }"
    plan = _run(tmp_path, css,
        {"spacing": {"enabled": True, "mode": "grid", "step": 4, "unit": "px", "roundingMode": "round"}})
    vals = [v["value"] for v in plan["variables"] if v["type"] == "spacing"]
    assert vals and vals[0] == "16px"


def test_grid_snap_floor_mode(tmp_path):
    css = ".a { padding: 14px; padding: 14px; }"
    plan = _run(tmp_path, css,
        {"spacing": {"enabled": True, "mode": "grid", "step": 4, "unit": "px", "roundingMode": "floor"}})
    vals = [v["value"] for v in plan["variables"] if v["type"] == "spacing"]
    assert vals and vals[0] == "12px"


def test_grid_snap_ceil_mode(tmp_path):
    css = ".a { padding: 14px; padding: 14px; }"
    plan = _run(tmp_path, css,
        {"spacing": {"enabled": True, "mode": "grid", "step": 4, "unit": "px", "roundingMode": "ceil"}})
    vals = [v["value"] for v in plan["variables"] if v["type"] == "spacing"]
    assert vals and vals[0] == "16px"


@pytest.mark.xfail(reason="minValue guard not yet enforced in extractor")
def test_min_value_guard_keeps_value_as_is(tmp_path):
    css = ".a { padding: 2px; padding: 2px; }"
    stdout, stderr, _ = run_mode("extract", tmp_path, config={
        "threshold": 2,
        "approximate": {"spacing": {"enabled": True, "mode": "grid", "step": 4, "unit": "px", "minValue": 4}},
    })
    plan = load_plan(tmp_path)
    vals = [v["value"] for v in plan["variables"] if v["type"] == "spacing"]
    assert vals and vals[0] == "2px"
    assert "minValue" in stderr or "minvalue" in stderr.lower() or "2px" in stderr


def test_custom_scale_snap(tmp_path):
    css = ".a { padding: 13px; padding: 13px; }"
    plan = _run(tmp_path, css, {
        "spacing": {"enabled": True, "mode": "custom", "customScale": [0, 4, 8, 12, 16, 24], "unit": "px"},
    })
    vals = [v["value"] for v in plan["variables"] if v["type"] == "spacing"]
    assert vals and vals[0] == "12px"


def test_colors_within_tolerance_merged(tmp_path):
    (tmp_path / "s.css").write_text(COLOR_MERGE)
    run_mode("extract", tmp_path, config={
        "threshold": 2,
        "approximate": {"colors": {"enabled": True, "tolerance": 4, "strategy": "nearest"}},
    })
    plan = load_plan(tmp_path)
    color_vars = [v for v in plan["variables"] if v["type"] == "colors"]
    # #3a86ff and #3b87fe should merge; #ff0000 should stay separate
    assert len(color_vars) == 2


def test_colors_above_tolerance_not_merged(tmp_path):
    (tmp_path / "s.css").write_text(COLOR_MERGE)
    run_mode("extract", tmp_path, config={
        "threshold": 2,
        "approximate": {"colors": {"enabled": True, "tolerance": 0}},
    })
    plan = load_plan(tmp_path)
    color_vars = [v for v in plan["variables"] if v["type"] == "colors"]
    assert len(color_vars) == 3


def test_alpha_difference_prevents_merge(tmp_path):
    (tmp_path / "s.css").write_text(ALPHA_GUARD)
    run_mode("extract", tmp_path, config={
        "threshold": 2,
        "approximate": {"colors": {"enabled": True, "tolerance": 10, "alphaTolerance": 0.05}},
    })
    plan = load_plan(tmp_path)
    color_vars = [v for v in plan["variables"] if v["type"] == "colors"]
    assert len(color_vars) == 2


@pytest.mark.xfail(reason="color cluster strategy not yet producing single merged variable")
def test_strategy_nearest_keeps_first_cluster_value(tmp_path):
    # With strategy=nearest, the representative is the first color seen in the cluster
    css = ".a { color: #0000ff; color: #0000ff; } .b { color: #0099ff; color: #0099ff; }"
    (tmp_path / "s.css").write_text(css)
    run_mode("extract", tmp_path, config={
        "threshold": 2,
        "normalize": {"colors": {"enabled": True, "targetFormat": "hex"}},
        "approximate": {"colors": {"enabled": True, "tolerance": 30, "strategy": "nearest"}},
    })
    plan = load_plan(tmp_path)
    color_vars = [v for v in plan["variables"] if v["type"] == "colors"]
    # Both colors must merge into one variable
    assert len(color_vars) == 1


@pytest.mark.xfail(reason="font-weight keyword snapping not yet implemented in extractor")
def test_font_weight_snapped_to_keyword(tmp_path):
    css = ".a { font-weight: 350; font-weight: 350; }"
    plan = _run(tmp_path, css,
        {"typography": {"fontWeight": {"enabled": True, "snapToKeywords": True}}})
    vals = [v["value"] for v in plan["variables"] if v["type"] == "typography_font_weight"]
    assert vals and vals[0] in ("300", "400")


def test_duration_step_snap(tmp_path):
    css = ".a { transition-duration: 180ms; transition-duration: 180ms; }"
    plan = _run(tmp_path, css,
        {"transitions": {"duration": {"enabled": True, "mode": "grid", "step": 50, "unit": "ms"}}})
    vals = [v["value"] for v in plan["variables"] if v["type"] == "transitions_duration"]
    assert vals and vals[0] == "200ms"


def test_max_variables_cap_triggers_tightening(tmp_path):
    # 4 distinct colors with low tolerance — cap at 2 should trigger tightening
    css = (
        ".a{color:#ff0000;color:#ff0000;}"
        ".b{color:#ff1111;color:#ff1111;}"
        ".c{color:#0000ff;color:#0000ff;}"
        ".d{color:#0011ff;color:#0011ff;}"
    )
    (tmp_path / "s.css").write_text(css)
    run_mode("extract", tmp_path, config={
        "threshold": 2,
        "approximate": {"colors": {"enabled": True, "tolerance": 1, "maxVariables": 2, "maxIterations": 5}},
    })
    plan = load_plan(tmp_path)
    color_vars = [v for v in plan["variables"] if v["type"] == "colors"]
    assert len(color_vars) <= 2


def test_max_variables_unreachable_emits_warning(tmp_path):
    css = (
        ".a{color:#ff0000;color:#ff0000;}"
        ".b{color:#00ff00;color:#00ff00;}"
        ".c{color:#0000ff;color:#0000ff;}"
    )
    (tmp_path / "s.css").write_text(css)
    stdout, stderr, _ = run_mode("extract", tmp_path, config={
        "threshold": 2,
        "approximate": {"colors": {"enabled": True, "tolerance": 1, "maxVariables": 1, "maxIterations": 2}},
    })
    assert "warning" in stderr.lower() or "could not reach" in stderr.lower()
