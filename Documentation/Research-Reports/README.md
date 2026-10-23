# Research Reports (Historical)

These reports were collected during Katab's design phase. They describe candidate APIs, trade-offs,
and external product behavior at the time of writing. **They are not current documentation** — the
implementation may differ, providers change, and some proposals were never adopted. Use
`Documentation/Technical/API_REFERENCE.md` and the code for the actual integration.

| Report | Focus |
|---|---|
| [Ollama — Harnessing Ollama API for AI Assistants](ollama/Harnessing%20Ollama%20API%20for%20AI%20Assistants.md) | Ollama endpoints, sampling parameters, tool-calling loops, VRAM tuning |
| [Ollama — Enhancing GNOME AI Harness Settings](gnome/Enhancing%20Gnome%20AI%20Harness%20Settings.md) | Mapping Ollama runtime options onto GNOME preferences UI |
| [SearxNG — GNOME Extension Tool Development](searxng/GNOME%20Extension%20SearxNG%20Tool%20Development.md) | Local metasearch integration blueprint (originally MCP-oriented) |
| [Crawl4AI — SearXNG & Crawl4AI Integration](crawl4ai/AI%20Extension_%20SearXNG%20%26%20Crawl4AI%20Integration.md) | Dual-engine scraping architecture and REST usage |
| [Crawl4AI — Enhance AI Extension with Web Scraping](crawl4ai/Enhance%20AI%20Extension%20with%20Web%20Scraping.md) | LLM-ready page extraction and filtering strategies |
| [Unsloth Studio — Harnessing the API](unsloth/Harnessing%20Unsloth%20Studio%20API.md) | Local Unsloth server, sessions, and server-side tools |
| [DeepSeek — API Integration Research](deepseek/DeepSeek%20API%20Integration%20Research.md) | Chat completions, reasoning, and vision integration notes |

How the shipped integration differs today:

- SearxNG is called directly over its JSON API (no MCP process).
- Crawl4AI uses `/crawl`, `/crawl/job`, and the sanctioned `/llm/job` endpoint for LLM extraction.
- Unsloth's `web_search`, `python`, and `terminal` tools run server-side and are not reimplemented
  locally.
- DeepSeek uses `deepseek-flash` (native image input) and `deepseek-v4-pro` (text-only, optional
  vision routing).
