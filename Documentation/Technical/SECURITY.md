# Security Policy

## Supported Versions

Currently, the main branch of `katabai-cetikaytools.com` is supported with security updates.

## Reporting a Vulnerability

We take the security of Katab seriously. If you discover a security vulnerability or if you believe an API key or a secret has been accidentally exposed, please let us know immediately.

1. **Do not** open a public issue regarding the vulnerability.
2. Please report the issue privately. (Provide contact instructions here, e.g., email the repository owner or use GitHub's private vulnerability reporting feature).
3. Be sure to include full details of the vulnerability and steps to reproduce.

### API Key Best Practices
- Never commit `sk-...` formatted keys to source code or documentation.
- Rely on GNOME's GSettings via `prefs.js` for inputting secrets into the extension.

### Document Tool Safety Notes
- The optional document tool only reads local native files and does not shell out through a command interpreter.
- PDF and DOCX parsing use direct `Gio.Subprocess` argv calls to local tools such as `pdftotext` and `pandoc`.
- Saved conversations keep document metadata only. Reattach the file if you need the full extracted text in a later session.

### Web Search Tool Safety Notes
- The optional web search tool talks directly to a user-configured, self-hosted SearxNG instance over HTTP using `libsoup`. It never spawns Docker, never launches a subprocess, and never contacts a third-party search broker.
- Search results and fetched pages are treated as **untrusted input**. They are clearly labelled, length-bounded, and never executed, mitigating prompt-injection from web content.
- When web tools are available or web/tool results are present in the conversation, Katab adds a provider-level safety instruction for providers that support system-style prompts: web results, fetched pages, and tool output are data to analyze, not instructions to obey.
- The optional `read_url` page fetch is guarded against SSRF: it accepts only `http`/`https` URLs, blocks private, loopback, and link-local addresses (IPv4 and IPv6), checks resolved DNS addresses before fetching, and manually revalidates every redirect target. The `web-search-allow-local-addresses` setting (off by default) is the only way to relax this, and is intended for trusted local-only deployments.
- An optional SearxNG API key is stored through GSettings like other secrets and sent only as an `Authorization: Bearer` header to the configured instance.
- The tool is disabled by default. When Unsloth is the active provider, web tooling runs server-side on Unsloth and the local SearxNG path is not used.

## Crawl4AI Web Scraper Safety Notes

- The Crawl4AI tool communicates directly with a user-configured, self-hosted Crawl4AI Docker container over HTTP using `libsoup`. It never spawns shells or subprocesses.
- All URLs are validated by the shared SSRF guard (`src/shared/networkGuard.js`) before scraping — the same IPv4/IPv6 blocklists and DNS validation used by web search.
- Scraped content is treated as **untrusted input** with the same labelling, truncation, and safety instruction injection as web search results.
- The `crawl4ai-allow-local-addresses` setting (off by default) is the only way to relax SSRF protection.
- An optional JWT API token is stored through GSettings and sent as an `Authorization: Bearer` header.
- The tool is disabled by default.

## Knowledge Base (RAG) Safety Notes

- The RAG tool communicates with a local Python FastAPI service at `localhost:11435` over HTTP.
- No data is exfiltrated — all embeddings, indexing, and search happen locally.
- The service is expected to be firewalled from external networks.
- Content indexed into the knowledge base (documents, conversations, research results) remains on the local machine.

## Deep Research Safety Notes

- Deep research synthesizes content from multiple untrusted web sources. The compression pipeline and content safety policy mitigate prompt injection from web content.
- All web fetches during research go through the same SSRF guards as regular web search and crawl.
- Research results are cached locally in `~/.local/share/katabai/research-cache.json`.
- The synthesis model receives clear instructions to treat all web-sourced data as untrusted.

## Network Guard Reference

The shared SSRF protection module is at `src/shared/networkGuard.js`. It exports:
- `isPrivateIPv4(addr)` — blocks 10.x, 172.16-31.x, 192.168.x, 127.x, link-local, CGNAT, multicast
- `isBlockedIPv6(addr)` — blocks loopback, unique local, link-local
- `isBlockedHost(host)` — blocks localhost/.local hostnames
- `assertFetchableUrl(url, errorClass)` — validates scheme, host, and resolved IPs
- `getUrlHost(url)`, `resolveRedirectUrl(url)`, `lookupHostAddresses(host)`
