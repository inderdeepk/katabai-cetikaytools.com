# Katabai Architecture

## Overview

Katab (ਕਿਤਾਬ) is a GNOME Shell extension providing a desktop AI assistant overlay that connects to multiple LLM providers (Ollama, Unsloth, OpenAI, Anthropic, DeepSeek) with tools for web search, web scraping, document parsing, knowledge base search, and deep research.

## Entry Points

| File | Role | Loaded By |
|---|---|---|
| `metadata.json` | Extension manifest | GNOME Shell |
| `extension.js` | Main JS entry — enable/disable, panel indicator, imports from `src/` | GNOME Shell |
| `prefs.js` | GTK4/Adwaita preferences orchestrator (pages in `src/ui/prefs/`) | GNOME Shell prefs system |
| `stylesheet.css` | Shell overlay St CSS (GNOME auto-loads from root) | GNOME Shell |
| `prefs.css` | GTK preferences CSS (loaded by prefs.js) | prefs.js |

## Source Layout (`src/`)

```
src/
├── core/          # Shared infrastructure
│   ├── historyManager.js        ← Conversation persistence (debounced writes)
│   ├── requestLifecycle.js      ← Request lifecycle state machine (idle → enriching → awaiting-model ⇄ tool-loop → synthesis → stopping → done/error)
│   └── toolCallMarkup.js        ← Tool-call markup normalization/stripping
├── providers/     # Provider adapters (request builders + stream parsing)
│   ├── catalog.js               ← Provider labels/meta/model catalogs (single source)
│   ├── chatRequest.js           ← Streaming request builders (all providers)
│   ├── nonStreamingRequest.js   ← Non-streaming request builders + response extraction
│   ├── historyPayload.js        ← Token estimates, context truncators, attachment payloads, provider-dialect sanitization
│   └── streamParse.js           ← SSE/NDJSON line parsing + tool-call accumulation
├── ui/            # Render-model helpers + shell widgets + preferences pages
│   ├── markdownRender.js        ← Markdown segmentation + inline formatting
│   ├── welcomePanel.js          ← Animated welcome scene (book, pages, dust) — owns actor tree + GLib timers
│   ├── usagePanel.js            ← "AI Token Breakdown" panel — tabs, range dropdown, companion/activity/spending cards
│   ├── historyView.js           ← History panel — list/search/tabs, KB search, conversation metadata editor
│   ├── sessionInfoPopup.js      ← Floating Session Info panel — context breakdown + summarize/compact actions
│   ├── toolsPopup.js            ← Floating Tools panel — tool rows + Auto/On/Off mode cycling
│   ├── recentChatsPopup.js      ← Header history-button hover preview — recent conversations
│   ├── headerBar.js             ← Chat header row (buildHeaderBar) — logo/title, provider chip, pickers, usage button + pet, history button, actions
│   ├── pickers.js               ← Picker panels — Ollama presets, provider (engine), DeepSeek models + shared shell/rows
│   ├── messageBubble.js         ← Chat message bubbles — row/bubble shell, thinking + tool log, footer copy/regenerate, cache/KB pills, attachments
│   ├── assistantRender.js       ← Assistant reply rendering — streaming dispatch, markdown segments, citations, sources, selection
│   └── prefs/                   ← Preferences window modules (prefs.js is an 86-line orchestrator)
│       ├── widgets.js           ← createPrefsContext: shared page/group/row builders + watch()/dispose()
│       ├── generalPage.js       ← General page (provider cards, appearance, shortcut, budget)
│       ├── ollamaPage.js        ← Ollama page (presets, connection, sampling, hardware)
│       ├── deepseekPage.js      ← DeepSeek page (balance, vision model, reasoning)
│       ├── providerPages.js     ← Unsloth / OpenAI / Anthropic pages
│       └── tools/               ← Tools page: index.js aggregator + document, webSearch, crawler, knowledge, deepResearch
├── tools/         # Tool implementations and declarative registry
│   ├── toolRegistry.js          ← Declarative tool registry (ToolDefinition map)
│   ├── toolDefinitions.js       ← Concrete tool definitions (side-effect import)
│   ├── webSearchTools.js        ← SearxNG search + read_url
│   ├── crawl4aiTools.js         ← Crawl4AI web scraping
│   ├── ragTools.js              ← Local RAG / knowledge base search
│   ├── exploreDocsTools.js      ← Agent-directed docs navigation
│   └── documentTools.js         ← Local file attachment parser
├── research/      # Deep research pipeline
│   ├── prompts.js               ← Research system prompts + response parsers
│   ├── planner.js               ← Planner agent + plan revision
│   ├── pipeline.js              ← Analysis phases (gap analysis, critiques, outline + quality check)
│   ├── branchRunner.js          ← Branch execution (search → crawl → compress), refinement, retries
│   ├── synthesisPrompt.js       ← Final-report prompt builder + contradiction detection
│   ├── compressionTools.js      ← LLM-based hierarchical compression
│   ├── citationTracker.js       ← Citation → bibliography binding
│   └── researchCache.js         ← Persistent search/crawl result cache + checkpoints
├── usage/         # Token economy and presets
│   ├── tokenUsageManager.js     ← Token tracking, budget, achievements
│   ├── deepseekPricing.js       ← DeepSeek peak/off-peak pricing (single source)
│   └── presetManager.js         ← Ollama preset CRUD
├── pets/          # Provider pet collection system
│   ├── petCollection.js         ← Pet data definitions, stages, forms
│   └── petSpriteActor.js        ← Clutter sprite renderer
└── shared/        # Shared utilities
    ├── httpBody.js              ← Capped HTTP body reader (shared by all tool runtimes)
    ├── toolModes.js             ← Auto/On/Off mode constants + labels (dialog cycling + tools popup)
    └── networkGuard.js          ← SSRF protection (IPv4/IPv6 blocklists)
```

