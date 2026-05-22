# Skill Spec: Security Audit and Fix

## Goal

Audit the codebase for security vulnerabilities — from OWASP Top 10 issues and exposed secrets to vulnerable dependencies and missing HTTP security headers — then apply safe, targeted fixes and produce a severity-ranked report so the most dangerous issues are addressed first.

---

## Trigger conditions

Invoke this skill when the user asks to:
- "run a security audit"
- "find security vulnerabilities"
- "check for exposed secrets / credentials"
- "audit dependencies for CVEs"
- "add security headers"
- "check for XSS / injection issues"
- "harden this app"
- "fix security issues"

---

## Inputs

| Input | Required | Description |
|---|---|---|
| `target` | No | File glob or directory to audit (default: entire project) |
| `fix` | No | `true` to apply auto-fixable issues; `false` (default) to report only |
| `includeDeps` | No | `true` to run dependency vulnerability scan (default: `true`) |
| `includeSecrets` | No | `true` to scan for committed secrets (default: `true`) |
| `includeHeaders` | No | `true` to check HTTP security headers (default: `true`) |
| `serveCommand` | No | Dev server command — required for header checks against a live server |
| `port` | No | Port for the dev server (default: `3000`) |
| `ignore` | No | Array of rule names, CVE IDs, or file paths to suppress |
| `outputDir` | No | Where to write the report (default: `.security/`) |

---

## Behavior

### 1. Pre-flight checks

- Confirm the working directory is a recognisable project
- Detect the language and framework: Node.js/TypeScript, Python, Go, Ruby, Java, PHP — determines which rules and dependency scanners apply
- Detect the package manager: npm, yarn, pnpm, pip, poetry, bundler, go modules, maven, gradle, composer
- If `fix: true`, confirm no uncommitted changes or ask for confirmation
- Warn: fixes that change security-sensitive logic (authentication, validation) will be flagged for human review rather than auto-applied

### 2. Secret detection (when `includeSecrets: true`)

Scan all files tracked by git (and untracked files in the working tree) for patterns that indicate committed credentials or secrets.

**Detection strategy:**

1. **Pattern matching** — check file contents against known secret patterns:

| Pattern | Description |
|---|---|
| `[A-Za-z0-9+/]{40}` in assignment context | Generic high-entropy base64 token |
| `sk-[A-Za-z0-9]{48}` | OpenAI API key |
| `AKIA[A-Z0-9]{16}` | AWS Access Key ID |
| `ghp_[A-Za-z0-9]{36}` | GitHub personal access token |
| `glpat-[A-Za-z0-9\-_]{20}` | GitLab personal access token |
| `-----BEGIN (RSA\|EC\|DSA\|OPENSSH) PRIVATE KEY-----` | Private key |
| `[A-Za-z0-9+/]{32}` near `password\|secret\|token\|key\|credential` | Context-aware high-entropy string |
| `mongodb(\+srv)?://[^@]+:[^@]+@` | MongoDB connection string with credentials |
| `postgres://[^@]+:[^@]+@` | PostgreSQL connection string with credentials |
| `mysql://[^@]+:[^@]+@` | MySQL connection string with credentials |
| `redis://:([^@]+)@` | Redis connection string with credentials |

2. **File name matching** — flag sensitive files that should not be committed:
   - `.env`, `.env.local`, `.env.production`, `.env.*` (any env file with content)
   - `*.pem`, `*.key`, `*.p12`, `*.pfx`
   - `credentials.json`, `service-account.json`, `secrets.json`
   - `id_rsa`, `id_ed25519`, `id_ecdsa` (SSH keys)

3. **Git history scan** — run `git log --all -p` and apply the same patterns; flag secrets found in past commits even if removed in HEAD (they remain in history)

**False positive reduction:**
- Ignore matches inside test fixtures whose file path contains `__fixtures__`, `testdata`, or `mocks/`
- Ignore matches where the value is `<PLACEHOLDER>`, `YOUR_KEY_HERE`, `xxxx`, `test`, `example`, or a string of only one repeated character
- Ignore `*.example`, `*.sample`, `*.template` files

