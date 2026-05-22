# /// script
# requires-python = ">=3.10"
# dependencies = []
# ///
"""
Skill test generator — reads a skill folder and writes a pytest test suite.
"""

from __future__ import annotations

import argparse
import ast
import json
import os
import re
import sys
import textwrap
from dataclasses import dataclass, field
from pathlib import Path

# ---------------------------------------------------------------------------
# Skill reader
# ---------------------------------------------------------------------------

@dataclass
class SkillInfo:
    name: str
    folder: Path
    skill_md: str
    scripts: dict[str, str]          # filename -> source
    inputs: list[dict]               # [{name, required, description, default}]
    modes: list[str]                 # CLI modes / subcommands
    edge_cases: list[str]            # raw text lines from Edge cases section
    gotchas: list[str]               # raw text lines from Gotchas section
    success_criteria: list[str]
    has_normalisation: bool
    has_approximation: bool
    script_flags: dict[str, list[str]]  # script filename -> [flag names]


def find_skill_folder(skill: str) -> Path:
    candidates = [
        Path(".agents/skills") / skill,
        Path.home() / ".agents/skills" / skill,
        Path(skill),
    ]
    for c in candidates:
        if c.is_dir() and (c / "SKILL.md").exists():
            return c
    raise FileNotFoundError(f"Skill folder not found for: {skill!r}")


def parse_inputs_table(md: str) -> list[dict]:
    inputs = []
    in_table = False
    for line in md.splitlines():
        if "| Input |" in line or "| `target`" in line or re.match(r"\|\s*`\w", line):
            in_table = True
        if in_table:
            if line.startswith("|---") or line.startswith("| ---"):
                continue
            m = re.match(r"\|\s*`([^`]+)`\s*\|\s*(Yes|No)\s*\|\s*(.+?)\s*\|", line)
            if m:
                name, required, desc = m.group(1), m.group(2), m.group(3).strip()
                default_m = re.search(r"\(default[:\s]+`?([^`)]+)`?\)", desc)
                inputs.append({
                    "name": name,
                    "required": required == "Yes",
                    "description": desc,
                    "default": default_m.group(1).strip() if default_m else None,
                })
            elif line.strip() == "" or (line.startswith("#") and in_table):
                if inputs:
                    in_table = False
    return inputs


def parse_section(md: str, heading: str) -> list[str]:
    lines = []
    inside = False
    for line in md.splitlines():
        if re.match(rf"^#+\s+{re.escape(heading)}", line, re.IGNORECASE):
            inside = True
            continue
        if inside:
            if re.match(r"^#+\s+", line):
                break
            stripped = line.strip()
            if stripped.startswith("- ") or stripped.startswith("* "):
                lines.append(stripped.lstrip("-* ").strip())
    return lines


def parse_modes(md: str, scripts: dict[str, str]) -> list[str]:
    """Extract CLI mode names from argparse choices in scripts only."""
    modes: list[str] = []
    for src in scripts.values():
        for m in re.finditer(r"choices=\[([^\]]+)\]", src):
            raw = m.group(1)
            # Only treat as modes if the choices look like command names (no spaces, lowercase/hyphens)
            candidates = re.findall(r"['\"]([a-z][a-z-]+)['\"]", raw)
            if candidates and all(re.match(r"^[a-z][a-z-]+$", c) for c in candidates):
                for c in candidates:
                    if c not in modes:
                        modes.append(c)
    return modes or ["scan", "extract", "write-variables", "replace"]


def extract_script_flags(src: str) -> list[str]:
    flags = []
    for m in re.finditer(r'add_argument\(["\'](-{1,2}[\w-]+)["\']', src):
        flags.append(m.group(1))
    return flags


def read_skill(skill: str) -> SkillInfo:
    folder = find_skill_folder(skill)
    skill_md = (folder / "SKILL.md").read_text()
    name_m = re.search(r"^name:\s*(.+)$", skill_md, re.MULTILINE)
    name = name_m.group(1).strip() if name_m else folder.name

    scripts: dict[str, str] = {}
    script_flags: dict[str, list[str]] = {}
    scripts_dir = folder / "scripts"
    if scripts_dir.is_dir():
        for f in scripts_dir.iterdir():
            if f.suffix in (".py", ".js", ".ts") and not f.name.startswith("_"):
                src = f.read_text()
                scripts[f.name] = src
                script_flags[f.name] = extract_script_flags(src)

    return SkillInfo(
        name=name,
        folder=folder,
        skill_md=skill_md,
        scripts=scripts,
        inputs=parse_inputs_table(skill_md),
        modes=parse_modes(skill_md, scripts),
        edge_cases=parse_section(skill_md, "Edge cases"),
        gotchas=parse_section(skill_md, "Gotchas"),
        success_criteria=parse_section(skill_md, "Success criteria"),
        has_normalisation="normalisation" in skill_md.lower() or "normalization" in skill_md.lower(),
        has_approximation="approximation" in skill_md.lower() or "approximate" in skill_md.lower(),
        script_flags=script_flags,
    )


