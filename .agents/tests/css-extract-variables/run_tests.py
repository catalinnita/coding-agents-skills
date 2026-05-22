#!/usr/bin/env python3
"""
Test runner for the css-extract-variables skill test suite.

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

CATEGORIES = {
    "happy-path":    HERE / "test_happy_path.py",
    "boundary":      HERE / "test_boundary.py",
    "edge-cases":    HERE / "test_edge_cases.py",
    "normalisation": HERE / "test_normalisation.py",
    "approximation": HERE / "test_approximation.py",
    "errors":        HERE / "test_errors.py",
    "dry-run":       HERE / "test_dry_run.py",
    "idempotency":   HERE / "test_idempotency.py",
}


def main() -> None:
    parser = argparse.ArgumentParser(description="Run css-extract-variables skill tests")
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
