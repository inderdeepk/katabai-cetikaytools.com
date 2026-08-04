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