# ---------------------------------------------------------------------------
# Runner script template
# ---------------------------------------------------------------------------

def make_run_script(skill_name: str) -> str:
    return textwrap.dedent(f'''\
        #!/usr/bin/env python3
        """
        Test runner for the {skill_name} skill test suite.

        Usage:
          python3 run_tests.py                        # run all tests
          python3 run_tests.py --category happy-path  # run one category
          python3 run_tests.py --verbose              # show each test name
          python3 run_tests.py --fail-fast            # stop on first failure
          python3 run_tests.py --xfail-as-error       # treat xfail as failure
        """
        from __future__ import annotations
        import argparse
        import subprocess
        import sys
        from pathlib import Path

        HERE = Path(__file__).parent

        CATEGORIES = {{
            "happy-path":    HERE / "test_happy_path.py",
            "boundary":      HERE / "test_boundary.py",
            "edge-cases":    HERE / "test_edge_cases.py",
            "normalisation": HERE / "test_normalisation.py",
            "approximation": HERE / "test_approximation.py",
            "errors":        HERE / "test_errors.py",
            "dry-run":       HERE / "test_dry_run.py",
            "idempotency":   HERE / "test_idempotency.py",
        }}


        def main() -> None:
            parser = argparse.ArgumentParser(description="Run {skill_name} skill tests")
            parser.add_argument("--category", choices=list(CATEGORIES), default=None,
                                help="Run only this category (default: all)")
            parser.add_argument("--verbose", "-v", action="store_true",
                                help="Show each test name")
            parser.add_argument("--fail-fast", "-x", action="store_true",
                                help="Stop on first failure")
            parser.add_argument("--xfail-as-error", action="store_true",
                                help="Treat xfail tests as errors")
            args = parser.parse_args()

            targets = [str(CATEGORIES[args.category])] if args.category else [str(HERE)]

            cmd = [sys.executable, "-m", "pytest"] + targets
            if args.verbose:
                cmd += ["-v"]
            else:
                cmd += ["-q"]
            if args.fail_fast:
                cmd += ["-x"]
            if args.xfail_as_error:
                cmd += ["--runxfail"]

            result = subprocess.run(cmd)
            sys.exit(result.returncode)


        if __name__ == "__main__":
            main()
    ''')


# ---------------------------------------------------------------------------
# Fixture generation
# ---------------------------------------------------------------------------

