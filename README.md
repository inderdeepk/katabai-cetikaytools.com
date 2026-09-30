# Katab (ਕਿਤਾਬ) — Desktop AI Assistant for GNOME

**Katab** (Punjabi for "book", ਕਿਤਾਬ) is a full-featured AI assistant embedded directly into the GNOME desktop. Access multiple LLM providers, search the web, scrape pages, run deep multi-source research, query a local knowledge base, attach documents, and collect evolving pet companions — all from a chat overlay in your top panel.

**Supports GNOME Shell 46, 47, and 48.**

## Features at a Glance

- **5 AI Providers** — Ollama (local), Unsloth Studio (local), DeepSeek, OpenAI, and Anthropic (Claude)
- **Streaming Chat** with markdown rendering, code highlighting, thinking/reasoning blocks, and inline citations
- **Document Attachments** — `.txt`, `.md`, `.pdf`, `.docx`, `.png`, `.jpg`, `.eml`
- **Web Search** via self-hosted SearxNG — manual `/search` or autonomous model-driven lookups
- **Web Scraping** via Crawl4AI — deep browser rendering with `/crawl`
- **Deep Research** — multi-phase pipeline: planning → parallel research → gap analysis → refinement → two-pass synthesis with citations; depth (Standard/Deep/Max) and per-role model overrides in Settings → Tools → Deep Research
- **Knowledge Base** — local RAG semantic search on your indexed documents (`/kb`)
- **Session Memory** — older turns fold into a persistent rolling summary so long chats keep context without resending the whole transcript
- **Pet Collection** — 5 provider pets with 6 evolution stages, crossbreed forms, and the Mixie companion
- **Token Tracking** — local-only ledger with cost estimates, configurable monthly budgets, and JSON export
- **Ollama Presets** — save, load, and share model configuration profiles
- **Dark/Light Theme** — automatic detection with live switching
- **Keyboard Shortcut** — `Ctrl+Super+C` to toggle chat

---

## Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [Documentation](#documentation)
- [Configuration & Security](#configuration--security)
- [Optional Tools](#optional-tools)
  - [Document Tool](#optional-document-tool)
  - [Web Search Tool](#optional-web-search-tool)
- [Chat Formatting](#chat-formatting)
- [AI Token Breakdown & Pets](#ai-token-breakdown)
- [Session Memory](#session-memory)
- [Contributing](#contributing)
- [License](#license)

---

## Installation

### Prerequisites
- GNOME Shell version 46.
- Optional local file support:
   - Plain text, Markdown, PNG, JPG, and JPEG work without extra packages.
   - Image understanding: DeepSeek Flash (V4.1) accepts images natively. Other providers need a vision-capable model — Ollama vision models take images directly, and text-only DeepSeek models can route images through the optional vision-model orchestration in Settings → DeepSeek.
   - PDFs require `pdftotext` from `poppler-utils` or the distro-equivalent `poppler` package.
   - DOCX files require `pandoc`.
   - `.eml` email files are parsed with a built-in MIME reader — no extra tools needed.

### Manual Installation
1. Clone or download the repository into your GNOME shell extensions directory:
   ```bash
   git clone https://github.com/inderdeepk/katabai-cetikaytools.com.git ~/.local/share/gnome-shell/extensions/katabai@cetikaytools.com
   ```
2. Navigate to the extension directory:
   ```bash
   cd ~/.local/share/gnome-shell/extensions/katabai@cetikaytools.com
   ```
3. Compile the settings schema:
   ```bash
   glib-compile-schemas schemas/
   ```
4. Restart GNOME Shell (or log out and log back in on Wayland).
5. Enable the extension using the Extensions application (`gnome-extensions-app`) or via the command line:
   ```bash
   gnome-extensions enable katabai@cetikaytools.com
   ```

## Quick Start

1. **Click the Katab icon** (📖) in your GNOME top panel, or press `Ctrl+Super+C`.
2. **Choose a provider** in the preferences: open the Extensions app → Katab → Settings → General → Model Provider.
3. **For local AI**: install [Ollama](https://ollama.com) (`ollama serve`), pull a model (`ollama pull llama3.2`), and select Ollama as your provider.
4. **For cloud AI**: enter your API key for DeepSeek, OpenAI, or Anthropic in their respective settings pages.
5. **Type a message** and press Enter to send. Press `Shift+Enter` for a new line.

For detailed setup and all features, see the [User Guide](Documentation/Help/UserGuide.md).

## Documentation

| Document | Description |
|---|---|
| [User Guide](Documentation/Help/UserGuide.md) | Getting started, provider setup, slash commands, tools, token breakdown, pets, troubleshooting |
| [Architecture](Documentation/Technical/ARCHITECTURE.md) | Codebase structure, design patterns, dependencies, data flow |
| [Security](Documentation/Technical/SECURITY.md) | Vulnerability reporting, API key practices, tool safety notes |
| [Development Guide](Documentation/Technical/DEVELOPMENT.md) | Environment setup, coding conventions, adding providers/tools, debugging |
| [API Reference](Documentation/Technical/API_REFERENCE.md) | Full GSettings schema reference, tool schemas, external service APIs |
| [Deep Research](Documentation/Technical/DEEP_RESEARCH.md) | Pipeline architecture: planning, compression, gap analysis, synthesis |
| [Testing](Documentation/Technical/TESTING.md) | Test commands, syntax validation, in-shell testing, known baseline noise |
| [Changelog](CHANGELOG.md) | Release history and notable changes |
| [Contributing](CONTRIBUTING.md) | Branching strategy, coding conventions, PR process |

## Configuration & Security

Katab is designed with security in mind. API keys are safely managed using GNOME's GSettings and are never hardcoded into the source code or loaded from plain text `.env` files.

To configure your API keys:
1. Open the GNOME Extensions application.
2. Click on the settings (gear) icon next to the "Katab - AI Assistant" extension.
3. Enter your API keys for Unsloth, OpenAI, or Anthropic in the Preferences window.
4. The extension will securely save these keys using GSettings.

## Optional Document Tool

Katab now includes an optional document tool that stays disabled by default. Basic chat does not depend on it.

To enable it:
1. Open the Katab preferences window.
2. Go to the `Tools` page.
3. Turn on `Enable Document Tool`.
4. Check the capability badges:
   - `Built in` means Katab can already read that format.
   - `Detected` means the required local parser was found on your system.
   - `Install` means the parser is missing and the settings page will tell you which package to install.

Common install commands:

```bash
# Debian / Ubuntu
sudo apt install poppler-utils pandoc

# Fedora
sudo dnf install poppler-utils pandoc

# Arch
sudo pacman -S poppler pandoc
```

Verify detection with:

```bash
which pdftotext
which pandoc
```

Once enabled, you can either click the attachment button in chat or use `/doc` directly:

```text
/doc
/doc "/absolute/path/to/file.pdf"
/doc "/absolute/path/to/file.docx" summarize the key points
/doc "/absolute/path/to/screenshot.png" describe what is in this image
```

Typing `/doc` with no quoted path opens the file picker. Supported formats are `.txt`, `.md`, `.pdf`, `.docx`, `.png`, `.jpg`, and `.jpeg`.

Documents are still parsed into text locally before they are sent to any provider. Image attachments are different: Katab base64-encodes them locally and only sends them when the active provider is Ollama and the selected Ollama model looks vision-capable. Pull a model such as `llama3.2-vision` or `llava` before sending images.

## Optional Web Search Tool

Katab can give models live web access through a **self-hosted [SearxNG](https://docs.searxng.org/)** instance. It talks directly to SearxNG's JSON API over HTTP — there is no Docker spawning, no MCP subprocess, and no third-party search key required. The tool stays disabled by default.

### 1. Run a SearxNG instance

The quickest way is the official container. SearxNG must have the JSON output format enabled (it is off by default):

```bash
docker run --rm -d \
  -p 8080:8080 \
  -v "${PWD}/searxng:/etc/searxng" \
  --name searxng \
  searxng/searxng
```

Then edit `searxng/settings.yml` and make sure the JSON format is allowed:

```yaml
search:
  formats:
    - html
    - json
```

Restart the container and confirm the JSON API answers:

```bash
curl 'http://localhost:8080/search?q=test&format=json' -H 'Accept: application/json'
```

### 2. Enable it in Katab

1. Open the Katab preferences window and go to the `Tools` page.
2. Click `Web Search` to open its settings.
3. Turn on `Enable Web Search` and set the `SearxNG URL` (for example `http://localhost:8080`).
4. Click `Test Connection` to verify Katab can reach the JSON API.

### 3. Use it

- **Manual search:** use `/search` at the start or end of a message to force a web lookup, e.g. `/search gnome 47 release date` or `gnome 47 release date /search`. Katab fetches results, then the model answers using them with source links.
- **Autonomous search:** when `Autonomous web search` is on (default), capable providers (Ollama, OpenAI, Anthropic, DeepSeek) can decide to call the `web_search` and `read_url` tools on their own during a normal conversation.

### Settings reference

| Setting | Purpose |
| --- | --- |
| SearxNG URL | Base URL of your SearxNG instance. |
| Result limit | Maximum results passed to the model (1–20). |
| Time range / Safe search / Language / Categories / Engines | Forwarded to SearxNG to scope results. |
| API key | Optional `Authorization: Bearer` token if your instance requires one. |
| Read full pages (`read_url`) | Lets the model open a result and read its text. Guarded against private/loopback addresses. |
| Multi-query expansion | Expands a `/search` query into several related queries before searching. Off by default for predictable latency. |
| Autonomous web search | Allows the model to call the search tools without `/search`. On by default. |
| Allow local/loopback addresses | Off by default. Only enable for a trusted local-only setup; it relaxes the SSRF guard. |

### Notes & security

- **Unsloth keeps its own server-side tools.** When Unsloth is the active provider, web search, Python, and terminal run on Unsloth's servers — this local SearxNG tool only applies to Ollama, OpenAI, Anthropic, and DeepSeek.
- Search results and fetched pages are **untrusted**. Katab labels them clearly, truncates them, and never executes them; treat any instructions found inside results with suspicion.
- `read_url` only fetches `http`/`https` URLs and blocks private, loopback, and link-local addresses unless you explicitly opt in. Reading PDF pages reuses `pdftotext` from `poppler-utils`.

## Chat Formatting

Assistant responses now render a chat-friendly markdown subset instead of showing raw formatting markers. Supported formatting includes headings, bold text, italics, bullet and numbered lists, blockquotes, inline code, and fenced code blocks.

Links are extracted from assistant responses and shown as clickable actions below the message bubble so they can be opened with your default browser. Markdown tables now render as structured chat tables; images and full CommonMark edge cases are still treated as plain text.

## AI Token Breakdown

Katab keeps a private, local-only ledger of your AI token usage and turns it into a companion experience:

- **Tokens button (top middle of the chat window)** — opens the breakdown panel with three tabs:
  - **Overview** — totals for today / week / month / year / all time, the local-vs-cloud ratio with a one-click "Try Next Draft Locally" action, trend summaries, milestones, and a 14-day activity chart.
  - **Collection** — the provider pet collection: inspect every pet, open detail views, pin a companion, and preview crossbreed forms.
  - **Spending** — estimated spend with per-provider/per-model breakdowns and monthly-budget progress.
- **Header context gauge** — the footer token box shows how full the context window is (system prompt + tool definitions + messages + space reserved for the response), with a draft-token preview while you type. Hover or click it for the Session Info breakdown, including the session-memory share and cumulative deep-research pipeline tokens.
- **Model pricing & cost** — built-in pricing for major models, including DeepSeek's time-aware peak/off-peak and cache hit/miss rates. Estimates are best-effort; actual bills may differ.
- **Budget warnings** — optionally set a monthly USD budget and a warning threshold (Settings → General). As spending approaches the limit, the Tokens panel shows budget progress and the Overview surfaces a warning tip.
- **Pet collection** — Ollie, Slothy, Sparky, Clyde, and Pearl each hatch and gain permanent XP from their own provider's token usage, growing Hatchling → Sprout → Scholar → Sage → Archmage. Raising two pets to Sprout unlocks their crossbreed forms; raising all five unlocks Mixie.
- **Active companion** — follow the current provider automatically, or pin any pet, crossbreed, or Mixie from the Collection tab.
- **Panel dropdown snapshot** — the GNOME top-bar menu shows the current chat plus a pet/usage snapshot: selected-range total, local share, leading provider, and a mini share bar.
- **Export** — "Export Usage JSON" writes a timestamped copy of the local ledger into your Documents folder. Everything stays on your machine.

Settings (Settings → General) let you pause tracking, choose the default range, set retention, control celebrations and desktop notifications, configure the monthly budget, export, or reset analytics and pet progress.

## Session Memory

Long conversations stay coherent without resending the whole transcript every turn: Katab asynchronously folds older turns into a compact, persistent session memory (project & goal, current state, progress, decisions, Q&A, next steps). The full transcript is still saved to disk and shown in the chat — only the model-facing payload is condensed.

- Folding runs in the background between turns and never blocks sending.
- Inspect the current memory and trigger **Summarize Now** from the Session Info popup (click the token gauge in the footer).
- The memory is stored inside the conversation itself, so it survives reloads and history switches.

## Contribution Guidelines

* **NEVER commit any API keys, credentials, or secrets to the repository.**
* Ensure that the `schemas/gschemas.compiled` file and any IDE configurations are kept out of version control (they are ignored via `.gitignore`).
* When updating documentation, always use mock placeholders for any API key examples (e.g., `sk-xxxxxxxxxxxx`).

## License

Katab is free software licensed under the [GNU General Public License v2.0 or later](LICENSE).
