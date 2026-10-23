# Katab (ਕਿਤਾਬ) — Desktop AI Assistant for GNOME

**Katab** (Punjabi for "book", ਕਿਤਾਬ) is a full-featured AI assistant embedded directly into the
GNOME desktop. Chat with local or cloud models, search and scrape the web, run deep multi-source
research, query a local knowledge base, attach documents, track token spend, and raise a collection
of pet companions — all from an overlay in your top panel.

**Supports GNOME Shell 46, 47, and 48.**

---

## Highlights

- **Five providers** — Ollama and Unsloth Studio (local), DeepSeek, OpenAI, and Anthropic (cloud).
  Switch from the header or from preferences.
- **Streaming chat** with a chat-friendly markdown renderer, code blocks with copy buttons,
  thinking/reasoning blocks, inline `[N]` citations, and source buttons.
- **Instant AI chat titles** — a new conversation is named from its first prompt, with a warm-up
  indicator while the title and first reply are prepared.
- **Session memory** — older turns fold into a persistent rolling summary so long chats keep
  context without resending the whole transcript.
- **Document attachments** — `.txt`, `.md`, `.markdown`, `.pdf`, `.docx`, `.eml`, `.png`, `.jpg`,
  `.jpeg`; parsed locally before anything is sent to a provider.