**Severity:** all confirmed secrets are **Critical**.

---

### 3. Dependency vulnerability scan (when `includeDeps: true`)

Run the appropriate vulnerability scanner for the detected package manager(s):

| Package manager | Command |
|---|---|
| npm / yarn / pnpm | `npm audit --json` |
| pip / poetry | `pip-audit --format=json` (install if missing) |
| bundler | `bundle audit --format json` (install if missing) |
| go modules | `govulncheck -json ./...` (install if missing) |
| maven | `mvn dependency-check:check -Dformat=JSON` |
| gradle | `./gradlew dependencyCheckAnalyze` |
| composer | `composer audit --format=json` |

Parse the output and record each CVE with:
- Package name and affected version
- CVE ID and CVSS score
- Severity: Critical (CVSS ≥ 9.0), High (7.0–8.9), Medium (4.0–6.9), Low (< 4.0)
- Fixed version (if available)
- Whether the vulnerable package is a direct or transitive dependency

If no scanner is available, fall back to checking `package.json` / lock files against the GitHub Advisory Database via the public API (no authentication required).

**Auto-fix for deps (when `fix: true`):**
- If the fix is a patch or minor version bump, run the package manager's update command for that specific package
- Never auto-update across major versions — flag for human review
- Always re-run the test suite after updating

---

### 4. Static code analysis

Scan source files for OWASP Top 10 and common vulnerability patterns.

**A01 – Broken Access Control**
- API route handlers with no authentication check (no session/token validation before accessing data) → High
- `role` or `admin` checks performed only on the client side with no server-side enforcement → High
- Direct object references using user-supplied IDs without ownership verification (e.g. `db.find({ id: req.params.id })` without user scope) → High
- Directory traversal: `path.join` or `fs` calls using unvalidated user input → High

**A02 – Cryptographic Failures**
- `Math.random()` used for security purposes (tokens, CSRF values, passwords) → High
- MD5 or SHA-1 used for password hashing → Critical
- Password stored in plaintext → Critical
- Symmetric encryption key hardcoded in source → Critical
- `crypto.createCipher` (deprecated, no IV) instead of `crypto.createCipheriv` → High
- HTTP URLs used for sensitive API calls when HTTPS is available → Medium
- JWT verified with `algorithms: ['none']` or no algorithm check → Critical

**A03 – Injection**
- SQL queries built by string concatenation with user input (not parameterised) → Critical
- `eval()`, `Function()`, or `vm.runInContext()` called with user-controlled data → Critical
- Shell commands built from user input: `exec()`, `spawn()`, `execSync()` without sanitisation → Critical
- `innerHTML`, `outerHTML`, `document.write()`, or `insertAdjacentHTML()` set with user-controlled data → High (XSS)
- `dangerouslySetInnerHTML` in React/Next.js receiving unsanitised data → High (XSS)
- LDAP, XPath, or NoSQL queries using unvalidated user input → High
- Template engines (`ejs`, `pug`, `handlebars`) using `{{{unescaped}}}` or `!{unescaped}` with user data → High

**A04 – Insecure Design**
- Password reset tokens that are guessable (short numeric codes, sequential IDs) → High
- Rate limiting absent on authentication endpoints → Medium
- Account enumeration possible via different error messages for "wrong password" vs "user not found" → Medium
- Multi-factor authentication reset bypasses MFA (e.g. forgot-password flow resets without MFA) → High

**A05 – Security Misconfiguration**
- Debug mode or verbose error messages enabled in production configuration → High
- Default credentials in configuration files → Critical
- CORS configured with `origin: '*'` on endpoints that return authenticated data → High
- `Access-Control-Allow-Credentials: true` combined with `Access-Control-Allow-Origin: *` → Critical
- Stack traces or internal paths exposed in error responses → Medium
- Unnecessary HTTP methods enabled on API endpoints (e.g. `DELETE` where only `GET` is needed) → Medium

