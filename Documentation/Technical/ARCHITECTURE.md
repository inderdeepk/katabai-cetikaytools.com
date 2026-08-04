# Katabai Architecture

## Overview

Katab (ਕਿਤਾਬ) is a GNOME Shell extension providing a desktop AI assistant overlay that connects to multiple LLM providers (Ollama, Unsloth, OpenAI, Anthropic, DeepSeek) with tools for web search, web scraping, document parsing, knowledge base search, and deep research.

## Entry Points

| File | Role | Loaded By |
|---|---|---|
| `metadata.json` | Extension manifest | GNOME Shell |
| `extension.js` | Main JS entry — enable/disable, panel indicator, imports from `src/` | GNOME Shell |
| `prefs.js` | GTK4/Adwaita preferences window | GNOME Shell prefs system |
| `stylesheet.css` | Shell overlay St CSS (GNOME auto-loads from root) | GNOME Shell |
| `prefs.css` | GTK preferences CSS (loaded by prefs.js) | prefs.js |

## Source Layout (`src/`)

```
src/
├── core/          # Major classes (extracted from extension.js monolith over time)
│   ├── historyManager.js        ← Conversation persistence (planned)
│   ├── providerHealthMonitor.js ← Health polling (planned)
│   ├── katabDialog.js           ← Main chat UI + orchestration (planned)
│   └── indicator.js             ← Panel button + menu (planned)
├── tools/         # Tool implementations and declarative registry
│   ├── toolRegistry.js          ← Declarative tool registry (ToolDefinition map)
│   ├── toolDefinitions.js       ← Concrete tool definitions (side-effect import)
│   ├── webSearchTools.js        ← SearxNG search + read_url
│   ├── crawl4aiTools.js         ← Crawl4AI web scraping
│   ├── ragTools.js              ← Local RAG / knowledge base search
│   └── documentTools.js         ← Local file attachment parser
├── research/      # Deep research pipeline
│   ├── compressionTools.js      ← LLM-based hierarchical compression
│   ├── citationTracker.js       ← Citation → bibliography binding
│   ├── researchCache.js         ← Persistent search/crawl result cache
│   └── deepResearch.js          ← Deep research orchestration (planned)
├── usage/         # Token economy and presets
│   ├── tokenUsageManager.js     ← Token tracking, budget, achievements
│   └── presetManager.js         ← Ollama preset CRUD
├── pets/          # Provider pet collection system
│   ├── petCollection.js         ← Pet data definitions, stages, forms
│   └── petSpriteActor.js        ← Clutter sprite renderer
└── shared/        # Shared utilities
    └── networkGuard.js          ← SSRF protection (IPv4/IPv6 blocklists)
```

## Assets

| Directory | Contents |
|---|---|
| `icons/` | Provider logos + custom SVG icons (9 files) |
| `sprites/` | Pet sprites (clyde, ollie, pearl, slothy, sparky, eggs, accents, mixie) |
| `schemas/` | GSettings schema XML + compiled binary |

## Key Design Patterns

- **ES Modules**: All JS files use `import`/`export` (no CommonJS). The GNOME Shell 46+ JS engine supports ES modules natively.
- **GObject Classes**: UI actors extend `GObject.Object` and register with `GObject.registerClass()`.
- **Soup v3**: All HTTP communication uses `Soup.Session` v3 (`gi://Soup?version=3.0`).
- **Provider Dialect Pattern**: Each provider has its own payload builder, SSE parser, and authentication in `extension.js::_streamResponse()` / `_readSSE()`.
- **Tool Registry**: Tools are declared in `src/tools/toolDefinitions.js` via `registerTool()` and dispatched by `extension.js::_handleToolCalls()`.
- **Debounced Persistence**: `HistoryManager` uses in-memory cache + 200ms debounced writes.
- **Pet Collection**: Independent XP per provider pet, crossbreed unlocks, collection rewards.

## Dependencies

- **GNOME Shell 46+** — `St`, `Clutter`, `Pango`, `GLib`, `Gio`, `Meta`, `Shell`
- **Soup 3.0** — HTTP client
- **Adw 1.5+** — Preferences window (for `Adw.NavigationPage` push_subpage)
- **Optional external services**: Ollama, SearxNG, Crawl4AI, local RAG service, OpenAI API, Anthropic API
- **Optional system tools**: `pdftotext` (poppler), `pandoc` (DOCX)
