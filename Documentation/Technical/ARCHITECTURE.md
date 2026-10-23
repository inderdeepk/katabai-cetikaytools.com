# Katab Architecture

## Overview

Katab (ਕਿਤਾਬ) is a GNOME Shell extension that provides a desktop AI-assistant overlay. It talks to
five LLM backends (Ollama, Unsloth Studio, DeepSeek, OpenAI, Anthropic) and adds optional local
tools: web search (SearxNG), page reading, web scraping (Crawl4AI), documentation navigation,
document parsing, a local knowledge base (RAG), and a multi-phase deep-research pipeline.

Two processes matter:

- **The shell process** loads `extension.js` (ES module) and draws the overlay with Clutter/St.
- **The preferences process** loads `prefs.js` (GTK4/Adwaita) in a separate process.

Both import the same pure modules from `src/`, so payload shaping, settings readers, presets, token
accounting, and pet rules never fork between the two surfaces.

---

## Contents

- [Overview](#overview)
- [Entry Points](#entry-points)
- [Source Layout](#source-layout-src)
- [Key Design Patterns](#key-design-patterns)
- [Dependencies](#dependencies)
- [Request Lifecycle](#request-lifecycle)
- [Message Send Pipeline](#message-send-pipeline)
- [Chat titles](#chat-titles)
- [Context budgeting](#context-budgeting)
- [Session Memory](#session-memory)
- [Tool System](#tool-system)
- [Provider Dialects](#provider-dialects)
- [Knowledge Base (RAG)](#knowledge-base-rag)
- [Deep Research (summary)](#deep-research-summary)
- [Token Usage & Pet System](#token-usage--pet-system)
- [Theme System](#theme-system)
- [Provider Health Monitor](#provider-health-monitor)
- [Assets](#assets)
- [Data Files](#data-files)

---

## Entry Points

| File | Role | Loaded by |
|---|---|---|
| `metadata.json` | Extension manifest (UUID, shell versions, schema id) | GNOME Shell |
| `extension.js` | Extension class, panel indicator, chat dialog, provider health monitor | GNOME Shell |
| `prefs.js` | Preferences orchestrator (92 lines); pages live in `src/ui/prefs/` | GNOME Shell prefs |
| `stylesheet.css` | Shell overlay St CSS | GNOME Shell (auto-loaded) |
| `prefs.css` | GTK preferences CSS | `prefs.js` via `Gtk.CssProvider` |
| `schemas/…gschema.xml` | All user-configurable settings | GLib/GSettings |

---

## Source Layout (`src/`)

```
src/
├── core/                  # Framework-free infrastructure
│   ├── historyManager.js    ← Conversation persistence (in-memory cache + 200 ms debounced writes)
│   ├── requestLifecycle.js  ← Send/stop FSM: idle → enriching → awaiting-model ⇄ tool-loop →
│   │                          synthesis → stopping → done/error
│   ├── sessionMemory.js     ← Rolling session-memory fold/prune rules and budget splitting
│   ├── titleGenerator.js    ← Manual + first-prompt auto title generation (bounded prompts + parsers)
│   └── toolCallMarkup.js    ← Tool-call markup normalization/stripping (healing retries)
├── providers/             # Provider adapters
│   ├── catalog.js            ← Provider identity/branding + DeepSeek model list (single source)
│   ├── chatRequest.js        ← Streaming request builders (Ollama, DeepSeek, OpenAI-compatible,
│   │                          Anthropic) + Ollama options builder
│   ├── nonStreamingRequest.js← Non-streaming builders + response text/usage extraction
│   ├── historyPayload.js     ← Token estimates, context truncators, attachment payloads,
│   │                          provider-dialect sanitization
│   └── streamParse.js        ← SSE/NDJSON line parsing + tool-call accumulation
├── tools/                 # Tool definitions and runtimes
│   ├── toolRegistry.js       ← Declarative registry (Map<name, ToolDefinition>)
│   ├── toolDefinitions.js    ← Concrete definitions (side-effect import)
│   ├── webSearchTools.js     ← SearxNG search + read_url
│   ├── crawl4aiTools.js      ← Crawl4AI client (sync + async jobs, LLM extraction)
│   ├── exploreDocsTools.js   ← Documentation table-of-contents navigation
│   ├── ragTools.js           ← Knowledge-base client (health/index/search/delete)
│   └── documentTools.js      ← Local attachment parser (txt/md/pdf/docx/eml/images)
├── research/              # Deep-research pipeline
│   ├── prompts.js            ← Research prompts + response parsers
│   ├── planner.js            ← Planner + plan-revision agents (retries, format nudges)
│   ├── pipeline.js           ← Gap analysis, critique, outline, quality check
│   ├── branchRunner.js       ← Branch execution (search → crawl → compress), retries, subpages
│   ├── synthesisPrompt.js    ← Final-report prompt, contradiction + grounding checks
│   ├── compressionTools.js   ← Hierarchical LLM compression (4 levels)
│   ├── citationTracker.js    ← Citation → bibliography binding
│   └── researchCache.js      ← SHA-256 keyed result cache + crash-recovery checkpoints
├── usage/
│   ├── tokenUsageManager.js  ← Token ledger, cost, budgets, milestones, pet XP
│   ├── deepseekPricing.js    ← Time-aware DeepSeek peak/off-peak + cache pricing
│   └── presetManager.js      ← Ollama preset CRUD (26 settings)
├── pets/
│   ├── petCollection.js      ← Pet definitions, stages, form ids, persisted-state normalization
│   └── petSpriteActor.js     ← Clutter sprite renderer (idle/sleep/celebrate/tip poses)
├── shared/
│   ├── contentKind.js        ← Code-heaviness detection + verbatim code excerpts
│   ├── httpBody.js           ← Capped HTTP body reader
│   ├── i18n.js               ← gettext bridge injected by each entry point
│   ├── networkGuard.js       ← SSRF guard (IPv4/IPv6 blocklists, DNS + redirect validation)
│   ├── pageLinks.js          ← Link extraction/normalization/scoring
│   └── toolModes.js          ← Auto/On/Off vocabulary + popup labels
└── ui/                    # Shell widgets + preferences pages
    ├── headerBar.js            ← Chat header row (provider chip, pickers, usage button, history)
    ├── welcomePanel.js         ← Animated welcome scene
    ├── assistantRender.js      ← Streaming dispatch, markdown segments, citations, sources
    ├── markdownRender.js       ← Markdown segmentation + inline formatting
    ├── messageBubble.js        ← Message shells, thinking/tool log, footer actions, attachments
    ├── pendingIndicator.js     ← Animated warm-up row (three pulsing dots + phase label)
    ├── pendingIndicatorController.js ← Warm-up state machine (grace timer, dismiss, one recovery)
    ├── historyView.js          ← History panel (list/search/tabs, KB search, metadata editor)
    ├── sessionInfoPopup.js     ← Session Info popup (context breakdown, summarize/compact)
    ├── toolsPopup.js           ← Floating tools panel with Auto/On/Off rows
    ├── recentChatsPopup.js     ← Recent-conversation hover preview
    ├── pickers.js              ← Ollama presets, provider picker, DeepSeek model picker
    ├── usagePanel.js           ← Token Breakdown panel (Overview/Collection/Spending)
    └── prefs/                  ← Preferences modules
        ├── widgets.js          ← createPrefsContext + row/page factories + watch()/dispose()
        ├── generalPage.js      ← Provider cards, chat titles, shortcut, appearance, tokens, pets, notifications
        ├── ollamaPage.js       ← Ollama connection/sampling/hardware/system prompt/presets
        ├── deepseekPage.js     ← DeepSeek connection, thinking, vision, balance
        ├── providerPages.js    ← Unsloth / OpenAI / Anthropic pages
        └── tools/              ← Tools index + document, webSearch, crawler, knowledge,
                                  deepResearch subpages
```

`extension.js` remains the integration layer: it owns the dialog, settings snapshots, the send/stop
state machine, tool dispatch (`_handleToolCalls` → `_executeToolCall` + `_finishToolBatch`), and the
research orchestration that calls into `src/research/`. Extracted modules take a small host bag
(callbacks, config readers, UI handles) so they stay free of shell imports and can be unit-tested.

---

## Key Design Patterns

- **ES modules everywhere** — GNOME Shell 46+ supports native `import`/`export`; there is no
  CommonJS anywhere.
- **GObject classes** — UI actors extend `GObject.Object` and use `GObject.registerClass()`.
- **Soup 3 only** — every HTTP call uses `gi://Soup?version=3.0`.
- **Provider dialect pattern** — each provider's payload, headers, and stream parser live in
  `src/providers/`; the dialog builds a config snapshot and owns the plumbing.
- **Declarative tools** — `registerTool()` definitions carry the model-facing JSON Schema, danger
  level, UI label/icon, slash command, and truncation key.
- **Host-bag boundaries** — research and provider modules receive exactly the dependencies they
  need instead of importing the extension.
- **Debounced persistence** — history, token ledger, cache, and presets batch writes; history
  flushes synchronously on extension disable.
- **Pure-logic modules first** — anything without Clutter/St/Gtk imports is covered by `gjs -m`
  unit tests.

---

## Dependencies

- **GNOME Shell 46–48** — `St`, `Clutter`, `Pango`, `GLib`, `Gio`, `Meta`, `Shell`.
- **Soup 3.0** — HTTP.
- **Adw** — Preferences window (`Adw.NavigationPage` subpages).
- **Optional services** — Ollama, Unsloth Studio, SearxNG, Crawl4AI, the bundled RAG service.
- **Optional system tools** — `pdftotext` (PDF), `pandoc` (DOCX), `msgfmt` (translations).

---

## Request Lifecycle

`src/core/requestLifecycle.js` is the single source of truth for send/stop state:

```
idle → enriching → awaiting-model ⇄ tool-loop → synthesis → stopping → done/error
```

- The dialog reads predicates (`canSend`, `canStop`, `isResponding`) instead of ad-hoc booleans.
- `_setStreamingState()` applies UI state and asserts consistency; mismatches are logged as
  `[Katab:lifecycle] state mismatch`.
- Normal turns commit the user message + assistant bubble before KB/web enrichment, so the
  lifecycle stays `AWAITING_MODEL` through the wait and Enter/Stop behaves consistently. Only
  pre-commit commands (e.g. `/kb import`) can temporarily reject a send while `ENRICHING`.

---

## Message Send Pipeline

```
User submits → _sendMessage()
    ├── Parse slash commands (/help, /doc, /search, /crawl, /kb, /research)
    ├── Attach documents (local parse; images cached as base64)
    ├── Validate image routing (Ollama vision model or DeepSeek vision config)
    ├── Validate /kb synchronously (invalid commands never create a bubble)
    ├── Append the user message + empty assistant bubble; clear the entry; arm the warm-up row
    ├── Knowledge context (post-commit, Stop stays active):
    │     ├── manual /kb search (20 s cap)
    │     ├── automatic pre-send search when KB is in Auto mode (8 s cap)
    │     └── skip auto search when /health says embeddings are down or the prompt is trivial
    ├── First-prompt AI title (when enabled) under a bounded hand-off
    ├── Vision pre-analysis (DeepSeek preprocess mode)
    ├── Research planner (when Deep Research is active)
    └── _streamResponse()

Warm-up row phases: "Preparing context…" → "Naming this chat…" → "Thinking…".
`src/ui/pendingIndicatorController.js` owns the rules: armed with a 300 ms grace period so fast
replies render without a loader flash; any thinking block, tool call, streamed token, error, or
stop dismisses it; if a status render (search started, retrying, …) dismissed it, the first real
model wait re-arms it exactly once, so a long model wait never leaves a frozen status line. The
row is never drawn over answer content.

_streamResponse()
    ├── Snapshot settings; build provider request via src/providers/chatRequest.js
    ├── Keep the warm-up row during the initial model wait, re-arming it once if a status
    │   render dismissed it (later iterations show "Waiting for response...")
    ├── Inject the web-content safety policy when tool/web content is in play
    ├── Advertise tool schemas when allowed (not force-synthesizing, not JSON mode)
    ├── Choose timeout: Ollama 0 (unbounded), DeepSeek 1800 s, others 30 s
    └── POST with Soup.Session

_readSSE()
    ├── Ollama: raw JSON lines → message.content / message.reasoning / message.tool_calls
    ├── OpenAI-compatible + DeepSeek: `data:` SSE → choices[0].delta
    ├── Anthropic: content_block_start/delta/stop, input_json_delta for tool use
    └── Accumulate text/thinking/tool calls; update the streaming bubble

stream end
    ├── Tool calls → _handleToolCalls() → save → recurse _streamResponse()
    ├── Healing retry when raw tool-call markup was emitted (MAX_HEALING_RETRIES = 3)
    ├── Force synthesis when the iteration cap or context threshold is reached
    └── Otherwise finalize: save, record tokens/pet XP, render citations/sources
```

### Chat titles

- The first user turn of a new chat is named by the active provider/model
  (`auto-generate-chat-titles`, on by default) using `buildAutoTitleMessages()`
  (2–6 words, ≤48 chars, 24-token cap).
- The title call runs after context prep and before the main model request; the warm-up row
  reflects that phase. It has its own Soup session with a 30 s hard timeout, and the send path
  waits only `AUTO_TITLE_HANDOFF_MS` (8 s) before handing off. A slow title keeps running in the
  background and updates history when it lands.
- Failures fall back silently to the first-60-characters history title. Manual or generated
  titles (`customTitle`) are never overwritten.

### Context budgeting

- `src/core/sessionMemory.js` folds older turns into a session memory before the request; the
  history payload then splits whatever remains within the provider's input budget.
- `src/providers/historyPayload.js` estimates tokens (~3.5 chars/token), truncates per tier, and
  sanitizes provider-specific message shapes.
- One attached image is charged `IMAGE_TOKEN_ESTIMATE` (1024 tokens) instead of its base64 length.

---

## Session Memory

Session memory keeps long chats coherent without resending the whole transcript.

| Constant | Value | Meaning |
|---|---|---|
| `SESSION_MEMORY_MAX_TOKENS` | 1024 | Output cap for the summarization call |
| `SESSION_MEMORY_MAX_CHARS` | 4000 | Hard cap on persisted memory text |
| `SESSION_MEMORY_TIMEOUT_MS` | 60 000 | Background fold timeout |
| `SESSION_MEMORY_KEEP_EXCHANGES` | 6 | Recent exchanges a forced summarize keeps verbatim |
| `SESSION_MEMORY_MIN_FOLD_COUNT` | 4 | Minimum messages before auto-folding |
| `SESSION_MEMORY_FOLD_TOTAL_MAX_CHARS` | 32 000 | Default cap for the whole fold prompt |

- The memory is stored inside the conversation object (`__katab_session_memory__` marker) and
  survives reloads and history switches.
- Folding runs between turns; the full transcript stays visible and on disk — only the model-facing
  payload is condensed.
- **Summarize Now** forces a fold; **Compact** trims the visible conversation instead.

---

## Tool System

### Registry

`src/tools/toolRegistry.js` holds a `Map<name, ToolDefinition>`. Each definition provides:
`name`, `description`, `parameters` (JSON Schema or `null`), `dangerLevel`, `handler`, `uiLabel`,
`uiIcon`, `command`, `resultTruncationKey`, `isMeta`, `providerScoped`.
Schema builders: `buildAllToolSchemas(provider)` and `buildToolSchemasFor(toolNames, provider)`.

### Registered tools

| Tool | Danger | Footer/command | Notes |
|---|---|---|---|
| `web_search` | read_only | Search / `/search` | SearxNG JSON API |
| `read_url` | read_only | — | SSRF-guarded page fetch; lists page links |
| `crawl_url` | read_only | Scrape / `/crawl` | Crawl4AI; `mode="extract"` for LLM extraction |
| `explore_docs` | read_only | — | Docs landing page → TOC + relevant links |
| `knowledge_search` | read_only | Knowledge / `/kb` | Local RAG; optional `collection` filter |
| `deep_research` | read_only | Research / `/research` | Meta-mode; no API schema |
| `document` | potentially_unsafe | Docs / `/doc` | Pre-send attachment parser; no API schema |
| `update_knowledge` | potentially_unsafe | — | Saves/updates a memory fact |
| `forget_knowledge` | potentially_unsafe | — | Deletes a memory fact |

### Modes

- Search, Scrape, and Knowledge cycle **Auto → On → Off**; On/Off is one-shot for Search and Scrape.
- Deep Research cycles **Off → On** only and persists for the whole turn.
- `src/shared/toolModes.js` owns the vocabulary and labels.

### Execution flow

```
_handleToolCalls(toolCalls, uiElements, reasoning, provider)
    ├── Bail out if the response UI was torn down
    ├── Partition calls by danger level
    ├── Execute read-only calls in parallel; unsafe calls sequentially
    ├── Truncate each result for the current iteration
    ├── Append tool results to history; save
    ├── Check force-synthesis thresholds
    └── Recurse into _streamResponse()
```

### Force synthesis

| Trigger | Normal | Deep Research |
|---|---|---|
| Iterations | `web-search-max-tool-iterations` (default 25, clamped 1–100) | `max(preference, 12)` |
| Context | `max(40 000 chars, 85 % of provider input budget)` | `max(80 000 chars, 85 % of provider input budget)` |

When triggered, tools are no longer advertised and a synthesis instruction is injected so the model
must answer with the evidence it already has.

### Healing retry

If a model emits raw tool-call markup instead of a function call, Katab strips the markup, injects a
correction prompt, and retries up to `MAX_HEALING_RETRIES` (3) times without consuming a tool
iteration.

### Result truncation tiers

Normal mode (iteration → limits):

| Iteration | Search results | Search snippet | `read_url` | `crawl_url` | KB |
|---|---|---|---|---|---|
| 1–2 | 10 | 500 | 16 000 | 32 000 | 8 000 |
| 3–4 | 8 | 400 | 8 000 | 16 000 | 5 000 |
| 5–6 | 6 | 300 | 4 000 | 8 000 | 3 000 |
| 7+ | 4 | 200 | 2 000 | 4 000 | 2 000 |

Deep Research uses its own, larger tiers (15/12/10/6 results; 16 000/32 000 down to 4 000/8 000 for
`read_url`/`crawl_url`).

---

## Provider Dialects

### Ollama
- **Endpoint**: `{url}/api/chat` · **Auth**: none · **Stream**: raw JSON lines (no `data:` prefix).
- **Special fields**: `message.reasoning`, `message.images[]`, `message.tool_calls[]`.
- **Final chunk**: `done: true` with `load_duration`, `prompt_eval_count`, `eval_count`,
  `eval_duration`.
- **Timeout**: none (local; the user can cancel).

### DeepSeek
- **Endpoint**: `{url}/chat/completions` · **Auth**: `Authorization: Bearer <api-key>`.
- **Stream**: SSE `data:` lines. **Special**: `thinking`, `reasoning_effort`, `response_format`.
- **Models**: `deepseek-flash` (V4.1, native image input), `deepseek-v4-pro` (reasoning, text-only),
  and the retired `deepseek-v4-flash` alias.
- **Images**: Flash natively, Pro through a configured vision backend (preprocess or direct routing).
- **Timeout**: 1800 s.

### Unsloth Studio
- **Endpoint**: `{url}/chat/completions` · **Auth**: optional bearer token.
- **Special**: `enable_tools`, `enabled_tools`, `session_id`, `tool_choice`.
- **Tools**: `web_search`, `python`, and `terminal` run on Unsloth's servers, not locally.

### OpenAI
- **Endpoint**: `{url}/chat/completions` · **Auth**: `Authorization: Bearer <api-key>`.
- **Tools**: OpenAI function-calling format. **Stream**: SSE `data:` lines.

### Anthropic
- **Endpoint**: `{url}/v1/messages` · **Auth**: `x-api-key` + `anthropic-version: 2023-06-01`.
- **System prompt**: top-level `system` field, not a message.
- **Tools**: `tool_use` blocks with `input_json_delta` fragments; `max_tokens: 4096`.
- **Stream**: `content_block_*` + `message_stop` events.

---

## Knowledge Base (RAG)

```
src/tools/ragTools.js (RagRuntime)            rag-service/server.py (FastAPI, 127.0.0.1:11435)
    ├── health()      ──►  GET  /health     (service + embedding backend diagnostics)
    ├── index()       ──►  POST /index      (chunk → embed → ChromaDB + BM25)
    ├── search()      ──►  POST /search     (dense + optional BM25 fusion + optional rerank)
    └── deleteData()  ──►  POST /delete     (by id / prefix / source_id)
        ChromaDB (~/.local/share/katabai/chroma) · embeddings via Ollama /api/embed
```

- **Space**: cosine; `score = 1 − distance` is a true cosine similarity. Client gates:
  `RAG_RELEVANT_MIN_SCORE` 0.55 (auto-inject context), `RAG_HIGH_CONFIDENCE_SCORE` 0.72 (suppress
  web search), `RAG_FALLBACK_MIN_RESULT_SCORE` 0.45 (minimum before falling back to the web).
- **Collections**: `conversations`, `documents`, `research_cache`.
- **Indexed content**: conversation turns (incremental), tool results (`web_search`, `read_url`,
  `crawl_url`, `explore_docs`), attachments/imports, memory facts (`update_<slug>` ids), and the
  research cache on Re-index.
- **State**: `rag-index-state.json` tracks conversation id → message count. Maintenance uses
  `rag-maintenance-generation` + `rag-maintenance-action`.
- **BM25**: in memory, rebuilt lazily from ChromaDB after any delete/replace/eviction.
- **Send-path bounds**: auto search 8 s, tool search 15 s, manual `/kb` 20 s, health probe 12 s.
- **Tool gating**: KB tools are advertised only when the KB is enabled, reachable, non-empty, and
  embeddings are up.

---

## Deep Research (summary)

See [DEEP_RESEARCH.md](DEEP_RESEARCH.md) for the full pipeline. The dialog orchestrates; the phase
logic lives in `src/research/`:

1. **Plan** — 3–5 angles (planner retries once with a format nudge); the plan card supports edits,
   revisions, cancel, and start.
2. **Branches** — sequential, with per-branch search → read/crawl → compression and transient-error
   retries with backoff.
3. **Mid-research critique** — sufficiency scoring, dropped/added angles, contradictions.
4. **Gap analysis** — 0–2 (Standard), 3 (Deep), or 4 (Max) follow-up queries.
5. **Refinement** — mini-branches, 2 crawls each.
6. **Two-pass synthesis** — outline (optionally refined) then streamed report.
7. **Quality check** — coverage/groundedness score; retries below 3 (Standard/Deep) or 4 (Max),
   bounded by `MAX_QUALITY_RETRY_ITERATIONS`.

Depth scales the synthesis context budget: 80 K (Standard), 120 K (Deep), 160 K (Max) characters.

---

## Token Usage & Pet System

### Ledger (`src/usage/tokenUsageManager.js`)
- **Storage**: `~/.local/share/katabai/token-usage.json` (400 ms debounced writes).
- **Record**: per-response provider, model, prompt/completion/reasoning/cached tokens, source
  (exact or estimated), cost.
- **Aggregation**: daily buckets plus day/week/month/year/all summaries; 14-day timeline.
- **Pricing**: `MODEL_PRICING` (local models are free; cloud models use built-in rates, with
  time-aware DeepSeek peak/off-peak and cache pricing in `deepseekPricing.js`).
- **Milestones**: first reply, first local tokens, 10k local tokens, mostly self-hosted (≥50 %
  local), and 7 active days.
- **Export**: JSON copy in `~/Documents/katabai-token-usage-<timestamp>.json`.

### Pets (`src/pets/petCollection.js`)
- Pure module with no GNOME imports; five provider pets with independent XP.
- Six stages: Unhatched Egg (0), Hatchling (1), Sprout (10 000), Scholar (100 000),
  Sage (1 000 000), Archmage (10 000 000).
- Selection is `follow-provider` or `pinned` (`pet-selection-mode`, `pet-pinned-form`); pinned forms
  are provider forms (`provider:<provider>`), validated by `parsePetForm()`.
- XP lives in the token ledger so it survives pruning; resetting the ledger resets pets.

### Sprite actor
Clutter renderer that loads `<provider>_<family>_<pose>[_0N].png` from `sprites/`, falls back to the
egg sprite, cycles idle frames, sleeps after inactivity, and can run static (panel/collection) or
animated (chat companion).

---

## Theme System

- **Shell overlay**: `stylesheet.css` (St CSS) — applied classes `katab-theme-dark` /
  `katab-theme-light` on the dialog and panel menu.
- **Preferences**: `prefs.css` (GTK CSS) — classes `katab-prefs-theme-dark` /
  `katab-prefs-theme-light`.
- **Shell detection**: reads `org.gnome.desktop.interface` `color-scheme` and listens for changes.
- **Prefs detection**: `Adw.StyleManager` `notify::dark`.
- St CSS does not support `flex-wrap` or `text-transform`, and large `border-radius`/`box-shadow`
  surfaces can trip offscreen-framebuffer limits.

---

## Provider Health Monitor

- One monitor instance owned by the extension, shared by the panel indicator, dialog, and prefs
  pickers.
- Polls every 15 s (`PROVIDER_STATUS_POLL_MS`) with an 8 s probe timeout.
- States: `checking`, `online`, `down`, `needs-setup`.
- Probes:

| Provider | Probe | Checks |
|---|---|---|
| Ollama | `GET /api/tags` | Service reachable, models listed |
| Unsloth | `POST /tokenize` (`{content:"ping"}`) | Endpoint reachable |
| OpenAI | `GET /v1/models` | Key valid, service up |
| DeepSeek | `GET /user/balance` | Key valid, balance readable |
| Anthropic | `GET /v1/models` (`x-api-key`) | Key valid, service up |

A provider with a missing URL/key/API key is reported as `needs-setup` without a probe.

---

## Assets

| Directory | Contents |
|---|---|
| `icons/` | Provider logos + Katab SVG icons |
| `sprites/` | Per-provider sprite sets (`ollie`, `slothy`, `sparky`, `clyde`, `pearl`), `eggs/`, and the pending `mixie/` placeholder |
| `schemas/` | GSettings XML + compiled binary (gitignored) |
| `po/` | gettext template + `POTFILES.in` |
| `locale/` | Compiled translations (generated by `make langs`, gitignored) |

---

## Data Files

| File | Owner |
|---|---|
| `~/.local/share/katabai/history.json` | `HistoryManager` |
| `~/.local/share/katabai/token-usage.json` | `TokenUsageManager` |
| `~/.local/share/katabai/presets.json` | `presetManager.js` |
| `~/.local/share/katabai/research-cache.json` | `researchCache.js` |
| `~/.local/share/katabai/research-checkpoint.json` | `researchCache.js` |
| `~/.local/share/katabai/rag-index-state.json` | dialog KB indexing |
| `~/.local/share/katabai/chroma/` | RAG service (ChromaDB) |
| dconf (`org.gnome.shell.extensions.katabai`) | settings, including API keys |

All paths derive from `GLib.get_user_data_dir()`, so `XDG_DATA_HOME` is respected.
