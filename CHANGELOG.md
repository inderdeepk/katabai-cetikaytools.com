# Changelog

All notable changes to the Katab GNOME Shell extension are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Added
- **DeepSeek Vision Model support**: Route image attachments through a separately configured vision model (Ollama or OpenAI-compatible) for DeepSeek V4 text-only models. Two modes: Preprocess (vision analysis injected as context) and Direct (images sent inline).
- **DeepSeek model picker**: Switch between DeepSeek V4 Flash and V4 Pro from the chat header dropdown without opening preferences.
- **Provider switcher in chat header**: Click the provider chip to switch AI backends directly from the chat overlay.
- **Ollama system prompt**: Customizable system prompt for Ollama models, live date injection for all providers.
- **RAG auto-search timeout guard**: `_withTimeout` helper bounds all local service awaits (RAG, Crawl4AI, SearxNG) preventing stuck sends.
- **Send re-entrancy guard**: `_sendInFlight` flag prevents multiple concurrent sends during long-running enrichment phases.

### Changed
- **Tool-call log UI**: Redesigned to VS Code-style with teal accents, animated spinners, expandable query/URL drawers.
- **Tool footer buttons**: Redesigned as compact horizontal chips matching footer row height.
- **Synthesis prompt**: Changed from branch-summary to topic-driven, centering the user's original question.
- **Raw fact injection**: Deep research synthesis now includes granular `{claim, url}` facts alongside compressed summaries.
- **Context budget**: Adaptive proportional truncation with 80K-char budget for synthesis.
- **Force-synthesis thresholds**: Raised `FORCE_SYNTHESIS_AFTER_ITERATIONS` from 3→5; model switch conditional on context size >60K.
- **Ollama deep research**: Fixed timeouts and think-mode blocking during synthesis for local models.
- **Offscreen framebuffer**: Removed `border-radius` and `box-shadow` from all chat content area elements to eliminate GPU texture errors on long responses.
- **Mid-reply close/reopen guards**: UI update functions now check dialog open state before manipulating widgets.

### Fixed
- **History save reliability**: `_readSSE` EOF handler now has its own try-catch with fallback save; `HistoryManager.flushSync()` called after every assistant response save.
- **`Array.filter()` reference detach bug**: `HistoryManager.saveConversation` now mutates cache in-place (no more silently lost assistant responses).
- **History reload blank-bubble bug**: Tool-call intermediary messages and Anthropic tool-result arrays now filtered from UI replay.
- **Ollama stream timeout**: Local Ollama requests no longer time out (was 30s, now unbounded).
- **Tool-call UI disposed widget errors**: `_responseUiAlive` guards prevent accessing destroyed widgets during async tool execution.
- **Prompt character cap**: Large paste handling with truncation notification.
- **Inline citation buttons**: `[N]` markers in deep research reports are now clickable, bibliography parsed from assistant output.
- **Enter-stacking**: Multiple rapid sends blocked by `_sendInFlight` guard.
- **Welcome new-chat scroll**: New Chat after loading a long conversation now resets viewport and prompt text.

### Security
- **SSRF protection extracted to shared module**: `src/shared/networkGuard.js` used by both `webSearchTools.js` and `crawl4aiTools.js`.
- **Web content safety policy**: Injected into system prompts for all providers when web tools are active.

---

## [1.0.0] — Initial Release

