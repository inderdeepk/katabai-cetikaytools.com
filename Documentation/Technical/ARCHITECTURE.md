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

---

## Data Flow

### Message Send Pipeline

```
User types message, presses Enter
        │
        ▼
_sendMessage() ── async
    ├── Parse slash commands (/search, /doc, /crawl, /kb, /research)
    ├── Attach documents (if /doc or footer Docs button)
    ├── Auto KB search (if RAG enabled, Auto mode, 3s timeout)
    ├── Vision analysis (if DeepSeek + images + vision model configured)
    ├── Push user message to _messageHistory
    ├── _saveCurrentConversation() + flushSync()
    │
    ▼
_streamResponse()
    ├── Build provider-specific payload
    │   ├── Ollama: /api/chat with options, think, format
    │   ├── DeepSeek: /chat/completions with thinking, reasoning_effort
    │   ├── Unsloth: /chat/completions with enable_tools
    │   ├── OpenAI: /chat/completions with tools
    │   └── Anthropic: /v1/messages with system, max_tokens
    ├── Set provider-appropriate timeout
    ├── Inject web content safety policy
    ├── Advertise tools (if enabled, not force-synthesizing)
    ├── POST request via Soup.Session
    │
    ▼
_readSSE() ── async recursive
    ├── Read line from response stream
    ├── Parse per provider:
    │   ├── Ollama: JSON.parse(line), extract message.content/reasoning/tool_calls
    │   ├── OpenAI/Unsloth/DeepSeek: strip "data: ", JSON.parse, extract choices[0].delta.content
    │   └── Anthropic: parse content_block_delta, tool_use, input_json_delta
    ├── Accumulate: responseState.accumulatedText, accumulatedThink, accumulatedToolCalls
    ├── Render streaming UI (_renderAssistantStreamingFast)
    │
    ▼
EOF (lineBytes === null)
    ├── If tool calls present:
    │   ├── _handleToolCalls() → execute tools (parallel for read_only, sequential for unsafe)
    │   ├── Push tool results to _messageHistory
    │   ├── _saveCurrentConversation() + flushSync()
    │   ├── Check force-synthesis thresholds
    │   └── Recurse → _streamResponse() with tool results in context
    │
    └── If no tool calls (or force-synthesizing):
        ├── _buildAssistantHistoryMessage()
        ├── Push to _messageHistory
        ├── _saveCurrentConversation() + flushSync()
        ├── Record token usage (tokenUsageManager.recordUsageEvent)
        ├── Update pet XP, check combos, check budget
        └── Render final response with sources, citations
```

### History Persistence

```
HistoryManager (static)
    ├── _cache: Array (in-memory, loaded once from disk)
    ├── _dirty: boolean (true when cache has unsaved changes)
    ├── _flushTimer: GLib timeout id (200ms debounce)
    │
    ├── load() → returns cache (reads disk on first call)
    ├── getCached() → returns cache (never reads disk)
    ├── saveConversation(entry) → mutate cache in-place, scheduleFlush()
    ├── deleteConversation(id) → mutate cache in-place, scheduleFlush()
    ├── _scheduleFlush() → set dirty, arm 200ms timer → _flushNow()
    ├── flushSync() → clear timer, _flushNow() immediately
    └── invalidateCache() → null cache (force reload on next load())
```

---

## Provider Payload Dialects

### Ollama
- **Endpoint**: `{url}/api/chat`
- **Method**: POST
- **Auth**: None
- **Stream format**: Raw JSON lines (no `data:` prefix)
- **Special fields**: `message.reasoning` (thinking), `message.images[]` (vision), `message.tool_calls[]`
- **Final chunk**: `done: true` with `load_duration`, `prompt_eval_count`, `eval_count`, `eval_duration`
- **Timeout**: 0 (no timeout — Ollama is local, user can cancel via stop button)

### DeepSeek
- **Endpoint**: `{url}/chat/completions`
- **Method**: POST
- **Auth**: `Authorization: Bearer <api-key>`
- **Stream format**: `data: {...}` SSE
- **Special**: `thinking` object, `reasoning_effort`, `response_format` (JSON mode)
- **Models**: `deepseek-v4-flash` (fast), `deepseek-v4-pro` (reasoning)
- **Vision**: Text-only — images routed through separately configured vision model
- **Timeout**: `DEEPSEEK_STREAM_TIMEOUT_SECONDS`

### Unsloth Studio
- **Endpoint**: `{url}/chat/completions`
- **Method**: POST
- **Auth**: `Authorization: Bearer <api-key>` (optional)
- **Stream format**: `data: {...}` SSE (OpenAI-compatible)
- **Special**: `enable_tools`, `enabled_tools`, `session_id`, `tool_choice`
- **Server-side tools**: web_search, python, terminal (not executed locally)

### OpenAI
- **Endpoint**: `{url}/chat/completions`
- **Method**: POST
- **Auth**: `Authorization: Bearer <api-key>`
- **Stream format**: `data: {...}` SSE
- **Tools**: OpenAI function-calling format

### Anthropic
- **Endpoint**: `{url}/v1/messages`
- **Method**: POST
- **Auth**: `x-api-key: <api-key>`
- **Headers**: `anthropic-version: 2023-06-01`
- **Stream format**: `data: {...}` SSE (content_block_start/delta/stop, message_stop)
- **Tools**: Anthropic tool_use format with input_json_delta
- **System prompt**: Top-level `system` field (not in messages array)
- **Max tokens**: `max_tokens: 4096`