- **Web search** through your own [SearxNG](https://docs.searxng.org/) instance (`/search`).
- **Web scraping** through your own [Crawl4AI](https://github.com/unclecode/crawl4ai) container
  (`/crawl`), with optional server-side LLM extraction.
- **Deep Research** — plan → branches → mid-research critique → gap analysis → refinement →
  two-pass synthesis → quality check, with Standard/Deep/Max depth and optional per-role models.
- **Knowledge base (RAG)** — local semantic + BM25 search over documents, conversations, and
  research results (`/kb`), backed by a bundled FastAPI + ChromaDB service.
- **Token tracking & pets** — a local-only ledger with cost estimates, budgets, milestones, export,
  and five provider pets that evolve across six stages.
- **Ollama presets** — save, load, and restore complete Ollama configurations.
- **Dark/light themes**, live system-theme switching, and a `Ctrl+Super+C` toggle shortcut.

---

## Table of Contents

- [Requirements](#requirements)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Features](#features)
  - [Providers](#providers)
  - [Chat and rendering](#chat-and-rendering)
  - [Session memory](#session-memory)
  - [Document tool](#document-tool)
  - [Web search (SearxNG)](#web-search-searxng)
  - [Web scraper (Crawl4AI)](#web-scraper-crawl4ai)
  - [Knowledge base (RAG)](#knowledge-base-rag)
  - [Deep Research](#deep-research)
  - [Token breakdown and pets](#token-breakdown-and-pets)
  - [Ollama presets](#ollama-presets)
  - [History](#history)
  - [Appearance and keyboard](#appearance-and-keyboard)
- [Commands and tools](#commands-and-tools)
- [Data and privacy](#data-and-privacy)
- [Documentation](#documentation)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)
- [License](#license)

---

## Requirements

### System

- GNOME Shell **46, 47, or 48** (see `metadata.json`).
- `glib-compile-schemas` from `glib2` — required once after checkout and after any schema edit.
- Optional for development: Node.js 20+ and npm (lint/format/test runner), GJS for the import
  smoke test.

### Optional local services

Katab works with only a provider configured. The tools below are opt-in and disabled by default.

| Service | Default URL | Used by |
|---|---|---|
| [Ollama](https://ollama.com) | `http://localhost:11434` | Ollama provider; KB embeddings; optional vision backend |
| [Unsloth Studio](https://github.com/unslothai/unsloth) | `http://localhost:8888/v1` | Unsloth provider (server-side tools) |
| [SearxNG](https://docs.searxng.org/) | `http://localhost:8080` | `web_search`, `read_url`, deep research |
| [Crawl4AI](https://github.com/unclecode/crawl4ai) | `http://localhost:11235` | `crawl_url`, `explore_docs`, deep research |
| Katab RAG service (bundled) | `http://127.0.0.1:11435` | `knowledge_search`, KB indexing |

### Optional system tools

| Tool | Package | Needed for |
|---|---|---|
| `pdftotext` | `poppler-utils` (Debian/Ubuntu), `poppler` (Arch) | PDF attachments and PDF page reads |
| `pandoc` | `pandoc` | DOCX attachments |
| `msgfmt` | `gettext` | Compiling translations (`make langs`) |

Everything else (plain text, Markdown, images, `.eml` email) is parsed with built-in code.

---

## Installation

### From source

1. Clone into your GNOME Shell extensions directory:
   ```bash
   git clone https://github.com/inderdeepk/katabai-cetikaytools.com.git \
     ~/.local/share/gnome-shell/extensions/katabai@cetikaytools.com
   cd ~/.local/share/gnome-shell/extensions/katabai@cetikaytools.com
   ```
2. Compile the settings schema:
   ```bash
   glib-compile-schemas schemas/
   # or: make compile-schemas
   ```
3. Restart GNOME Shell — log out and back in on Wayland, or `Alt+F2` → `r` on X11.
4. Enable the extension:
   ```bash
   gnome-extensions enable katabai@cetikaytools.com
   ```

### Development install

`make install` rsyncs the checkout into the extensions directory, `make reload` disables and
re-enables it, and `make logs` follows the relevant journal lines:

```bash
make install && make reload
make logs
```

See the [Development Guide](Documentation/Technical/DEVELOPMENT.md) for the full loop and
[Testing](Documentation/Technical/TESTING.md) for validation commands.

---

## Quick Start

1. Click the Katab icon in the top panel, or press `Ctrl+Super+C`.
2. Open **Settings** (panel menu, or the Extensions app) → **General** → **Active Provider**.
3. For local models: run Ollama (`ollama serve`), pull a model (`ollama pull llama3.2`), then pick
   it on the **Ollama** page.
4. For cloud models: enter an API key on the **DeepSeek**, **OpenAI**, or **Anthropic** page.
5. Type a message and press **Enter**. **Shift+Enter** inserts a newline; **Stop** cancels a
   streaming response.

The [User Guide](Documentation/Help/UserGuide.md) covers every feature and setting.

---

## Features

### Providers

| Provider | Default endpoint | Default model | Notes |
|---|---|---|---|
| Ollama | `http://localhost:11434` | `llama3` | Full sampling/hardware tuning, thinking mode, vision models, presets |
| Unsloth Studio | `http://localhost:8888/v1` | `default` | Server-side `web_search`, `python`, and `terminal` tools |
| DeepSeek | `https://api.deepseek.com` | `deepseek-flash` | Thinking mode, reasoning effort, JSON mode, balance display |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o` | Function-calling tools |
| Anthropic | `https://api.anthropic.com` | `claude-3-5-sonnet-20241022` | Tool use, top-level system prompt |

Image attachments work with **Ollama vision models** and with **DeepSeek** (`deepseek-flash`
natively, or any DeepSeek model routed through a configured vision backend).

### Chat and rendering

- Markdown subset rendering: headings, emphasis, lists, blockquotes, inline code, fenced code
  blocks, and tables.
- Code blocks carry a **Copy** button; each message has a copy action.
- Thinking/reasoning output collapses into a **Show Thinking** block.
- After tool use, responses include source buttons and clickable `[N]` citations; Deep Research
  reports also include a bibliography.
- A warm-up row (*Naming this chat…* → *Thinking…*) covers the first-prompt title request and the
  handoff to the main response.
- The prompt counter turns amber near the limit and red at the 16,000-character cap.

### Session memory

Katab folds older turns into a compact, persistent session memory (project and goal, current state,
progress, decisions, Q&A, next steps) in the background between turns. The full transcript still
lives in `history.json` and in the visible chat; only the model-facing payload is condensed.

- Open **Session Info** from the footer token gauge to inspect the memory, run **Summarize Now**,
  or **Compact Conversation**.
- Memory is stored inside the conversation, so it survives reloads and history switches.

### Document tool

Disabled by default, enabled under **Settings → Tools → Document Tool**.

- Built-in parsing for `.txt`, `.md`, `.markdown`, `.eml`, `.png`, `.jpg`, `.jpeg`.
- `.pdf` needs `pdftotext`; `.docx` needs `pandoc`; the preferences page shows
  **Built in / Detected / Install** capability badges.
- Attach from **Tools → Docs** (footer gear) or with `/doc "path" [instruction]`.
- Documents are parsed locally. Images are base64-encoded locally and only sent to providers that
  can accept them.

### Web search (SearxNG)

Disabled by default; enable under **Settings → Tools → Web Search** and set the SearxNG URL.
SearxNG must expose the JSON format:

```yaml
search:
  formats:
    - html
    - json
```

- `/search query` anywhere in a message forces a lookup; the **Tools** popup (footer gear) sets
  Search to **Auto → On → Off**.
- With **Autonomous web search** on (default), models may call `web_search` and `read_url`
  themselves.
- `read_url` results include the links found on the page so the model can follow subpages.
- All page fetches are SSRF-guarded (`src/shared/networkGuard.js`); private/loopback access
  requires an explicit opt-in setting.

### Web scraper (Crawl4AI)

Disabled by default; enable under **Settings → Tools → Web Scraper**.

- `/crawl <url>` deep-scrapes one page; `/crawl <query>` searches first and scrapes the top result.
- With autonomous scraping on (default), the model can call `crawl_url`, and `explore_docs` to
  navigate a documentation site via its table of contents.
- Raw Markdown is the default output; `mode="extract"` requests server-side LLM extraction
  (structured JSON or a freeform answer) when the Crawl4AI server has an LLM provider configured.
- **Follow Subpage Links in Research** (default on, 3 links per branch) lets Deep Research follow
  the most relevant links found on scraped pages.

### Knowledge base (RAG)

Disabled by default. Katab ships the service source in [`rag-service/`](rag-service/) and can
install it from preferences:

1. Copy the bundled service to its deployed location (the one-click setup manages the virtualenv
   and systemd unit, not the source file):
   ```bash
   mkdir -p ~/.local/share/katabai/rag-service
   cp rag-service/server.py rag-service/requirements.txt ~/.local/share/katabai/rag-service/
   # later updates: make sync-rag-server
   ```
2. Open **Settings → Tools → Knowledge Base**.
3. In the **Service** group, click **Set Up & Start** — Katab creates the virtualenv, installs
   dependencies, writes the `katabai-rag.service` systemd user unit, and starts it.
   (Manual steps and the unit file are shown in the page's **Setup** expander.)
4. Pull the embedding model once: `ollama pull nomic-embed-text`.
5. Turn on **Enable Knowledge Base** and click **Test Connection**.

Use `/kb query`, `/kb import "path"`, or **Tools → Knowledge** (footer gear). Conversations, attached
documents, tool results, memory facts, and (on Re-index) the research cache are indexed locally.

### Deep Research

Enable Web Search or Web Scraper first. Start a run with `/research` or the **Research** row in the
footer Tools popup (an Off/On toggle). The pipeline is: planning (3–5 angles, editable and approvable) →
sequential branches → mid-research critique → gap analysis → refinement → two-pass synthesis →
quality check.

- **Settings → Tools → Deep Research** exposes **Research Depth** (Standard / Deep / Max) and
  optional **Compression** and **Synthesis** model overrides.
- Reports include inline citations and a bibliography; results are cached in
  `~/.local/share/katabai/research-cache.json`.
- See [DEEP_RESEARCH.md](Documentation/Technical/DEEP_RESEARCH.md) for the internals.

### Token breakdown and pets

Open the **Usage** button in the chat header (with its pet avatar) or the **Token Breakdown** panel menu entry. Three tabs:

- **Overview** — today/week/month/year/all-time totals, local-vs-cloud share, trends, milestones,
  and a 14-day chart.
- **Collection** — five provider pets (Ollie, Slothy, Sparky, Clyde, Pearl), six stages, XP
  progress, companion pinning, and usage milestones.
- **Spending** — estimated cost by provider and model, plus monthly-budget progress.

The footer token gauge shows context-window usage (system prompt, tools, messages, reserved reply)
and opens Session Info. Set a monthly budget and warning threshold under **Settings → General**.
Everything is local; **Export Usage JSON** writes a timestamped copy to your Documents folder.

### Ollama presets

Presets capture 26 Ollama settings (connection, generation, sampling, hardware, and system prompt).
Manage them from the **Presets** button in the chat header (shown when Ollama is active) or from
**Settings → Ollama → Model Presets**. Stored in `~/.local/share/katabai/presets.json`.

### History

Conversations auto-save to `~/.local/share/katabai/history.json` (up to 50 conversations, debounced
writes, synchronous flush on disable). The history panel has **Active** and **Archived** tabs,
search, and a title/description editor with optional **Generate with AI**. New chats are also named
automatically from their first prompt by the active provider/model; disable this under
**Settings → General → Chat → AI-Generated Chat Titles**.

### Appearance and keyboard

- `Ctrl+Super+C` toggles the chat; rebind it under **Settings → General → Keyboard Shortcut**.
- **Chat Text Size** (Compact / Comfortable / Large) and **Glassy Translucent Dialog** live under
  **Settings → General → Appearance**.
- Dark/light follows the system color scheme and updates live in both the overlay and preferences.

---

## Commands and tools

| Command | Tool | Description |
|---|---|---|
| `/help` | — | Show the commands available with the current provider and settings |
| `/doc "path"` | `document` | Attach and parse a local file (pre-send tool) |
| `/search query` | `web_search` | Search the web through SearxNG |
| `/crawl URL` | `crawl_url` | Deep-scrape a page (or search then scrape the top result) |
| `/kb query` | `knowledge_search` | Search the local knowledge base |
| `/kb import "path"` | — | Import files or a folder into the knowledge base |
| `/research` | `deep_research` | Toggle the Deep Research meta-mode |
| `/python` | — | Execute Python server-side (Unsloth only) |
| `/terminal` | — | Run a shell command server-side (Unsloth only) |

Agent-only tools with no command: `read_url`, `explore_docs`, `update_knowledge`,
`forget_knowledge`. See the [API Reference](Documentation/Technical/API_REFERENCE.md) for their
schemas and danger levels.

---

## Data and privacy

Katab has no telemetry and no Katab-operated backend. Chat traffic goes only to the provider you
select (or to the local services you configure).

| Data | Path |
|---|---|
| Chat history | `~/.local/share/katabai/history.json` |
| Token ledger | `~/.local/share/katabai/token-usage.json` |
| Ollama presets | `~/.local/share/katabai/presets.json` |
| Research cache | `~/.local/share/katabai/research-cache.json` |
| Research checkpoints | `~/.local/share/katabai/research-checkpoint.json` |
| Knowledge base index state | `~/.local/share/katabai/rag-index-state.json` |
| Knowledge base vectors | `~/.local/share/katabai/chroma/` |
| RAG service checkout | `~/.local/share/katabai/rag-service/` |
| API keys and settings | GSettings (dconf) — see [Security](Documentation/Technical/SECURITY.md) |

API keys are stored through GSettings, never hardcoded and never read from `.env` files. dconf is
not encrypted at rest; rely on full-disk encryption and file permissions for defense in depth.

---

## Documentation

| Document | Description |
|---|---|
| [Documentation index](Documentation/README.md) | Map of every document and its audience |
| [User Guide](Documentation/Help/UserGuide.md) | Complete user manual |
| [Architecture](Documentation/Technical/ARCHITECTURE.md) | Source layout, lifecycle, data flow, subsystems |
| [API Reference](Documentation/Technical/API_REFERENCE.md) | GSettings keys, tool schemas, external APIs |
| [Deep Research](Documentation/Technical/DEEP_RESEARCH.md) | Research pipeline internals |
| [Development Guide](Documentation/Technical/DEVELOPMENT.md) | Setup, conventions, extension recipes, debugging |
| [Testing](Documentation/Technical/TESTING.md) | Test suites, audits, CI, checklists |
| [Security](Documentation/Technical/SECURITY.md) | Reporting, secret handling, tool safety |
| [RAG service](rag-service/README.md) | Local service source, deployment, tests |
| [Fidelity audits](scripts/audits/README.md) | How past refactors are proven to be pure code moves |
| [Changelog](CHANGELOG.md) | Notable changes |
| [Contributing](CONTRIBUTING.md) | Branching, conventions, PR and release process |

---

## Troubleshooting

A few quick checks; the [User Guide](Documentation/Help/UserGuide.md#16-troubleshooting) has the
full list.

```bash
# Extension logs
journalctl -f -o cat /usr/bin/gnome-shell | grep -i katab

# Local services
curl http://localhost:11434/api/tags                  # Ollama
curl 'http://localhost:8080/search?q=test&format=json' # SearxNG (JSON enabled)
curl http://localhost:11235/health                    # Crawl4AI
curl http://127.0.0.1:11435/health                    # RAG service
```

- **"Provider is down"** — start the local service or check the API key.
- **Blank or truncated replies** — a tool-iteration or context limit forced synthesis; start a new
  chat or raise **Max Tool Iterations** (Settings → Tools → Web Search).
- **SearxNG returns HTML** — add `json` to `search.formats` and restart the container.
- **No images sent** — switch to a vision-capable Ollama model, or configure DeepSeek image support.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for branching, coding conventions, localization, and the
release checklist. Run at least `make check && make test` before opening a pull request; CI also
runs ESLint, Prettier, and the RAG service tests.

## License

Katab is free software licensed under the
[GNU General Public License v2.0 or later](LICENSE).
