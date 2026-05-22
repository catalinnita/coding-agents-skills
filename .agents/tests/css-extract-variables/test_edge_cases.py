"""Edge-case tests — one test per documented edge case and gotcha."""
from __future__ import annotations
import json
from pathlib import Path
import pytest
from helpers import run_mode, load_plan, FIXTURES_DIR

COMMENTS = (FIXTURES_DIR / "edge-cases__values-in-comments.css").read_text()
VAR_REFS  = (FIXTURES_DIR / "edge-cases__existing-var-refs.css").read_text()
IMPORTANT = (FIXTURES_DIR / "edge-cases__important.css").read_text()
SHORTHAND = (FIXTURES_DIR / "edge-cases__shorthand-partial.css").read_text()
CALC      = (FIXTURES_DIR / "edge-cases__calc.css").read_text()
GRADIENTS = (FIXTURES_DIR / "edge-cases__gradients.css").read_text()
MEDIA     = (FIXTURES_DIR / "edge-cases__media-query.css").read_text()


def test_values_in_comments_not_extracted(tmp_path):
    (tmp_path / "s.css").write_text(COMMENTS)
    run_mode("extract", tmp_path, config={"threshold": 1})
    plan = load_plan(tmp_path)
    originals = [s["original"] for v in plan["variables"] for s in v["sources"]]
    assert "#3a86ff" not in originals  # inside comment, must be excluded


def test_existing_var_refs_not_replaced(tmp_path):
    (tmp_path / "s.css").write_text(VAR_REFS)
    run_mode("extract", tmp_path, config={"threshold": 1})
    run_mode("write-variables", tmp_path, variables_file=tmp_path / "vars.css")
    run_mode("replace", tmp_path)
    content = (tmp_path / "s.css").read_text()
    # Original var() references must survive unchanged
    assert "var(--color-primary)" in content
    assert "var(--spacing-4)" in content
    # No double-wrapping
    assert "var(var(" not in content


def test_important_preserved_after_replacement(tmp_path):
    (tmp_path / "s.css").write_text(IMPORTANT)
    run_mode("extract", tmp_path, config={"threshold": 2})
    run_mode("write-variables", tmp_path, variables_file=tmp_path / "vars.css")
    run_mode("replace", tmp_path)
    content = (tmp_path / "s.css").read_text()
    assert "!important" in content
    # The var() must appear before !important, not after
    import re
    assert re.search(r"var\(--[^)]+\)\s*!important", content)


def test_non_repeated_gradient_not_extracted(tmp_path):
    (tmp_path / "s.css").write_text(GRADIENTS)
    run_mode("extract", tmp_path, config={"threshold": 2})
    plan = load_plan(tmp_path)
    shadow_vars = [v for v in plan["variables"] if v["type"] == "shadows"]
    # The non-repeated gradient must not be extracted
    originals = [s["original"] for v in shadow_vars for s in v["sources"]]
    assert not any("to bottom" in o for o in originals)


@pytest.mark.xfail(reason="background: gradient not yet captured under shadows type")
def test_repeated_gradient_extracted(tmp_path):
    (tmp_path / "s.css").write_text(GRADIENTS)
    run_mode("extract", tmp_path, config={"threshold": 2, "types": ["shadows"]})
    plan = load_plan(tmp_path)
    shadow_vars = [v for v in plan["variables"] if v["type"] == "shadows"]
    originals = [s["original"] for v in shadow_vars for s in v["sources"]]
    assert any("to right" in o for o in originals)


def test_media_query_values_not_extracted_by_default(tmp_path):
    (tmp_path / "s.css").write_text(MEDIA)
    run_mode("extract", tmp_path, config={"threshold": 2})
    plan = load_plan(tmp_path)
    originals = [s["original"] for v in plan["variables"] for s in v["sources"]]
    assert "768px" not in originals


def test_js_extensions_skipped(tmp_path):
    (tmp_path / "styles.js").write_text(
        "const s = { color: '#3a86ff', color: '#3a86ff' };"
    )
    run_mode("extract", tmp_path, config={
        "threshold": 1,
        "extensions": [".css", ".scss"],
    })
    plan = load_plan(tmp_path)
    assert len(plan["variables"]) == 0


def test_existing_variable_file_not_overwritten(tmp_path):
    css = ".a { color: #3a86ff; color: #3a86ff; }"
    (tmp_path / "s.css").write_text(css)
    vars_file = tmp_path / "vars.css"
    vars_file.write_text(":root {\n  --existing-var: red;\n}\n")
    run_mode("extract", tmp_path, config={"threshold": 2})
    run_mode("write-variables", tmp_path, variables_file=vars_file)
    content = vars_file.read_text()
    assert "--existing-var: red" in content


def test_file_with_no_extractable_values_not_written(tmp_path):
    (tmp_path / "s.css").write_text(".a { display: flex; }")
    vars_file = tmp_path / "vars.css"
    run_mode("extract", tmp_path)
    run_mode("write-variables", tmp_path, variables_file=vars_file)
    assert not vars_file.exists()


@pytest.mark.xfail(reason="shorthand review comment not yet implemented in script")
def test_partial_shorthand_gets_review_comment(tmp_path):
    (tmp_path / "s.css").write_text(SHORTHAND)
    run_mode("extract", tmp_path, config={"threshold": 2})
    run_mode("write-variables", tmp_path, variables_file=tmp_path / "vars.css")
    run_mode("replace", tmp_path)
    content = (tmp_path / "s.css").read_text()
    assert "css-extract: review" in content
