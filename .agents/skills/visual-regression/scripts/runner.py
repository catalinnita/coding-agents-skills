# /// script
# requires-python = ">=3.10"
# dependencies = ["playwright", "pillow", "numpy"]
# ///
"""
Visual regression runner — modes: preflight | plan | start-baseline |
start-candidate | capture | compare | report | teardown | run
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import textwrap
import time
import urllib.request
from dataclasses import dataclass, field, asdict
from html import escape
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# Constants / defaults
# ---------------------------------------------------------------------------

DEFAULT_VIEWPORTS = [
    {"label": "mobile",  "width": 375,  "height": 812},
    {"label": "tablet",  "width": 768,  "height": 1024},
    {"label": "desktop", "width": 1440, "height": 900},
]

DEFAULT_CONFIG: dict[str, Any] = {
    "base": "main",
    "threshold": 0.01,
    "viewports": DEFAULT_VIEWPORTS,
    "port": 3000,
    "basePort": 3001,
    "outputDir": ".visual-regression",
    "fullPage": True,
    "animations": "disable",
    "parallel": 4,
    "dryRun": False,
}

SERVER_READY_TIMEOUT = 120
SERVER_POLL_INTERVAL = 0.5

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

def load_config(path: str | None, project_dir: Path) -> dict[str, Any]:
    cfg = dict(DEFAULT_CONFIG)
    candidates = []
    if path:
        candidates = [Path(path)]
    else:
        candidates = [project_dir / ".visual-regression.config.json"]
    for c in candidates:
        if c.exists():
            with open(c) as f:
                cfg.update(json.load(f))
            break
    cfg["outputDir"] = str(project_dir / cfg["outputDir"])
    return cfg


def output_dir(cfg: dict) -> Path:
    return Path(cfg["outputDir"])

# ---------------------------------------------------------------------------
# Pre-flight
# ---------------------------------------------------------------------------

def is_port_free(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        return s.connect_ex(("localhost", port)) != 0


def find_free_port(start: int) -> int:
    p = start
    while not is_port_free(p):
        p += 1
    return p


def cmd_preflight(cfg: dict, project_dir: Path) -> None:
    errors: list[str] = []
    warnings: list[str] = []

    # Git repo
    r = subprocess.run(["git", "rev-parse", "--git-dir"], cwd=project_dir,
                       capture_output=True)
    if r.returncode != 0:
        errors.append("Not a git repository.")

    # Uncommitted changes
    r = subprocess.run(["git", "status", "--porcelain"], cwd=project_dir,
                       capture_output=True, text=True)
    if r.stdout.strip():
        warnings.append("Uncommitted changes detected. They will NOT be captured by the "
                        "worktree baseline — only committed code is compared.")

    # Base branch exists
    base = cfg.get("base", "main")
    r = subprocess.run(["git", "rev-parse", "--verify", base], cwd=project_dir,
                       capture_output=True)
    if r.returncode != 0:
        fallback = "master"
        r2 = subprocess.run(["git", "rev-parse", "--verify", fallback],
                             cwd=project_dir, capture_output=True)
        if r2.returncode == 0:
            cfg["base"] = fallback
            warnings.append(f"Branch '{base}' not found; falling back to '{fallback}'.")
        else:
            errors.append(f"Base branch '{base}' (and fallback 'master') not found.")

    # Ports
    port = find_free_port(cfg["port"])
    base_port = find_free_port(cfg["basePort"])
    if base_port == port:
        base_port = find_free_port(port + 1)
    if port != cfg["port"]:
        warnings.append(f"Port {cfg['port']} busy; using {port} for candidate.")
    if base_port != cfg["basePort"]:
        warnings.append(f"Port {cfg['basePort']} busy; using {base_port} for baseline.")
    cfg["port"] = port
    cfg["basePort"] = base_port

    # Playwright
    r = subprocess.run([sys.executable, "-m", "playwright", "--version"],
                       capture_output=True)
    if r.returncode != 0:
        warnings.append("Playwright not found; will install chromium automatically.")

    # Node
    if not shutil.which("node"):
        errors.append("node not found on PATH.")

    for w in warnings:
        print(f"  ⚠  {w}", file=sys.stderr)
    if errors:
        for e in errors:
            print(f"  ✗  {e}", file=sys.stderr)
        sys.exit(1)
    print("  ✓  Pre-flight OK", file=sys.stderr)


# ---------------------------------------------------------------------------
# Project detection
# ---------------------------------------------------------------------------

def detect_project(project_dir: Path) -> tuple[str | None, str | None]:
    """Returns (build_command, serve_command)."""
    pkg = project_dir / "package.json"
    if (project_dir / "next.config.js").exists() or (project_dir / "next.config.ts").exists() or \
       (project_dir / "next.config.mjs").exists():
        return "next build", "next start"
    if (project_dir / "vite.config.js").exists() or (project_dir / "vite.config.ts").exists():
        return "vite build", "vite preview"
    if (project_dir / "nuxt.config.js").exists() or (project_dir / "nuxt.config.ts").exists():
        return "nuxt build", "nuxt start"
    if (project_dir / "angular.json").exists():
        return "ng build", "ng serve"
    if pkg.exists():
        data = json.loads(pkg.read_text())
        scripts = data.get("scripts", {})
        deps = {**data.get("dependencies", {}), **data.get("devDependencies", {})}
        if "react-scripts" in deps:
            return "react-scripts build", "react-scripts start"
        build = scripts.get("build")
        serve = scripts.get("start") or scripts.get("dev") or scripts.get("serve")
        if build or serve:
            return build, serve
    if (project_dir / "index.html").exists():
        return None, "npx serve ."
    return None, None


def install_deps(project_dir: Path) -> None:
    if (project_dir / "package-lock.json").exists():
        subprocess.run(["npm", "ci"], cwd=project_dir, check=True)
    elif (project_dir / "yarn.lock").exists():
        subprocess.run(["yarn", "install", "--frozen-lockfile"], cwd=project_dir, check=True)
    elif (project_dir / "pnpm-lock.yaml").exists():
        subprocess.run(["pnpm", "install", "--frozen-lockfile"], cwd=project_dir, check=True)
    else:
        subprocess.run(["npm", "install"], cwd=project_dir, check=True)


# ---------------------------------------------------------------------------
# Route discovery
# ---------------------------------------------------------------------------

def _slug(route: str) -> str:
    s = route.strip("/").replace("/", "__") or "index"
    return re.sub(r"[^a-zA-Z0-9_-]", "_", s)


def discover_routes_from_framework(project_dir: Path) -> list[str]:
    routes: list[str] = []
    # Next.js pages/ or app/
    for pages_dir in [project_dir / "pages", project_dir / "app",
                      project_dir / "src" / "pages", project_dir / "src" / "app"]:
        if pages_dir.is_dir():
            for p in pages_dir.rglob("*.tsx"):
                rel = p.relative_to(pages_dir)
                route = "/" + "/".join(rel.parts[:-1] + (rel.stem,))
                route = re.sub(r"/index$", "", route) or "/"
                route = re.sub(r"/\[.*?\]", "", route)  # strip dynamic segments
                if route and "[" not in route:
                    routes.append(route)
            for p in pages_dir.rglob("*.jsx"):
                rel = p.relative_to(pages_dir)
                route = "/" + "/".join(rel.parts[:-1] + (rel.stem,))
                route = re.sub(r"/index$", "", route) or "/"
                if route and "[" not in route:
                    routes.append(route)
    return list(dict.fromkeys(routes))


def discover_routes_sitemap(base_url: str) -> list[str]:
    try:
        with urllib.request.urlopen(f"{base_url}/sitemap.xml", timeout=5) as r:
            body = r.read().decode()
        return re.findall(r"<loc>[^<]*?(/[^<]*?)</loc>", body)
    except Exception:
        return []


def discover_routes_crawl(base_url: str, max_depth: int = 3) -> list[str]:
    visited: set[str] = set()
    queue: list[tuple[str, int]] = [("/", 0)]
    while queue:
        path, depth = queue.pop(0)
        if path in visited or depth > max_depth:
            continue
        visited.add(path)
        try:
            with urllib.request.urlopen(f"{base_url}{path}", timeout=5) as r:
                body = r.read().decode(errors="replace")
            for href in re.findall(r'href=["\']([^"\']+)["\']', body):
                if href.startswith("/") and not href.startswith("//"):
                    frag = href.split("#")[0].split("?")[0]
                    if frag not in visited:
                        queue.append((frag, depth + 1))
        except Exception:
            pass
    return sorted(visited)


def cmd_plan(cfg: dict, project_dir: Path) -> None:
    od = output_dir(cfg)
    od.mkdir(parents=True, exist_ok=True)

    build_cmd, serve_cmd = detect_project(project_dir)
    if not cfg.get("buildCommand") and build_cmd:
        cfg["buildCommand"] = build_cmd
    if not cfg.get("serveCommand") and serve_cmd:
        cfg["serveCommand"] = serve_cmd
    if not cfg.get("serveCommand"):
        print("ERROR: could not detect serve command. Set serveCommand in config.",
              file=sys.stderr)
        sys.exit(1)

    routes = cfg.get("routes")
    if not routes:
        # Try framework routes first (doesn't need a running server)
        routes = discover_routes_from_framework(project_dir)
        if not routes:
            # Try sitemap from candidate server if it's already up
            base_url = f"http://localhost:{cfg['port']}"
            routes = discover_routes_sitemap(base_url)
        if not routes:
            base_url = f"http://localhost:{cfg['port']}"
            routes = discover_routes_crawl(base_url)
        if not routes:
            routes = ["/"]

    # Filter dynamic segments
    routes = [r for r in routes if not re.search(r"[:\[][^/]", r)]
    routes = list(dict.fromkeys(routes))[:50]

    viewports = cfg.get("viewports", DEFAULT_VIEWPORTS)
    plan = {
        "routes": routes,
        "viewports": viewports,
        "buildCommand": cfg.get("buildCommand"),
        "serveCommand": cfg.get("serveCommand"),
        "base": cfg.get("base", "main"),
        "port": cfg["port"],
        "basePort": cfg["basePort"],
        "totalComparisons": len(routes) * len(viewports),
    }
    (od / "plan.json").write_text(json.dumps(plan, indent=2))

    print(f"\nPlan written to {od / 'plan.json'}")
    print(f"  Routes:       {len(routes)}")
    print(f"  Viewports:    {len(viewports)}")
    print(f"  Comparisons:  {plan['totalComparisons']}")
    print(f"  Serve:        {cfg.get('serveCommand')}")
    print(f"  Build:        {cfg.get('buildCommand') or '(none)'}")


# ---------------------------------------------------------------------------
# Server management
# ---------------------------------------------------------------------------

def wait_for_server(port: int, timeout: int = SERVER_READY_TIMEOUT) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f"http://localhost:{port}/", timeout=2) as r:
                if r.status < 500:
                    return True
        except Exception:
            pass
        time.sleep(SERVER_POLL_INTERVAL)
    return False


def servers_file(cfg: dict) -> Path:
    return output_dir(cfg) / "servers.json"


def read_servers(cfg: dict) -> dict:
    sf = servers_file(cfg)
    if sf.exists():
        return json.loads(sf.read_text())
    return {}


def write_servers(cfg: dict, data: dict) -> None:
    servers_file(cfg).write_text(json.dumps(data, indent=2))


def start_server(cmd: str, port: int, cwd: Path, env_extra: dict | None = None) -> int:
    env = {**os.environ, "PORT": str(port), **(env_extra or {})}
    # Split command respecting quotes
    parts = cmd.split()
    # Use shell=True to support npm scripts, npx, etc.
    proc = subprocess.Popen(
        cmd,
        shell=True,
        cwd=str(cwd),
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
    )
    return proc.pid


def cmd_start_baseline(cfg: dict, project_dir: Path) -> None:
    od = output_dir(cfg)
    od.mkdir(parents=True, exist_ok=True)
    plan = json.loads((od / "plan.json").read_text())
    base = plan["base"]
    worktree_dir = od / "baseline"

    # Remove stale worktree
    subprocess.run(["git", "worktree", "remove", str(worktree_dir), "--force"],
                   cwd=project_dir, capture_output=True)
    worktree_dir.mkdir(parents=True, exist_ok=True)

    print(f"  Creating worktree for '{base}'...", file=sys.stderr)
    r = subprocess.run(["git", "worktree", "add", str(worktree_dir), base],
                       cwd=project_dir, capture_output=True, text=True)
    if r.returncode != 0:
        print(f"ERROR creating worktree: {r.stderr}", file=sys.stderr)
        sys.exit(1)

    print("  Installing baseline dependencies...", file=sys.stderr)
    install_deps(worktree_dir)

    build_cmd = plan.get("buildCommand")
    if build_cmd:
        print(f"  Building baseline: {build_cmd}", file=sys.stderr)
        subprocess.run(build_cmd, shell=True, cwd=str(worktree_dir), check=True)

    serve_cmd = plan["serveCommand"]
    base_port = plan["basePort"]
    print(f"  Starting baseline server on :{base_port}...", file=sys.stderr)
    pid = start_server(serve_cmd, base_port, worktree_dir)

    if not wait_for_server(base_port):
        print(f"ERROR: baseline server did not start within {SERVER_READY_TIMEOUT}s",
              file=sys.stderr)
        sys.exit(1)

    servers = read_servers(cfg)
    servers["baseline"] = {"pid": pid, "port": base_port}
    write_servers(cfg, servers)
    print(f"  ✓ Baseline server ready on :{base_port} (pid {pid})", file=sys.stderr)


def cmd_start_candidate(cfg: dict, project_dir: Path) -> None:
    od = output_dir(cfg)
    plan = json.loads((od / "plan.json").read_text())

    build_cmd = plan.get("buildCommand")
    if build_cmd:
        print(f"  Building candidate: {build_cmd}", file=sys.stderr)
        subprocess.run(build_cmd, shell=True, cwd=str(project_dir), check=True)

    serve_cmd = plan["serveCommand"]
    port = plan["port"]
    print(f"  Starting candidate server on :{port}...", file=sys.stderr)
    pid = start_server(serve_cmd, port, project_dir)

    if not wait_for_server(port):
        print(f"ERROR: candidate server did not start within {SERVER_READY_TIMEOUT}s",
              file=sys.stderr)
        sys.exit(1)

    servers = read_servers(cfg)
    servers["candidate"] = {"pid": pid, "port": port}
    write_servers(cfg, servers)
    print(f"  ✓ Candidate server ready on :{port} (pid {pid})", file=sys.stderr)


# ---------------------------------------------------------------------------
# Screenshot capture
# ---------------------------------------------------------------------------

DISABLE_ANIMATIONS_CSS = """
*, *::before, *::after {
  animation-duration: 0s !important;
  animation-delay: 0s !important;
  transition-duration: 0s !important;
  transition-delay: 0s !important;
}
"""


def _screenshot_one(
    url: str,
    out_path: Path,
    viewport: dict,
    cfg: dict,
    page: Any,
) -> str:
    """Capture one screenshot. Returns 'ok' or error message."""
    try:
        page.set_viewport_size({"width": viewport["width"], "height": viewport["height"]})
        page.goto(url, wait_until="networkidle", timeout=30_000)
        page.evaluate("() => document.fonts.ready")

        if cfg.get("animations", "disable") == "disable":
            page.add_style_tag(content=DISABLE_ANIMATIONS_CSS)

        wait_for = cfg.get("waitFor")
        if wait_for:
            if isinstance(wait_for, str):
                page.wait_for_selector(wait_for, timeout=10_000)
            elif isinstance(wait_for, (int, float)):
                page.wait_for_timeout(int(wait_for))

        # Apply ignore masks
        for rule in cfg.get("ignore", []):
            selector = rule if isinstance(rule, str) else rule.get("selector")
            route_filter = rule.get("route") if isinstance(rule, dict) else None
            if selector and (not route_filter or
                             url.endswith(route_filter)):
                try:
                    page.evaluate(f"""
                        document.querySelectorAll({json.dumps(selector)}).forEach(el => {{
                            el.style.visibility = 'hidden';
                        }});
                    """)
                except Exception:
                    pass

        # Scroll to bottom to trigger lazy loads, then back
        page.evaluate("window.scrollTo(0, document.body.scrollHeight)")
        page.wait_for_timeout(300)
        page.evaluate("window.scrollTo(0, 0)")
        page.wait_for_timeout(100)

        out_path.parent.mkdir(parents=True, exist_ok=True)
        page.screenshot(
            path=str(out_path),
            full_page=cfg.get("fullPage", True),
        )
        return "ok"
    except Exception as e:
        return str(e)


def _apply_auth(page: Any, cfg: dict, base_url: str) -> None:
    auth = cfg.get("auth")
    if not auth:
        return
    atype = auth.get("type", "cookie")
    if atype == "cookie":
        context = page.context
        context.add_cookies(auth.get("cookies", []))
    elif atype == "bearer":
        page.set_extra_http_headers({"Authorization": f"Bearer {auth['token']}"})
    elif atype == "login-form":
        page.goto(f"{base_url}{auth['loginRoute']}", wait_until="networkidle")
        page.fill(auth["usernameSelector"], auth["username"])
        page.fill(auth["passwordSelector"], auth["password"])
        page.click(auth["submitSelector"])
        page.wait_for_selector(auth["successSelector"], timeout=10_000)


def cmd_capture(cfg: dict, project_dir: Path) -> None:
    from playwright.sync_api import sync_playwright

    od = output_dir(cfg)
    plan = json.loads((od / "plan.json").read_text())
    servers = read_servers(cfg)

    candidate_port = servers.get("candidate", {}).get("port", plan["port"])
    baseline_port = servers.get("baseline", {}).get("port", plan["basePort"])

    results: list[dict] = []
    total = len(plan["routes"]) * len(plan["viewports"])
    done = 0

    with sync_playwright() as p:
        browser = p.chromium.launch(args=["--ignore-certificate-errors"])

        for vp in plan["viewports"]:
            context = browser.new_context(ignore_https_errors=True)
            cand_page = context.new_page()
            base_page = context.new_page()

            _apply_auth(cand_page, cfg, f"http://localhost:{candidate_port}")
            _apply_auth(base_page, cfg, f"http://localhost:{baseline_port}")

            for route in plan["routes"]:
                slug = _slug(route)
                cand_path = od / "candidate" / vp["label"] / f"{slug}.png"
                base_path = od / "baseline" / vp["label"] / f"{slug}.png"

                cand_url = f"http://localhost:{candidate_port}{route}"
                base_url = f"http://localhost:{baseline_port}{route}"

                for attempt in range(3):
                    cand_status = _screenshot_one(cand_url, cand_path, vp, cfg, cand_page)
                    base_status = _screenshot_one(base_url, base_path, vp, cfg, base_page)
                    if cand_status == "ok" and base_status == "ok":
                        break
                    time.sleep(0.5)

                done += 1
                status = "ok" if (cand_status == "ok" and base_status == "ok") else "error"
                error_msg = None if status == "ok" else f"candidate:{cand_status} baseline:{base_status}"
                results.append({
                    "route": route,
                    "viewport": vp["label"],
                    "slug": slug,
                    "status": status,
                    "error": error_msg,
                })
                icon = "✓" if status == "ok" else "✗"
                print(f"  [{done}/{total}] {icon} {vp['label']} {route}", file=sys.stderr)

            context.close()
        browser.close()

    (od / "captures.json").write_text(json.dumps(results, indent=2))
    ok = sum(1 for r in results if r["status"] == "ok")
    print(f"\n  Captured {ok}/{total} screenshots", file=sys.stderr)


# ---------------------------------------------------------------------------
# Image comparison
# ---------------------------------------------------------------------------

def _pixel_diff(img_a: Any, img_b: Any) -> tuple[float, Any]:
    """Returns (diff_ratio, diff_image). Uses numpy for speed."""
    import numpy as np
    from PIL import Image, ImageDraw

    # Resize to match dimensions
    if img_a.size != img_b.size:
        w = max(img_a.width, img_b.width)
        h = max(img_a.height, img_b.height)
        img_a = img_a.resize((w, h), Image.LANCZOS)
        img_b = img_b.resize((w, h), Image.LANCZOS)

    a = np.array(img_a.convert("RGBA"), dtype=np.float32)
    b = np.array(img_b.convert("RGBA"), dtype=np.float32)

    diff = np.abs(a - b)
    # A pixel is "different" if any channel differs by more than 10
    mask = np.any(diff > 10, axis=2)
    diff_pixels = int(mask.sum())
    total_pixels = mask.size
    diff_ratio = diff_pixels / total_pixels

    # Build diff image
    diff_img = np.array(img_a.convert("RGBA"))
    diff_img[mask] = [255, 0, 0, 180]  # red highlight
    diff_img[~mask] = (diff_img[~mask].astype(float) * 0.4).astype(np.uint8)

    from PIL import Image as PILImage
    return diff_ratio, PILImage.fromarray(diff_img.astype(np.uint8), "RGBA")


def _ssim(img_a: Any, img_b: Any) -> float:
    """Simplified SSIM on greyscale 800px-wide images."""
    import numpy as np
    from PIL import Image

    def _resize_to_width(img: Any, w: int) -> Any:
        ratio = w / img.width
        return img.resize((w, int(img.height * ratio)), Image.LANCZOS)

    w = min(800, img_a.width, img_b.width)
    a = np.array(_resize_to_width(img_a, w).convert("L"), dtype=np.float64)
    b = np.array(_resize_to_width(img_b, w).convert("L"), dtype=np.float64)

    if a.shape != b.shape:
        min_h = min(a.shape[0], b.shape[0])
        a, b = a[:min_h], b[:min_h]

    c1, c2 = 6.5025, 58.5225  # (0.01 * 255)^2, (0.03 * 255)^2
    mu_a, mu_b = a.mean(), b.mean()
    sigma_a = a.std()
    sigma_b = b.std()
    sigma_ab = float(((a - mu_a) * (b - mu_b)).mean())

    numerator = (2 * mu_a * mu_b + c1) * (2 * sigma_ab + c2)
    denominator = (mu_a**2 + mu_b**2 + c1) * (sigma_a**2 + sigma_b**2 + c2)
    return float(numerator / denominator) if denominator != 0 else 1.0


def _classify(diff_ratio: float, ssim: float, threshold: float) -> str:
    if diff_ratio <= threshold and ssim >= 0.99:
        return "pass"
    if diff_ratio <= threshold * 3 or ssim >= 0.97:
        return "warn"
    return "fail"


def cmd_compare(cfg: dict) -> None:
    from PIL import Image

    od = output_dir(cfg)
    captures = json.loads((od / "captures.json").read_text())
    threshold = cfg.get("threshold", 0.01)
    comparisons: list[dict] = []

    for cap in captures:
        if cap["status"] != "ok":
            comparisons.append({**cap, "result": "error",
                                 "diffRatio": None, "ssim": None})
            continue

        slug = cap["slug"]
        vp = cap["viewport"]
        cand_path = od / "candidate" / vp / f"{slug}.png"
        base_path = od / "baseline" / vp / f"{slug}.png"

        if not cand_path.exists() or not base_path.exists():
            comparisons.append({**cap, "result": "missing",
                                 "diffRatio": None, "ssim": None})
            continue

        img_c = Image.open(cand_path)
        img_b = Image.open(base_path)

        size_changed = img_c.size != img_b.size
        diff_ratio, diff_img = _pixel_diff(img_c, img_b)
        ssim_score = _ssim(img_c, img_b)

        result = _classify(diff_ratio, ssim_score, threshold)
        if size_changed and result == "pass":
            result = "warn"

        diff_path = od / "diff" / vp / f"{slug}.png"
        diff_path.parent.mkdir(parents=True, exist_ok=True)
        diff_img.save(str(diff_path))

        comparisons.append({
            **cap,
            "result": result,
            "diffRatio": round(diff_ratio, 6),
            "ssim": round(ssim_score, 6),
            "sizeChanged": size_changed,
            "candidateSize": list(img_c.size),
            "baselineSize": list(img_b.size),
        })

        icon = {"pass": "✓", "warn": "⚠", "fail": "✗"}.get(result, "?")
        print(f"  {icon} {vp:8} {cap['route']:40} "
              f"diff={diff_ratio*100:.3f}%  ssim={ssim_score:.4f}", file=sys.stderr)

    (od / "comparisons.json").write_text(json.dumps(comparisons, indent=2))
    counts = {"pass": 0, "warn": 0, "fail": 0, "error": 0}
    for c in comparisons:
        counts[c.get("result", "error")] = counts.get(c.get("result", "error"), 0) + 1
    print(f"\n  pass={counts['pass']}  warn={counts['warn']}  "
          f"fail={counts['fail']}  error={counts['error']}", file=sys.stderr)


# ---------------------------------------------------------------------------
# HTML report
# ---------------------------------------------------------------------------

def _img_b64(path: Path) -> str:
    if not path.exists():
        return ""
    return base64.b64encode(path.read_bytes()).decode()


def _badge(result: str) -> str:
    colours = {"pass": "#22c55e", "warn": "#f59e0b", "fail": "#ef4444", "error": "#6b7280"}
    icons = {"pass": "✅", "warn": "⚠️", "fail": "❌", "error": "💀"}
    c = colours.get(result, "#6b7280")
    i = icons.get(result, "?")
    return (f'<span style="background:{c};color:#fff;padding:2px 8px;'
            f'border-radius:4px;font-size:12px;font-weight:600">{i} {result}</span>')


def cmd_report(cfg: dict, project_dir: Path) -> None:
    od = output_dir(cfg)
    comparisons = json.loads((od / "comparisons.json").read_text())

    # Git info
    def git(args: list[str]) -> str:
        r = subprocess.run(["git"] + args, cwd=project_dir,
                           capture_output=True, text=True)
        return r.stdout.strip()

    branch = git(["rev-parse", "--abbrev-ref", "HEAD"])
    candidate_sha = git(["rev-parse", "--short", "HEAD"])
    base = cfg.get("base", "main")
    base_sha = git(["rev-parse", "--short", base])
    now = time.strftime("%Y-%m-%d %H:%M")

    counts = {"pass": 0, "warn": 0, "fail": 0, "error": 0}
    for c in comparisons:
        key = c.get("result", "error")
        counts[key] = counts.get(key, 0) + 1

    # Sort: fail first, then warn, then pass
    order = {"fail": 0, "warn": 1, "error": 2, "pass": 3}
    comparisons_sorted = sorted(comparisons, key=lambda x: order.get(x.get("result"), 9))

    rows_html = []
    for comp in comparisons_sorted:
        result = comp.get("result", "error")
        vp = comp.get("viewport", "")
        route = comp.get("route", "")
        slug = comp.get("slug", _slug(route))
        diff_ratio = comp.get("diffRatio")
        ssim_val = comp.get("ssim")
        expanded = "open" if result in ("fail", "warn") else ""

        diff_str = f"{diff_ratio*100:.3f}%" if diff_ratio is not None else "—"
        ssim_str = f"{ssim_val:.4f}" if ssim_val is not None else "—"

        cand_b64 = _img_b64(od / "candidate" / vp / f"{slug}.png")
        base_b64 = _img_b64(od / "baseline" / vp / f"{slug}.png")
        diff_b64 = _img_b64(od / "diff" / vp / f"{slug}.png")

        def img_tag(b64: str, label: str) -> str:
            if not b64:
                return f'<div style="color:#999;font-size:12px">{label}<br>(missing)</div>'
            return (f'<figure style="margin:0;text-align:center">'
                    f'<div style="font-size:11px;color:#666;margin-bottom:4px">{label}</div>'
                    f'<a href="data:image/png;base64,{b64}" target="_blank">'
                    f'<img src="data:image/png;base64,{b64}" '
                    f'style="max-width:320px;border:1px solid #ddd;border-radius:4px" /></a>'
                    f'</figure>')

        images_html = (
            f'<div style="display:flex;gap:16px;flex-wrap:wrap;padding:12px 0">'
            f'{img_tag(base_b64, "Baseline (main)")}'
            f'{img_tag(cand_b64, "Candidate (branch)")}'
            f'{img_tag(diff_b64, "Diff")}'
            f'</div>'
        )

        size_note = ""
        if comp.get("sizeChanged"):
            size_note = (f' <span style="font-size:11px;color:#f59e0b">'
                         f'size: {comp["baselineSize"]} → {comp["candidateSize"]}</span>')

        rows_html.append(f"""
        <details {expanded} style="border:1px solid #e5e7eb;border-radius:6px;margin-bottom:8px">
          <summary style="padding:10px 14px;cursor:pointer;display:flex;
                          align-items:center;gap:12px;list-style:none;background:#fafafa;
                          border-radius:6px">
            {_badge(result)}
            <code style="font-size:13px">{escape(route)}</code>
            <span style="color:#6b7280;font-size:12px">{escape(vp)}</span>
            <span style="margin-left:auto;font-size:12px;color:#6b7280">
              diff {diff_str} &nbsp; ssim {ssim_str}
            </span>
            {size_note}
          </summary>
          <div style="padding:0 14px 14px">{images_html}</div>
        </details>""")

    html = textwrap.dedent(f"""\
    <!DOCTYPE html>
    <html lang="en">
    <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Visual Regression — {escape(branch)}</title>
    <style>
    body {{ font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
           max-width: 1200px; margin: 0 auto; padding: 24px; color: #111; background: #fff; }}
    h1 {{ font-size: 20px; margin: 0 0 4px; }}
    .meta {{ color: #6b7280; font-size: 13px; margin-bottom: 24px; }}
    .summary {{ display: flex; gap: 24px; margin-bottom: 24px;
                padding: 16px; background: #f9fafb; border-radius: 8px; }}
    .stat {{ text-align: center; }}
    .stat-n {{ font-size: 28px; font-weight: 700; }}
    .stat-l {{ font-size: 12px; color: #6b7280; margin-top: 2px; }}
    details > summary::-webkit-details-marker {{ display: none; }}
    details[open] > summary {{ border-radius: 6px 6px 0 0; border-bottom: 1px solid #e5e7eb; }}
    </style>
    </head>
    <body>
    <h1>Visual Regression Report</h1>
    <div class="meta">
      Branch: <strong>{escape(branch)}</strong> ({escape(candidate_sha)}) &nbsp;|&nbsp;
      Baseline: <strong>{escape(base)}</strong> ({escape(base_sha)}) &nbsp;|&nbsp;
      {escape(now)}
    </div>
    <div class="summary">
      <div class="stat"><div class="stat-n" style="color:#22c55e">{counts['pass']}</div>
        <div class="stat-l">pass</div></div>
      <div class="stat"><div class="stat-n" style="color:#f59e0b">{counts['warn']}</div>
        <div class="stat-l">warn</div></div>
      <div class="stat"><div class="stat-n" style="color:#ef4444">{counts['fail']}</div>
        <div class="stat-l">fail</div></div>
      <div class="stat"><div class="stat-n" style="color:#6b7280">{counts['error']}</div>
        <div class="stat-l">error</div></div>
      <div class="stat"><div class="stat-n">{len(comparisons)}</div>
        <div class="stat-l">total</div></div>
    </div>
    {''.join(rows_html)}
    </body></html>
    """)

    (od / "report.html").write_text(html)
    # Write JSON report (without base64 blobs)
    (od / "report.json").write_text(json.dumps({
        "branch": branch, "candidateSha": candidate_sha,
        "base": base, "baseSha": base_sha,
        "date": now, "threshold": cfg.get("threshold", 0.01),
        "summary": counts, "comparisons": comparisons,
    }, indent=2))

    print(f"\n  Report: {od / 'report.html'}", file=sys.stderr)
    print(f"  JSON:   {od / 'report.json'}", file=sys.stderr)

    # Open in browser
    import webbrowser
    webbrowser.open(str((od / "report.html").resolve().as_uri()))


# ---------------------------------------------------------------------------
# Teardown
# ---------------------------------------------------------------------------

def cmd_teardown(cfg: dict, project_dir: Path) -> None:
    od = output_dir(cfg)
    sf = servers_file(cfg)
    if sf.exists():
        servers = json.loads(sf.read_text())
        for role, info in servers.items():
            pid = info.get("pid")
            if pid:
                try:
                    os.kill(pid, signal.SIGTERM)
                    time.sleep(1)
                    try:
                        os.kill(pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                except ProcessLookupError:
                    pass
                print(f"  Stopped {role} server (pid {pid})", file=sys.stderr)
        sf.unlink(missing_ok=True)

    worktree_dir = od / "baseline"
    subprocess.run(["git", "worktree", "remove", str(worktree_dir), "--force"],
                   cwd=project_dir, capture_output=True)
    if worktree_dir.exists():
        shutil.rmtree(worktree_dir, ignore_errors=True)
    print("  ✓ Teardown complete", file=sys.stderr)


# ---------------------------------------------------------------------------
# Full pipeline
# ---------------------------------------------------------------------------

def cmd_run(cfg: dict, project_dir: Path, yes: bool = False) -> None:
    try:
        print("\n── Pre-flight ──────────────────────────", file=sys.stderr)
        cmd_preflight(cfg, project_dir)

        print("\n── Plan ────────────────────────────────", file=sys.stderr)
        cmd_plan(cfg, project_dir)

        if not yes and not cfg.get("dryRun"):
            plan = json.loads((output_dir(cfg) / "plan.json").read_text())
            print(f"\nAbout to start 2 servers and capture "
                  f"{plan['totalComparisons']} screenshots.")
            ans = input("Continue? [y/N] ").strip().lower()
            if ans != "y":
                print("Aborted.", file=sys.stderr)
                return

        if cfg.get("dryRun"):
            print("\ndryRun=true — stopping after plan.", file=sys.stderr)
            return

        print("\n── Baseline server ─────────────────────", file=sys.stderr)
        cmd_start_baseline(cfg, project_dir)

        print("\n── Candidate server ────────────────────", file=sys.stderr)
        cmd_start_candidate(cfg, project_dir)

        print("\n── Capture ─────────────────────────────", file=sys.stderr)
        cmd_capture(cfg, project_dir)

        print("\n── Compare ─────────────────────────────", file=sys.stderr)
        cmd_compare(cfg)

        print("\n── Report ──────────────────────────────", file=sys.stderr)
        cmd_report(cfg, project_dir)

    finally:
        print("\n── Teardown ────────────────────────────", file=sys.stderr)
        cmd_teardown(cfg, project_dir)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description="Visual regression runner")
    parser.add_argument(
        "--mode",
        choices=["preflight", "plan", "start-baseline", "start-candidate",
                 "capture", "compare", "report", "teardown", "run"],
        required=True,
    )
    parser.add_argument("--config", default=None, help="Path to config JSON")
    parser.add_argument("--project-dir", default=".", help="Root of the target project")
    parser.add_argument("--yes", "-y", action="store_true",
                        help="Skip confirmation prompts")

    args = parser.parse_args()
    project_dir = Path(args.project_dir).resolve()
    cfg = load_config(args.config, project_dir)

    # Register teardown on interrupt
    def _handle_signal(sig, frame):
        print("\nInterrupted — running teardown...", file=sys.stderr)
        cmd_teardown(cfg, project_dir)
        sys.exit(1)

    signal.signal(signal.SIGINT, _handle_signal)
    signal.signal(signal.SIGTERM, _handle_signal)

    od = output_dir(cfg)
    od.mkdir(parents=True, exist_ok=True)

    dispatch = {
        "preflight":       lambda: cmd_preflight(cfg, project_dir),
        "plan":            lambda: cmd_plan(cfg, project_dir),
        "start-baseline":  lambda: cmd_start_baseline(cfg, project_dir),
        "start-candidate": lambda: cmd_start_candidate(cfg, project_dir),
        "capture":         lambda: cmd_capture(cfg, project_dir),
        "compare":         lambda: cmd_compare(cfg),
        "report":          lambda: cmd_report(cfg, project_dir),
        "teardown":        lambda: cmd_teardown(cfg, project_dir),
        "run":             lambda: cmd_run(cfg, project_dir, yes=args.yes),
    }
    dispatch[args.mode]()


if __name__ == "__main__":
    main()
