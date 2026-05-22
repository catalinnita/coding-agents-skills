---
name: security
description: >
  Audits the codebase for security vulnerabilities including OWASP Top 10 issues,
  committed secrets and credentials, vulnerable dependencies (CVEs), and missing
  HTTP security headers. Applies safe targeted fixes and produces a
  severity-ranked HTML report with remediation guidance. Use when asked to run a
  security audit, find vulnerabilities, check for exposed secrets, audit
  dependencies for CVEs, add security headers, or harden an app.
compatibility: >
  Requires Python 3.10+. Dependency scanning requires the appropriate package
  manager CLI (npm, pip-audit, bundle-audit, govulncheck, etc.). Header checks
  require Node.js and Playwright when run against a live server.
metadata:
  author: catalin nita
  version: "1.0"
---

## Overview

Audit and fix security vulnerabilities in a codebase. Scans all tracked files
for committed secrets (including git history), runs the appropriate dependency
vulnerability scanner for the detected package manager, performs static analysis
for OWASP Top 10 patterns, checks HTTP security headers, applies safe
auto-fixes, and writes a self-contained HTML report with concrete remediation
guidance.

## Inputs

| Input | Required | Description |
|---|---|---|
| `target` | No | File glob or directory to audit. Default: entire project |
| `fix` | No | `true` to apply auto-fixable issues. Default: `false` (report only) |
| `includeDeps` | No | Run dependency CVE scan. Default: `true` |
| `includeSecrets` | No | Scan for committed secrets. Default: `true` |
| `includeHeaders` | No | Check HTTP security headers. Default: `true` |
| `serveCommand` | No | Dev server command — required for live header checks |
| `port` | No | Dev server port. Default: `3000` |
| `ignore` | No | Array of rule names, CVE IDs, or file paths to suppress |
| `outputDir` | No | Output directory. Default: `.security/` |

## Step 1 — Resolve config and pre-flight checks

Look for config in this order:
1. `.security.config.json` in the project root
2. Built-in defaults

Run pre-flight checks:

```bash
python3 .agents/skills/security/scripts/runner.py \
  --mode preflight \
  --project-dir <path-to-project>
```

Checks performed:
- Detect language and framework (Node.js/TypeScript, Python, Go, Ruby, Java, PHP)
- Detect package manager(s): npm, yarn, pnpm, pip, poetry, bundler, go modules, maven, gradle, composer
- If `fix: true` — confirm no uncommitted changes or ask for confirmation
- Warn: fixes that change security-sensitive logic are flagged for human review, never auto-applied
- If monorepo detected — scan each app; report issues per-app

## Step 2 — Secret detection (when `includeSecrets: true`)

Scan all tracked files, untracked working-tree files, and full git history:

```bash
python3 .agents/skills/security/scripts/runner.py \
  --mode secrets \
  --project-dir <path-to-project>
```

**Pattern matching** — flag high-entropy strings and known credential formats:

| Pattern | Description |
|---|---|
| `AKIA[A-Z0-9]{16}` | AWS Access Key ID |
| `sk-[A-Za-z0-9]{48}` | OpenAI API key |
| `ghp_[A-Za-z0-9]{36}` | GitHub personal access token |
| `glpat-[A-Za-z0-9\-_]{20}` | GitLab personal access token |
| `-----BEGIN ... PRIVATE KEY-----` | Private key |
| `mongodb(\+srv)?://[^@]+:[^@]+@` | MongoDB connection string with credentials |
| `postgres://[^@]+:[^@]+@` | PostgreSQL connection string with credentials |
| High-entropy string near `password\|secret\|token\|key` | Context-aware credential |

**File name matching** — flag sensitive files that should not be committed:
`.env`, `.env.*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa`, `id_ed25519`, `credentials.json`, `service-account.json`.

**Git history scan** — run `git log --all -p` and apply the same patterns; secrets removed in HEAD are still in history.

**False positive reduction**: ignore matches inside `__fixtures__/`, `testdata/`, `mocks/`; ignore placeholder values (`YOUR_KEY_HERE`, `xxxx`, `example`); ignore `*.example`, `*.sample`, `*.template` files.

All confirmed secrets are **Critical**. Secrets are never printed in full — truncated to first 4 characters + `****`.

Writes `<outputDir>/secrets.json`.

## Step 3 — Dependency vulnerability scan (when `includeDeps: true`)

Run the appropriate scanner for each detected package manager:

```bash
python3 .agents/skills/security/scripts/runner.py \
  --mode deps \
  --project-dir <path-to-project>
```

| Package manager | Command |
|---|---|
| npm / yarn / pnpm | `npm audit --json` |
| pip / poetry | `pip-audit --format=json` |
| bundler | `bundle audit --format json` |
| go modules | `govulncheck -json ./...` |
| maven | `mvn dependency-check:check -Dformat=JSON` |
| composer | `composer audit --format=json` |