### Added
- **Multi-provider AI assistant**: Support for Ollama (local), Unsloth Studio (local), OpenAI, Anthropic (Claude), and DeepSeek API.
- **Chat overlay**: Clutter/St-based chat dialog accessible from GNOME top panel with `Ctrl+Super+C` keyboard shortcut.
- **Streaming responses**: SSE-based streaming with per-provider parsing (Ollama raw JSON, OpenAI/Unsloth SSE, Anthropic delta events, DeepSeek SSE).
- **Thinking/Reasoning display**: `<think>` tag parsing and collapsible thinking blocks.
- **Markdown rendering**: Headings, bold, italic, lists, blockquotes, inline code, fenced code blocks with syntax highlighting.
- **Code block copy**: Individual copy buttons for code blocks plus full-message copy.
- **Conversation history**: JSON persistence at `~/.local/share/katabai/history.json` with debounced writes, 50-entry limit, and in-memory cache.
- **Provider health monitor**: Periodic polling (15s interval) of Ollama `/api/tags`, Unsloth `/tokenize`, and cloud API endpoints. Panel status dot with online/down/needs-setup states.
- **Panel activity indicator**: Animated spinner during streaming (when chat is closed) and error icon for failed responses.
- **Dark/Light theme**: Automatic detection via `org.gnome.desktop.interface` `color-scheme` key, with live switching.
- **GTK4/Adwaita preferences window**: Provider configuration, API keys via GSettings, model selection, and per-provider tuning.
- **Ollama presets**: Save/load named configuration profiles capturing all 27 Ollama settings. Drift detection and reconciliation.
- **Document tool** (`/doc`): Local file attachment for `.txt`, `.md`, `.pdf` (via `pdftotext`), `.docx` (via `pandoc`), `.png`, `.jpg`, `.jpeg`. Multi-attachment support with chip UI.
- **Image attachments**: Base64-encoded local images sent to vision-capable Ollama models. Vision-model auto-detection via `/api/show` probe.
- **Web search tool** (`/search`, SearxNG): Self-hosted metasearch with manual and autonomous modes. Multi-query expansion, time/category/safesearch filtering, `read_url` page fetch.
- **Crawl4AI web scraper** (`/crawl`): Deep browser-based page scraping with BM25/Pruning content filtering, fit-markdown extraction, job polling.
- **Deep Research mode** (`/research`): Multi-phase research pipeline — planning (3-5 angles), parallel branch execution, mid-research critique, gap analysis, refinement, two-pass synthesis with outline, quality check.
- **Compression pipeline**: 4-level LLM-based hierarchical compression (per-page → merge → thematic clustering → section drafting).
- **Citation tracker**: Inline `[N]` citation buttons, bibliography parsing, source links below responses.
- **Research cache**: SHA-256 keyed persistent cache for searches and crawls.
- **Local RAG knowledge base** (`/kb`): Semantic search via Python FastAPI + ChromaDB service at `localhost:11435`. Auto-search mode, conversation/document indexing.
- **Token usage tracking**: Local-only JSON ledger at `~/.local/share/katabai/token-usage.json`. Prompt/completion/reasoning/cached token counts per event.
- **Token cost estimation**: Built-in pricing tables for OpenAI, Anthropic, DeepSeek, and Unsloth models.
- **Token budget**: Monthly USD budget with configurable warning threshold and in-chat/desktop notifications.
- **Token export**: JSON, CSV, Markdown report, and self-contained HTML export formats.
- **Chat combo system**: Reply streak counter per conversation with token score.
- **Provider pet collection**: 5 pets (Ollie, Slothy, Sparky, Clyde, Pearl) with 6 stages (Egg → Hatchling → Sprout → Scholar → Sage → Archmage), independent XP, crossbreeds, and Mixie collection reward.
- **Pet sprite actor**: Clutter-based sprite renderer with idle animation, sleep cycle, accent overlays, and panel/collection rendering.
- **Tool registry**: Declarative `Map<name, ToolDefinition>` pattern with danger levels, parallel read-only execution, self-healing retry loop.
- **Tool grouping UI**: Collapsible "Ran N tools" group for multi-tool turns.
- **Progressive tool-result truncation**: 4-tier truncation based on iteration count.
- **Force synthesis**: Tool advertisement removal when context exceeds threshold, with separate instructions for regular and deep research modes.
- **Inline citation buttons**: Clickable `[N]` markers parsed from bibliography sections.
- **Prompt history recall**: Shell-style Up/Down arrow navigation through sent prompts.
- **Prompt character counter**: Visual counter with warn/danger thresholds at 90%/100% of 16K character limit.
- **SSRF protection**: IPv4/IPv6 private range blocking, DNS validation, redirect revalidation.
- **Desktop notifications**: Companion stage-ups, achievement unlocks, budget warnings.
- **21 achievements**: Progression, streak, and special category badges.
- **Usage panel**: Token dashboard with time ranges, provider breakdown, model breakdown, efficiency metrics, trend card, activity strip.
- **Panel dropdown snapshot**: Pet sprite, range total, local share, provider share bar in top panel menu.
