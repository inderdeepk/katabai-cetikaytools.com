# Katab (ਕਿਤਾਬ) User Help Guide

Welcome to **Katab (ਕਿਤਾਬ)**, your desktop AI assistant integrated directly into the GNOME status bar. This guide covers everything from initial setup to advanced features like deep research, knowledge bases, and pet companions.

---

## Table of Contents

1. [Getting Started](#1-getting-started)
2. [Configuration & Setup](#2-configuration--setup)
3. [Provider-Specific Setup](#3-provider-specific-setup)
4. [Using the Assistant](#4-using-the-assistant)
5. [Chat Features](#5-chat-features)
6. [Optional Document Tool](#6-optional-document-tool)
7. [Optional Web Search Tool](#7-optional-web-search-tool)
8. [Optional Crawl4AI Web Scraper](#8-optional-crawl4ai-web-scraper)
9. [Optional Knowledge Base (RAG)](#9-optional-knowledge-base-rag)
10. [Deep Research Mode](#10-deep-research-mode)
11. [Ollama Presets](#11-ollama-prefsets)
12. [AI Token Breakdown & Pets](#12-ai-token-breakdown--pets)
13. [Chat History](#13-chat-history)
14. [Keyboard Shortcut & Theme](#14-keyboard-shortcut--theme)
15. [Preferences Overview](#15-preferences-overview)
16. [Troubleshooting](#16-troubleshooting)
17. [Glossary](#17-glossary)

---

## 1. Getting Started

Once you have installed Katab (as described in the `README.md`), it will appear as an icon in your GNOME top panel (status bar).

### Opening Katab
- Click the Katab icon in the top panel to open the assistant overlay.
- Press `Ctrl+Super+C` to toggle the chat window from anywhere.
- The chat interface lets you converse with your selected AI model without needing a browser tab or terminal.

### Panel Indicator
The top panel icon shows:
- **Katab logo** (default) — the extension is running normally.
- **Green dot** — the selected provider is online and healthy.
- **Red dot** — the provider is unreachable (check your connection or service).
- **Yellow dot** — the provider needs setup (API key, URL, or model not configured).
- **Animated spinner** — a response is streaming while the chat window is closed.
- **Warning icon** — the last response ended with an error.

### Panel Menu
Clicking the panel icon opens a dropdown with:
- **New Chat** — start a fresh conversation.
- **Current Chat** — status of the active conversation with provider health indication.
- **Token Breakdown** — condensed snapshot of today's token usage.
- **Settings** — opens the preferences window.
- **Recent Conversations** — quick-load from history.

---

## 2. Configuration & Setup

Katab supports five AI backends, from local execution environments to cloud models. All settings are configured in the GNOME Extensions preferences.

### Accessing Preferences
1. Open the **Extensions** app (`gnome-extensions-app`) on your GNOME desktop.
2. Scroll to **Katab - AI Assistant**.
3. Click the **Settings (gear)** icon next to it.

### Selecting a Provider
In the **General** tab of the settings window, choose your primary AI provider:
- **Ollama (Local)** — Fast, lightweight local model runner.
- **Unsloth Studio (Local)** — Optimized local AI with built-in tools.
- **DeepSeek** — Cloud API with Flash (fast) and Pro (deep reasoning) models.
- **OpenAI** — Connects to OpenAI's cloud API.
- **Anthropic** — Connects to Claude cloud API.

You can also switch providers directly from the chat header without opening preferences — click the provider chip and select from the picker.

---

## 3. Provider-Specific Setup

Each provider requires its own URL, authentication, and model configuration. Katab stores all secrets securely in GNOME's GSettings — never in plain-text `.env` files.

### 🦙 Ollama (Local)
1. Install [Ollama](https://ollama.com) and ensure the daemon is running:
   ```bash
   ollama serve
   # or
   systemctl status ollama
   ```
2. Pull at least one model:
   ```bash
   ollama pull llama3.2
   ```
3. In Katab preferences → Ollama: set the **Base URL** (default: `http://localhost:11434`).
4. Select your **Model** from the dropdown or type a model name.
5. **Advanced tuning** is available: context size, temperature, top-k/p, GPU layers, threads, mirostat sampling, repeat penalties, and more.
6. For image attachments, pull a vision-capable model:
   ```bash
   ollama pull llama3.2-vision
   # or
   ollama pull llava
   ```
7. Configure a **System Prompt** to give the model persistent instructions.

### 🦥 Unsloth Studio (Local)
1. Ensure Unsloth Studio is running (default: `http://localhost:8888/v1`).
2. Set the **Base URL** in Katab preferences → Unsloth.
3. Enter an **API Key** if your instance requires one.
4. Specify the **Model** name.
5. **Note**: When Unsloth is active, web search, Python, and terminal run on Unsloth's own servers. Katab's local SearxNG and Crawl4AI tools are bypassed.

### 🔮 DeepSeek
1. **Base URL**: `https://api.deepseek.com` (default).
2. **API Key**: Enter your DeepSeek API key.
3. **Model**: Choose in preferences or switch from the chat header:
   - `deepseek-v4-flash` — Fast, cost-effective responses.
   - `deepseek-v4-pro` — Deeper reasoning with thinking mode.
4. **Thinking Mode**: Enable for the model to show its reasoning process. Use **Reasoning Effort** to control depth.
5. **JSON Mode**: Force structured JSON output.
6. **System Prompt**: Customize the model's default behavior.
7. **Image Support (Vision Model)**: DeepSeek V4 is text-only. To send images:
   - Go to DeepSeek preferences → Image Support.
   - Choose a **Routing Mode**: *Preprocess* (vision model analyzes image → DeepSeek writes answer) or *Direct* (images sent inline).
   - Choose a **Vision Backend**: Ollama or OpenAI-compatible endpoint.
   - Set the **Vision Model** (e.g., `llama3.2-vision` for Ollama).
   - Optionally set a **Fallback Model** for retry on failure.

### ☁️ OpenAI
1. **Base URL**: Typically `https://api.openai.com/v1`.
2. **API Key**: Enter your OpenAI API key starting with `sk-`.
3. **Model**: Enter the model name (e.g., `gpt-4o`, `gpt-3.5-turbo`).

### 🤖 Anthropic (Claude)
1. **Base URL**: Typically `https://api.anthropic.com`.
2. **API Key**: Enter your Anthropic API key starting with `sk-ant-`.
3. **Model**: Enter the model name (e.g., `claude-3-5-sonnet-20240620`).

---

## 4. Using the Assistant

### Basic Chat
1. Click the Katab icon in the status bar or press `Ctrl+Super+C` to open the chat.
2. Type your message and press **Enter** to send.
3. Press **Shift+Enter** to insert a new line in the prompt box.
4. During a response, the **Stop** button replaces the Send button — click to cancel.

### Chat Header
The top of the chat window shows:
- **Provider chip** — current AI provider with icon, name, and status dot. Click to switch providers.
- **Model selector** — choose a model (or Flash/Pro for DeepSeek).
- **Pet sprite** — your active companion with idle animation.
- **Token counter** — live token estimate during streaming and context usage bar.

### Slash Commands

Type `/help` at any time to see available commands for your current provider and settings.

| Command | Description |
|---|---|
| `/help` | Show available commands |
| `/doc "path"` | Attach a local file (`.txt`, `.md`, `.pdf`, `.docx`, `.png`, `.jpg`) |
| `/search query` | Search the web via SearxNG |
| `/crawl URL` | Deep-scrape a web page with Crawl4AI |
| `/crawl query` | Search then scrape the top result |
| `/kb query` | Search your local knowledge base |
| `/research` | Activate Deep Research mode for exhaustive multi-source research |
| `/python` | Execute Python code (Unsloth only) |
| `/terminal` | Run a shell command (Unsloth only) |

### Footer Tool Buttons

The buttons in the chat footer are **mode controls**, not just command inserters:

- **Docs** — one-shot: attach a file.
- **Search** — cycles **Auto → On → Off**. *On* forces a web search for the next message. *Off* blocks all web search for the next message. *Auto* follows your GSettings preferences.
- **Scrape** — same Auto/On/Off cycling for Crawl4AI.
- **Research** — same Auto/On/Off cycling for Deep Research mode.
- **KB** — one-shot: search the knowledge base.

One-shot modes (Search On, Scrape On, Research On) reset to Auto after the message is sent.

---

## 5. Chat Features

### Markdown Rendering
Responses support a chat-friendly markdown subset: headings, bold, italic, bullet and numbered lists, blockquotes, inline code, and fenced code blocks. Code blocks include syntax highlighting and a **Copy** button.

### Thinking/Reasoning Blocks
When models produce reasoning content (DeepSeek thinking mode, Ollama `think` mode), it appears in a collapsible section labeled **"Show Thinking"**. Click to expand and read the model's reasoning process.

### Sources & Citations
When web search or crawl results are used:
- **Source buttons** appear below the assistant response with clickable links that open in your default browser.
- **Inline citations** (`[1]`, `[2]`, etc.) are clickable and jump to the corresponding source.
- The model automatically includes a **bibliography** section for deep research reports.

### Copy Controls
- **Full message copy**: Button next to each message bubble copies the entire response.
- **Code block copy**: Individual copy button on each code block.
- **Manual selection**: You can also select text directly — click and drag on any message text, then press `Ctrl+C`.

### Multi-Attachment Support
You can attach multiple files to a single message. Each attachment appears as a chip in the footer bar. Click the ✕ on a chip to remove it, or use "Clear all attachments" to start over.

### Prompt History Recall
Press **Up Arrow** in an empty prompt (or at the first line) to recall your last sent message. Press **Up/Down** to navigate through your prompt history. Press **Down** past the last entry to restore your draft.

### Prompt Character Counter
A counter appears at the bottom-right of the prompt area. It turns amber at 90% capacity and red at the 16,000 character limit. Pasting large text that exceeds the limit is automatically truncated with a notification.

---

## 6. Optional Document Tool

Katab includes an optional document tool for attaching local files to chat. It is disabled by default — regular chat works exactly the same if you never turn it on.

### Enabling the Document Tool
1. Open Katab preferences → **Tools** → **Document**.
2. Turn on **Enable Document Tool**.
3. Check the capability badges:
   - **Built in**: No extra package needed.
   - **Detected**: Required local parser found.
   - **Install**: Parser missing — the settings page tells you which package to install.

### Supported Formats
| Format | Requirement | Notes |
|---|---|---|
| `.txt` / `.md` | Built in | No extra packages |
| `.png` / `.jpg` / `.jpeg` | Built in | Only sent for Ollama with vision-capable model |
| `.pdf` | `pdftotext` (poppler-utils) | |
| `.docx` | `pandoc` | |

### Installing Missing Tools
```bash
# Debian / Ubuntu
sudo apt install poppler-utils pandoc

# Fedora
sudo dnf install poppler-utils pandoc

# Arch
sudo pacman -S poppler pandoc
```

Verify with:
```bash
which pdftotext
which pandoc
```

### Attaching Files
Two methods:
1. Click the **Docs** button in the chat footer and choose a file.
2. Use the `/doc` command:
   ```
   /doc
   /doc "/absolute/path/to/file.pdf"
   /doc "/absolute/path/to/file.docx" summarize the main points
   /doc "/absolute/path/to/screenshot.png" describe this image
   ```

Typing `/doc` without a quoted path opens the file picker.

### Important Notes
- Documents are parsed locally before the extracted text is sent to your provider.
- Image attachments are base64-encoded locally and only sent when the provider/model supports vision.
- Saved conversations store attachment metadata only — not the full content. Reattach files when reopening old conversations.
- Image support for non-Ollama providers: DeepSeek uses a separately configured vision model, while OpenAI and Anthropic receive images through their native multimodal APIs.

---

## 7. Optional Web Search Tool

Katab can give your model live web access through a **self-hosted [SearxNG](https://docs.searxng.org/)** instance. Katab talks directly to SearxNG's JSON API — no Docker spawning, no subprocess, and no third-party search API key. The tool is disabled by default.

> **Unsloth note:** When Unsloth is active, web search runs on Unsloth's own servers. This local SearxNG tool is for Ollama, DeepSeek, OpenAI, and Anthropic.

### Step 1 — Run SearxNG with JSON Enabled
SearxNG does not return JSON by default. Run an instance and enable the `json` format:

```bash
docker run --rm -d -p 8080:8080 \
  -v "${PWD}/searxng:/etc/searxng" \
  --name searxng searxng/searxng
```

Edit `searxng/settings.yml`:
```yaml
search:
  formats:
    - html
    - json
```

Restart the container and verify:
```bash
curl 'http://localhost:8080/search?q=test&format=json' -H 'Accept: application/json'
```

### Step 2 — Enable in Katab
1. Open Katab preferences → **Tools** → **Web Search**.
2. Turn on **Enable Web Search**.
3. Set the **SearxNG URL** (e.g., `http://localhost:8080`).
4. Click **Test Connection** — the status badge confirms Katab can reach the JSON API.

### Step 3 — Search
- **Manual**: Use `/search` at the start or end of a message: `/search gnome 47 release date` or `gnome 47 release date /search`. Katab gathers results and the model answers with source links.
- **Autonomous**: With **Autonomous web search** on (default), capable models can call `web_search` and `read_url` tools by themselves when they need current information.
- **Footer button**: Cycle the Search button to **On** to force a search for the next message.

### Settings Reference
| Setting | Description |
|---|---|
| **SearxNG URL** | Base URL of your instance |
| **Result limit** | Max results passed to model (1–20) |
| **Time range / Safe search / Language / Categories / Engines** | Forwarded to SearxNG |
| **API key** | Optional `Authorization: Bearer` token |
| **Read full pages (`read_url`)** | Lets the model open and read result pages |
| **Multi-query expansion** | Expands one `/search` into several related queries (off by default) |
| **Autonomous web search** | Model can search without `/search` (on by default) |
| **Allow local/loopback addresses** | Off by default — only enable for trusted local-only setups |

### Security
- Search results and fetched pages are **untrusted data**. Katab labels and truncates them and never executes anything they contain.
- `read_url` only fetches `http`/`https` URLs and blocks private, loopback, and link-local addresses unless explicitly allowed.
- Reading PDF result pages reuses `pdftotext` from `poppler-utils`.

---

## 8. Optional Crawl4AI Web Scraper

Katab can deep-scrape web pages through a **self-hosted [Crawl4AI](https://github.com/unclecode/crawl4ai) Docker container**. Unlike the simple `read_url` which fetches raw HTML text, Crawl4AI renders pages in a real browser (JavaScript, SPAs, lazy-loading), then extracts clean Markdown content. The tool is disabled by default.

### Step 1 — Run Crawl4AI
```bash
docker run --rm -d -p 11235:11235 \
  --name crawl4ai \
  unclecode/crawl4ai
```

Verify:
```bash
curl http://localhost:11235/health
```

### Step 2 — Enable in Katab
1. Open Katab preferences → **Tools** → **Web Scraper**.
2. Turn on **Enable Web Scraper**.
3. Set the **Crawl4AI URL** (default: `http://localhost:11235`).
4. Click **Test Connection**.

### Step 3 — Scrape
- **Manual**: `/crawl https://example.com/article` scrapes a URL directly. `/crawl gnome 47` searches via SearxNG then scrapes the top result. You can also embed `/crawl <url>` anywhere in a message — e.g. *"Tell me about X. /crawl https://example.com"* — and the page will be scraped and included alongside your question.
- **Autonomous**: The model can call `crawl_url` after `web_search` to read promising results in depth.
- **Footer button**: Cycle the Scrape button to **On** for one-shot scraping.

### Settings Reference
| Setting | Description |
|---|---|
| **Crawl4AI URL** | Base URL of your instance |
| **API token** | Optional bearer token |
| **Fit markdown mode** | `pruning` (default) or `bm25` (keyword-focused extraction) |
| **BM25 threshold** | Relevance cutoff for BM25 mode |
| **Cache mode** | `bypass` (default) or `enabled` |
| **Word count threshold** | Minimum words before a page is considered substantive |
| **Page timeout** | Max seconds to wait for a page (default: 60) |
| **Max characters** | Truncation limit for extracted content (default: 24,000) |
| **Stealth mode** | Simulates user interaction to bypass bot detection |
| **Autonomous** | Model can call `crawl_url` without `/crawl` (on by default) |
| **Allow local addresses** | Off by default — only enable for trusted local setups |
| **Extraction mode** | `markdown` (default) or `llm-schema` / `llm-block` (see below) |
| **LLM provider** | LiteLLM model identifier for LLM extraction (defaults to DeepSeek V4 Flash, `deepseek/deepseek-v4-flash`) |
| **Chunk token threshold** | Max tokens per chunk when splitting large pages for the LLM (default 4000) |
| **Chunk overlap rate** | Overlap between chunks to preserve context (default 0.1) |

### LLM Extraction (Optional)

By default Crawl4AI extracts clean Markdown using its built-in content filter. If your Crawl4AI server has an LLM provider configured, you can also ask it to extract **structured JSON** or a **freeform answer** directly from the page.

> **How it works**: Katab submits the crawl to Crawl4AI's dedicated **`/llm` endpoint**, which constructs the `LLMExtractionStrategy` **server-side** — so it works even on Crawl4AI's secure-by-default build (which blocks client-supplied LLM config on `/crawl`). Katab only sends the URL, the provider name, and the schema/instruction; your API key is never sent to or stored by Katab.

#### Step 1 — Configure the server
Add an LLM provider to your Crawl4AI container environment. The default provider is **DeepSeek V4 Flash**, so with Docker Compose you set `LLM_PROVIDER` and `DEEPSEEK_API_KEY` in `.llm.env` (see the Setup section in Preferences for the compose file), then restart the container:

```bash
# .llm.env — add these lines, then: docker compose down && docker compose up -d
LLM_PROVIDER=deepseek/deepseek-v4-flash
DEEPSEEK_API_KEY=sk-...
```

For a single container, pass them with `-e`:
```bash
docker run -d \
  --name crawl4ai \
  -p 11235:11235 \
  -e CRAWL4AI_API_TOKEN=your-token \
  -e SECRET_KEY=another-random-string \
  -e LLM_PROVIDER=deepseek/deepseek-v4-flash \
  -e DEEPSEEK_API_KEY=sk-... \
  --shm-size=1g \
  unclecode/crawl4ai:latest

# Other providers also work if you change LLM_PROVIDER and add that key:
#   LLM_PROVIDER=openai/gpt-4o-mini   + OPENAI_API_KEY
#   LLM_PROVIDER=anthropic/claude-3-5-sonnet + ANTHROPIC_API_KEY
#   LLM_PROVIDER=ollama/llama3.2       (no key needed)
```

> **Provider allowlist**: the `LLM_PROVIDER` env var (or `llm.provider` in `config.yml`) is what tells the server which provider family is allowed. On a stock v0.9.x container only the family of `llm.provider` is allowed (default `openai`) unless you set `LLM_PROVIDER` — so if you request `deepseek/...` without it, the `/llm` job is rejected with "LLM provider not allowed".

#### Step 2 — Choose an extraction mode
Open Katab preferences → **Tools** → **Web Scraper** → **LLM Extraction (Optional)** and pick a mode:

| Mode | Result |
|---|---|
| **Markdown Only (Default)** | Current behavior — no LLM involved |
| **LLM Structured JSON (Schema)** | LLM returns JSON matching your schema |
| **LLM Freeform Answer (Block)** | LLM answers your instruction in prose |

- **Schema mode**: a general-purpose JSON Schema (title, summary, key points) is prefilled — edit it to match the fields you want, then use **Validate Schema** to check it.
- **Block mode**: a default summary instruction is prefilled — edit it to suit the page type (e.g. *"Extract the product name, price, and availability from this page."*).
- **LLM Provider**: defaults to **DeepSeek V4 Flash** (`deepseek/deepseek-v4-flash`). It's sent by name to Crawl4AI's `/llm` endpoint. The provider must be allowed on the server: set `LLM_PROVIDER=<same value>` and the provider's API key (e.g. `DEEPSEEK_API_KEY`) in `.llm.env`, then restart the container (see Step 1). Enter any other LiteLLM identifier to switch, e.g. `openai/gpt-4o-mini`, `anthropic/claude-3-5-sonnet`, or `ollama/llama3.2`.
- **Chunk Token Threshold / Overlap Rate**: tune how Crawl4AI splits large pages for the LLM (defaults 4000 / 0.1).

> **Cost note**: LLM extraction is slower and costs money per call. It is **off by default**, and results are cached locally for 24 hours (keyed by URL + extraction settings) so repeat crawls don't re-bill.

#### Troubleshooting: "LLM extraction unavailable"

If a crawl returns the **"LLM extraction unavailable"** notice (Katab fell back to Markdown), the Crawl4AI server could not run the `/llm` extraction job. Common causes and fixes:

1. **Server doesn't expose `/llm/job`** — you need Crawl4AI v0.9.x (the endpoint ships with the secure-by-default server). Upgrade the image.
2. **Provider not allowed** — the server must allow the provider family you requested. Set `LLM_PROVIDER=<the same provider value>` (e.g. `LLM_PROVIDER=deepseek/deepseek-v4-flash`) in `.llm.env` — or `llm.provider` / `llm.allowed_providers` in `config.yml` — then restart the container.
3. **Missing server LLM key** — set the provider's API key (e.g. `DEEPSEEK_API_KEY`) in `.llm.env` / container environment.

Katab now uses the sanctioned `/llm` endpoint automatically, so **no image patching is required**. (If you previously patched `UNTRUSTED_ALLOWED_TYPES` to allow `LLMExtractionStrategy` on `/crawl`, that still works too — but it's no longer necessary.)

### Security
- Scraped content is **untrusted data** — same SSRF and content safety protections as web search.
- All URLs are validated against the shared network guard before fetching.
- The tool communicates directly with Crawl4AI over HTTP — no subprocess or shell invocation.

---

## 9. Optional Knowledge Base (RAG)

Katab can search a local semantic knowledge base using a Python FastAPI + ChromaDB service. Your documents, conversations, and research findings are indexed into vector embeddings for similarity-based retrieval. The tool is disabled by default.

### Step 1 — Run the RAG Service
Ensure the Python RAG service is running at `http://localhost:11435`:
```bash
curl http://localhost:11435/health
```

The service uses Ollama for embeddings. Ensure Ollama is running and an embedding model is pulled:
```bash
ollama pull nomic-embed-text
```

### Step 2 — Enable in Katab
1. Open Katab preferences → **Tools** → **Knowledge Base**.
2. Turn on **Enable Knowledge Base**.
3. Configure the **Service URL** (default: `http://localhost:11435`).
4. Set the **Ollama URL** for embeddings (default: `http://localhost:11434`).
5. Choose an **Embedding Model** (e.g., `nomic-embed-text`).
6. Click **Test Connection**.

### Step 3 — Use
- **Manual**: `/kb what are the key findings from last week's research` — Katab searches the knowledge base and injects relevant results as context.
- **Auto mode**: When KB mode is set to **Auto**, Katab automatically searches the knowledge base before each message and adds relevant context. Set to **On** for one-shot search, **Off** to skip.
- **Autonomous**: The model can call `knowledge_search` when it needs information from your indexed documents.

### Settings Reference
| Setting | Description |
|---|---|
| **Service URL** | RAG service endpoint |
| **Ollama URL** | Ollama endpoint for embeddings |
| **Embedding model** | Model used for vector embeddings |
| **Chunk size / Overlap** | Document splitting parameters |
| **Top-K** | Number of results to retrieve per query |
| **Max chunks / collection** | Capacity limits |
| **Auto-prune** | Automatically clean old entries |
| **Index toggles** | Which content to index: documents, conversations, research |
| **Auto-update** | Re-index when files change |
| **Reranking** | Re-rank results for improved relevance |
| **Hybrid search** | Combine semantic and keyword search |

---

## 10. Deep Research Mode

Deep Research is a meta-mode that raises tool-call limits and context thresholds for exhaustive multi-source research. Instead of stopping after a few web searches, it runs an iterative pipeline:

### Pipeline Phases

1. **Planning** — The AI breaks your query into 3–5 research angles with SEO-optimized search queries. You can review and approve before execution begins. While a plan is pending, you can keep chatting to request changes — follow-up messages are treated as plan revisions (e.g. *"it's 2026, not 2025 — update the plan"*) and edit the existing plan in place rather than replacing it. Use **Edit plan** to adjust angles manually, **Cancel plan** to abandon the research, or **Start research** to begin.
2. **Branch Execution** — Each angle runs sequentially: search → read → crawl → compress. Cross-branch context is shared so later angles benefit from earlier findings.
3. **Mid-Research Critique** — After every few branches, the AI evaluates coverage and adjusts remaining angles.
4. **Gap Analysis** — A lightweight review identifies uncovered aspects and generates 0–2 targeted follow-up queries.
5. **Refinement** — Gap-filling mini-branches with focused search and crawl.
6. **Two-Pass Synthesis** — First pass generates a structured outline. Second pass streams the full report with the outline as a scaffold.
7. **Quality Check** — The report is scored (1–5). If below 3, additional research is triggered.

### How to Use
- Type `/research` in your message, or cycle the **Research** footer button to **On**.
- The research button only appears when web search or Crawl4AI is available.
- A progress card shows each phase as it completes, with timing and source counts.

### Threshold Differences
| Parameter | Normal | Deep Research |
|---|---|---|
| Force-synthesis after | 5 iterations | 12 iterations |
| Context synthesis threshold | 50K chars | 150K chars |
| Search results per query | 10 → 8 → 5 → 3 | 15 → 10 → 8 → 5 |
| Crawl char limit | 24K → 12K → 6K → 3K | 24K → 16K → 10K → 6K |

### What to Expect
- Deep Research takes longer — each branch involves multiple network calls and compression steps.
- Reports include inline citations and a bibliography section.
- The compression pipeline preserves granular facts alongside summarized findings.
- Results are cached so repeated research on similar topics is faster.

---

## 11. Ollama Presets

Presets let you save, load, and share complete Ollama configurations. Each preset captures all 27 Ollama settings: model, context size, sampling parameters, hardware settings, system prompt, and more.

### Managing Presets from Chat
1. Click the **Preset** button in the chat header (only visible when Ollama is active).
2. View your saved presets in the picker panel.
3. Click a preset to load it — all Ollama settings are applied immediately.
4. To save current settings as a preset: type a name in the save bar and click **Save**.
5. Delete presets from the same panel.

### Managing Presets from Preferences
Open Katab preferences → **Ollama** → **Model Presets**:
- **Save Current Settings**: Enter a name and click Save to snapshot all current Ollama settings.
- **Load**: Apply a preset's settings.
- **Delete**: Remove a preset.
- **Pending Changes**: If you modify settings after loading a preset, a row appears offering to **Save Changes** (overwrite the preset) or **Discard Changes** (reload the preset).

### What Presets Capture
Model, base URL, context size, prediction length, keep-alive, format (JSON/none), raw mode, think mode, temperature, top-k, top-p, min-p, tfs-z, typical-p, mirostat, mirostat-tau, mirostat-eta, repeat-last-n, repeat-penalty, presence-penalty, frequency-penalty, use-mmap, use-mlock, num-gpu, num-thread, and system prompt.

---

## 12. AI Token Breakdown & Pets

Katab keeps a private, local-only ledger of your AI token usage and pairs it with a pet collection system. Everything stays on your computer — no data is sent anywhere.

### Opening the Breakdown
- **Chat window** — click the **Tokens** button in the header.
- **Top bar** — the panel dropdown shows a snapshot (pet sprite, range total, local share, provider share bar). Click it to open the full breakdown.

### Usage Dashboard
- **Time ranges**: Today, Week, Month, Year, All Time.
- **Chat combo**: Each reply in the same conversation builds a streak. The combo card shows reply count and session token score. Combos reset on new chat.
- **Live counter**: Streaming token estimate in the chat header.
- **Totals**: Prompt/reply split, reply count, DeepSeek cached-token savings.
- **Efficiency**: Average tokens per reply, prompt:completion ratio, cache hit rate.
- **Trend**: Comparison with previous range, most active day.
- **By provider**: Stacked share bar, per-provider token rows with percentages.
- **Top models**: Which models consumed the most tokens.
- **Local share**: How much ran on your hardware, with a quick action to switch to Ollama.
- **Achievements**: 21 badges across progression, streak, and special categories.
- **Activity strip**: 14-day mini bar chart.
- **Estimated cost**: Built-in pricing for major models.

### Pet Collection
Five provider pets live in your collection:

| Provider | Pet |
|---|---|
| Ollama | **Ollie** |
| Unsloth | **Slothy** |
| OpenAI | **Sparky** |
| Anthropic | **Clyde** |
| DeepSeek | **Pearl** |

#### How Pets Work
- A provider's first tracked response **hatches** its egg.
- Only tokens used with that provider feed its pet.
- Each pet tracks independent XP and progresses through 6 stages:

| Stage | Min XP | Sprite |
|---|---|---|
| Unhatched Egg | 0 | Egg |
| Hatchling | 1 | Baby |
| Sprout | 10,000 | Baby |
| Scholar | 100,000 | Adult |
| Sage | 1,000,000 | Adult |
| Archmage | 10,000,000 | Adult |

#### Active Companion
- By default, the active pet follows your current provider.
- Open **View Collection** → select a pet or form → **Make Companion** to pin it.
- Provider usage still feeds the pet belonging to the provider that generated the response.
- Choose **Follow Current Provider** to return to automatic switching.

#### Crossbreeds & Mixie
- When two provider pets reach **Sprout** (10K XP), their crossbreed pair unlocks permanently in both directions.
- The base pet supplies the body and stage; the other pet supplies an accessory overlay.
- When all five pets reach Sprout, **Mixie** unlocks — its stage equals the lowest stage shared by all five provider pets.

#### Persistence
- Pet XP and unlocks are permanent collection data — they survive analytics pruning and retention policies.
- Optional in-chat and desktop celebrations announce hatches, stage-ups, crossbreeds, and Mixie milestones.

### Token Budget & Cost Tracking
- Set a **monthly USD budget** and warning threshold (default: $5 at 70%).
- Katab estimates costs from token counts using built-in pricing tables.
- Warnings appear in-chat and as desktop notifications when approaching the limit.

### Export & Reset
Open **Settings → General → AI Token Breakdown**:
- **Export**: JSON, CSV, Markdown report, or self-contained HTML page.
- **Reset**: Deletes token analytics, all pet XP, crossbreeds, and Mixie progress. Chat history is not affected.
- **Pause Tracking**: Temporarily stop recording without deleting data.
- **Retention**: Keep forever, prune after 90 days, or prune after 1 year.
- **Desktop Notifications**: Toggle companion stage-ups, achievements, and budget alerts.

---

## 13. Chat History

Katab automatically saves your conversations.

### Storage
- File: `~/.local/share/katabai/history.json`
- Format: JSON array of conversations, each with `id`, `title`, `timestamp`, and `messages`.
- Limit: 50 most recent conversations.
- Title: First 60 characters of your first message.

### Managing History
- **History button** in the chat header opens the history panel.
- Click a conversation to load it — the current conversation is saved first.
- **New Chat** in the panel menu or via the button starts a fresh conversation.
- Conversations are saved automatically after each assistant response and tool call.
- Closing the chat window does not lose the current conversation — it resumes when you reopen.

### Auto-Save Behavior
- Writes are debounced (200ms) to minimize disk I/O.
- A synchronous flush runs on extension disable to prevent data loss on shutdown.
- The current conversation is saved before loading history or starting a new chat.

---

## 14. Keyboard Shortcut & Theme

### Keyboard Shortcut
- **Default**: `Ctrl+Super+C` toggles the chat overlay.
- **Change**: Go to Preferences → General → **Toggle Chat Window**. Click the shortcut row and press your desired key combination.

### Dark/Light Theme
Katab automatically detects your GNOME desktop theme (dark or light) and switches its appearance in real time:
- The shell overlay uses `.katab-theme-dark` / `.katab-theme-light` classes on the dialog and panel menu.
- The preferences window uses `.katab-prefs-theme-dark` / `.katab-prefs-theme-light`.
- Detection reads `org.gnome.desktop.interface` `color-scheme` key (shell side) and `Adw.StyleManager` (prefs side).
- Changes take effect immediately when you switch your system theme — no restart needed.

---

## 15. Preferences Overview

The GTK4/Adwaita preferences window has these navigation pages:

| Page | Contents |
|---|---|
| **General** | Provider selection, keyboard shortcut, document tool toggle, token breakdown settings, budget, export |
| **Ollama** | Base URL, model, context size, sampling parameters, hardware settings, system prompt, presets |
| **DeepSeek** | API key, model, thinking mode, JSON mode, system prompt, vision model configuration |
| **Unsloth** | Base URL, API key, model, context size |
| **OpenAI** | Base URL, API key, model |
| **Anthropic** | Base URL, API key, model |
| **Tools → Document** | Document tool settings |
| **Tools → Web Search** | SearxNG connection and search settings |
| **Tools → Web Scraper** | Crawl4AI connection and extraction settings |
| **Tools → Knowledge Base** | RAG service connection and indexing settings |

### Common Preferences Features
- **Connection Testing**: Most provider and tool pages have a **Test Connection** button with a status badge.
- **Capability Badges**: Document tool page shows which parsers are available (Built in / Detected / Install needed).
- **Settings Sync**: Preferences rows mirror external `gsettings`/`dconf` changes — if you change a setting via command line, the UI updates automatically.
- **Provider-Specific Pages**: Only settings relevant to each provider appear on its page.

---

## 16. Troubleshooting

### Common Issues

#### "Provider is down" (red dot in panel)
- **Ollama**: Ensure the daemon is running (`ollama serve` or `systemctl start ollama`).
- **Unsloth**: Check that Unsloth Studio is running at the configured URL.
- **DeepSeek/OpenAI/Anthropic**: Verify your API key and internet connection.

#### "Model not found"
- **Ollama**: Pull the model first: `ollama pull <model-name>`.
- **Other providers**: Check the model name spelling in preferences.

#### Web search returns no results
- Ensure SearxNG is running and JSON format is enabled in `settings.yml`:
  ```yaml
  search:
    formats:
      - html
      - json
  ```
- Verify with: `curl 'http://localhost:8080/search?q=test&format=json'`
- If you get HTML or a 403, JSON format is not enabled.

#### Crawl4AI connection fails
- Ensure the Docker container is running: `docker ps | grep crawl4ai`
- Verify the health endpoint: `curl http://localhost:11235/health`
- Check the URL in preferences matches your container port.

#### Knowledge Base search times out
- Ensure the RAG service is running: `curl http://localhost:11435/health`
- Ensure Ollama is running for embeddings.
- Auto KB search has a 3-second timeout — if the service is slow, switch KB mode to **Off** or **On** (manual).

#### Responses are blank or very short
- If using DeepSeek Flash with web tools enabled, the model may hit tool-call limits. Try switching to Pro, or disable autonomous web search.
- Long conversations with many tool calls may trigger force-synthesis. Start a new chat for a fresh context.

#### "Not in the stage" warnings in logs
- These are harmless. They occur when the extension styles widgets before they appear on screen. They don't affect functionality.

#### Extension doesn't load
- Check the journal: `journalctl -f -o cat /usr/bin/gnome-shell | grep -i katab`
- Ensure schemas are compiled: `glib-compile-schemas ~/.local/share/gnome-shell/extensions/katabai@cetikaytools.com/schemas/`
- Verify GNOME Shell version is 46, 47, or 48.

### Diagnostic Commands
```bash
# Check Ollama
curl http://localhost:11434/api/tags

# Check SearxNG
curl 'http://localhost:8080/search?q=test&format=json'

# Check Crawl4AI
curl http://localhost:11235/health

# Check RAG service
curl http://localhost:11435/health

# Check Unsloth
curl http://localhost:8888/v1/tokenize -H "Content-Type: application/json" -d '{"text":"test"}'

# View Katab logs
journalctl -f -o cat /usr/bin/gnome-shell | grep -i katab

# Check GSettings
gsettings list-recursively org.gnome.shell.extensions.katabai
```

### Data Locations
| Data | Path |
|---|---|
| Chat history | `~/.local/share/katabai/history.json` |
| Token usage | `~/.local/share/katabai/token-usage.json` |
| Ollama presets | `~/.local/share/katabai/presets.json` |
| Research cache | `~/.local/share/katabai/research-cache.json` |

---

## 17. Glossary

| Term | Definition |
|---|---|
| **Katab** | Punjabi for "book" (ਕਿਤਾਬ) — the extension name. |
| **Provider** | An AI backend: Ollama, Unsloth, DeepSeek, OpenAI, or Anthropic. |
| **Tool** | A capability exposed to the model: `web_search`, `read_url`, `crawl_url`, `document`, `deep_research`, `knowledge_search`. |
| **Tool Mode** | Auto (model decides when to use tools), On (forced for one message), Off (disabled). |
| **Deep Research** | Multi-phase research pipeline with planning, parallel branches, gap analysis, and synthesis. |
| **RAG** | Retrieval-Augmented Generation — semantic search over a local vector database (ChromaDB). |
| **SSRF** | Server-Side Request Forgery — the network guard blocks requests to private/internal addresses. |
| **SSE** | Server-Sent Events — protocol used for streaming LLM responses line by line. |
| **Pet Companion** | Gamified avatar tied to a provider: Ollie, Slothy, Sparky, Clyde, or Pearl. |
| **Pet Stage** | Evolution level: Egg → Hatchling → Sprout → Scholar → Sage → Archmage. |
| **XP** | Experience points — earned from token usage with a provider. |
| **Crossbreed** | Combined pet form unlocked when two provider pets reach Sprout. |
| **Mixie** | Collection reward pet — unlocked when all five pets reach Sprout. |
| **Preset** | Saved Ollama configuration profile capturing all model settings. |
| **Compression** | LLM-based summarization pipeline that reduces web page content into concise findings. |
| **Synthesis** | The final phase where the model writes its answer after gathering tool results. |
| **Truncation Tier** | Progressive reduction of tool result sizes as more iterations are performed. |
| **Healing Retry** | When a model emits malformed tool-call syntax, Katab strips it and retries with a correction prompt. |
| **Force Synthesis** | Stops advertising tools when context exceeds a threshold, compelling the model to write its answer. |
| **Thinking/Reasoning** | The model's internal reasoning process, shown in a collapsible block. |
| **Citation** | Clickable `[N]` marker linking a claim to its source in the bibliography. |
