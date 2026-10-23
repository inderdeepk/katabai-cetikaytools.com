# Katab Documentation Index

This directory holds every Katab document except `README.md`, `CONTRIBUTING.md`, and
`CHANGELOG.md`, which live at the repository root.

## Start Here

| Audience | Document |
|---|---|
| New users | [User Guide](Help/UserGuide.md) — day-one setup, every feature, troubleshooting |
| New contributors | [Contributing](../CONTRIBUTING.md) → [Development Guide](Technical/DEVELOPMENT.md) |
| Reviewers / maintainers | [Architecture](Technical/ARCHITECTURE.md), [Testing](Technical/TESTING.md), [Security](Technical/SECURITY.md) |

## Current Documentation

| Document | Audience | Contents |
|---|---|---|
| [User Guide](Help/UserGuide.md) | Users | Provider setup, slash commands, tools, deep research, token breakdown, pets, history, preferences, troubleshooting, glossary |
| [Architecture](Technical/ARCHITECTURE.md) | Contributors | Entry points, source layout, request lifecycle, session memory, tools, RAG, providers, token/pet system, theme, health monitor |
| [API Reference](Technical/API_REFERENCE.md) | Integrators / contributors | Every GSettings key, every tool schema sent to models, and the external service APIs Katab talks to |
| [Deep Research](Technical/DEEP_RESEARCH.md) | Contributors | Pipeline phases, module map, compression tiers, thresholds, depth levels, failure handling |
| [Development Guide](Technical/DEVELOPMENT.md) | Contributors | Environment setup, conventions, fidelity audits, adding providers/tools/pets, debugging, schema management |
| [Testing](Technical/TESTING.md) | Contributors | Test commands, syntax/import checks, RAG tests, coverage table, release checklists, CI |
| [Security](Technical/SECURITY.md) | Users / reviewers | Vulnerability reporting, secret storage, tool safety, data-at-rest inventory |

Supporting READMEs live next to the code they describe:

- [RAG service](../rag-service/README.md) — local FastAPI + ChromaDB service.
- [Fidelity audits](../scripts/audits/README.md) — refactor-verification scripts.
- [Mixie sprites](../sprites/mixie/README.md) — legacy placeholder; not used at runtime.

## Historical Material (not current documentation)

| Directory | What it is |
|---|---|
| [Archive/](Archive/) | Finished design documents kept for provenance: the pet collection implementation plan and the sprite checklist. Implementation details may have drifted; treat the code as authoritative. |
| [Research-Reports/](Research-Reports/) | External API/product research that informed early design. Reports describe candidate designs, not necessarily what shipped. |

## Documentation Rules

1. **Code is the source of truth.** Verify GSettings keys against
   `schemas/org.gnome.shell.extensions.katabai.gschema.xml`, tool schemas against
   `src/tools/toolDefinitions.js`, and constants against `extension.js`.
2. **Keep cross-references relative** (`Technical/ARCHITECTURE.md` from this folder,
   `Documentation/Technical/...` from the repository root).
3. **Never include real secrets.** Use `sk-xxxxxxxxxxxx` placeholders.
4. **Update the owning document** when you change behavior:
   - New setting → [Technical/API_REFERENCE.md](Technical/API_REFERENCE.md) and the relevant
     preferences section in [Help/UserGuide.md](Help/UserGuide.md).
   - New tool/command → [API_REFERENCE](Technical/API_REFERENCE.md),
     [ARCHITECTURE](Technical/ARCHITECTURE.md), and [UserGuide](Help/UserGuide.md).
   - New module → the source layout in [ARCHITECTURE](Technical/ARCHITECTURE.md) and, if it joins
     the i18n scan, `po/POTFILES.in`.
   - New user-facing behavior → `CHANGELOG.md` under `[Unreleased]`.
5. **Date large rewrites** in the change log rather than in the body of a doc, so
   documents describe the present rather than a snapshot.