Per CVE record: package name and affected version, CVE ID, CVSS score, severity (Critical ≥9.0 / High 7.0–8.9 / Medium 4.0–6.9 / Low <4.0), fixed version, direct vs transitive.

If no scanner available, fall back to checking lock files against the GitHub Advisory Database public API.

Writes `<outputDir>/deps.json`.

## Step 4 — Static code analysis

Scan source files for OWASP Top 10 and common vulnerability patterns:

```bash
python3 .agents/skills/security/scripts/runner.py \
  --mode analyze \
  --project-dir <path-to-project>
```

**A01 – Broken Access Control**
- API route handlers with no authentication check → High
- `role` / `admin` checks only client-side with no server enforcement → High
- Direct object references using unscoped user-supplied IDs → High
- Directory traversal: `path.join` / `fs` calls with unvalidated user input → High

**A02 – Cryptographic Failures**
- `Math.random()` used for tokens, CSRF values, or passwords → High
- MD5 or SHA-1 for password hashing → Critical; plaintext password storage → Critical
- Hardcoded symmetric encryption key → Critical
- `crypto.createCipher` (no IV) instead of `crypto.createCipheriv` → High
- HTTP URLs used for sensitive API calls → Medium
- JWT verified with `algorithms: ['none']` or no algorithm check → Critical

**A03 – Injection**
- SQL queries built by string concatenation with user input → Critical
- `eval()`, `Function()`, `vm.runInContext()` with user-controlled data → Critical
- Shell commands built from user input (`exec`, `spawn`, `execSync`) → Critical
- `innerHTML`, `outerHTML`, `document.write()`, `insertAdjacentHTML()` with user-controlled data → High (XSS)
- `dangerouslySetInnerHTML` receiving unsanitised data → High (XSS)
- Template engines using unescaped interpolation with user data → High

**A04 – Insecure Design**
- Guessable password reset tokens (short numeric codes, sequential IDs) → High
- No rate limiting on authentication endpoints → Medium
- Account enumeration via different error messages for wrong password vs unknown user → Medium

**A05 – Security Misconfiguration**
- Debug mode or verbose errors enabled in production config → High
- Default credentials in config files → Critical
- CORS `origin: '*'` on authenticated endpoints → High
- `Access-Control-Allow-Credentials: true` + `Access-Control-Allow-Origin: *` → Critical
- Stack traces or internal paths in error responses → Medium

**A07 – Identification and Authentication Failures**
- Session tokens in `localStorage` / `sessionStorage` → High
- Session ID not regenerated after login (session fixation) → High
- Cookies missing `HttpOnly`, `Secure`, or `SameSite` flags → High / Medium
- JWT signed with weak hardcoded secret → Critical; `exp` not validated → High
- Unlimited failed login attempts without lockout or CAPTCHA → Medium

**A08 – Software and Data Integrity Failures**
- `<script src>` from CDN without `integrity` attribute (SRI) → Medium
- Deserialization of untrusted data executed as objects → High

**A09 – Security Logging and Monitoring Failures**
- Auth events not logged (login success/failure, logout, password reset) → Medium
- Passwords, tokens, or card numbers in log statements → High
- User input inserted into log messages without sanitisation (log injection) → Medium

**A10 – Server-Side Request Forgery (SSRF)**
- `fetch()` / `axios` / `http.get()` called with URL from user-controlled host or path → High

Writes `<outputDir>/static-vulnerabilities.json`.

## Step 5 — HTTP security headers (when `includeHeaders: true`)

If `serveCommand` provided, start the dev server and HEAD-request each route. Otherwise scan config files:

```bash
python3 .agents/skills/security/scripts/runner.py \
  --mode headers \
  --project-dir <path-to-project>
```

**Checked headers:**

| Header | Requirement | Severity if absent |
|---|---|---|
| `Content-Security-Policy` | Present and non-trivial | High |
| `Strict-Transport-Security` | `max-age` ≥ 31536000 | High |
| `X-Content-Type-Options` | `nosniff` | Medium |
| `X-Frame-Options` | `DENY` or `SAMEORIGIN` (or CSP `frame-ancestors`) | Medium |
| `Referrer-Policy` | `no-referrer` or `strict-origin-when-cross-origin` | Low |
| `Permissions-Policy` | Restricts camera, microphone, geolocation | Low |
| `Cache-Control` | API responses with sensitive data must include `no-store` | Medium |

**Config file scanning** when live server is not available:

