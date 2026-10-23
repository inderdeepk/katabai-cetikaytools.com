# Testing Katab

## Contents

- [Running Tests](#running-tests)
- [Syntax Validation](#syntax-validation)
- [In-Shell Testing](#in-shell-testing)
- [Schema Validation](#schema-validation)
- [Known Baseline Noise](#known-baseline-noise)
- [Adding New Tests](#adding-new-tests)
- [Test Coverage](#test-coverage)
- [Fidelity Audits](#fidelity-audits)
- [RAG Service Tests](#rag-service-tests)
- [CI](#ci)
- [End-to-End Testing Checklist](#end-to-end-testing-checklist)
- [Regression Test Checklist](#regression-test-checklist)

---

## Running Tests

Katab uses GJS (`gjs -m`) for unit tests. Tests live in `tests/` and import from `../src/`.

```bash
# Run all suites (parallel, one gjs process per suite, compact summary)
make test

# Per-suite pass counts and timings
make test-verbose

# One suite, or a filtered subset
gjs -m tests/petCollection.test.js
node scripts/run-tests.mjs --filter networkGuard

# Tune parallelism / per-suite timeout (ms)
node scripts/run-tests.mjs --jobs 4 --timeout 60000
```

`make test` runs suites concurrently (default: up to 8 workers) but keeps each
suite in its own `gjs` process, so module-level state never leaks between
suites. It prints only failures and a final summary; a suite that hangs is
killed after the timeout (default 120 s) and reported as failed. Exit status is
non-zero if any suite fails.

## Syntax Validation

```bash
# Check that every JS file parses as an ES module (requires Node.js)
make check

# Or just the syntax pass (single espree process; falls back to `node --check`)
node scripts/check-syntax.mjs
```

`make check` also balances CSS delimiters and import-smokes every `src/` module
under GJS (catching module-resolution errors that parsing cannot see).

## In-Shell Testing

The authoritative validation is a live GNOME Shell reload:

```bash
# Disable and re-enable the extension
gnome-extensions disable katabai@cetikaytools.com
gnome-extensions enable katabai@cetikaytools.com

# Check for errors in the journal
journalctl -f -o cat /usr/bin/gnome-shell | grep -i katab
```

## Schema Validation

```bash
make compile-schemas
# or:
glib-compile-schemas schemas/
```

## Known Baseline Noise

The following warnings are non-fatal and appear at startup even in a clean build:
- `st_widget_get_theme_node ... not in the stage` — widgets styled while hidden
- `g_signal_connect_object: assertion 'G_TYPE_CHECK_INSTANCE (instance)' failed` (×2)

Only investigate when accompanied by a stack trace.

## Adding New Tests

1. Create `tests/yourModule.test.js`.
2. Import the module under test from `../src/` and the helpers from `./testUtils.js`:
   `import { assert, assertEqual, assertDeepEqual, runTests, createMockSettings } from './testUtils.js';`
3. Export an array of `[name, fn]` entries and end the file with `await runTests(tests);`.
   The harness awaits async test functions, counts failures, and throws so the
   process exits non-zero — never hand-roll a runner (an unawaited async IIFE
   exits 0 even when every test fails).
4. Use the shared helpers instead of ad-hoc mocks:
   - `createMockSettings({...})` — Gio.Settings stand-in keyed by GSettings key.
   - `createMockLlmCall([...])` — deterministic LLM stub.
   - `makeTempDir()` / `removeTempDir()` — isolated scratch directories.
   - `readTextFile()` — UTF-8 read that tolerates a missing file.
5. Databases/files must be redirected to a temp path via the module's
   `_set*PathForTesting()` seam (or `XDG_DATA_HOME` / `HOME` set before the
   first GLib directory lookup). Suites run concurrently — never share a fixed
   `/tmp` filename.
6. Aim for pure-logic modules first — modules without GNOME Shell/Clutter dependencies.

## Test Coverage

| Module | Status | Notes |
|---|---|---|
| `src/pets/petCollection.js` | ✅ Tested | Stages, XP, form ids, selection, persisted-state normalization |
| `src/core/*.js` | ✅ Tested | History store, request lifecycle, session memory folding, title generator, tool-call markup |
| `src/providers/*.js` | ✅ Tested | Payload shaping, request building, SSE stream parsing, non-streaming fallback |
| `src/research/*.js` | ✅ Tested | Planner, branch runner (incl. retries + subpage links), citation tracker, compression, cache + checkpoints, prompts, synthesis prompt |
| `src/shared/*.js` | ✅ Tested | Network guard, HTTP body reader, page links, content classification, i18n bridge |
| `src/usage/*.js` | ✅ Tested | Token ledger, pricing, preset CRUD (isolated `XDG_DATA_HOME`), milestones |
| `src/tools/*.js` | ⚠️ Partial | Pure helpers/config parsers/formatting are unit-tested; runtime network, subprocess, and Crawl4AI service calls need live services |
| `src/ui/markdownRender.js` | ✅ Tested | Chunking, inline formatting, render model |
| Other `src/ui/**` | ❌ Untestable | Require Clutter/St/Gtk widgets — covered by `make check` import smoke plus in-shell verification |
| `extension.js` | ❌ Untestable | Requires GNOME Shell runtime (Clutter, St) — covered by `make check` parse + mandatory in-shell verification |
| `prefs.js` | ⚠️ Partial | Orchestrator only — covered by `make check` parse and a live prefs open; its `src/ui/prefs/**` modules are additionally import-smoked by `make check` when GTK4/Adwaita are available (CI installs them) |
| `rag-service/server.py` | ✅ Tested | stdlib `unittest` suite in `rag-service/tests/` |

## Fidelity Audits

`scripts/audits/` proves that past refactors were pure code moves: each script re-extracts the
pre-refactor method bodies from git history, applies the documented renames, and flat-compares them
against the current sources.

```bash
make audit                                  # all audits
node scripts/audits/audit-pickers.mjs       # one audit
```

- Audits **skip** (exit 0 with a notice) on shallow clones, so CI is unaffected and the real gate is
  local.
- Run `make audit` after refactoring code with audit coverage; a `DIFF` points at the exact
  character where moved text diverged.
- Intentional drift is allowed only through exact-match allowances, never wildcard regexes.
- See [scripts/audits/README.md](../../scripts/audits/README.md) for the technique and pitfalls.

## RAG Service Tests

The local FastAPI + ChromaDB service has its own stdlib `unittest` suite:

```bash
# Uses the deployed venv when present
make test-rag-server

# Or directly (any environment with the dependencies installed)
python -m unittest discover -s rag-service/tests -p 'test_*.py'
```

CI runs these in a separate job with `rag-service/requirements.txt` installed.

## CI

`.github/workflows/ci.yml` runs two jobs on every push and pull request:

| Job | Steps |
|---|---|
| Extension checks & unit tests | Checkout → install GJS/GTK/Adw/Soup → Node 20 → `npm ci` → `npm run lint` → `npm run format:check` → `make compile-schemas` → `make check` → `make test` → `make package` |
| RAG service unit tests | Python 3.12 → `pip install -r rag-service/requirements.txt` → `python -m unittest discover` |

CI does **not** run `make audit` (shallow checkout) and cannot exercise the live shell.

## End-to-End Testing Checklist

For new features, verify:
1. ☐ Extension enables without errors (`journalctl` clean)
2. ☐ Feature works with all applicable providers
3. ☐ Feature works in both dark and light themes
4. ☐ Error paths handled gracefully (wrong URL, network down, invalid input)
5. ☐ History saves and reloads correctly with the new feature
6. ☐ Preferences UI reflects and syncs settings correctly
7. ☐ No "not in the stage" or "already been disposed" warnings
8. ☐ No offscreen framebuffer errors on long content
9. ☐ Schema compiled without errors
10. ☐ All existing features still work (regression check)

## Regression Test Checklist

Before merging to main:
1. ☐ `make check` passes (ES-module parse + CSS delimiter balance + gjs import smoke)
2. ☐ `make test` passes (unit tests)
3. ☐ `make compile-schemas` succeeds
4. ☐ `make package` creates valid zip
5. ☐ Extension enables/disables cleanly
6. ☐ Chat sends and receives with Ollama
7. ☐ Chat history saves and loads
8. ☐ Provider switching works
9. ☐ Dark/light theme switching works
10. ☐ Keyboard shortcut toggles chat
