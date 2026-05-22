"""File system helpers for tests — write fixtures into tmp_path."""
from pathlib import Path

def write_css(tmp_path: Path, name: str, content: str) -> Path:
    p = tmp_path / name
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content)
    return p
