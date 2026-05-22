#!/usr/bin/env python3
# /// script
# requires-python = ">=3.8"
# ///
"""
scaffold.py — Generate an agentskills.io-compatible skill folder.

Produces:
  <output-dir>/<name>/SKILL.md           Always created
  <output-dir>/<name>/scripts/template.py  Only with --with-script

Data goes to stdout as JSON. Diagnostics go to stderr.
Exit codes: 0 success, 1 validation error, 2 skill already exists, 3 write error.
"""
import argparse
import json
import os
import re
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# Templates
# ---------------------------------------------------------------------------

SKILL_MD_TEMPLATE = """\
---
name: {name}
description: >
  {description}
---

## Overview

{purpose}

## Steps

1. TODO: describe step 1

2. TODO: describe step 2

## Notes

- TODO: add gotchas, edge cases, or project-specific context
"""

SCRIPT_TEMPLATE = """\
#!/usr/bin/env python3
# /// script
# requires-python = ">=3.8"
# ///
\"\"\"
{name} — TODO: describe what this script does.

Usage:
  python3 scripts/template.py --input <value> [--dry-run]

Exit codes: 0 success, 1 error.
\"\"\"
import argparse
import json
import sys


def main() -> None:
    parser = argparse.ArgumentParser(
        description="TODO: describe this script",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\\n"
            "  python3 scripts/template.py --input hello\\n"
            "  python3 scripts/template.py --input hello --dry-run"
        ),
    )
    parser.add_argument("--input", required=True, help="TODO: describe input")
    parser.add_argument(
        "--dry-run", action="store_true", help="Preview without side effects"
    )
    args = parser.parse_args()

    # TODO: implement logic here

    result = {{"success": True, "input": args.input, "dry_run": args.dry_run}}
    json.dump(result, sys.stdout, indent=2)
    print()  # trailing newline after JSON


if __name__ == "__main__":
    main()
"""

# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

NAME_RE = re.compile(r"^[a-z0-9]([a-z0-9-]*[a-z0-9])?$")


def validate_name(name: str) -> str | None:
    """Return an error string, or None if valid."""
    if not name:
        return "name must not be empty"
    if len(name) > 64:
        return f"name exceeds 64 characters ({len(name)})"
    if not NAME_RE.match(name):
        return (
            "name must be lowercase alphanumeric + hyphens only, "
            "with no leading, trailing, or consecutive hyphens"
        )
    if "--" in name:
        return "name must not contain consecutive hyphens"
    return None


def validate_description(description: str) -> str | None:
    if not description.strip():
        return "description must not be empty"
    if len(description) > 1024:
        return f"description exceeds 1024 characters ({len(description)})"
    return None


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Scaffold an agentskills.io-compatible skill folder",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\n"
            "  python3 scripts/scaffold.py --name get-prices --description "
            '"Fetches stock prices. Use when..." --purpose "Retrieves live prices."\n'
            "  python3 scripts/scaffold.py --name get-prices --description "
            '"..." --purpose "..." --with-script --overwrite'
        ),
    )
    parser.add_argument("--name", required=True, help="Skill name (lowercase, hyphens only)")
    parser.add_argument("--description", required=True, help="What it does and when to use it (max 1024 chars)")
    parser.add_argument("--purpose", required=True, help="One-line summary for the body heading")
    parser.add_argument(
        "--output-dir",
        default=None,
        help="Parent directory for the new skill. Defaults to .agents/skills/ relative to cwd.",
    )
    parser.add_argument(
        "--with-script",
        action="store_true",
        help="Also generate scripts/template.py stub",
    )
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Replace an existing skill folder",
    )
    args = parser.parse_args()

    # --- Validate inputs ---
    name_err = validate_name(args.name)
    if name_err:
        print(f"Error: --name: {name_err}", file=sys.stderr)
        print(f"       Received: {args.name!r}", file=sys.stderr)
        sys.exit(1)

    desc_err = validate_description(args.description)
    if desc_err:
        print(f"Error: --description: {desc_err}", file=sys.stderr)
        sys.exit(1)

    # --- Resolve output directory ---
    if args.output_dir:
        base_dir = Path(args.output_dir)
    else:
        # Walk up from cwd looking for .agents/ or fall back to cwd/.agents/skills/
        cwd = Path.cwd()
        candidate = cwd / ".agents" / "skills"
        base_dir = candidate

    skill_dir = base_dir / args.name

    if skill_dir.exists() and not args.overwrite:
        print(
            f"Error: skill '{args.name}' already exists at {skill_dir}",
            file=sys.stderr,
        )
        print("       Pass --overwrite to replace it.", file=sys.stderr)
        sys.exit(2)

    # --- Create files ---
    created_files: list[str] = []

    try:
        skill_dir.mkdir(parents=True, exist_ok=True)

        # SKILL.md — wrap long description lines for YAML block scalar
        skill_md_path = skill_dir / "SKILL.md"
        skill_md_path.write_text(
            SKILL_MD_TEMPLATE.format(
                name=args.name,
                description=args.description,
                purpose=args.purpose,
            ),
            encoding="utf-8",
        )
        created_files.append(str(skill_md_path))
        print(f"Created {skill_md_path}", file=sys.stderr)

        if args.with_script:
            scripts_dir = skill_dir / "scripts"
            scripts_dir.mkdir(exist_ok=True)
            script_path = scripts_dir / "template.py"
            script_path.write_text(
                SCRIPT_TEMPLATE.format(name=args.name),
                encoding="utf-8",
            )
            script_path.chmod(0o755)
            created_files.append(str(script_path))
            print(f"Created {script_path}", file=sys.stderr)

    except OSError as exc:
        print(f"Error: failed to write files: {exc}", file=sys.stderr)
        sys.exit(3)

    # --- Output JSON result to stdout ---
    result = {
        "success": True,
        "skill_dir": str(skill_dir),
        "files": created_files,
    }
    json.dump(result, sys.stdout, indent=2)
    print()


if __name__ == "__main__":
    main()
