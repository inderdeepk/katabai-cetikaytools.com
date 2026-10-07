# Fidelity audits

These scripts prove that each past refactor was a **pure code move**: they
extract the original method bodies from git history, apply the mechanical
transforms that the move performed (renames, `this._x` → `host.x`, …), and
flat-compare the result against the current sources. A `FIDELITY: PASS` means
every moved line survived verbatim (modulo the documented transforms and
explicit allowances).

Run them from the repository root:

```sh
make audit            # all audits
node scripts/audits/audit-pickers.mjs   # a single audit
```

## Baselines

Each audit loads its "old" source via `loadBaseline(ref)` (`git show
<ref>:extension.js`) — see the header of each file for its exact ref. On a
shallow clone (CI checkouts default to `fetch-depth: 1`) the commit object is
missing and the audit prints `[SKIP]` and exits 0, so `make audit` is safe
everywhere; run it locally or in a full-history checkout for real coverage.

| Audit | Proves | Baseline |
|---|---|---|
| `audit-welcome.mjs` | welcome panel extraction → `src/ui/welcomePanel.js` | `100a1d0` |
| `audit-usage.mjs` | usage panel extraction → `src/ui/usagePanel.js` | `100a1d0` |
| `audit-history.mjs` | history view extraction → `src/ui/historyView.js` | `100a1d0` |
| `audit-session-info.mjs` | session info popup → `src/ui/sessionInfoPopup.js` | `100a1d0` |
| `audit-tools-popup.mjs` | tools popup → `src/ui/toolsPopup.js` (+ tool modes) | `6d6d896` |
| `audit-recent-chats.mjs` | recent-chats preview → `src/ui/recentChatsPopup.js` | `6d6d896` |
| `audit-header-bar.mjs` | header row → `src/ui/headerBar.js` | `fc4f882` |
| `audit-pickers.mjs` | picker panels → `src/ui/pickers.js` | `fc4f882` |
| `audit-message-bubbles.mjs` | message frame → `src/ui/messageBubble.js` | `d3a612f` |
| `audit-assistant-render.mjs` | render pipeline → `src/ui/assistantRender.js` | `0e3ad5d` |
| `audit-constructor.mjs` | constructor decomposition (line-coverage style) | `d1879c9` |
| `audit-handleStreamEnd.mjs` | SSE stream-end decomposition (slice + line-coverage style) | `d3b49ef` |

## How an audit works

1. **Extract** each old method body by name (`extractMethod`-style, walking
   the full parameter list so multi-line signatures work).
2. **Transform** the old body with an ordered `SUBS` list — every rename or
   signature change the move performed. Order matters: multi-line block
   rewrites first, then method renames, then generic `this._x` substitutions.
3. **Flat-compare** the transformed old body against the new module body:
   whitespace-insensitive, trailing commas before closers dropped,
   box-drawing comment runs collapsed (see `lib.js`).
4. **Allowances**: intentional comment updates (`_makeTextSelectable` →
   `makeTextSelectable`), post-pass additions (`accessible_name`, `_(...)`
   i18n wrappers), and constructor preamble/epilogue lines are removed from
   the *module* side via explicit allow-lists — never by broad regexes that
   could mask real drift.
5. Extra checks per audit: forbidden residual patterns in `extension.js`,
   wrapper delegation strings, host-bag keys, import/smoke-exclusion state.

## Adding an audit for a new refactor

1. Note the current `HEAD` commit — that becomes the baseline ref.
2. Before moving code, snapshot nothing: the audit recovers the old body
   from `git show <ref>:extension.js` later.
3. After the move, write `scripts/audits/audit-<name>.mjs` in the same shape
   (`loadBaseline(ref)` + extract + SUBS + flat compare + residual/wrapper
   checks). New audits may `import { extractMethod, flat, normalizedLines,
   countLines } from './lib.js'` instead of copying them.
4. For in-place reorganizations (like the constructor decomposition) use the
   **line-coverage** variant: multiset comparison of normalized lines
   between the old body and (new body + extracted methods), plus per-method
   "contiguous slice" substring checks.
5. `node scripts/audits/audit-<name>.mjs` until PASS, then `make audit`.

## Pitfalls (learned the hard way)

- Line comments are **not** stripped by `flat()` — comment renames need an
  explicit allowance.
- Comments **above** a method signature are outside the extracted body and
  are not compared.
- Exact-match allow-lists, not wildcard regexes: a greedy
  `accessible_name:[^,]*` also stripped pre-existing names and produced false
  diffs.
- `const` does **not** hoist — helper constants used during the comparison
  loop must be declared above it (`ReferenceError: Cannot access … before
  initialization`).
- When replacing a block with an empty string, plan the re-insertion in the
  same pass; the line-coverage check is what guarantees nothing was lost.