**A06 – Vulnerable and Outdated Components**
- Handled by the dependency scan (Section 3)

**A07 – Identification and Authentication Failures**
- Session tokens stored in `localStorage` or `sessionStorage` (vulnerable to XSS) rather than `HttpOnly` cookies → High
- Session ID not regenerated after login (session fixation) → High
- Missing `HttpOnly` flag on session cookies → High
- Missing `Secure` flag on session cookies → High
- Missing `SameSite` attribute on session cookies → Medium
- JWT signed with a hardcoded weak secret → Critical
- JWT expiry (`exp`) not validated → High
- Unlimited failed login attempts with no lockout or CAPTCHA → Medium

**A08 – Software and Data Integrity Failures**
- `<script src="...">` loading from a CDN without a `integrity` attribute (Subresource Integrity) → Medium
- Deserialization of untrusted data: `JSON.parse(userInput)` used to reconstruct objects that are later executed → High
- Auto-update or plugin loading from external URLs without signature verification → High

**A09 – Security Logging and Monitoring Failures**
- Authentication events (login success, failure, logout, password reset) not logged → Medium
- Sensitive data (passwords, tokens, credit card numbers) present in log statements → High
- Log injection: user input inserted into log messages without sanitisation → Medium

**A10 – Server-Side Request Forgery (SSRF)**
- HTTP requests made to URLs derived from user input without allowlist validation → High
- `fetch()`, `axios.get()`, `http.get()` called with a URL that includes user-controlled host or path → High

---

### 5. HTTP security headers (when `includeHeaders: true`)

If `serveCommand` is provided, start the dev server and make a HEAD request to each route. Otherwise, scan config files for header configuration.

**Checked headers:**

| Header | Requirement | Severity if absent |
|---|---|---|
| `Content-Security-Policy` | Must be present and non-trivial (not `*`) | High |
| `Strict-Transport-Security` | Must include `max-age` ≥ 31536000 | High |
| `X-Content-Type-Options` | Must be `nosniff` | Medium |
| `X-Frame-Options` | Must be `DENY` or `SAMEORIGIN` (or CSP `frame-ancestors`) | Medium |
| `Referrer-Policy` | Must be `no-referrer` or `strict-origin-when-cross-origin` | Low |
| `Permissions-Policy` | Should restrict camera, microphone, geolocation | Low |
| `Cache-Control` | API responses returning sensitive data must include `no-store` | Medium |
| `Set-Cookie` flags | `HttpOnly`, `Secure`, `SameSite` — see A07 above | High |

Scan config files when live server is not available:

| Framework | Config file |
|---|---|
| Next.js | `next.config.*` — `headers()` function |
| Express | Middleware chains — look for `helmet()` or manual `res.setHeader` |
| Fastify | `fastify-helmet` plugin registration |
| Nuxt | `nuxt.config.*` — `routeRules` or `nitro.routeRules` |
| Nginx | `nginx.conf` — `add_header` directives |
| Apache | `.htaccess` — `Header set` directives |

---

### 6. Fix phase (when `fix: true`)

Apply only violations that have a safe, deterministic fix and do not alter application logic.

**Auto-fixable:**

| Violation | Fix applied |
|---|---|
| Missing `HttpOnly` / `Secure` / `SameSite` on cookie | Add the missing attributes to the `Set-Cookie` call or cookie options object |
| `Math.random()` for token generation | Replace with `crypto.randomBytes(32).toString('hex')` (Node.js) or equivalent |
| Missing `integrity` on CDN `<script>` | Fetch the SRI hash and add `integrity` and `crossorigin="anonymous"` |
| Missing security headers in Express | Add `helmet()` middleware import and registration (warn: review CSP policy) |
| Missing security headers in Next.js | Add `headers()` config with safe defaults (warn: review CSP policy) |
| `target="_blank"` missing `rel="noopener noreferrer"` | Add the attribute (also an SEO issue) |
| Dependency patch-level update | Run the package manager update command for the specific package |

