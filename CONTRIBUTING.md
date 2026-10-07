# Contributing to Katab

Thanks for your interest in contributing to Katab (ਕਿਤਾਬ), the GNOME desktop AI assistant!

## Code of Conduct

- Be respectful and constructive in all interactions.
- Focus on improving the extension for all users.
- Assume good faith from other contributors.

## Security

**Never commit API keys, credentials, or secrets to the repository.** Katab stores all secrets through GNOME's GSettings — API keys should never appear in source code, documentation, or configuration files. If you accidentally commit a secret, rotate it immediately and contact the maintainers.

For vulnerability disclosures, see [SECURITY.md](Documentation/Technical/SECURITY.md).

## Development Setup

1. **Clone the repository** into your GNOME Shell extensions directory:
   ```bash
   git clone https://github.com/inderdeepk/katabai-cetikaytools.com.git ~/.local/share/gnome-shell/extensions/katabai@cetikaytools.com
   cd ~/.local/share/gnome-shell/extensions/katabai@cetikaytools.com
   ```

2. **Compile GSettings schemas**:
   ```bash
   make compile-schemas
   # or: glib-compile-schemas schemas/
   ```

3. **Enable the extension**:
   ```bash
   gnome-extensions enable katabai@cetikaytools.com
   ```

4. **Reload after changes**: Use `Alt+F2`, type `r`, and press Enter (X11) or log out and back in (Wayland). Alternatively:
   ```bash
   gnome-extensions disable katabai@cetikaytools.com
   gnome-extensions enable katabai@cetikaytools.com
   ```

5. **View logs**:
   ```bash
   journalctl -f -o cat /usr/bin/gnome-shell | grep -i katab
   ```

`make reload` and `make logs` wrap steps 4 and 5 for quick iteration.

## Branching Strategy

- **`main`**: Stable branch. Only merge tested, reviewed changes.
- **`New-Features`**: Active development branch. Create feature branches from here.

### Workflow
1. Create a feature branch from `New-Features`.
2. Make your changes with clear, atomic commits.
3. Run the full local validation: `make check` (parse + CSS + import smoke), `make test`, `npm run lint`, and `npm run format:check` — CI runs all of them on every PR.
4. Test with a live GNOME Shell reload and verify no journal errors.
5. Open a pull request against `New-Features`.

## Coding Conventions

### JavaScript

- **ES Modules only**: Use `import`/`export` (no CommonJS `require`). GNOME Shell 46+ supports ES modules natively.
- **GObject classes**: Extend `GObject.Object` and register with `GObject.registerClass()` for UI actors.
- **Soup v3**: All HTTP uses `gi://Soup?version=3.0`. Import paths must include the version.
- **Async patterns**: Use `async`/`await` with `Gio.Cancellable` for network operations. Never block the main thread.
- **Error handling**: Always wrap `JSON.parse`, API calls, and file I/O in try/catch.
- **Formatting**: The repo is Prettier-formatted (4-space indent, single quotes, semicolons, 100 columns). Use `npm run format`, and make sure your editor's JS formatter is the workspace Prettier setup — a different formatter produces drift that fails CI's `format:check`.
- **Naming**: camelCase for variables and methods, PascalCase for classes, UPPER_SNAKE_CASE for constants.
- **Comments**: JSDoc-style for public APIs. Explain _why_, not _what_.

### GSettings Schema

- **After any XML edit**, recompile schemas:
  ```bash
  glib-compile-schemas schemas/
  ```
- Key naming: lowercase with hyphens (e.g., `deepseek-vision-model`).
- Keybinding keys must use type `as` (string array), not `s`.
- Default values must be valid for the key type.

### GNOME Shell St CSS

- **No `flex-wrap` or `text-transform`**: These CSS properties are not supported by GNOME Shell's St toolkit.
- **Avoid `border-radius` and `box-shadow`** on large/resizable containers: They trigger `ClutterOffscreenEffect` which creates GPU textures that can exceed `GL_MAX_TEXTURE_SIZE` on long content.
- **Use `rgba()` colors** for transparency, not `opacity`.
- **Dark/light variants**: All chat UI classes need both `.katab-theme-dark` and `.katab-theme-light` variants.

### Clutter UI Patterns

- **Creating selectable text**: Set `reactive=true`, `selectable=true`, `cursor_visible=true`, `editable=false`, and wire custom `button-press`/`motion`/`button-release` handlers that return `Clutter.EVENT_STOP`. Never set read-only `ClutterText` as editable — it strips Pango markup.
- **Byte vs. character offsets**: `clutter_text_coords_to_position()` returns UTF-8 byte indices, but `set_selection()` expects character offsets. Convert with a `g_utf8_strlen(text, maxbytes)` helper.
- **Key focus**: Use `widget.grab_key_focus()`, never `global.stage.set_key_focus()`.
- **Clipboard**: Use `St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text)`.

## Project Structure

```
extension.js          — Main entry: extension class, KatabDialog, Panel Indicator, ProviderHealthMonitor
prefs.js              — GTK4/Adwaita preferences orchestrator (pages live in src/ui/prefs/)
prefs.css             — Preferences window styling
stylesheet.css        — Shell overlay St CSS
metadata.json         — Extension manifest
schemas/              — GSettings schema XML + compiled binary
src/
├── core/             — HistoryManager, request-lifecycle FSM, tool-call markup
├── providers/        — Provider request builders, stream parsers, catalog
├── ui/               — Markdown render-model helpers + prefs/ page modules
├── tools/            — Tool implementations and declarative registry
├── research/         — Deep research pipeline (planner, branch runner, synthesis, compression, citations, cache)
├── usage/            — Token tracking, DeepSeek pricing, presets
├── pets/             — Pet collection system
└── shared/           — Shared utilities (HTTP body reader, SSRF guard)
tests/                — GJS unit-test suites
scripts/              — check-css.mjs + import-smoke.js dev checks (npm tooling in package.json; not shipped)
Documentation/        — Help, Technical, Archive, Research Reports
icons/                — Provider logos and custom icons
sprites/              — Pet sprite PNGs
```

