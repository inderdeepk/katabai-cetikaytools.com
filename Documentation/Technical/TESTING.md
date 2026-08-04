# Testing Katabai

## Running Tests

Katabai uses GJS (`gjs -m`) for unit tests. Tests live in `tests/` and import from `../src/`.

```bash
# Run all tests
make test

# Or individually:
gjs -m tests/petCollection.test.js
gjs -m tests/tokenUsageManager.test.js
```

## Syntax Validation

```bash
# Check all JS files compile
make check

# Or manually:
gjs -c "imports.searchPath.push('.');"  # (limited — full check requires in-shell)
```

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

1. Create `tests/yourModule.test.js`
2. Import from `../src/` (e.g., `import { yourFn } from '../src/shared/networkGuard.js';`)
3. Use `GLib.test_create_suite` + `GLib.test_add` pattern (see existing tests)
4. Aim for pure-logic modules first — modules without GNOME Shell/Clutter dependencies

## Test Coverage

| Module | Status | Notes |
|---|---|---|
| `src/pets/petCollection.js` | ✅ Tested | 16 tests: stages, XP, crossbreeds, Mixie |
| `src/usage/tokenUsageManager.js` | ✅ Tested | Store creation, event recording, summaries |
| `src/shared/networkGuard.js` | ⚠️ Partial | Can be tested with Node.js outside GNOME Shell |
| `extension.js` | ❌ Untestable | Requires GNOME Shell runtime (Clutter, St) |
| `prefs.js` | ❌ Untestable | Requires GTK4/Adwaita runtime |
| `src/tools/*.js` | ❌ Untestable | Require Soup session or GNOME Shell APIs |

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
1. ☐ `make check` passes (syntax validation)
2. ☐ `make test` passes (unit tests)
3. ☐ `make compile-schemas` succeeds
4. ☐ `make package` creates valid zip
5. ☐ Extension enables/disables cleanly
6. ☐ Chat sends and receives with Ollama
7. ☐ Chat history saves and loads
8. ☐ Provider switching works
9. ☐ Dark/light theme switching works
10. ☐ Keyboard shortcut toggles chat