FIXTURES: dict[str, str] = {
    "happy-path__full-config.css": textwrap.dedent("""\
        /* Full config fixture: colors, spacing, typography, radii, shadows, z-index, transitions */
        .btn {
          color: #3a86ff;
          background: #3a86ff;
          padding: 8px 16px;
          font-size: 16px;
          font-weight: 600;
          border-radius: 4px;
          box-shadow: 0 2px 4px rgba(0,0,0,0.15);
          z-index: 10;
          transition-duration: 200ms;
        }
        .btn:hover {
          color: #3a86ff;
          padding: 8px 16px;
          font-size: 16px;
        }
    """),
    "edge-cases__values-in-comments.css": textwrap.dedent("""\
        /* color: #3a86ff; this should NOT be extracted */
        .btn {
          /* padding: 8px; also safe */
          color: red; /* inline comment: font-size: 14px; */
          background: blue;
          background: blue;
        }
    """),
    "edge-cases__existing-var-refs.css": textwrap.dedent("""\
        .btn {
          color: var(--color-primary);
          padding: var(--spacing-4);
          font-size: 16px;
          font-size: 16px;
        }
    """),
    "edge-cases__important.css": textwrap.dedent("""\
        .btn {
          color: #3a86ff !important;
          color: #3a86ff !important;
          padding: 8px !important;
          padding: 8px !important;
        }
    """),
    "edge-cases__shorthand-partial.css": textwrap.dedent("""\
        /* margin: 8px auto — only 8px has a variable, auto does not */
        .btn {
          margin: 8px auto;
          margin: 8px auto;
          padding: 8px 16px;
          padding: 8px 16px;
        }
    """),
    "edge-cases__calc.css": textwrap.dedent("""\
        .btn {
          width: calc(100% - 16px);
          width: calc(100% - 16px);
          height: calc(8px + 2rem);
          height: calc(8px + 2rem);
        }
    """),
    "edge-cases__gradients.css": textwrap.dedent("""\
        /* gradient repeated — should extract as one variable */
        .a { background: linear-gradient(to right, #3a86ff, #ff006e); }
        .b { background: linear-gradient(to right, #3a86ff, #ff006e); }
        /* gradient not repeated — should not extract */
        .c { background: linear-gradient(to bottom, #fff, #000); }
    """),
    "edge-cases__media-query.css": textwrap.dedent("""\
        @media (max-width: 768px) {
          .btn { font-size: 14px; }
        }
        @media (max-width: 768px) {
          .card { font-size: 14px; }
        }
    """),
    "boundary__single-occurrence.css": textwrap.dedent("""\
        /* Every value appears exactly once — nothing should be extracted with threshold=2 */
        .btn {
          color: #3a86ff;
          padding: 8px;
          font-size: 14px;
          border-radius: 4px;
        }
    """),
    "boundary__at-threshold.css": textwrap.dedent("""\
        /* Values appear exactly threshold times */
        .a { color: #3a86ff; padding: 8px; }
        .b { color: #3a86ff; padding: 8px; }
    """),
    "normalisation__hex-formats.css": textwrap.dedent("""\
        /* 3-digit, 6-digit, 8-digit (alpha), rgb, rgba, hsl, named */
        .a { color: #fff; color: #fff; }
        .b { color: #ffffff; color: #ffffff; }
        .c { color: #ffffff80; color: #ffffff80; }
        .d { color: rgb(255,0,0); color: rgb(255,0,0); }
        .e { color: rgba(0,0,0,0.5); color: rgba(0,0,0,0.5); }
        .f { color: hsl(200,100%,50%); color: hsl(200,100%,50%); }
        .g { color: red; color: red; }
    """),
    "normalisation__spacing-units.css": textwrap.dedent("""\
        .a { padding: 16px; padding: 16px; }
        .b { padding: 1rem; padding: 1rem; }
        .c { padding: 1em; padding: 1em; }
        .d { padding: 50%; padding: 50%; }
        .e { padding: 10vh; padding: 10vh; }
    """),
    "normalisation__duration.css": textwrap.dedent("""\
        .a { transition-duration: 200ms; transition-duration: 200ms; }
        .b { transition-duration: 0.2s; transition-duration: 0.2s; }
    """),
    "approximation__grid-snap.css": textwrap.dedent("""\
        /* 13px, 14px, 15px should all snap to same value with step=4 */
        .a { padding: 13px; padding: 13px; }
        .b { padding: 14px; padding: 14px; }
        .c { padding: 15px; padding: 15px; }
        .d { padding: 16px; padding: 16px; }
    """),
    "approximation__color-merge.css": textwrap.dedent("""\
        /* These two blues are perceptually very close — should merge with tolerance=4 */
        .a { color: #3a86ff; color: #3a86ff; }
        .b { color: #3b87fe; color: #3b87fe; }
        /* This red is far from blue — should not merge */
        .c { color: #ff0000; color: #ff0000; }
    """),
    "approximation__alpha-guard.css": textwrap.dedent("""\
        /* Same RGB but different alpha — must NOT merge */
        .a { color: rgba(58,134,255,1.0); color: rgba(58,134,255,1.0); }
        .b { color: rgba(58,134,255,0.5); color: rgba(58,134,255,0.5); }
    """),
    "errors__malformed.css": textwrap.dedent("""\
        /* Unclosed block */
        .btn {
          color: #3a86ff;
        /* missing closing brace */
        .card { padding: 8px; padding: 8px; }
    """),
    "idempotency__already-replaced.css": textwrap.dedent("""\
        /* Already uses var() — a second pass must not modify this file */
        .btn {
          color: var(--color-primary);
          padding: var(--spacing-8px);
        }
    """),
}