See [ARCHITECTURE.md](Documentation/Technical/ARCHITECTURE.md) for detailed file descriptions and [DEVELOPMENT.md](Documentation/Technical/DEVELOPMENT.md) for developer guides.

## Adding Features

### Adding a New Provider
1. Add `-url`, `-api-key`, `-model` keys to `schemas/org.gnome.shell.extensions.katabai.gschema.xml`.
2. Add entries to `PROVIDER_LABELS` and `PROVIDER_META` in `src/providers/catalog.js`.
3. Add the provider page in `src/ui/prefs/providerPages.js` (simple URL/key/model shape) — or a dedicated module under `src/ui/prefs/` if it needs more than the shared row builders.
4. Add the streaming request builder in `src/providers/chatRequest.js` (and the non-streaming variant in `src/providers/nonStreamingRequest.js`).
5. Add the stream-line parser + tool-call accumulation in `src/providers/streamParse.js`.
6. Add health probe to `ProviderHealthMonitor`.
7. Recompile schemas and test with a live reload.

### Adding a New Tool
1. Define the tool in `src/tools/toolDefinitions.js` using `registerTool()`.
2. Create a runtime module in `src/tools/` if needed.
3. Add handler dispatch in `extension.js::_handleToolCalls()`.
4. Add GSettings keys if the tool is configurable.
5. Add a preferences section under `src/ui/prefs/tools/` (export a `build…Section(ctx)` returning the tool subpage, then register it in `tools/index.js`).
6. Add UI button in `extension.js` footer if user-triggerable.
7. Consider SSRF safety for any network tool.

## Testing

```bash
# Run unit tests
make test

# ES module syntax check, CSS delimiter balance, and gjs import smoke
make check

# ESLint (requires Node.js — run `npm ci` once)
npm run lint

# Prettier formatting
npm run format        # rewrite files to canonical style
npm run format:check  # verify (CI gate)
```

- Unit tests use GJS (`gjs -m`) and live in `tests/`.
- Only pure-logic modules without GNOME Shell/Clutter dependencies can be unit tested.
- The authoritative validation is a live GNOME Shell reload. Check `journalctl` for errors.
- Functional testing of UI, streaming, and tool-calling requires a running GNOME Shell session with configured providers.

See [TESTING.md](Documentation/Technical/TESTING.md) for detailed testing procedures.

## Translations

Katab uses standard GNOME gettext conventions. Translatable strings are wrapped
with `_()` / `ngettext()` imported from `src/shared/i18n.js` — a tiny bridge
that both entry points wire to the shell's own gettext functions
(`enable()` in `extension.js`, `fillPreferencesWindow()` in `prefs.js`). Until a
language is installed the bridge passes strings through unchanged.

- **Refresh the template** after adding/removing wrapped strings: `make pot`
  (updates `po/katabai@cetikaytools.com.pot`; sources are listed in
  `po/POTFILES.in` — keep it in sync with new files).
- **Start a new language**: `msginit -i po/katabai@cetikaytools.com.pot -l xx -o po/xx.po`
  (or copy an existing `.po`), translate, then `make langs` to compile
  `locale/xx/LC_MESSAGES/katabai@cetikaytools.com.mo`.
- **Never commit** compiled `.mo` files or the generated `locale/` tree — both
  are gitignored and rebuilt by `make langs`. Commit `.po` sources only.
- Test a language with `LANG=xx.UTF-8` plus a shell reload (Alt+F2 → r) and
  `gnome-extensions prefs katabai@cetikaytools.com`.

## Release Checklist

For maintainers publishing a release:

1. **Bump the version** in `metadata.json` — it must be **monotonic** (extensions.gnome.org rejects uploads whose version does not increase).
2. **Update `CHANGELOG.md`**: move the `[Unreleased]` entries under a new version/date heading.
3. **Validate**: `make check && make test` (CI runs the same on every push), plus a live shell reload and smoke test — send, cancel mid-stream, one tool-call turn, history reload, and a deep-research run.
4. **Package**: `make package` produces the distributable zip; verify it contains `schemas/gschemas.compiled`.
5. **Publish**: upload the zip to extensions.gnome.org (or install it locally for a final check).

## GNOME Shell Compatibility Policy

Katab supports the shell versions listed in `metadata.json` (`shell-version`). When a new GNOME Shell release appears:

1. Run the extension on the new shell (X11 and Wayland if possible).
2. Exercise the release smoke test above and scan the journal for new warnings/criticals (`make logs`).
3. Check shell API changes against the release notes (St/Clutter/Pango/Soup usage in particular).
4. Only then add the new version to `metadata.json` — never pre-emptively.
5. Keep changes compatible with the oldest supported version until a deliberate, documented drop.

## Documentation

- **User-facing**: `README.md` and `Documentation/Help/UserGuide.md`.
- **Technical**: `Documentation/Technical/` — architecture, security, testing, development, API reference, deep research.
- **Changelog**: `CHANGELOG.md` — update with each PR under `[Unreleased]`.
- Use the existing document structure and style when adding new documentation.
- Cross-reference between documents using relative Markdown links.
- Keep documentation factual and accurate — verify all GSettings keys, endpoint URLs, and command examples.
