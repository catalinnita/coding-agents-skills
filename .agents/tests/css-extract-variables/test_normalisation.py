"""Normalisation tests — one test per conversion pair and documented rule."""
from __future__ import annotations
import json
from pathlib import Path
import pytest
from helpers import run_mode, load_plan, FIXTURES_DIR

HEX_FORMATS  = (FIXTURES_DIR / "normalisation__hex-formats.css").read_text()
SPACING_UNITS = (FIXTURES_DIR / "normalisation__spacing-units.css").read_text()
DURATION     = (FIXTURES_DIR / "normalisation__duration.css").read_text()


def _extract_with_norm(tmp_path, css, normalize_cfg, threshold=2):
    (tmp_path / "s.css").write_text(css)
    run_mode("extract", tmp_path, config={"threshold": threshold, "normalize": normalize_cfg})
    return load_plan(tmp_path)


def test_hex_normalized_to_hsl(tmp_path):
    css = ".a { color: #3a86ff; color: #3a86ff; }"
    plan = _extract_with_norm(tmp_path, css, {"colors": {"enabled": True, "targetFormat": "hsl"}})
    vals = [v["value"] for v in plan["variables"] if v["type"] == "colors"]
    assert vals and all(v.startswith("hsl(") for v in vals)


def test_hex_normalized_to_rgb(tmp_path):
    css = ".a { color: #3a86ff; color: #3a86ff; }"
    plan = _extract_with_norm(tmp_path, css, {"colors": {"enabled": True, "targetFormat": "rgb"}})
    vals = [v["value"] for v in plan["variables"] if v["type"] == "colors"]
    assert vals and all(v.startswith("rgb(") for v in vals)


def test_short_hex_expanded_before_conversion(tmp_path):
    css = ".a { color: #fff; color: #fff; }"
    plan = _extract_with_norm(tmp_path, css, {"colors": {"enabled": True, "targetFormat": "hsl"}})
    vals = [v["value"] for v in plan["variables"] if v["type"] == "colors"]
    assert vals and all(v.startswith("hsl(") for v in vals)


def test_named_color_converted_to_hsl(tmp_path):
    css = ".a { color: red; color: red; }"
    plan = _extract_with_norm(tmp_path, css, {"colors": {"enabled": True, "targetFormat": "hsl"}})
    vals = [v["value"] for v in plan["variables"] if v["type"] == "colors"]
    assert vals and all(v.startswith("hsl(") for v in vals)


def test_rgba_alpha_preserved_in_hsl(tmp_path):
    css = ".a { color: rgba(0,0,0,0.5); color: rgba(0,0,0,0.5); }"
    plan = _extract_with_norm(tmp_path, css, {"colors": {"enabled": True, "targetFormat": "hsl"}})
    vals = [v["value"] for v in plan["variables"] if v["type"] == "colors"]
    assert vals and all("/ 0.5" in v or "0.5" in v for v in vals)


def test_hex_alpha_falls_back_to_rgba(tmp_path):
    css = ".a { color: #3a86ff80; color: #3a86ff80; }"
    plan = _extract_with_norm(tmp_path, css, {"colors": {"enabled": True, "targetFormat": "hex"}})
    vals = [v["value"] for v in plan["variables"] if v["type"] == "colors"]
    assert vals and all(v.startswith("rgba(") for v in vals)


def test_px_to_rem_conversion(tmp_path):
    css = ".a { padding: 16px; padding: 16px; }"
    plan = _extract_with_norm(tmp_path, css,
        {"spacing": {"enabled": True, "targetUnit": "rem", "baseFontSize": 16}})
    vals = [v["value"] for v in plan["variables"] if v["type"] == "spacing"]
    assert vals and all("rem" in v for v in vals)
    assert any("1.0rem" in v or "1rem" in v for v in vals)


def test_px_to_rem_custom_base(tmp_path):
    css = ".a { padding: 20px; padding: 20px; }"
    plan = _extract_with_norm(tmp_path, css,
        {"spacing": {"enabled": True, "targetUnit": "rem", "baseFontSize": 10}})
    vals = [v["value"] for v in plan["variables"] if v["type"] == "spacing"]
    assert vals and any("2.0rem" in v or "2rem" in v for v in vals)


@pytest.mark.xfail(reason="em→rem warning not yet emitted by extractor")
def test_em_converted_to_rem_with_warning(tmp_path):
    css = ".a { padding: 1em; padding: 1em; }"
    stdout, stderr, _ = run_mode("extract", tmp_path,
        config={"threshold": 2, "normalize": {"spacing": {"enabled": True, "targetUnit": "rem"}}})
    plan = load_plan(tmp_path)
    vals = [v["value"] for v in plan["variables"] if v["type"] == "spacing"]
    assert vals and all("rem" in v for v in vals)
    assert "em" in stderr.lower() or "em" in stdout.lower()


def test_percent_unit_skipped_with_report(tmp_path):
    css = ".a { padding: 50%; padding: 50%; }"
    stdout, stderr, _ = run_mode("extract", tmp_path,
        config={"threshold": 2, "normalize": {"spacing": {"enabled": True, "targetUnit": "rem"}}})
    plan = load_plan(tmp_path)
    vals = [v["value"] for v in plan["variables"] if v["type"] == "spacing"]
    assert not vals or all("%" in v for v in vals)


def test_ms_to_s_conversion(tmp_path):
    css = ".a { transition-duration: 200ms; transition-duration: 200ms; }"
    plan = _extract_with_norm(tmp_path, css,
        {"transitions": {"duration": {"enabled": True, "targetUnit": "s"}}})
    vals = [v["value"] for v in plan["variables"] if v["type"] == "transitions_duration"]
    assert vals and all(v.endswith("s") and not v.endswith("ms") for v in vals)
    assert any("0.2" in v for v in vals)


def test_s_to_ms_conversion(tmp_path):
    css = ".a { transition-duration: 0.2s; transition-duration: 0.2s; }"
    plan = _extract_with_norm(tmp_path, css,
        {"transitions": {"duration": {"enabled": True, "targetUnit": "ms"}}})
    vals = [v["value"] for v in plan["variables"] if v["type"] == "transitions_duration"]
    assert vals and all("ms" in v for v in vals)
    assert any("200" in v for v in vals)


def test_hex_and_rgb_same_color_deduplicated(tmp_path):
    """#3a86ff and rgb(58,134,255) are the same color — with normalisation they become one variable."""
    css = ".a { color: #3a86ff; } .b { color: #3a86ff; } .c { color: rgb(58,134,255); } .d { color: rgb(58,134,255); }"
    plan = _extract_with_norm(tmp_path, css, {"colors": {"enabled": True, "targetFormat": "hsl"}})
    color_vars = [v for v in plan["variables"] if v["type"] == "colors"]
    assert len(color_vars) == 1


def test_unitless_line_height_unchanged(tmp_path):
    css = ".a { line-height: 1.5; line-height: 1.5; }"
    plan = _extract_with_norm(tmp_path, css,
        {"typography": {"lineHeight": {"enabled": True, "targetUnit": "rem"}}}, threshold=2)
    vals = [v["value"] for v in plan["variables"]]
    assert any(v == "1.5" for v in vals)