| Framework | Config file |
|---|---|
| Next.js | `next.config.*` — `headers()` function |
| Express | Middleware chains — `helmet()` or manual `res.setHeader` |
| Fastify | `fastify-helmet` plugin registration |
| Nuxt | `nuxt.config.*` — `routeRules` / `nitro.routeRules` |
| Nginx | `nginx.conf` — `add_header` directives |
| Apache | `.htaccess` — `Header set` directives |

Writes `<outputDir>/headers.json`.

## Step 6 — Fix phase (when `fix: true`)

Apply only violations with a safe, deterministic fix that does not alter application logic:

```bash
python3 .agents/skills/security/scripts/runner.py \
  --mode fix \
  --project-dir <path-to-project>
```

**Auto-fixable:**

| Violation | Fix applied |
|---|---|
| Missing `HttpOnly` / `Secure` / `SameSite` on cookie | Add missing attributes to `Set-Cookie` call or options object |
| `Math.random()` for token generation | Replace with `crypto.randomBytes(32).toString('hex')` |
| Missing `integrity` on CDN `<script>` | Fetch SRI hash, add `integrity` and `crossorigin="anonymous"` |
| Missing security headers in Express | Add `helmet()` middleware (warn: review CSP policy) |
| Missing security headers in Next.js | Add `headers()` config with safe defaults (warn: review CSP policy) |
| `target="_blank"` missing `rel="noopener noreferrer"` | Add the attribute |
| Dependency patch-level CVE | Run package manager update for the specific package |

**Never auto-fixed** (reported with exact file path, line number, and remediation code snippet):
SQL / command injection; authentication logic; CORS policy; committed secrets (provide `git filter-repo` command for history removal); access control gaps; major-version dependency updates.

If a test suite exists, run it after fixing and report any failures.

## Step 7 — Generate report

```bash
python3 .agents/skills/security/scripts/runner.py \
  --mode report \
  --project-dir <path-to-project>
```

Writes `<outputDir>/report.html` — **self-contained** HTML (no external dependencies). Secrets and Critical CVEs shown in a red banner at the top:

```
Project:   my-app
Date:      2026-05-22
Files scanned: 112

Critical:   3 issues
High:      11 issues
Medium:     8 issues
Low:        5 issues

Dependency CVEs: 4 (1 Critical, 2 High, 1 Medium)
Secrets found:   2

Auto-fixed: 5   Needs review: 24
```

Per-issue table: severity, OWASP category (or Secret / Dependency / Header), file + line (clickable), plain-English description, evidence snippet (secrets truncated to first 4 chars + `****`), remediation instructions with code example. Sorted Critical → Low.

Also writes `<outputDir>/report.json`. The JSON report never contains full secret values.

## Convenience: run the full pipeline

```bash
python3 .agents/skills/security/scripts/runner.py \
  --mode run \
  --project-dir <path-to-project>
```

Runs Steps 1–7 in sequence.

## Available scripts

- **`scripts/runner.py`** — main orchestrator. Run with `--help` for full usage.

## Severity definitions

| Severity | Definition |
|---|---|
| Critical | Remotely exploitable with no auth; confirmed secret; direct data breach risk |
| High | Exploitable with minimal preconditions; session hijacking; privilege escalation; SSRF |
| Medium | Exploitable under specific conditions; defence-in-depth weakness |
| Low | Hardening recommendation; no direct exploit path |

## Output structure

```
.security/
  secrets.json
  deps.json
  static-vulnerabilities.json
  headers.json
  report.html                  ← open this
  report.json
```

## Edge cases

- **Secrets in git history**: always scan all branches; a secret removed in HEAD is still accessible via `git log` — include commit SHA and date in the report
- **Minified / bundled files**: skip `dist/`, `build/`, `.next/`, `out/`, `*.min.js` — scan source instead
- **Test files**: secrets in `__tests__/`, `*.test.*`, `*.spec.*`, `fixtures/` flagged as Low not Critical — may be intentional test data but must still be reviewed
- **Environment variable references**: `process.env.SECRET` is fine — only flag when the actual value is hardcoded
- **Third-party code in `vendor/` / `node_modules/`**: dependency scan covers these; skip static analysis
- **False positives for high-entropy strings**: only flag when in an assignment context near a security-sensitive key name
- **HTTPS in development**: `Secure` flag and HSTS are expected to be absent locally — flag only when a production config file is detected
- **CSP auto-fix**: not auto-fixed because it requires knowledge of all script and style sources; provide a template with `TODO` placeholders

## Success criteria

- Every source file scanned (excluding `node_modules/`, `dist/`, `vendor/`)
- Git history scanned for secrets across all branches
- Dependency scan runs for all detected package managers
- Each issue includes exact file, line number, and a code-level remediation example
- Secrets never printed in full in any report output
- Auto-fixes do not break the existing test suite
- `report.html` is self-contained and opens without a server
- No false positives for env variable references, placeholder values, or test fixtures
