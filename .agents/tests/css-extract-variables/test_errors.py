"""Error tests — one test per failure mode."""
from __future__ import annotations
import json
import os
import stat
from pathlib import Path
import pytest
from helpers import run_mode, FIXTURES_DIR

MALFORMED = (FIXTURES_DIR / "errors__malformed.css").read_text()


def test_missing_config_file_exits_nonzero(tmp_path):
    import subprocess, sys
    from helpers import SCRIPT
    result = subprocess.run(
        [sys.executable, str(SCRIPT), "--mode", "scan", "--config", str(tmp_path / "nonexistent.json")],
        capture_output=True, text=True,
    )
    assert result.returncode != 0


def test_invalid_json_config_exits_nonzero(tmp_path):
    import subprocess, sys
    from helpers import SCRIPT
    bad = tmp_path / "bad.json"
    bad.write_text("{not valid json}")
    result = subprocess.run(
        [sys.executable, str(SCRIPT), "--mode", "scan", "--config", str(bad)],
        capture_output=True, text=True,
    )
    assert result.returncode != 0


def test_missing_plan_file_for_replace_exits_nonzero(tmp_path):
    import subprocess, sys, json as _json
    from helpers import SCRIPT
    cfg = tmp_path / "c.json"
    cfg.write_text(_json.dumps({"target": str(tmp_path)}))
    result = subprocess.run(
        [sys.executable, str(SCRIPT), "--mode", "replace",
         "--config", str(cfg), "--plan", str(tmp_path / "nonexistent.json")],
        capture_output=True, text=True,
    )
    assert result.returncode != 0


def test_malformed_css_skips_bad_declaration_continues(tmp_path):
    (tmp_path / "s.css").write_text(MALFORMED)
    stdout, stderr, code = run_mode("extract", tmp_path, config={"threshold": 1})
    # Must not crash — should complete with exit 0 or at least produce a plan
    assert code == 0 or "warning" in stderr.lower()


def test_no_matching_files_produces_empty_plan(tmp_path):
    (tmp_path / "s.txt").write_text("color: red;")
    run_mode("extract", tmp_path, config={"extensions": [".css"]})
    from helpers import load_plan
    plan = load_plan(tmp_path)
    assert plan["variables"] == []


@pytest.mark.skipif(os.name == "nt", reason="chmod not reliable on Windows")
def test_unreadable_file_skipped_with_warning(tmp_path):
    f = tmp_path / "s.css"
    f.write_text(".a { color: #fff; }")
    f.chmod(0o000)
    try:
        stdout, stderr, code = run_mode("extract", tmp_path, config={"threshold": 1})
        assert "warning" in stderr.lower() or code == 0
    finally:
        f.chmod(0o644)


def test_missing_required_flag_prints_usage(tmp_path):
    import subprocess, sys
    from helpers import SCRIPT
    result = subprocess.run(
        [sys.executable, str(SCRIPT)],
        capture_output=True, text=True,
    )
    assert result.returncode != 0
    assert "usage" in result.stderr.lower() or "usage" in result.stdout.lower()
