# Katab (ਕਿਤਾਬ) - AI Assistant

Katab (ਕਿਤਾਬ) is a beautiful GNOME desktop AI assistant, offering quick access to local Ollama endpoints and OpenAI tools right from your status bar.

## Goals

The vision for Katab is to provide a seamless, integrated AI assistant directly into the GNOME desktop environment, enabling quick local and remote AI access without disrupting your workflow.

## Installation

### Prerequisites
- GNOME Shell version 46.
- Optional local file support:
   - Plain text, Markdown, PNG, JPG, and JPEG work without extra packages.
   - Image attachments are sent only through Ollama and require a vision-capable model such as `llama3.2-vision` or `llava`.
   - PDFs require `pdftotext` from `poppler-utils` or the distro-equivalent `poppler` package.
   - DOCX files require `pandoc`.

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

Katab keeps a private, local-only ledger of your AI token usage and turns it into a fun companion with gamification:

- **Tokens button (top middle of the chat window)** — opens the full breakdown: totals for today / week / month / year / all time, combo streak with score, provider and model percentages with share bars, local-vs-cloud split, efficiency metrics (avg/reply, P:C ratio), trend card, milestone row, achievement badges, and a 14-day activity strip.
- **Chat combo system** — each reply in the same conversation builds a combo streak visible in the chat header. Combos rack up a token score and unlock achievements; starting a new chat resets the counter to zero.
- **Header live counter** — a streaming token counter appears next to the combo indicator during active responses, showing estimated tokens in real time.
- **Achievement system** — 21 achievements across progression, streak, and special categories. Unlock badges like "Homegrown", "Deep Dive", "Diplomat", and "Penny Pincher". New unlocks show in-chat and in the achievements panel.
- **Model pricing & cost** — built-in pricing for major models (GPT-4o, Claude, DeepSeek, etc.) with estimated spend calculation. The efficiency card shows tokens/reply averages and prompt:completion ratios.
- **Panel dropdown snapshot** — the GNOME top-bar menu shows the active pet sprite, selected-range total, local share, leading provider, and a tiny provider share bar. Click it to jump straight to the full breakdown.
- **Pet collection** — Ollie, Slothy, Sparky, Clyde, and Pearl each hatch and gain permanent XP from their own provider's token usage. Every pet independently grows through Hatchling → Sprout → Scholar → Sage → Archmage.
- **Active companion** — follow the currently selected provider automatically or pin any available provider pet, crossbreed form, or Mixie from the collection view.
- **Crossbreeds and Mixie** — raising two pets to Sprout permanently unlocks both directional crossbreed forms. Raising all five to Sprout unlocks Mixie, whose stage follows the least-advanced provider pet.
- **Gentle local nudge** — the local card explains how much usage ran on hardware you control and includes a quick action that switches the next draft to Ollama.
- **Export formats** — export your usage data as JSON, CSV, Markdown report, or a self-contained HTML page via the preferences panel.
- **Settings controls** — Settings → General lets you pause tracking, choose the analytics range and retention, select follow/pinned companion behavior, enable celebrations, manage monthly budget warnings, export data, or reset analytics and collection progress. Everything stays local.

## Contribution Guidelines

* **NEVER commit any API keys, credentials, or secrets to the repository.**
* Ensure that the `schemas/gschemas.compiled` file and any IDE configurations are kept out of version control (they are ignored via `.gitignore`).
* When updating documentation, always use mock placeholders for any API key examples (e.g., `sk-xxxxxxxxxxxx`).

## License

*(Add your license information here)*
