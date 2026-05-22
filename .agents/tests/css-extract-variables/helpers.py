"""Importable helpers shared across the test suite."""
from __future__ import annotations
import json
import subprocess
import sys
from pathlib import Path

SKILL_DIR = Path("/Users/catalinnita/Dev/ai/agents/.agents/skills/css-extract-variables")
SCRIPT = SKILL_DIR / "scripts" / "extractor.py"
FIXTURES_DIR = Path(__file__).parent / "fixtures"
CONFIGS_DIR = FIXTURES_DIR / "configs"


def run_mode(
    mode: str,
    tmp_path: Path,
    config: dict | None = None,
    extra_args: list[str] | None = None,
    plan_path: Path | None = None,
    variables_file: Path | None = None,
) -> tuple[str, str, int]:
    """Run the extractor script in a given mode. Returns (stdout, stderr, returncode)."""
    cfg_path = tmp_path / "_config.json"
    cfg = {"target": str(tmp_path), **(config or {})}
    cfg_path.write_text(json.dumps(cfg))

    cmd = [sys.executable, str(SCRIPT), "--mode", mode, "--config", str(cfg_path)]

    if mode == "extract":
        plan = plan_path or (tmp_path / "plan.json")
        cmd += ["--output-plan", str(plan)]
    if mode in ("write-variables", "replace"):
        plan = plan_path or (tmp_path / "plan.json")
        cmd += ["--plan", str(plan)]
    if mode == "write-variables" and variables_file:
        cmd += ["--variables-file", str(variables_file)]

    cmd += (extra_args or [])
    result = subprocess.run(cmd, capture_output=True, text=True)
    return result.stdout, result.stderr, result.returncode


def load_plan(tmp_path: Path, plan_path: Path | None = None) -> dict:
    p = plan_path or (tmp_path / "plan.json")
    return json.loads(p.read_text())
