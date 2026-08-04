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

## Branching Strategy

- **`main`**: Stable branch. Only merge tested, reviewed changes.
- **`New-Features`**: Active development branch. Create feature branches from here.

### Workflow
1. Create a feature branch from `New-Features`.
2. Make your changes with clear, atomic commits.
3. Run `make check` and `make test` to validate.
4. Test with a live GNOME Shell reload and verify no journal errors.
5. Open a pull request against `New-Features`.

## Coding Conventions

### JavaScript

- **ES Modules only**: Use `import`/`export` (no CommonJS `require`). GNOME Shell 46+ supports ES modules natively.
- **GObject classes**: Extend `GObject.Object` and register with `GObject.registerClass()` for UI actors.
- **Soup v3**: All HTTP uses `gi://Soup?version=3.0`. Import paths must include the version.
- **Async patterns**: Use `async`/`await` with `Gio.Cancellable` for network operations. Never block the main thread.
- **Error handling**: Always wrap `JSON.parse`, API calls, and file I/O in try/catch.
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
extension.js          — Main entry: extension class, KatabDialog, HistoryManager, ProviderHealthMonitor, Indicator
prefs.js              — GTK4/Adwaita preferences window
prefs.css             — Preferences window styling
stylesheet.css        — Shell overlay St CSS
metadata.json         — Extension manifest
schemas/              — GSettings schema XML + compiled binary
src/
├── core/             — Planned refactoring targets (currently empty)
├── tools/            — Tool implementations and declarative registry
├── research/         — Deep research: compression, citations, cache
├── usage/            — Token tracking, presets
├── pets/             — Pet collection system
└── shared/           — Shared utilities (SSRF guard)
tests/                — Unit tests
Documentation/        — Help, Technical, Archive, Research Reports
icons/                — Provider logos and custom icons
sprites/              — Pet sprite PNGs
```

See [ARCHITECTURE.md](Documentation/Technical/ARCHITECTURE.md) for detailed file descriptions and [DEVELOPMENT.md](Documentation/Technical/DEVELOPMENT.md) for developer guides.

## Adding Features

### Adding a New Provider
1. Add `-url`, `-api-key`, `-model` keys to `schemas/org.gnome.shell.extensions.katabai.gschema.xml`.
2. Add entries to `PROVIDER_LABELS` and `PROVIDER_META` constants in `extension.js`.
3. Add provider page to `prefs.js`.
4. Add payload builder in `extension.js::_streamResponse()`.
5. Add SSE parser in `extension.js::_readSSE()`.
6. Add health probe to `ProviderHealthMonitor`.
7. Recompile schemas and test with a live reload.

### Adding a New Tool
1. Define the tool in `src/tools/toolDefinitions.js` using `registerTool()`.
2. Create a runtime module in `src/tools/` if needed.
3. Add handler dispatch in `extension.js::_handleToolCalls()`.
4. Add GSettings keys if the tool is configurable.
5. Add preferences subpage in `prefs.js`.
6. Add UI button in `extension.js` footer if user-triggerable.
7. Consider SSRF safety for any network tool.

## Testing

```bash
# Run unit tests
make test

# Syntax check
make check
```

- Unit tests use GJS (`gjs -m`) and live in `tests/`.
- Only pure-logic modules without GNOME Shell/Clutter dependencies can be unit tested.
- The authoritative validation is a live GNOME Shell reload. Check `journalctl` for errors.
- Functional testing of UI, streaming, and tool-calling requires a running GNOME Shell session with configured providers.

See [TESTING.md](Documentation/Technical/TESTING.md) for detailed testing procedures.

## Documentation

- **User-facing**: `README.md` and `Documentation/Help/UserGuide.md`.
- **Technical**: `Documentation/Technical/` — architecture, security, testing, development, API reference, deep research.
- **Changelog**: `CHANGELOG.md` — update with each PR under `[Unreleased]`.
- Use the existing document structure and style when adding new documentation.
- Cross-reference between documents using relative Markdown links.
- Keep documentation factual and accurate — verify all GSettings keys, endpoint URLs, and command examples.