CONFIG_FIXTURES: dict[str, dict] = {
    "default.json": {},
    "full.json": {
        "prefix": "--brand",
        "threshold": 2,
        "dryRun": False,
        "types": ["colors", "spacing", "typography", "radii", "shadows", "z-index", "transitions"],
        "normalize": {"colors": {"enabled": True, "targetFormat": "hsl", "precision": 2},
                      "spacing": {"enabled": True, "targetUnit": "rem", "baseFontSize": 16}},
        "approximate": {"colors": {"enabled": True, "tolerance": 4, "strategy": "nearest"},
                        "spacing": {"enabled": True, "mode": "grid", "step": 4, "unit": "px"}},
    },
    "scss.json": {"scss": True},
    "dry-run.json": {"dryRun": True},
    "normalize-hsl.json": {"normalize": {"colors": {"enabled": True, "targetFormat": "hsl"}}},
    "normalize-rgb.json": {"normalize": {"colors": {"enabled": True, "targetFormat": "rgb"}}},
    "normalize-rem.json": {"normalize": {"spacing": {"enabled": True, "targetUnit": "rem", "baseFontSize": 16}}},
    "normalize-ms.json": {"normalize": {"transitions": {"duration": {"enabled": True, "targetUnit": "ms"}}}},
    "approximate-grid.json": {"approximate": {"spacing": {"enabled": True, "mode": "grid", "step": 4, "unit": "px"}}},
    "approximate-scale.json": {"approximate": {"typography": {"fontSize": {"enabled": True, "mode": "scale", "scaleBase": 16, "scaleRatio": 1.25}}}},
    "approximate-color-merge.json": {"approximate": {"colors": {"enabled": True, "tolerance": 4, "strategy": "nearest"}}},
    "approximate-max-vars.json": {"approximate": {"colors": {"enabled": True, "tolerance": 2, "maxVariables": 2, "maxIterations": 3}}},
    "threshold-1.json": {"threshold": 1},
    "threshold-high.json": {"threshold": 999},
    "colors-only.json": {"types": ["colors"]},
    "spacing-only.json": {"types": ["spacing"]},
}


# ---------------------------------------------------------------------------
# conftest.py
# ---------------------------------------------------------------------------

HELPERS_TEMPLATE = '''\
"""Importable helpers shared across the test suite."""
from __future__ import annotations
import json
import subprocess
import sys
from pathlib import Path

SKILL_DIR = Path("{skill_dir}")
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
'''

CONFTEST = '''\
"""Pytest fixtures — imports helpers so test files can use \'from helpers import ...\'."""
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
'''


# ---------------------------------------------------------------------------
# Test generators
# ---------------------------------------------------------------------------

def generate_happy_path(info: SkillInfo) -> str:
    modes_list = ", ".join(f'"{m}"' for m in (info.modes or ["scan", "extract", "write-variables", "replace"]))
    return f'''\
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


@pytest.mark.parametrize("mode", [{modes_list}])
def test_mode_exits_zero_on_valid_input(tmp_path, mode):
    setup_css(tmp_path)
    if mode in ("write-variables", "replace"):
        run_mode("extract", tmp_path)
    _, _, code = run_mode(mode, tmp_path)
    assert code == 0
'''


def generate_boundary(info: SkillInfo) -> str:
    return '''\
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
'''


def generate_edge_cases(info: SkillInfo) -> str:
    return '''\
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
    vars_file.write_text(":root {\\n  --existing-var: red;\\n}\\n")
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
'''


def generate_normalisation(info: SkillInfo) -> str:
    return '''\
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
'''


def generate_approximation(info: SkillInfo) -> str:
    return '''\
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
'''


def generate_errors(info: SkillInfo) -> str:
    return '''\
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
'''


def generate_dry_run(info: SkillInfo) -> str:
    return '''\
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
    # Plan file may be created (it\'s a temp artifact, not a user-visible write)
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
'''


def generate_idempotency(info: SkillInfo) -> str:
    return '''\
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
'''


# ---------------------------------------------------------------------------
# Writer
# ---------------------------------------------------------------------------

