"""Subprocess mock for unit tests that do not need the real script."""
from unittest.mock import MagicMock
import subprocess

def make_result(stdout="", stderr="", returncode=0):
    r = MagicMock(spec=subprocess.CompletedProcess)
    r.stdout = stdout
    r.stderr = stderr
    r.returncode = returncode
    return r