**Never auto-fixed:**
- SQL or command injection (requires structural query rewrite)
- Authentication logic (requires understanding the auth flow)
- CORS policy (requires understanding which origins are legitimate)
- Committed secrets (requires secret rotation — provide guidance and the `git filter-repo` command to remove from history)
- Access control gaps (requires understanding the data model)

For issues that cannot be auto-fixed, provide exact file paths, line numbers, and a concrete remediation code snippet in the report.

---

### 7. Generate report

Write to `<outputDir>/report.html` — self-contained HTML, no external dependencies.

**Summary header:**

```
Project:   my-app
Date:      2026-05-21 14:32
Files scanned: 112

Critical:   3 issues
High:      11 issues
Medium:     8 issues
Low:        5 issues

Dependency CVEs: 4 (1 Critical, 2 High, 1 Medium)
Secrets found:   2

Auto-fixed: 5
Needs review: 24
```

**Per-issue table:**

| Column | Description |
|---|---|
| Severity | Critical / High / Medium / Low |
| Category | OWASP category or Secret / Dependency / Header |
| File + line | Clickable path |
| Issue | Plain-English description |
| Evidence | Offending code snippet (secrets redacted to first 4 chars + `****`) |
| Remediation | Concrete fix instructions with a code example |

Issues sorted Critical → Low. Secrets and Critical CVEs shown in a red banner at the top.

Also write `<outputDir>/report.json` with machine-readable results.

**Important:** the JSON report must never contain the full value of any detected secret. Truncate to the first 4 characters followed by `****`.

---

## Severity definitions

| Severity | Definition |
|---|---|
| Critical | Exploitable remotely with no authentication; or confirmed secret exposure; or direct data breach risk |
| High | Exploitable with minimal preconditions; session hijacking, privilege escalation, SSRF |
| Medium | Exploitable under specific conditions; defence-in-depth weakness; OWASP best practice violation |
| Low | Hardening recommendation; no direct exploit path but reduces attack surface |

---

## Output structure

```
.security/
  report.html
  report.json
```

---

## Edge cases and constraints

- **Secrets in git history**: always scan history as well as HEAD; a secret removed in a recent commit is still accessible via `git log`; include the commit SHA and date in the report
- **Minified or bundled files**: skip `.min.js`, `dist/`, `build/`, `.next/`, `out/` for static analysis — these are derived files; scan the source instead
- **Test files**: secrets in `__tests__/`, `*.test.*`, `*.spec.*`, `fixtures/` are flagged as Low rather than Critical — they may be intentional test data but must still be reviewed
- **Environment variable references**: `process.env.SECRET` is fine — flag only when the actual secret value is hardcoded
- **Third-party code in `vendor/` or `node_modules/`**: dependency scan covers vulnerabilities here; skip static analysis for these directories
- **Monorepos**: detect all apps and scan each; report issues per-app
- **False positives for high-entropy strings**: apply context checks — a 40-char hex string is only flagged if it appears in an assignment context near a security-sensitive key name
- **Language server / LSP**: if the project uses TypeScript, leverage type information where available to distinguish user-controlled input from internal constants
- **HTTPS in development**: `Secure` cookie flag and HSTS are expected to be absent in local dev — note this and flag only when a production config file is detected
- **CSP auto-fix limitation**: generating a Content-Security-Policy is not auto-fixed because it requires knowledge of all script and style sources; provide a template with `TODO` placeholders and instructions

---

## Success criteria

- Every source file is scanned (excluding `node_modules/`, `dist/`, `vendor/`)
- Git history is scanned for secrets across all branches
- Dependency scan runs and produces results for all detected package managers
- Each issue includes the exact file, line number, and a code-level remediation example
- Secrets are never printed in full in the report output
- Auto-fixes do not break the existing test suite
- `report.html` is self-contained and opens without a server
- No false positives for environment variable references, placeholder values, or test fixtures