def write_suite(info: SkillInfo, output_dir: Path) -> dict:
    fixtures_dir = output_dir / "fixtures"
    configs_dir = fixtures_dir / "configs"
    mocks_dir = output_dir / "mocks"
    fixtures_dir.mkdir(parents=True, exist_ok=True)
    configs_dir.mkdir(parents=True, exist_ok=True)
    mocks_dir.mkdir(parents=True, exist_ok=True)

    # Fixtures
    for name, content in FIXTURES.items():
        (fixtures_dir / name).write_text(content)
    for name, cfg in CONFIG_FIXTURES.items():
        (configs_dir / name).write_text(json.dumps(cfg, indent=2))

    # Mocks
    (mocks_dir / "__init__.py").write_text("")
    (mocks_dir / "filesystem.py").write_text(textwrap.dedent("""\
        \"\"\"File system helpers for tests — write fixtures into tmp_path.\"\"\"
        from pathlib import Path

        def write_css(tmp_path: Path, name: str, content: str) -> Path:
            p = tmp_path / name
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(content)
            return p
    """))
    (mocks_dir / "subprocess.py").write_text(textwrap.dedent("""\
        \"\"\"Subprocess mock for unit tests that do not need the real script.\"\"\"
        from unittest.mock import MagicMock
        import subprocess

        def make_result(stdout="", stderr="", returncode=0):
            r = MagicMock(spec=subprocess.CompletedProcess)
            r.stdout = stdout
            r.stderr = stderr
            r.returncode = returncode
            return r
    """))

    # helpers + conftest
    helpers_content = HELPERS_TEMPLATE.replace("{skill_dir}", str(info.folder.resolve()))
    (output_dir / "helpers.py").write_text(helpers_content)
    (output_dir / "conftest.py").write_text(CONFTEST)
    (output_dir / "__init__.py").write_text("")

    # Test files
    tests = {
        "test_happy_path.py": generate_happy_path(info),
        "test_boundary.py": generate_boundary(info),
        "test_edge_cases.py": generate_edge_cases(info),
        "test_normalisation.py": generate_normalisation(info),
        "test_approximation.py": generate_approximation(info),
        "test_errors.py": generate_errors(info),
        "test_dry_run.py": generate_dry_run(info),
        "test_idempotency.py": generate_idempotency(info),
    }

    counts = {}
    for filename, content in tests.items():
        path = output_dir / filename
        path.write_text(content)
        counts[filename] = content.count("\ndef test_")

    # Runner script
    runner = output_dir / "run_tests.py"
    runner.write_text(make_run_script(info.name))
    runner.chmod(0o755)

    return counts


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description="Skill test generator")
    parser.add_argument("--skill", required=True, help="Skill name or path")
    parser.add_argument("--output", default=None, help="Output directory for test suite")
    parser.add_argument("--framework", default="pytest", choices=["pytest", "jest", "vitest"])
    parser.add_argument("--coverage", default="all",
                        choices=["happy-path", "edge-cases", "errors", "boundary", "all"])
    args = parser.parse_args()

    print(f"Reading skill: {args.skill}", file=sys.stderr)
    info = read_skill(args.skill)

    # Default: .agents/tests/<skill-name>/ — separate from the skill folder itself
    if args.output:
        output_dir = Path(args.output)
    else:
        agents_root = info.folder.parent.parent  # .agents/skills/ -> .agents/
        output_dir = agents_root / "tests" / info.name
    output_dir.mkdir(parents=True, exist_ok=True)

    print(f"Generating test suite → {output_dir}", file=sys.stderr)
    counts = write_suite(info, output_dir)

    total = sum(counts.values())
    runner = output_dir / "run_tests.py"
    print(f"\nGenerated test suite for: {info.name}")
    print(f"Output:  {output_dir}")
    print(f"Runner:  {runner}\n")
    print("Categories:")
    labels = {
        "test_happy_path.py": "happy-path",
        "test_boundary.py": "boundary",
        "test_edge_cases.py": "edge-cases",
        "test_normalisation.py": "normalisation",
        "test_approximation.py": "approximation",
        "test_errors.py": "errors",
        "test_dry_run.py": "dry-run",
        "test_idempotency.py": "idempotency",
    }
    for fn, label in labels.items():
        c = counts.get(fn, 0)
        print(f"  {label:<18} {c:>3} tests")
    print(f"  {'─' * 22}")
    print(f"  {'Total':<18} {total:>3} tests")
    print(f"\nFixtures:  {len(FIXTURES) + len(CONFIG_FIXTURES)} files")
    print(f"Mocks:      2 modules")
    print(f"\nRun:")
    print(f"  python3 {runner}            # all tests")
    print(f"  python3 {runner} --category happy-path")
    print(f"  python3 {runner} --category edge-cases --verbose")
    print(f"\nGaps (spec documented but not yet implemented — marked @xfail):")
    gaps = [
        "minValue guard not enforced           → test_approximation.py",
        "color cluster strategy (large delta)  → test_approximation.py",
        "font-weight keyword snapping          → test_approximation.py",
        "background:gradient extraction        → test_edge_cases.py",
        "em→rem warning emission               → test_normalisation.py",
    ]
    for g in gaps:
        print(f"  {g}")


if __name__ == "__main__":
    main()
