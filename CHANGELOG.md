# Changelog

All notable changes to the Katab GNOME Shell extension are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Added
- **EML email attachments**: The document tool (`/doc`) now accepts `.eml` files. Katab parses them locally with a built-in MIME reader (no external tool) — headers (From/To/Subject/Date, RFC 2047 encoded-words), the text/plain branch of multipart/alternative, HTML-only bodies converted to text, quoted-printable/base64 transfer encodings, and attachment names/sizes.
- **Crawl4AI LLM Extraction (optional)**: Ask the Crawl4AI server's LLM to return structured JSON (schema mode) or a freeform answer (block mode) instead of raw Markdown. New `crawl4ai-extraction-mode`, `crawl4ai-llm-provider`, `crawl4ai-llm-instruction`, `crawl4ai-llm-schema-json`, `crawl4ai-llm-chunk-token-threshold`, and `crawl4ai-llm-overlap-rate` settings. Default stays markdown-only; API keys remain server-side.
- **DeepSeek as the default Crawl4AI LLM provider**: `crawl4ai-llm-provider` now defaults to `deepseek/deepseek-v4-flash`, and both LLM extraction modes ship prefilled defaults (a general-purpose JSON Schema and a summary block instruction) so enabling a mode works out of the box.
- **Inline `/crawl <url>` command**: `/crawl <url>` is now recognized anywhere in a message (e.g. *"Tell me about X. /crawl https://example.com"*), not just at the start or end.
- **Crawl4AI LLM extraction via the sanctioned `/llm` endpoint**: LLM modes (schema/block) now submit to Crawl4AI's `/llm/job` endpoint, which constructs the extraction strategy server-side — so DeepSeek extraction works on secure-by-default v0.9.x builds with no image patching. If `/llm` is unavailable, Katab falls back to Markdown and shows a notice.
- **LLM extraction caching**: Parameter-aware cache entries (URL + schema/instruction/model) prevent re-billing on repeat crawls.
- **Agent-directed docs navigation (`explore_docs`)**: In Deep Research, the model can now explore a documentation site's landing page to get its table of contents (internal-link structure), then `crawl_url` only the pages most relevant to the question — precision navigation instead of a blind site-wide crawl. Agent-only (no footer button / slash command); advertised to the model alongside `crawl_url` under the same web-scraping autonomy gate, and described in the deep-research system prompt.
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
- **Silent crawl success path**: A successful scrape produced no `[Katab:crawl4ai]` journalctl lines (only failures/cache hits logged). The success path now logs the scrape start (mode + provider + URLs), `/llm/job` submission and completion (with output sizes), markdown per-URL results, and a `/crawl command → scraping` trigger line.
- **Raw `/crawl` text leaking into the RAG auto-search query**: With an inline `/crawl <url>` command, the RAG web-search fallback searched the raw command text. Added `stripCrawl4AICommand` so the auto-search query and the model-visible user message keep only the conversational part (e.g. "tell me what this page is about").
- **Redundant RAG enrichment for direct `/crawl <url>`**: The auto KB search + low-coverage web-search fallback no longer run when a direct `/crawl <url>` command is active — the scraped page is the authoritative source, so the supplement (often rate-limited or unrelated) is skipped and logged as such.
- **Crawl4AI LLM setup instructions**: GSettings descriptions, Preferences text, User Guide, and API reference now document that the LLM provider must be allowed server-side — set `LLM_PROVIDER` (matching the Katab `crawl4ai-llm-provider` value) plus the provider's API key (e.g. `DEEPSEEK_API_KEY`) in the container's `.llm.env`, then restart with `docker compose down && docker compose up -d`. Documented the `/llm/job` endpoint as the sanctioned LLM-extraction path.
- **Research plan revisions replacing the plan**: Sending a follow-up prompt while a research plan is pending approval (e.g. *"the year is 2026, not 2025 — update it"*) used to be treated as a brand-new research query, regenerating the whole plan from scratch. Follow-ups during the plan phase are now routed through a revision planner that edits the existing plan in place — preserving the original query, angle structure, and unchanged details while applying only the requested corrections. An explicit `/research` command still starts a fresh plan, and if a revision fails the pending plan is left untouched. Revisions don't consume the Deep Research turn, so a one-shot `/research` keeps its deep-research thresholds through the eventual execution, and the plan phase routes correctly even if the mode was toggled off meanwhile. Added a **Cancel plan** button to the plan card (previously `_cancelResearchPlan` was unreachable); cancelling now also turns Deep Research mode back off so the next message behaves like a normal chat.
- **Research grinding on a dead search/scrape service**: When SearxNG or Crawl4AI was unreachable (offline), the research pipeline retried the same connection failure at every level — 3 attempts per query inside the search runtime, 2 fallback engine configs, then 2 branch retries — for *every* branch in the plan, with no abort, then continued into gap analysis/synthesis on empty findings. Connection failures are now treated as a **service-down** condition: `_attemptSearch` throws `connection-failed` on the first connection error instead of retrying, the research branch loop (and the gap-filling refinement phase) abort the whole run on the first `connection-failed`/`network-error`, marks the remaining branches as failed in the timeline immediately, and surfaces a clear message explaining that the web search / scraping service is unreachable and to start it before running research again. Research mode is turned back off and the checkpoint is cleared so a broken run isn't resumed.
- **Research plan sometimes skipped (empty planner response)**: The planner occasionally received a malformed, verbose, or wrong-schema response from the model instead of the required JSON array. A single unparseable response discarded the entire planning phase and fell straight into tool use/answering with no plan. The planner (and the plan-revision planner) now retry once with a format nudge when the response isn't a valid plan, and log a truncated sample of the raw response to the journal for diagnosis.
- **Research couldn't be stopped manually**: During research execution (the branch phases), the run had no cancellable wired up and the streaming state was false, so the send button stayed "Send" and pressing it started a new message instead of stopping the research — a long run could only be stopped during plan generation or the final synthesis stream. Research now sets up a cancellable + streaming state when it starts (the send button becomes "Stop"), `_isRequestCancelled` also recognizes the structured `'cancelled'` error code so a stop between branch retries is honored, and pressing Stop cleans up the research UI and state with a "Research stopped." message (mode returns to normal chat). This is consistent across all phases (branch execution, gap analysis, refinement, and the final stream), and a `finally` block releases the research-run streaming state whenever the run ends without a synthesis stream so the send button never stays stuck on "Stop" (which would drop the user's next message). Stopping or a service-down abort now also clears the research checkpoint, and checkpoint resume only happens when it belongs to the **same research query** — a stale checkpoint (e.g. left by a stop, or a reload followed by a new question) can no longer overwrite a freshly generated plan with an unrelated one.

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
