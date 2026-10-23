# Security Policy

## Contents

- [Supported Versions](#supported-versions)
- [Reporting a Vulnerability](#reporting-a-vulnerability)
- [Secrets and Configuration](#secrets-and-configuration)
- [Tool Safety](#tool-safety)
- [Data at Rest](#data-at-rest)
- [Network Guard Reference](#network-guard-reference)
- [Prompt-Injection and Content Handling](#prompt-injection-and-content-handling)

---

## Supported Versions

Security fixes are applied to the `main` branch and shipped in the next extension release. Katab is
a desktop extension, not a hosted service: there is no Katab-operated backend, telemetry, or shared
data store.

## Reporting a Vulnerability

Please **do not open a public issue** for a security problem.

1. Use GitHub's private vulnerability reporting on
   [inderdeepk/katabai-cetikaytools.com](https://github.com/inderdeepk/katabai-cetikaytools.com)
   (Security → *Report a vulnerability*).
2. If that is unavailable, contact the repository owner privately through their GitHub profile.
3. Include the affected version (`metadata.json`), the GNOME Shell version, reproduction steps, and
   the impact you believe is possible.

Please allow a reasonable window for a fix before public disclosure. Reports about the extension's
own code are in scope; vulnerabilities in Ollama, SearxNG, Crawl4AI, ChromaDB, or a provider API
belong upstream unless Katab's integration makes them reachable.

---

## Secrets and Configuration

### Where secrets live

- API keys (Ollama has none; Unsloth, DeepSeek, OpenAI, Anthropic, SearxNG, Crawl4AI, and the
  optional vision endpoint do) are stored in **GSettings** under
  `org.gnome.shell.extensions.katabai`.
- GSettings persists values through dconf in `~/.config/dconf/user`. **dconf is not encrypted**, and
  it is readable by the logged-in user and by root.
- Katab never reads `.env` files and never hardcodes credentials.

### Handling guidance

- Never commit real keys, tokens, or cookies. Use `sk-xxxxxxxxxxxx` placeholders in docs and tests.
- Rely on full-disk encryption and correct home-directory permissions for defense in depth.
- Rotate a key immediately if it was committed or pasted into an issue; then purge it from history.
- Screenshots and logs: Katab does not log request headers or keys. If you paste journal output,
  check for accidental key material first.

### In code

- Keys are attached only to the request headers for the endpoint that needs them.
- The Crawl4AI LLM key is configured **server-side** (`.llm.env`); Katab sends only the provider
  name to `/llm/job`.
- Provider error bodies are surfaced to the UI for diagnosis; they are not forwarded to other
  services.

---

## Tool Safety

All optional tools are disabled by default and can be enabled individually under
**Settings → Tools**.

### Document tool

- Reads local files the user selects; it never shells out through a command interpreter.
- PDF and DOCX parsing use direct `Gio.Subprocess` argv calls to `pdftotext` / `pandoc` (no shell
  expansion).
- Plain text, Markdown, images, and `.eml` are parsed in-process.
- Saved conversations keep attachment **metadata only**; reattach a file to reuse its text.

### Web search (SearxNG)

- Talks directly to the user-configured SearxNG JSON API over HTTP; no Docker spawning and no
  subprocess.
- Search results and fetched pages are **untrusted input**: labelled, length-bounded, and never
  executed.
- When web/tool results are present, Katab injects a safety instruction telling the model to treat
  them as data, not instructions.
- An optional SearxNG API key is stored in GSettings and sent only as
  `Authorization: Bearer <token>` to that instance.
- When Unsloth is active, web search runs server-side on Unsloth and this path is unused.

### Page reading (`read_url`) and subpage following

- Only `http`/`https` URLs are accepted.
- `src/shared/networkGuard.js` blocks private, loopback, link-local, CGNAT, and multicast IPv4
  ranges, loopback/unique-local/link-local IPv6, and localhost-style hostnames. It resolves DNS
  before fetching and revalidates every redirect target.
- `web-search-allow-local-addresses` (off by default) is the only relaxation and is intended for
  trusted local-only deployments.
- Reading PDF pages reuses `pdftotext`.

### Web scraper (Crawl4AI)

- Communicates directly with the user's Crawl4AI container over HTTP; no shell or subprocess.
- Every URL passes the same SSRF guard before scraping (`crawl4ai-allow-local-addresses` is the only
  opt-out).
- Scraped content is untrusted and follows the same labelling/truncation/safety-instruction rules.
- An optional JWT is stored in GSettings and sent as `Authorization: Bearer <token>`.
- LLM extraction sends only a URL, provider name, instruction, and schema to `/llm/job`; the LLM
  credentials stay on the Crawl4AI server.
- Subpage following (Deep Research) is one level deep and bounded by
  `crawl4ai-max-follow-links` (cap 10).

### Knowledge base (RAG)

- The service binds to loopback (`127.0.0.1:11435`); all embedding and indexing stays local.
- Indexed content (documents, conversations, tool results, research cache, memory facts) remains on
  the machine in `~/.local/share/katabai/chroma/`.
- Retrieved KB content can include previously crawled web text; result blocks label it as reference
  data and the web-content policy applies whenever KB context is present.
- `update_knowledge` / `forget_knowledge` can only touch memory-fact chunks (`update_<slug>` ids) —
  never documents or conversation history. With **Auto-update** off, both require confirmation.
- Deleting a conversation also purges that conversation's indexed chunks.
- `/kb import` parses only supported formats (`txt`, `md`, `pdf`, `docx`, `eml`) from paths the user
  explicitly selects.

### Deep research

- Synthesizes content from multiple untrusted web sources; compression prompts and the content
  safety policy mitigate prompt injection.
- Every fetch goes through the same SSRF guards.
- Results are cached locally in `~/.local/share/katabai/research-cache.json`; checkpoints live in
  `research-checkpoint.json`.
- The synthesis prompt explicitly treats web-sourced data as untrusted.

---

## Data at Rest

| Data | Path | Contains |
|---|---|---|
| Settings (incl. API keys) | dconf `org.gnome.shell.extensions.katabai` | Keys, URLs, prompts |
| Chat history | `~/.local/share/katabai/history.json` | Full transcripts, attachment metadata |
| Token ledger | `~/.local/share/katabai/token-usage.json` | Usage, cost, pet XP |
| Presets | `~/.local/share/katabai/presets.json` | Ollama profiles (including system prompt) |
| Research cache/checkpoints | `~/.local/share/katabai/research-cache.json`, `research-checkpoint.json` | Web content and findings |
| KB state | `~/.local/share/katabai/rag-index-state.json` | Index bookkeeping |
| KB vectors | `~/.local/share/katabai/chroma/` | Embedded documents/conversations |
| Usage export | `~/Documents/katabai-token-usage-*.json` | Ledger snapshot (user-triggered) |

Katab does not read these files outside the extension, and none of them is uploaded anywhere except
as part of a request you send to a provider you configured.

---

## Network Guard Reference

`src/shared/networkGuard.js` exports:

- `isPrivateIPv4(host)` — blocks RFC1918, loopback, link-local, CGNAT, multicast, and reserved
  ranges.
- `isBlockedIPv6(host)` — blocks loopback, unique-local, and link-local addresses.
- `isBlockedHost(host, allowLocal)` — blocks localhost-style and `.local` names unless allowed.
- `assertFetchableUrl(url, { allowLocal }, errorClass)` — validates scheme, host, and resolved IPs.
- `getUrlHost(url)`, `resolveRedirectUrl(baseUrl, location)`, `lookupHostAddresses(host)`.

The module is unit-tested (`tests/networkGuard.test.js`) and shared by web search, crawl, explore
docs, and the research branch runner.

---

## Prompt-Injection and Content Handling

- Web, scrape, KB, and document content is wrapped in clearly delimited blocks with source labels.
- Tool results are truncated per iteration so a hostile page cannot consume the whole context.
- Katab never executes instructions found in fetched content; the model is told the same.
- The model can propose `update_knowledge` / `forget_knowledge`, but those are local state changes
  gated by explicit confirmation unless auto-update is enabled.
- Code blocks from web pages are shown as text; they are never run.