---

## Tool-Calling Architecture

### Tool Registry (`src/tools/toolRegistry.js`)
- Declarative `Map<name, ToolDefinition>`
- Each tool: `name`, `description`, `parameters` (JSON Schema), `dangerLevel`, `handler`, `uiLabel`, `uiIcon`, `command`, `resultTruncationKey`, `isMeta`, `providerScoped`
- Schema builders: `buildAllToolSchemas(provider)`, `buildToolSchemasFor(toolNames, provider)`

### Danger Level Model
| Level | Tools | Execution |
|---|---|---|
| `read_only` | web_search, read_url, crawl_url, knowledge_search | Parallel via `Promise.all()` |
| `potentially_unsafe` | document (reserved: python, terminal) | Sequential with delay |

### Tool Execution Flow
```
_handleToolCalls(toolCalls, uiElements)
    ├── Validate _responseUiAlive(uiElements)
    ├── Partition by dangerLevel
    ├── read_only tools → Promise.all() parallel execution
    ├── potentially_unsafe tools → sequential with delay
    ├── Each tool result truncated via _truncateToolResultForIteration()
    ├── Push results to _messageHistory + flushSync()
    ├── Check force-synthesis thresholds
    └── Recurse _streamResponse() with updated context
```

### Healing Retry
When a model emits raw tool-call markup (malformed JSON or XML) instead of proper function calls:
1. Detect via `_contentLooksLikeToolCalls()`
2. Strip markup with `_stripToolCallMarkup()`
3. Inject `TOOL_CALL_HEALING_INSTRUCTION` correction prompt
4. Retry up to `MAX_HEALING_RETRIES=3` times (does not increment `_toolIterations`)
5. On exhaustion: show cleaned text or error

### Force Synthesis
When tool iterations or context size exceed thresholds:
1. Set `_forceSynthesisActive = true`
2. Stop advertising tools in the API payload
3. Inject `FORCE_SYNTHESIS_SYSTEM_INSTRUCTION` (deep research) or `REGULAR_SYNTHESIS_SYSTEM_INSTRUCTION` (normal)
4. Model is compelled to write its answer without further tool calls

---

## Token Usage & Pet System

### Token Ledger (`src/usage/tokenUsageManager.js`)
- **Storage**: `~/.local/share/katabai/token-usage.json`
- **Record**: Per-response event with provider, model, prompt/completion/reasoning/cached tokens, source (exact or estimated), cost
- **Aggregation**: Daily buckets, time-range summaries
- **Pricing**: Built-in `MODEL_PRICING` table for cost estimation
- **Achievements**: 21 badges across progression (First Reply, 100/1K/10K/100K tokens), streak (3/7/14/30-day), and special categories
- **Combo**: Per-conversation reply streak with token score
- **Exports**: JSON, CSV, Markdown report, self-contained HTML

### Pet Collection (`src/pets/petCollection.js`)
- **Pure rules module**: No GNOME Shell dependencies
- **5 provider pets**: Defined as frozen objects in `PET_DEFINITIONS`
- **6 stages**: Frozen array in `PET_STAGES` with `rank`, `minXp`, `key`, `label`, `spriteFamily`
- **Crossbreeds**: Computed from `getQualifyingPairKeys()` — both pets at Sprout+
- **Mixie**: `canUnlockMixie()` — all 5 pets at Sprout+
- **XP tracking**: Stored in `tokenUsageManager` alongside usage data

### Pet Sprite Actor (`src/pets/petSpriteActor.js`)
- Clutter-based renderer with idle animation (cycling through sprite frames)
- Sleep cycle on idle timeout
- Accent overlay sprites per provider
- Animation gated by `_animate` flag (main companion animates, panel/collection actors are static)

---

## Theme System

### Two Separate Stylesheets
- **Shell overlay**: `stylesheet.css` — St CSS, auto-loaded by GNOME Shell from extension root
- **Preferences window**: `prefs.css` — GTK CSS, loaded by `prefs.js` via `Gtk.CssProvider`
- **Never mix**: St CSS rules do not work in GTK, and vice versa

### Detection
- **Shell side**: Reads `org.gnome.desktop.interface` `color-scheme` key (`'prefer-dark'` = dark, `'default'` = light)
- **Prefs side**: Uses `Adw.StyleManager.get_default()` with `notify::dark` signal
- Both listen for live changes and update immediately

### Class Application
- Shell dialog and panel menu: `.katab-theme-dark` / `.katab-theme-light` on actor
- Prefs window: `.katab-prefs-theme-dark` / `.katab-prefs-theme-light` on window

---

## Provider Health Monitor

### Architecture
- Singleton at extension level — shared by panel indicator and dialog
- Polls every 15 seconds (configurable)
- Tri-state: `checking` → `online` / `down` / `needs-setup`
- Emits status changes to subscribers

### Probes
| Provider | Endpoint | What It Checks |
|---|---|---|
| Ollama | `GET /api/tags` | Service is running, returns models |
| Unsloth | `POST /tokenize` | API is reachable and responding |
| OpenAI | `GET /v1/models` | API key is valid, service is up |
| DeepSeek | `GET /user/balance` | API key is valid, balance is sufficient |
| Anthropic | `GET /v1/models` | API key is valid, service is up |