> **Decomposition status (Oct 2026)**: `prefs.js` is fully split — an 86-line orchestrator plus the `src/ui/prefs/` modules above. Provider payload shaping lives in `src/providers/historyPayload.js` (43 unit tests), the welcome scene in `src/ui/welcomePanel.js`, the token-breakdown panel in `src/ui/usagePanel.js`, the history panel (list + KB search + metadata editor) in `src/ui/historyView.js`, the Session Info popup in `src/ui/sessionInfoPopup.js`, the tools popup in `src/ui/toolsPopup.js`, the recent-chats preview in `src/ui/recentChatsPopup.js`, the chat header row in `src/ui/headerBar.js`, the picker panels in `src/ui/pickers.js`, and the chat message bubbles in `src/ui/messageBubble.js`, and the assistant reply render pipeline (streaming dispatch, segments, citations, sources) in `src/ui/assistantRender.js`. In `extension.js`, `_buildUI`, `_sendMessage` (203-line coordinator over six phases: attachments, tool commands, knowledge context, vision pre-analysis, research planner, pipeline), and `_handleToolCalls` (64-line coordinator over `_executeToolCall` + `_finishToolBatch`) are extracted into focused methods (message construction delegates to `src/ui/messageBubble.js`, and `_handleStreamEnd` — the SSE stream-end finalization — is itself a ~65-line coordinator over `_recoverThinkingOnlyFallback` (thinking-only fallback), `_recoverTextBasedToolCalls` (text-based tool-call scan), `_finalizeToolCallTurn` (tool-iteration cap + forced synthesis), and `_finalizeSynthesisTurn` (degraded-output recovery, save + notify)). The dialog constructor is decomposed into focused init methods (`_scheduleStartupRagTasks`, `_initSleepMonitor`, `_initStateFields`, `_wireSettingsWatchers`, `_initInterfaceSettings`, `_buildActorShell`, `_installStageCapture`, `_subscribeProviderHealth`) behind a ~35-line shell. Remaining work: the full i18n string-wrapping pass and the release checklist (analysis items #7–#8); the accessibility pass and the metadata version bump are done.

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
- **Provider Dialect Pattern**: Each provider's payload builder, auth headers, and stream parser live in `src/providers/` (`chatRequest.js`, `nonStreamingRequest.js`, `streamParse.js`, `historyPayload.js`, `catalog.js`). The dialog assembles config snapshots and owns the send/redirect/cancel plumbing. `historyPayload.js` additionally owns history → payload shaping (estimates, truncators, attachment blocks, `sanitizeHistoryMessage`) so the dialog supplies provider state through small callbacks.
- **Request Lifecycle**: send/stop state is a single state machine (`src/core/requestLifecycle.js` — idle → enriching → awaiting-model ⇄ tool-loop → synthesis → stopping → done/error). Guards and UI decisions read lifecycle predicates (`canSend`, `canStop`, `isResponding`); `_setStreamingState` only applies UI and asserts consistency (`[Katab:lifecycle] state mismatch` in the journal).
- **Host-Bag Boundaries**: extracted research/provider modules are pure functions taking an injected dependency bag (e.g. `_pipelineHost()`, `_researchBranchHost()`, or a context object for the synthesis prompt) — runtimes, UI callbacks, config readers, and stores stay in the dialog.
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

## Knowledge Base (RAG)

```
RagRuntime (src/tools/ragTools.js)           server.py (FastAPI, 127.0.0.1:11435)
    ├── health()      ──────────►  GET  /health     (probes Ollama embedding backend)
    ├── index()       ──────────►  POST /index      → chunk → embed → ChromaDB + BM25
    ├── search()      ──────────►  POST /search     → dense (cosine) + BM25 fusion + optional rerank
    └── deleteData()  ──────────►  POST /delete     → purge by id / source_id / prefix
        ChromaDB (~/.local/share/katabai/chroma) · embeddings via Ollama /api/embed
```

- **Space**: collections use cosine distance; `score = 1 − distance` is a true cosine similarity. Client thresholds (`RAG_RELEVANT_MIN_SCORE` 0.55, `RAG_HIGH_CONFIDENCE_SCORE` 0.72, `RAG_FALLBACK_MIN_RESULT_SCORE` 0.45) are calibrated for this scale.
- **What gets indexed**: conversation turns (incremental deltas with per-message metadata), tool results (`web_search`, `read_url`, `crawl_url`, `explore_docs`), attached/imported documents, memory facts (`update_<slug>` ids), and — on Re-index — the local research cache (`research-cache.json`).
- **State**: `rag-index-state.json` tracks indexed conversations (id → message count). Maintenance actions are signalled via `rag-maintenance-generation` + `rag-maintenance-action`; Re-index triggers a full reconcile + research-cache re-import, Clear resets and stays empty, Import processes a file/folder queue.
- **BM25**: held in memory, marked dirty on any delete/replace/eviction, and rebuilt lazily from ChromaDB before the next hybrid search (ChromaDB is the single source of truth).
- **Send-path bounds**: all local-service awaits go through `_withTimeout` (auto KB search 8s, tool search 15s, manual `/kb` 20s). When `/health` reports embeddings down, auto search is skipped with a chat notice; trivial prompts skip auto search entirely.
- **Tool gating**: `knowledge_search`, `update_knowledge`, and `forget_knowledge` are advertised only when the KB is enabled, reachable, non-empty, and embeddings are up; `knowledge_search` accepts an optional `collection` filter.

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
- **Models**: `deepseek-flash` (fast, V4.1, native image input), `deepseek-v4-pro` (reasoning)
- **Vision**: `deepseek-flash` accepts images natively; `deepseek-v4-pro` is text-only — images routed through separately configured vision model
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
    ├── Each tool result truncated via truncateToolResultForIteration()
    │   (src/providers/historyPayload.js)
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
