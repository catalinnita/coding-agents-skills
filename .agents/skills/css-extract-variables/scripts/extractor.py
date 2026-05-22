# /// script
# requires-python = ">=3.10"
# dependencies = ["colormath"]
# ///
"""
CSS variable extractor — modes: scan | extract | write-variables | replace
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------

DEFAULTS: dict[str, Any] = {
    "target": ".",
    "output": "auto",
    "prefix": "--",
    "threshold": 2,
    "dryRun": False,
    "types": ["colors", "spacing", "typography", "radii", "shadows", "z-index", "transitions"],
    "exclude": ["node_modules", "dist", "build", ".git"],
    "extensions": [".css", ".scss", ".sass", ".less", ".module.css", ".module.scss"],
    "scss": False,
}

# ---------------------------------------------------------------------------
# Config helpers
# ---------------------------------------------------------------------------

def load_config(path: str | None) -> dict[str, Any]:
    cfg = dict(DEFAULTS)
    if path:
        with open(path) as f:
            user = json.load(f)
        cfg.update(user)
    return cfg


def cfg_prefix(cfg: dict) -> str:
    p = cfg.get("prefix", "--")
    if not p.startswith("--"):
        p = "--" + p.lstrip("-")
    return p


# ---------------------------------------------------------------------------
# File discovery
# ---------------------------------------------------------------------------

def discover_files(cfg: dict) -> list[Path]:
    target = Path(cfg["target"])
    extensions = set(cfg["extensions"])
    exclude = set(cfg["exclude"])
    files: list[Path] = []
    for root, dirs, filenames in os.walk(target):
        dirs[:] = [d for d in dirs if d not in exclude and not d.startswith(".")]
        for fn in filenames:
            p = Path(root) / fn
            if any(fn.endswith(ext) for ext in extensions):
                files.append(p)
    return sorted(files)


# ---------------------------------------------------------------------------
# Color utilities
# ---------------------------------------------------------------------------

HEX_RE = re.compile(r"#([0-9a-fA-F]{3,8})\b")
RGB_RE = re.compile(r"rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+(?:\s*,\s*[\d.]+)?\s*\)")
HSL_RE = re.compile(r"hsla?\(\s*[\d.]+\s*,\s*[\d.%]+\s*,\s*[\d.%]+(?:\s*,\s*[\d.]+)?\s*\)")

CSS_NAMED_COLORS = {
    "black": "#000000", "white": "#ffffff", "red": "#ff0000",
    "green": "#008000", "blue": "#0000ff", "yellow": "#ffff00",
    "cyan": "#00ffff", "magenta": "#ff00ff", "orange": "#ffa500",
    "purple": "#800080", "pink": "#ffc0cb", "gray": "#808080",
    "grey": "#808080", "navy": "#000080", "teal": "#008080",
    "maroon": "#800000", "lime": "#00ff00", "aqua": "#00ffff",
    "fuchsia": "#ff00ff", "silver": "#c0c0c0",
}

COLOR_SKIP_DEFAULT = {"currentColor", "inherit", "transparent"}


def hex_to_rgb(h: str) -> tuple[int, int, int, float]:
    h = h.lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    if len(h) == 6:
        r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
        return r, g, b, 1.0
    if len(h) == 8:
        r, g, b, a = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), int(h[6:8], 16) / 255
        return r, g, b, a
    raise ValueError(f"Unknown hex: {h}")


def rgb_to_hsl(r: int, g: int, b: int) -> tuple[float, float, float]:
    r_, g_, b_ = r / 255, g / 255, b / 255
    cmax, cmin = max(r_, g_, b_), min(r_, g_, b_)
    delta = cmax - cmin
    l = (cmax + cmin) / 2
    s = 0.0 if delta == 0 else delta / (1 - abs(2 * l - 1))
    if delta == 0:
        h = 0.0
    elif cmax == r_:
        h = 60 * (((g_ - b_) / delta) % 6)
    elif cmax == g_:
        h = 60 * ((b_ - r_) / delta + 2)
    else:
        h = 60 * ((r_ - g_) / delta + 4)
    return round(h, 2), round(s * 100, 2), round(l * 100, 2)


def parse_color_to_rgba(raw: str) -> tuple[int, int, int, float] | None:
    raw = raw.strip()
    lower = raw.lower()
    if lower in COLOR_SKIP_DEFAULT:
        return None
    if lower in CSS_NAMED_COLORS:
        return hex_to_rgb(CSS_NAMED_COLORS[lower])
    if raw.startswith("#"):
        try:
            return hex_to_rgb(raw)
        except ValueError:
            return None
    m = re.match(r"rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)", raw)
    if m:
        r, g, b = int(float(m.group(1))), int(float(m.group(2))), int(float(m.group(3)))
        a = float(m.group(4)) if m.group(4) else 1.0
        return r, g, b, a
    # Handle both legacy comma syntax hsl(H, S%, L%) and modern space syntax hsl(H S% L% / A)
    m = re.match(
        r"hsla?\(\s*([\d.]+)\s*[,\s]\s*([\d.]+)%\s*[,\s]\s*([\d.]+)%"
        r"(?:\s*[/,]\s*([\d.]+))?\s*\)",
        raw,
    )
    if m:
        h, s, l = float(m.group(1)), float(m.group(2)) / 100, float(m.group(3)) / 100
        a = float(m.group(4)) if m.group(4) else 1.0
        c = (1 - abs(2 * l - 1)) * s
        x = c * (1 - abs((h / 60) % 2 - 1))
        m2 = l - c / 2
        if h < 60:   r2, g2, b2 = c, x, 0
        elif h < 120: r2, g2, b2 = x, c, 0
        elif h < 180: r2, g2, b2 = 0, c, x
        elif h < 240: r2, g2, b2 = 0, x, c
        elif h < 300: r2, g2, b2 = x, 0, c
        else:          r2, g2, b2 = c, 0, x
        return round((r2 + m2) * 255), round((g2 + m2) * 255), round((b2 + m2) * 255), a
    return None


def rgba_to_target(r: int, g: int, b: int, a: float, fmt: str, precision: int = 2) -> str:
    if fmt == "hex":
        if a < 1.0:
            return f"rgba({r}, {g}, {b}, {round(a, precision)})"
        return f"#{r:02x}{g:02x}{b:02x}"
    if fmt == "rgb":
        if a < 1.0:
            return f"rgba({r}, {g}, {b}, {round(a, precision)})"
        return f"rgb({r}, {g}, {b})"
    if fmt == "hsl":
        h, s, l = rgb_to_hsl(r, g, b)
        if a < 1.0:
            return f"hsl({h} {s}% {l}% / {round(a, precision)})"
        return f"hsl({h} {s}% {l}%)"
    if fmt == "oklch":
        # Simplified oklch approximation via linear-light sRGB
        def to_linear(c: int) -> float:
            v = c / 255
            return v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4
        rl, gl, bl = to_linear(r), to_linear(g), to_linear(b)
        ll = 0.4122214708 * rl + 0.5363325363 * gl + 0.0514459929 * bl
        mm = 0.2119034982 * rl + 0.6806995451 * gl + 0.1073969566 * bl
        ss = 0.0883024619 * rl + 0.2817188376 * gl + 0.6299787005 * bl
        l_ = ll ** (1/3); m_ = mm ** (1/3); s_ = ss ** (1/3)
        L = round(0.2104542553 * l_ + 0.7936177850 * m_ - 0.0040720468 * s_, precision)
        a_ = round(1.9779984951 * l_ - 2.4285922050 * m_ + 0.4505937099 * s_, precision)
        b_ = round(0.0259040371 * l_ + 0.7827717662 * m_ - 0.8086757660 * s_, precision)
        C = round(math.sqrt(a_ ** 2 + b_ ** 2), precision)
        H = round(math.degrees(math.atan2(b_, a_)) % 360, precision)
        if a < 1.0:
            return f"oklch({L} {C} {H} / {round(a, precision)})"
        return f"oklch({L} {C} {H})"
    return f"rgb({r}, {g}, {b})"


def color_delta_e(r1: int, g1: int, b1: int, r2: int, g2: int, b2: int) -> float:
    """Simplified perceptual distance in Lab space (approximation of Delta-E 76)."""
    def to_xyz(r: int, g: int, b: int) -> tuple[float, float, float]:
        def gamma(c: int) -> float:
            v = c / 255
            return v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4
        rl, gl, bl = gamma(r), gamma(g), gamma(b)
        x = rl * 0.4124 + gl * 0.3576 + bl * 0.1805
        y = rl * 0.2126 + gl * 0.7152 + bl * 0.0722
        z = rl * 0.0193 + gl * 0.1192 + bl * 0.9505
        return x, y, z

    def xyz_to_lab(x: float, y: float, z: float) -> tuple[float, float, float]:
        def f(t: float) -> float:
            return t ** (1/3) if t > 0.008856 else 7.787 * t + 16 / 116
        fx, fy, fz = f(x / 0.95047), f(y / 1.00000), f(z / 1.08883)
        L = 116 * fy - 16
        a = 500 * (fx - fy)
        b = 200 * (fy - fz)
        return L, a, b

    L1, a1, b1_ = xyz_to_lab(*to_xyz(r1, g1, b1))
    L2, a2, b2_ = xyz_to_lab(*to_xyz(r2, g2, b2))
    return math.sqrt((L1 - L2) ** 2 + (a1 - a2) ** 2 + (b1_ - b2_) ** 2)


# ---------------------------------------------------------------------------
# Numeric value utilities
# ---------------------------------------------------------------------------

UNIT_RE = re.compile(r"^([\d.]+)(px|rem|em|%|vh|vw|ch|ex|ms|s)$")
UNITLESS_RE = re.compile(r"^\d+(\.\d+)?$")


def parse_numeric(raw: str) -> tuple[float, str] | None:
    m = UNIT_RE.match(raw.strip())
    if m:
        return float(m.group(1)), m.group(2)
    return None


def to_target_unit(value: float, unit: str, target: str, base: float = 16) -> tuple[float, str]:
    if unit == target:
        return value, unit
    if unit == "px" and target == "rem":
        return value / base, "rem"
    if unit == "rem" and target == "px":
        return value * base, "px"
    if unit == "px" and target == "em":
        return value / base, "em"
    if unit == "em" and target == "rem":
        return value, "rem"
    if unit == "ms" and target == "s":
        return round(value / 1000, 4), "s"
    if unit == "s" and target == "ms":
        return round(value * 1000, 2), "ms"
    return value, unit


def _fmt_number(v: float) -> str:
    """Format a float, stripping unnecessary trailing zeros and decimal point."""
    s = f"{v:.10f}".rstrip("0").rstrip(".")
    return s if s else "0"


def snap_to_grid(value: float, step: float, mode: str = "round") -> float:
    if mode == "floor":
        return math.floor(value / step) * step
    if mode == "ceil":
        return math.ceil(value / step) * step
    return round(value / step) * step


def snap_to_scale(value: float, scale: list[float]) -> float:
    return min(scale, key=lambda s: abs(s - value))


def modular_scale(base: float, ratio: float, steps: int = 12) -> list[float]:
    scale = []
    for i in range(-steps, steps + 1):
        scale.append(round(base * (ratio ** i), 4))
    return sorted(set(scale))


# ---------------------------------------------------------------------------
# CSS parsing — extract raw values with positions
# ---------------------------------------------------------------------------

COMMENT_RE = re.compile(r"/\*.*?\*/", re.DOTALL)
VAR_REF_RE = re.compile(r"var\(--[^)]+\)")

SPACING_PROPS = {"margin", "padding", "gap", "width", "height", "top", "right", "bottom", "left", "inset",
                 "margin-top", "margin-right", "margin-bottom", "margin-left",
                 "padding-top", "padding-right", "padding-bottom", "padding-left"}
TYPOGRAPHY_PROPS = {"font-size", "font-weight", "font-family", "line-height", "letter-spacing"}
RADIUS_PROPS = {"border-radius", "border-top-left-radius", "border-top-right-radius",
                "border-bottom-left-radius", "border-bottom-right-radius"}
SHADOW_PROPS = {"box-shadow", "text-shadow"}
Z_PROPS = {"z-index"}
TRANSITION_PROPS = {"transition-duration", "animation-duration", "transition-timing-function",
                    "transition", "animation"}

FONT_WEIGHT_KEYWORDS = {"100", "200", "300", "400", "500", "600", "700", "800", "900",
                        "bold", "bolder", "lighter", "normal"}


@dataclass
class RawOccurrence:
    file: Path
    line: int
    prop: str
    original: str
    value_type: str


def strip_comments(text: str) -> tuple[str, set[int]]:
    """Return text with comments blanked out and set of line numbers that are comment-only."""
    comment_lines: set[int] = set()
    def blank(m: re.Match) -> str:
        span = m.group(0)
        lines_in_comment = span.count("\n")
        start_line = text[:m.start()].count("\n") + 1
        for i in range(lines_in_comment + 1):
            comment_lines.add(start_line + i)
        return " " * len(span)
    cleaned = COMMENT_RE.sub(blank, text)
    return cleaned, comment_lines


def parse_file(path: Path, types: list[str]) -> list[RawOccurrence]:
    text = path.read_text(encoding="utf-8", errors="replace")
    cleaned, comment_lines = strip_comments(text)
    occurrences: list[RawOccurrence] = []

    # Match CSS declarations: property: value;
    decl_re = re.compile(
        r"([\w-]+)\s*:\s*([^;{}]+?)(?=\s*[;{}])",
        re.MULTILINE,
    )

    for m in decl_re.finditer(cleaned):
        prop = m.group(1).strip().lower()
        raw_value = m.group(2).strip()
        line_no = cleaned[:m.start()].count("\n") + 1

        if line_no in comment_lines:
            continue
        if VAR_REF_RE.search(raw_value):
            continue

        def add(vtype: str, token: str) -> None:
            occurrences.append(RawOccurrence(path, line_no, prop, token.strip(), vtype))

        # Colors
        if "colors" in types:
            for token in _extract_color_tokens(raw_value):
                add("colors", token)

        # Spacing
        if "spacing" in types and prop in SPACING_PROPS:
            for token in _extract_length_tokens(raw_value):
                add("spacing", token)

        # Typography
        if "typography" in types and prop in TYPOGRAPHY_PROPS:
            if prop == "font-family":
                add("typography_family", raw_value)
            elif prop == "font-weight" and raw_value in FONT_WEIGHT_KEYWORDS:
                add("typography_weight", raw_value)
            elif prop in {"font-size", "line-height", "letter-spacing"}:
                for token in _extract_length_tokens(raw_value, allow_unitless=(prop == "line-height")):
                    add(f"typography_{prop.replace('-', '_')}", token)

        # Radii
        if "radii" in types and prop in RADIUS_PROPS:
            for token in _extract_length_tokens(raw_value):
                add("radii", token)

        # Shadows
        if "shadows" in types and prop in SHADOW_PROPS:
            if raw_value and raw_value != "none":
                add("shadows", raw_value)

        # Z-index
        if "z-index" in types and prop in Z_PROPS:
            if UNITLESS_RE.match(raw_value):
                add("z_index", raw_value)

        # Transitions
        if "transitions" in types and prop in TRANSITION_PROPS:
            if prop == "transition-timing-function":
                add("transitions_easing", raw_value)
            else:
                for token in _extract_time_tokens(raw_value):
                    add("transitions_duration", token)

    return occurrences


def _extract_color_tokens(value: str) -> list[str]:
    tokens: list[str] = []
    for m in HEX_RE.finditer(value):
        tokens.append(m.group(0))
    for m in RGB_RE.finditer(value):
        tokens.append(m.group(0))
    for m in HSL_RE.finditer(value):
        tokens.append(m.group(0))
    # Named colors
    for word in re.findall(r"\b[a-zA-Z]+\b", value):
        if word.lower() in CSS_NAMED_COLORS:
            tokens.append(word)
    return tokens


def _extract_length_tokens(value: str, allow_unitless: bool = False) -> list[str]:
    tokens: list[str] = []
    for token in re.split(r"\s+", value):
        token = token.strip().rstrip(";,")
        if UNIT_RE.match(token):
            tokens.append(token)
        elif allow_unitless and UNITLESS_RE.match(token):
            tokens.append(token)
    return tokens


def _extract_time_tokens(value: str) -> list[str]:
    return re.findall(r"\d+(?:\.\d+)?(?:ms|s)\b", value)


# ---------------------------------------------------------------------------
# Normalization
# ---------------------------------------------------------------------------

def normalize_color(raw: str, cfg_norm: dict) -> str | None:
    rgba = parse_color_to_rgba(raw)
    if rgba is None:
        return None
    r, g, b, a = rgba
    fmt = cfg_norm.get("targetFormat", "hsl")
    precision = cfg_norm.get("precision", 2)
    return rgba_to_target(r, g, b, a, fmt, precision)


def normalize_length(raw: str, cfg_norm: dict, base: float = 16) -> str | None:
    parsed = parse_numeric(raw)
    if parsed is None:
        return raw
    value, unit = parsed
    skip = set(cfg_norm.get("skipUnits", ["%", "vh", "vw", "ch", "ex"]))
    if unit in skip:
        return raw
    target = cfg_norm.get("targetUnit", "rem")
    new_val, new_unit = to_target_unit(value, unit, target, base)
    return f"{round(new_val, 4)}{new_unit}"


def normalize_duration(raw: str, cfg_norm: dict) -> str:
    parsed = parse_numeric(raw)
    if parsed is None:
        return raw
    value, unit = parsed
    target = cfg_norm.get("targetUnit", "ms")
    new_val, new_unit = to_target_unit(value, unit, target)
    return f"{_fmt_number(new_val)}{new_unit}"


# ---------------------------------------------------------------------------
# Approximation
# ---------------------------------------------------------------------------

def approximate_lengths(
    values: list[str],
    cfg_approx: dict,
    max_vars: int | None,
    max_iters: int = 5,
) -> dict[str, str]:
    """Return mapping original_normalized_value → snapped_value."""
    mode = cfg_approx.get("mode", "grid")
    unit = cfg_approx.get("unit", "rem")
    step = float(cfg_approx.get("step", 4))
    rounding_mode = cfg_approx.get("roundingMode", "round")
    min_val = cfg_approx.get("minValue")
    max_val = cfg_approx.get("maxValue")
    custom_scale = cfg_approx.get("customScale")
    round_dp = cfg_approx.get("roundDecimalPlaces", 4)

    if mode == "scale" and cfg_approx.get("scaleBase"):
        custom_scale = modular_scale(
            float(cfg_approx["scaleBase"]),
            float(cfg_approx.get("scaleRatio", 1.25)),
        )

    mapping: dict[str, str] = {}

    for iteration in range(max_iters + 1):
        mapping = {}
        current_step = step * (2 ** iteration)
        for raw in values:
            parsed = parse_numeric(raw)
            if parsed is None:
                mapping[raw] = raw
                continue
            value, u = parsed
            if min_val is not None and value < float(min_val):
                mapping[raw] = raw
                continue
            if max_val is not None and value > float(max_val):
                mapping[raw] = raw
                continue
            if custom_scale:
                snapped = snap_to_scale(value, [float(s) for s in custom_scale])
            else:
                snapped = snap_to_grid(value, current_step, rounding_mode)
            snapped = round(snapped, round_dp)
            mapping[raw] = f"{_fmt_number(snapped)}{u}"

        distinct = len(set(mapping.values()))
        if max_vars is None or distinct <= max_vars:
            break
        if iteration == max_iters:
            print(
                f"  Warning: could not reach maxVariables={max_vars} after {max_iters} iterations "
                f"(result: {distinct} variables)",
                file=sys.stderr,
            )

    return mapping


def approximate_colors(
    rgba_values: list[tuple[int, int, int, float]],
    cfg_approx: dict,
    max_vars: int | None,
    max_iters: int = 5,
) -> dict[tuple, tuple]:
    """Return mapping (r,g,b,a) → (r,g,b,a) after cluster merging."""
    tolerance = float(cfg_approx.get("tolerance", 4))
    alpha_tol = float(cfg_approx.get("alphaTolerance", 0.05))
    strategy = cfg_approx.get("strategy", "nearest")
    mapping: dict[tuple, tuple] = {v: v for v in rgba_values}

    for iteration in range(max_iters + 1):
        current_tol = tolerance * (2 ** iteration)
        clusters: list[list[tuple]] = []
        for rgba in rgba_values:
            placed = False
            for cluster in clusters:
                rep = cluster[0]
                if abs(rgba[3] - rep[3]) <= alpha_tol:
                    if color_delta_e(rgba[0], rgba[1], rgba[2], rep[0], rep[1], rep[2]) <= current_tol:
                        cluster.append(rgba)
                        placed = True
                        break
            if not placed:
                clusters.append([rgba])

        new_mapping: dict[tuple, tuple] = {}
        for cluster in clusters:
            if strategy == "centroid" and len(cluster) > 1:
                r = round(sum(c[0] for c in cluster) / len(cluster))
                g = round(sum(c[1] for c in cluster) / len(cluster))
                b = round(sum(c[2] for c in cluster) / len(cluster))
                a = round(sum(c[3] for c in cluster) / len(cluster), 4)
                rep = (r, g, b, a)
            else:
                rep = cluster[0]
            for item in cluster:
                new_mapping[item] = rep

        mapping = new_mapping
        distinct = len(set(mapping.values()))
        if max_vars is None or distinct <= max_vars:
            break
        if iteration == max_iters:
            print(
                f"  Warning: color maxVariables={max_vars} unreachable after {max_iters} iterations "
                f"(result: {distinct})",
                file=sys.stderr,
            )

    return mapping


# ---------------------------------------------------------------------------
# Naming
# ---------------------------------------------------------------------------

def slugify(value: str) -> str:
    s = value.lower()
    s = re.sub(r"[^a-z0-9]+", "-", s)
    return s.strip("-")


def make_variable_name(prefix: str, vtype: str, value: str, naming: dict, taken: set[str]) -> str:
    templates = {
        "colors": "{prefix}-color-{slug}",
        "spacing": "{prefix}-spacing-{value}",
        "typography_font_size": "{prefix}-font-size-{value}",
        "typography_font_weight": "{prefix}-font-weight-{value}",
        "typography_family": "{prefix}-font-family-{slug}",
        "typography_line_height": "{prefix}-line-height-{value}",
        "typography_letter_spacing": "{prefix}-letter-spacing-{value}",
        "radii": "{prefix}-radius-{value}",
        "shadows": "{prefix}-shadow-{slug}",
        "z_index": "{prefix}-z-{value}",
        "transitions_duration": "{prefix}-duration-{value}",
        "transitions_easing": "{prefix}-easing-{slug}",
    }
    template = naming.get(vtype, templates.get(vtype, "{prefix}-{slug}"))
    slug = slugify(value)
    safe_val = re.sub(r"[^a-z0-9.-]", "-", value.lower()).strip("-")
    name = template.format(prefix=prefix.rstrip("-"), slug=slug, value=safe_val)
    # Remove double dashes caused by empty segments
    name = re.sub(r"-{2,}", "--", name)
    if not name.startswith("--"):
        name = "--" + name.lstrip("-")

    if name not in taken:
        return name
    counter = 2
    while f"{name}-{counter}" in taken:
        counter += 1
    return f"{name}-{counter}"


# ---------------------------------------------------------------------------
# Extraction plan
# ---------------------------------------------------------------------------

@dataclass
class Variable:
    name: str
    value: str
    vtype: str
    occurrences: list[RawOccurrence] = field(default_factory=list)


def build_plan(
    occurrences: list[RawOccurrence],
    cfg: dict,
) -> dict[str, Any]:
    threshold: int = cfg.get("threshold", 2)
    prefix = cfg_prefix(cfg)
    naming: dict = cfg.get("naming", {})
    normalize_cfg: dict = cfg.get("normalize", {})
    approx_cfg: dict = cfg.get("approximate", {})
    max_iters: int = approx_cfg.get("maxIterations", 5)

    # Group by (vtype, original)
    groups: dict[tuple[str, str], list[RawOccurrence]] = defaultdict(list)
    for occ in occurrences:
        groups[(occ.value_type, occ.original)].append(occ)

    # Normalize
    normalized: dict[tuple[str, str], str] = {}
    for (vtype, original), occs in groups.items():
        norm_color_cfg = normalize_cfg.get("colors", {})
        norm_spacing_cfg = normalize_cfg.get("spacing", {})
        norm_typo_cfg = normalize_cfg.get("typography", {})
        norm_transition_cfg = normalize_cfg.get("transitions", {})
        base = float(norm_spacing_cfg.get("baseFontSize", 16))

        if vtype == "colors" and norm_color_cfg.get("enabled"):
            n = normalize_color(original, norm_color_cfg)
            normalized[(vtype, original)] = n if n else original
        elif vtype in ("spacing", "radii") and normalize_cfg.get(vtype, {}).get("enabled"):
            n = normalize_length(original, normalize_cfg.get(vtype, norm_spacing_cfg), base)
            normalized[(vtype, original)] = n or original
        elif vtype.startswith("typography_") and norm_typo_cfg:
            sub = vtype.replace("typography_", "").replace("_", "-")
            sub_cfg = norm_typo_cfg.get(sub, norm_typo_cfg.get("fontSize", {}))
            if sub_cfg.get("enabled"):
                n = normalize_length(original, sub_cfg, base)
                normalized[(vtype, original)] = n or original
            else:
                normalized[(vtype, original)] = original
        elif vtype == "transitions_duration" and normalize_cfg.get("transitions", {}).get("duration", {}).get("enabled"):
            n = normalize_duration(original, normalize_cfg["transitions"]["duration"])
            normalized[(vtype, original)] = n
        else:
            normalized[(vtype, original)] = original

    # Re-group by (vtype, normalized_value)
    norm_groups: dict[tuple[str, str], list[RawOccurrence]] = defaultdict(list)
    for (vtype, original), occs in groups.items():
        norm_val = normalized[(vtype, original)]
        norm_groups[(vtype, norm_val)].extend(occs)

    # Approximate colors
    color_norm_vals = list({v for (vt, v) in norm_groups if vt == "colors"})
    color_approx_map: dict[str, str] = {}
    if color_norm_vals and approx_cfg.get("colors", {}).get("enabled"):
        color_approx_cfg = approx_cfg["colors"]
        rgba_list = []
        raw_to_rgba: dict[str, tuple] = {}
        for cv in color_norm_vals:
            rgba = parse_color_to_rgba(cv)
            if rgba:
                rgba_list.append(rgba)
                raw_to_rgba[cv] = rgba
        rgba_map = approximate_colors(
            rgba_list,
            color_approx_cfg,
            color_approx_cfg.get("maxVariables"),
            max_iters,
        )
        fmt = normalize_cfg.get("colors", {}).get("targetFormat", "hsl")
        precision = normalize_cfg.get("colors", {}).get("precision", 2)
        for cv in color_norm_vals:
            rgba = raw_to_rgba.get(cv)
            if rgba:
                snapped = rgba_map[rgba]
                color_approx_map[cv] = rgba_to_target(*snapped, fmt, precision)
            else:
                color_approx_map[cv] = cv

    # Approximate numeric groups
    numeric_approx_maps: dict[str, dict[str, str]] = {}
    for group_key in ("spacing", "radii", "transitions_duration",
                      "typography_font_size", "typography_line_height", "typography_letter_spacing"):
        vtype_vals = list({v for (vt, v) in norm_groups if vt == group_key})
        if not vtype_vals:
            continue
        # Find the matching approx config
        if group_key == "spacing":
            a_cfg = approx_cfg.get("spacing", {})
        elif group_key == "radii":
            a_cfg = approx_cfg.get("radii", {})
        elif group_key == "transitions_duration":
            a_cfg = approx_cfg.get("transitions", {}).get("duration", {})
        elif group_key.startswith("typography_"):
            sub = group_key.replace("typography_", "").replace("_", "-")
            a_cfg = approx_cfg.get("typography", {}).get(sub, {})
        else:
            a_cfg = {}
        if a_cfg.get("enabled"):
            numeric_approx_maps[group_key] = approximate_lengths(
                vtype_vals, a_cfg, a_cfg.get("maxVariables"), max_iters
            )

    # Final grouping after approximation
    final_groups: dict[tuple[str, str], list[RawOccurrence]] = defaultdict(list)
    for (vtype, norm_val), occs in norm_groups.items():
        if vtype == "colors":
            final_val = color_approx_map.get(norm_val, norm_val)
        elif vtype in numeric_approx_maps:
            final_val = numeric_approx_maps[vtype].get(norm_val, norm_val)
        else:
            final_val = norm_val
        final_groups[(vtype, final_val)].extend(occs)

    # Apply threshold, build variables
    variables: list[dict] = []
    skipped: list[dict] = []
    warnings: list[str] = []
    taken_names: set[str] = set()

    for (vtype, final_val), occs in sorted(final_groups.items()):
        count = len(occs)
        if count < threshold:
            skipped.append({
                "value": final_val,
                "type": vtype,
                "occurrences": count,
                "source": f"{occs[0].file}:{occs[0].line}",
            })
            continue

        name = make_variable_name(prefix, vtype, final_val, naming, taken_names)
        taken_names.add(name)

        if "unnamed" in name:
            warnings.append(f"{final_val} → {name}  (could not auto-name; review suggested)")

        variables.append({
            "name": name,
            "value": final_val,
            "type": vtype,
            "occurrences": count,
            "sources": [
                {"file": str(o.file), "line": o.line, "original": o.original}
                for o in occs
            ],
        })

    return {"variables": variables, "skipped": skipped, "warnings": warnings}


# ---------------------------------------------------------------------------
# Write variable file
# ---------------------------------------------------------------------------

TYPE_ORDER = [
    "colors", "spacing", "radii", "shadows",
    "typography_font_size", "typography_font_weight", "typography_family",
    "typography_line_height", "typography_letter_spacing",
    "z_index", "transitions_duration", "transitions_easing",
]

TYPE_LABELS = {
    "colors": "Colors",
    "spacing": "Spacing",
    "radii": "Radii",
    "shadows": "Shadows",
    "typography_font_size": "Font Sizes",
    "typography_font_weight": "Font Weights",
    "typography_family": "Font Families",
    "typography_line_height": "Line Heights",
    "typography_letter_spacing": "Letter Spacing",
    "z_index": "Z-Index",
    "transitions_duration": "Durations",
    "transitions_easing": "Easings",
}


def write_variables_file(plan: dict, output_path: Path, cfg: dict) -> None:
    scss = cfg.get("scss", False)
    selector = cfg.get("output_file", {}).get("selector", ":root")
    group_by_type = cfg.get("output_file", {}).get("groupByType", True)
    merge_existing = cfg.get("output_file", {}).get("mergeExisting", True)

    existing_names: set[str] = set()
    existing_content = ""
    if merge_existing and output_path.exists():
        existing_content = output_path.read_text()
        existing_names = set(re.findall(r"--([\w-]+)\s*:", existing_content))

    by_type: dict[str, list[dict]] = defaultdict(list)
    for var in plan["variables"]:
        if var["name"].lstrip("-") in existing_names:
            continue
        by_type[var["type"]].append(var)

    lines: list[str] = []
    if not scss:
        lines.append(f"{selector} {{")

    for vtype in TYPE_ORDER:
        vars_in_type = by_type.get(vtype, [])
        if not vars_in_type:
            continue
        if group_by_type:
            label = TYPE_LABELS.get(vtype, vtype)
            lines.append(f"  /* {label} */" if not scss else f"/* {label} */")
        for var in vars_in_type:
            if scss:
                name = var["name"].lstrip("-")
                lines.append(f"${name}: {var['value']};")
            else:
                lines.append(f"  {var['name']}: {var['value']};")
        lines.append("")

    if not scss:
        lines.append("}")

    new_vars = [v for vlist in by_type.values() for v in vlist]
    if not new_vars:
        return

    new_block = "\n".join(lines)

    if merge_existing and existing_content:
        output_path.write_text(existing_content.rstrip() + "\n\n" + new_block + "\n")
    else:
        output_path.write_text(new_block + "\n")


# ---------------------------------------------------------------------------
# Replacement
# ---------------------------------------------------------------------------

def replace_in_files(plan: dict, cfg: dict) -> dict[str, int]:
    scss = cfg.get("scss", False)
    replacements_by_file: dict[str, int] = defaultdict(int)

    # Group sources by file, deduplicating by (original, var_name) per file
    file_replacements: dict[str, dict[str, str]] = defaultdict(dict)
    for var in plan["variables"]:
        for src in var["sources"]:
            key = src["original"]
            # First assignment wins (longest match already handled by sort below)
            if key not in file_replacements[src["file"]]:
                file_replacements[src["file"]][key] = var["name"]

    for filepath, orig_to_var in file_replacements.items():
        path = Path(filepath)
        if not path.exists():
            continue
        content = path.read_text(encoding="utf-8", errors="replace")
        # Process longest originals first to prevent substring clobbering
        pairs = sorted(orig_to_var.items(), key=lambda kv: len(kv[0]), reverse=True)
        new_content = content
        total = 0
        for original, var_name in pairs:
            replacement = f"${var_name.lstrip('-')}" if scss else f"var({var_name})"
            # Match original only as a CSS value token — not inside var(...) or variable names.
            # Lookbehind: must be preceded by : space ( or ,
            # Lookahead:  must be followed by ; ) , space or end-of-line
            # Negative lookbehind for -- prevents matching inside custom property names.
            escaped = re.escape(original)
            pattern = re.compile(
                r"(?<!--)(?<![a-zA-Z0-9-])" + escaped + r"(?![a-zA-Z0-9-])"
            )
            new_val, count = pattern.subn(replacement, new_content)
            if count:
                new_content = new_val
                total += count
        replacements_by_file[filepath] = total
        path.write_text(new_content, encoding="utf-8")

    return dict(replacements_by_file)


# ---------------------------------------------------------------------------
# Output file path heuristics
# ---------------------------------------------------------------------------

def resolve_output_path(cfg: dict, cwd: Path) -> Path:
    output = cfg.get("output", "auto")
    if output and output != "auto":
        return Path(output)
    candidates = [
        cwd / "src/styles/variables.css",
        cwd / "src/styles/tokens.css",
        cwd / "styles/variables.css",
    ]
    # Check for existing file with :root
    for c in candidates:
        if c.exists() and ":root" in c.read_text():
            return c
    return candidates[0]


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def cmd_scan(cfg: dict) -> None:
    files = discover_files(cfg)
    print(json.dumps([str(f) for f in files], indent=2))


def cmd_extract(cfg: dict, plan_path: str) -> None:
    files = discover_files(cfg)
    print(f"Scanning {len(files)} files...", file=sys.stderr)
    all_occs: list[RawOccurrence] = []
    for f in files:
        try:
            all_occs.extend(parse_file(f, cfg.get("types", DEFAULTS["types"])))
        except Exception as e:
            print(f"  Warning: could not parse {f}: {e}", file=sys.stderr)

    plan = build_plan(all_occs, cfg)
    with open(plan_path, "w") as fp:
        json.dump(plan, fp, indent=2)

    # Summary table
    by_type: dict[str, int] = defaultdict(int)
    for var in plan["variables"]:
        by_type[var["type"]] += 1
    print(f"\nExtracted {len(plan['variables'])} variables:", file=sys.stderr)
    for vtype, count in sorted(by_type.items()):
        label = TYPE_LABELS.get(vtype, vtype)
        print(f"  {label:<20} {count}", file=sys.stderr)
    if plan["skipped"]:
        print(f"\nSkipped (below threshold): {len(plan['skipped'])}", file=sys.stderr)
    if plan["warnings"]:
        print(f"\nWarnings:", file=sys.stderr)
        for w in plan["warnings"]:
            print(f"  {w}", file=sys.stderr)


def cmd_write_variables(cfg: dict, plan_path: str, variables_file: str | None) -> None:
    with open(plan_path) as fp:
        plan = json.load(fp)
    output_path = Path(variables_file) if variables_file else resolve_output_path(cfg, Path("."))
    output_path.parent.mkdir(parents=True, exist_ok=True)
    write_variables_file(plan, output_path, cfg)
    print(f"Written to: {output_path}", file=sys.stderr)


def cmd_replace(cfg: dict, plan_path: str) -> None:
    with open(plan_path) as fp:
        plan = json.load(fp)
    counts = replace_in_files(plan, cfg)
    total = sum(counts.values())
    print(f"\nModified {len(counts)} files ({total} replacements):", file=sys.stderr)
    for filepath, count in sorted(counts.items()):
        print(f"  {filepath}  ({count} replacements)", file=sys.stderr)


def main() -> None:
    parser = argparse.ArgumentParser(description="CSS variable extractor")
    parser.add_argument("--config", help="Path to config JSON file")
    parser.add_argument(
        "--mode",
        choices=["scan", "extract", "write-variables", "replace"],
        required=True,
    )
    parser.add_argument("--output-plan", default="extraction-plan.json")
    parser.add_argument("--plan", default="extraction-plan.json")
    parser.add_argument("--variables-file", default=None)
    args = parser.parse_args()

    cfg = load_config(args.config)

    if args.mode == "scan":
        cmd_scan(cfg)
    elif args.mode == "extract":
        cmd_extract(cfg, args.output_plan)
    elif args.mode == "write-variables":
        cmd_write_variables(cfg, args.plan, args.variables_file)
    elif args.mode == "replace":
        cmd_replace(cfg, args.plan)


if __name__ == "__main__":
    main()
