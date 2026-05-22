#!/usr/bin/env python3
# /// script
# requires-python = ">=3.8"
# ///
"""
accessibility — TODO: describe what this script does.

Usage:
  python3 scripts/template.py --input <value> [--dry-run]

Exit codes: 0 success, 1 error.
"""
import argparse
import json
import sys


def main() -> None:
    parser = argparse.ArgumentParser(
        description="TODO: describe this script",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "Examples:\n"
            "  python3 scripts/template.py --input hello\n"
            "  python3 scripts/template.py --input hello --dry-run"
        ),
    )
    parser.add_argument("--input", required=True, help="TODO: describe input")
    parser.add_argument(
        "--dry-run", action="store_true", help="Preview without side effects"
    )
    args = parser.parse_args()

    # TODO: implement logic here

    result = {"success": True, "input": args.input, "dry_run": args.dry_run}
    json.dump(result, sys.stdout, indent=2)
    print()  # trailing newline after JSON


if __name__ == "__main__":
    main()
