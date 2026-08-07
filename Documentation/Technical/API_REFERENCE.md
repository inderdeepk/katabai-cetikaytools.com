# Katab API Reference

This document provides a complete reference for Katab's GSettings schema, tool definitions (as sent to AI providers), and external service API endpoints.

---

## Table of Contents

- [GSettings Schema Reference](#gsettings-schema-reference)
  - [General Settings](#general-settings)
  - [Ollama Settings](#ollama-settings)
  - [DeepSeek Settings](#deepseek-settings)
  - [Unsloth Settings](#unsloth-settings)
  - [OpenAI Settings](#openai-settings)
  - [Anthropic Settings](#anthropic-settings)
  - [Web Search Settings (SearxNG)](#web-search-settings-searxng)
  - [Web Scraper Settings (Crawl4AI)](#web-scraper-settings-crawl4ai)
  - [Knowledge Base Settings (RAG)](#knowledge-base-settings-rag)
  - [Token Usage & Pets Settings](#token-usage--pets-settings)
- [Tool Schema Reference](#tool-schema-reference)
  - [web_search](#web_search)
  - [read_url](#read_url)
  - [crawl_url](#crawl_url)
  - [knowledge_search](#knowledge_search)
  - [document](#document)
  - [deep_research](#deep_research)
- [External Service APIs](#external-service-apis)
  - [Ollama](#ollama)
  - [DeepSeek](#deepseek)
  - [Unsloth Studio](#unsloth-studio)
  - [OpenAI](#openai)
  - [Anthropic](#anthropic)
  - [SearxNG](#searxng)
  - [Crawl4AI](#crawl4ai)
  - [RAG Service](#rag-service)

---

## GSettings Schema Reference

Schema ID: `org.gnome.shell.extensions.katabai`
Path: `/org/gnome/shell/extensions/katabai/`

### General Settings

| Key | Type | Default | Description |
|---|---|---|---|
| `provider` | `s` | `'unsloth'` | Active AI provider: `ollama`, `unsloth`, `openai`, `anthropic`, or `deepseek` |
| `toggle-current-chat` | `as` | `["<Control><Super>c"]` | Keyboard shortcut to toggle the chat overlay |
| `document-tool-enabled` | `b` | `false` | Enable local document parsing tool |

### Ollama Settings

#### Connection
| Key | Type | Default | Description |
|---|---|---|---|
| `ollama-url` | `s` | `'http://localhost:11434'` | Ollama API base URL |
| `ollama-model` | `s` | `'llama3'` | Model name |
| `ollama-active-preset` | `s` | `''` | ID of the currently loaded preset |

#### Context & Generation
| Key | Type | Default | Description |
|---|---|---|---|
| `ollama-num-ctx` | `i` | `4096` | Context window size |
| `ollama-num-predict` | `i` | `-1` | Max generation tokens (-1 = unlimited) |
| `ollama-num-keep` | `i` | `0` | Retained system tokens |
| `ollama-keep-alive` | `s` | `'5m'` | Model retention in VRAM (e.g., `'5m'`, `'0'`, `'999999h'`) |
| `ollama-format` | `s` | `''` | Output format: `''` (none) or `'json'` |
| `ollama-raw` | `b` | `false` | Disable chat templating |
| `ollama-think` | `b` | `true` | Enable reasoning/thinking mode |
| `ollama-system-prompt` | `s` | *(see schema)* | System prompt prepended to requests |

#### Sampling Parameters
| Key | Type | Default | Range | Description |
|---|---|---|---|---|
| `ollama-temperature` | `d` | `0.7` | 0.0–2.0 | Sampling temperature |
| `ollama-top-k` | `i` | `40` | 1+ | Top-K sampling |
| `ollama-top-p` | `d` | `0.9` | 0.0–1.0 | Nucleus sampling |
| `ollama-min-p` | `d` | `0.05` | 0.0–1.0 | Minimum probability |
| `ollama-tfs-z` | `d` | `1.0` | 0.0–2.0 | Tail free sampling |
| `ollama-typical-p` | `d` | `1.0` | 0.0–2.0 | Typical sampling |

#### Mirostat (Dynamic Entropy)
| Key | Type | Default | Description |
|---|---|---|---|
| `ollama-mirostat` | `i` | `0` | Mirostat version (0 = disabled, 1, 2) |
| `ollama-mirostat-tau` | `d` | `5.0` | Target entropy |
| `ollama-mirostat-eta` | `d` | `0.1` | Learning rate |

#### Degeneration Control
| Key | Type | Default | Description |
|---|---|---|---|
| `ollama-repeat-last-n` | `i` | `64` | Lookback window for repetition |
| `ollama-repeat-penalty` | `d` | `1.1` | Multiplicative repeat penalty |
| `ollama-presence-penalty` | `d` | `0.0` | Presence penalty |
| `ollama-frequency-penalty` | `d` | `0.0` | Frequency penalty |

#### Hardware
| Key | Type | Default | Description |
|---|---|---|---|
| `ollama-use-mmap` | `b` | `true` | Memory mapping |
| `ollama-use-mlock` | `b` | `false` | Lock in physical RAM |
| `ollama-num-gpu` | `i` | `-1` | GPU layers (-1 = auto) |
| `ollama-num-thread` | `i` | `4` | CPU threads |

### DeepSeek Settings

#### Connection
| Key | Type | Default | Description |
|---|---|---|---|
| `deepseek-url` | `s` | `'https://api.deepseek.com'` | DeepSeek API base URL |
| `deepseek-api-key` | `s` | `''` | DeepSeek API key |
| `deepseek-model` | `s` | `'deepseek-v4-flash'` | Model: `deepseek-v4-flash` or `deepseek-v4-pro` |
| `deepseek-system-prompt` | `s` | *(see schema)* | System prompt |

#### Output Control
| Key | Type | Default | Description |
|---|---|---|---|
| `deepseek-thinking-enabled` | `b` | `true` | Enable chain-of-thought reasoning |
| `deepseek-reasoning-effort` | `s` | `'high'` | Reasoning depth: `'high'` or `'max'` |
| `deepseek-json-mode` | `b` | `false` | Force valid JSON output |

#### Vision Model (Image Support)
| Key | Type | Default | Description |
|---|---|---|---|
| `deepseek-vision-backend` | `s` | `''` | Vision backend: `''` (disabled), `'ollama'`, or `'openai'` |
| `deepseek-vision-mode` | `s` | `'preprocess'` | Routing mode: `'preprocess'` or `'direct'` |
| `deepseek-vision-model` | `s` | `''` | Vision model name (e.g., `llama3.2-vision`) |
| `deepseek-vision-fallback-model` | `s` | `''` | Secondary model if primary fails |
| `deepseek-vision-url` | `s` | `''` | OpenAI-compatible vision endpoint URL |
| `deepseek-vision-api-key` | `s` | `''` | Bearer token for vision endpoint |

#### Account Balance (read-only, polled by health monitor)
| Key | Type | Default | Description |
|---|---|---|---|
| `deepseek-balance-available` | `b` | `true` | Whether balance is sufficient |
| `deepseek-balance-currency` | `s` | `''` | Currency code (e.g., `CNY`) |
| `deepseek-balance-total` | `s` | `''` | Total balance |
| `deepseek-balance-granted` | `s` | `''` | Promotional credits |
| `deepseek-balance-topped-up` | `s` | `''` | Top-up credits |
| `deepseek-balance-last-checked` | `x` | `0` | Last balance check timestamp (ms) |

### Unsloth Settings

| Key | Type | Default | Description |
|---|---|---|---|
| `unsloth-url` | `s` | `'http://localhost:8888/v1'` | Unsloth Studio base URL |
| `unsloth-api-key` | `s` | `''` | API key (if required) |
| `unsloth-model` | `s` | `'default'` | Model name |
| `unsloth-num-ctx` | `i` | `8192` | Context window size |

### OpenAI Settings

| Key | Type | Default | Description |
|---|---|---|---|
| `openai-url` | `s` | `'https://api.openai.com/v1'` | OpenAI base URL |
| `openai-api-key` | `s` | `''` | OpenAI API key |
| `openai-model` | `s` | `'gpt-4o'` | Model name |

### Anthropic Settings

| Key | Type | Default | Description |
|---|---|---|---|
| `anthropic-url` | `s` | `'https://api.anthropic.com'` | Anthropic base URL |
| `anthropic-api-key` | `s` | `''` | Anthropic API key (`x-api-key` header) |
| `anthropic-model` | `s` | `'claude-3-5-sonnet-20241022'` | Model name |

### Web Search Settings (SearxNG)

| Key | Type | Default | Description |
|---|---|---|---|
| `web-search-enabled` | `b` | `false` | Enable web search tool |
| `web-search-url` | `s` | `'http://localhost:8080'` | SearxNG base URL (must have JSON format enabled) |
| `web-search-result-limit` | `i` | `5` | Max results per query (1–20) |
| `web-search-time-range` | `s` | `''` | Time filter: `''`, `day`, `week`, `month`, `year` |
| `web-search-safesearch` | `i` | `1` | SafeSearch: 0 (none), 1 (moderate), 2 (strict) |
| `web-search-language` | `s` | `''` | Language code filter (e.g., `'en'`) |
| `web-search-categories` | `s` | `'general'` | Comma-separated categories |
| `web-search-engines` | `s` | `''` | Comma-separated engine restrictions |
| `web-search-api-key` | `s` | `''` | Optional bearer token |
| `web-search-fetch-page-enabled` | `b` | `true` | Enable `read_url` page fetching |
| `web-search-multiquery-enabled` | `b` | `false` | Enable multi-query expansion |
| `web-search-autonomous-enabled` | `b` | `true` | Model can search autonomously |
| `web-search-allow-local-addresses` | `b` | `false` | Allow private/loopback URLs |
| `web-search-max-tool-iterations` | `i` | `10` | Max sequential tool call rounds (1–50) |

### Web Scraper Settings (Crawl4AI)

| Key | Type | Default | Description |
|---|---|---|---|
| `crawl4ai-enabled` | `b` | `false` | Enable web scraper |
| `crawl4ai-url` | `s` | `'http://localhost:11235'` | Crawl4AI base URL |
| `crawl4ai-api-token` | `s` | `''` | JWT bearer token |
| `crawl4ai-fit-markdown-mode` | `s` | `'pruning'` | Filter: `'pruning'` or `'bm25'` |
| `crawl4ai-bm25-threshold` | `d` | `0.5` | BM25 relevance threshold (0.3–0.8) |
| `crawl4ai-cache-mode` | `s` | `'bypass'` | Cache: `'bypass'`, `'enabled'`, `'read_only'` |
| `crawl4ai-word-count-threshold` | `i` | `10` | Min words per page (1–200) |
| `crawl4ai-page-timeout` | `i` | `60` | Page render timeout (10–300 seconds) |
| `crawl4ai-max-chars` | `i` | `24000` | Output truncation cap (500–100000) |
| `crawl4ai-simulate-user` | `b` | `false` | Stealth mode (mouse movements, delays) |
| `crawl4ai-autonomous-enabled` | `b` | `true` | Model can scrape autonomously |
| `crawl4ai-allow-local-addresses` | `b` | `false` | Allow private/loopback URLs |
| `crawl4ai-job-poll-ms` | `i` | `2000` | Async job polling interval (500–10000ms) |
| `crawl4ai-capture-network` | `b` | `false` | Capture XHR/Fetch background calls |
| `crawl4ai-extraction-mode` | `s` | `'markdown'` | Extraction mode: `'markdown'`, `'llm-schema'`, `'llm-block'` |
| `crawl4ai-llm-provider` | `s` | `'deepseek/deepseek-v4-flash'` | LiteLLM provider string for LLM extraction (defaults to DeepSeek V4 Flash). Must be allowed server-side: set `LLM_PROVIDER` (and the provider's API key) in the container's `.llm.env`, then restart |
| `crawl4ai-llm-instruction` | `s` | default summary instruction | Freeform instruction for `llm-block` mode (sensible default prefilled) |
| `crawl4ai-llm-schema-json` | `s` | default schema | JSON Schema object (string) for `llm-schema` mode (general-purpose default prefilled) |
| `crawl4ai-llm-chunk-token-threshold` | `i` | `4000` | Token threshold per chunk (500–16000) |
| `crawl4ai-llm-overlap-rate` | `d` | `0.1` | Chunk overlap rate (0.0–0.5) |

### Knowledge Base Settings (RAG)

| Key | Type | Default | Description |
|---|---|---|---|
| `rag-enabled` | `b` | `false` | Enable knowledge base |
| `rag-memory-enabled` | `b` | `true` | Master memory indexing switch |
| `rag-service-url` | `s` | `'http://localhost:11435'` | RAG service base URL |
| `rag-ollama-url` | `s` | `'http://localhost:11434'` | Ollama URL for embeddings |
| `rag-embedding-model` | `s` | `'nomic-embed-text'` | Embedding model name |
| `rag-chunk-size` | `i` | `800` | Characters per chunk (200–4000) |
| `rag-chunk-overlap` | `i` | `120` | Character overlap (0–500) |
| `rag-top-k` | `i` | `5` | Results per query (1–20) |
| `rag-max-chunks-per-collection` | `i` | `10000` | Max chunks per collection (0–100000) |
| `rag-max-total-size-mb` | `i` | `500` | Max storage in MB (0–10000) |
| `rag-auto-prune` | `b` | `true` | LRU eviction at size cap |
| `rag-index-documents` | `b` | `true` | Index document attachments |
| `rag-index-conversations` | `b` | `true` | Index past conversations |
| `rag-index-research-cache` | `b` | `true` | Index web search/scape results |
| `rag-autonomous-enabled` | `b` | `true` | Model can search KB autonomously |
| `rag-auto-update-enabled` | `b` | `false` | Model can update KB without confirmation |
| `rag-fallback-enabled` | `b` | `true` | Auto web search on low-quality KB results |
| `rag-fallback-threshold` | `d` | `0.6` | Min score before web fallback (0.0–1.0) |
| `rag-rerank-enabled` | `b` | `false` | Enable cross-encoder reranking |
| `rag-rerank-model` | `s` | `'bge-reranker-v2-m3'` | Reranker model name |
| `rag-rerank-candidate-multiplier` | `i` | `4` | Candidate pool multiplier (1–10) |
| `rag-hybrid-enabled` | `b` | `true` | BM25 + dense retrieval fusion |

### Token Usage & Pets Settings

| Key | Type | Default | Description |
|---|---|---|---|
| `token-usage-enabled` | `b` | `true` | Enable token tracking |
| `token-usage-default-range` | `s` | `'month'` | Default range: `day`, `week`, `month`, `year`, `all` |
| `token-usage-retention-days` | `i` | `0` | Retention: 0 = forever |
| `token-usage-celebrations-enabled` | `b` | `true` | In-chat milestone messages |
| `pet-selection-mode` | `s` | `'follow-provider'` | Pet mode: `follow-provider` or `pinned` |
| `pet-pinned-form` | `s` | `''` | Pinned pet form identifier |
| `token-budget-enabled` | `b` | `false` | Enable monthly budget tracking |
| `token-budget-monthly-usd` | `d` | `5.0` | Monthly budget in USD |
| `token-budget-warning-pct` | `i` | `70` | Warning threshold percentage |
| `token-desktop-notifications-enabled` | `b` | `true` | Desktop notifications for milestones |

---

## Tool Schema Reference

The following JSON schemas are sent to AI providers to enable autonomous tool calling.

### web_search

Searches the web via SearxNG metasearch.

```json
{
  "type": "function",
  "function": {
    "name": "web_search",
    "description": "Search the web using a private SearxNG metasearch engine. Returns result titles, URLs, and snippets. Use this to find current information, verify facts, or discover sources. After searching, use read_url to fetch full page content for the most promising results.",
    "parameters": {
      "type": "object",
      "properties": {
        "query": {
          "type": "string",
          "description": "The search query string. Be specific — use keywords and phrases likely to appear on result pages."
        },
        "categories": {
          "type": "array",
          "items": { "type": "string" },
          "description": "Optional SearxNG categories (e.g., [\"general\"], [\"science\"], [\"news\"])."
        },
        "time_range": {
          "type": "string",
          "enum": ["", "day", "week", "month", "year"],
          "description": "Optional time filter."
        },
        "limit": {
          "type": "integer",
          "minimum": 1,
          "maximum": 20,
          "description": "Max results (default 10, capped at 20)."
        }
      },
      "required": ["query"]
    }
  }
}
```

**Danger level**: `read_only`

### read_url

Fetches and extracts readable text from a web page.

```json
{
  "type": "function",
  "function": {
    "name": "read_url",
    "description": "Fetch and extract the main content from a web page as readable text. Use this after web_search to read promising results in full. Strips navigation, ads, and boilerplate, keeping only the core content.",
    "parameters": {
      "type": "object",
      "properties": {
        "url": {
          "type": "string",
          "description": "The absolute HTTP(S) URL of the page to fetch."
        }
      },
      "required": ["url"]
    }
  }
}
```

**Danger level**: `read_only`
**SSRF protected**: Yes — blocks private, loopback, and link-local addresses.

### crawl_url

Deep-scrapes a page using Crawl4AI's browser rendering.

```json
{
  "type": "function",
  "function": {
    "name": "crawl_url",
    "description": "Deep-scrape a single web page and return clean, readable Markdown. Use this after web_search to read a promising result in full depth. The page is rendered in a real browser (JavaScript, SPAs, lazy-loading), then stripped of navigation, ads, and boilerplate.",
    "parameters": {
      "type": "object",
      "properties": {
        "url": {
          "type": "string",
          "description": "The absolute HTTP(S) URL to deep-scrape."
        },
        "query": {
          "type": "string",
          "description": "Optional. When using BM25 fit mode, this query focuses extraction on the most relevant portions."
        }
      },
      "required": ["url"]
    }
  }
}
```

**Danger level**: `read_only`

### explore_docs

Crawls a documentation landing page and returns its table of contents (internal-link structure) plus the most query-relevant links, so the agent can then deep-scrape only the pages it selected.

```json
{
  "type": "function",
  "function": {
    "name": "explore_docs",
    "description": "Explore a documentation website and return its table of contents. Crawls the given landing page, extracts the sidebar/internal navigation links, and (when a query is provided) highlights the most relevant pages. Use this when you know the docs site URL and want to navigate it efficiently: explore the structure first, then use crawl_url on the specific pages you selected.",
    "parameters": {
      "type": "object",
      "properties": {
        "url": {
          "type": "string",
          "description": "The absolute http(s) URL of the documentation landing page to explore (e.g. https://docs.example.org/)."
        },
        "query": {
          "type": "string",
          "description": "Optional. The research topic you are looking for — used to highlight the most relevant links in the table of contents."
        }
      },
      "required": ["url"]
    }
  }
}
```

**Danger level**: `read_only`
**Agent-only**: No footer button or slash command — advertised to the model alongside `crawl_url` under the same web-scraping autonomy gate.

### knowledge_search

Queries the local RAG knowledge base.

```json
{
  "type": "function",
  "function": {
    "name": "knowledge_search",
    "description": "Search the local knowledge base for semantically relevant information. Use natural language — the search is semantic, not keyword-based.",
    "parameters": {
      "type": "object",
      "properties": {
        "query": {
          "type": "string",
          "description": "The search query in natural language."
        }
      },
      "required": ["query"]
    }
  }
}
```

**Danger level**: `read_only`

### document

Attaches and parses local files. This tool has no API schema (it operates before the request is sent, during message enrichment).

**Danger level**: `potentially_unsafe` (reads local filesystem)

### deep_research

Meta-mode toggle. This tool has no API schema — it is a mode flag, not a callable function.

**Danger level**: `read_only`
**Meta**: `true` — does not generate tool calls; it modifies pipeline behavior.

---

## External Service APIs

### Ollama

**Default URL**: `http://localhost:11434`
**Authentication**: None (local)

#### POST `/api/chat`
Chat completion with streaming.

**Request**:
```json
{
  "model": "llama3.2",
  "messages": [
    { "role": "system", "content": "You are a helpful assistant." },
    { "role": "user", "content": "Hello" }
  ],
  "stream": true,
  "keep_alive": "5m",
  "think": true,
  "options": {
    "temperature": 0.7,
    "top_k": 40,
    "top_p": 0.9,
    "num_ctx": 4096,
    "num_gpu": -1,
    "num_thread": 4
  },
  "format": "json",
  "raw": false
}
```

**Response** (SSE, one JSON object per line):
```json
{"model":"llama3.2","created_at":"...","message":{"role":"assistant","content":"Hello! How"},"done":false}
{"model":"llama3.2","created_at":"...","message":{"role":"assistant","content":" can I help?"},"done":false}
{"model":"llama3.2","created_at":"...","message":{"role":"assistant","content":""},"done":true,"total_duration":1234567890,"load_duration":123456789,"prompt_eval_count":10,"prompt_eval_duration":123456789,"eval_count":5,"eval_duration":123456789}
```

With thinking:
```json
{"model":"qwen3","message":{"role":"assistant","content":"Answer","reasoning":"Let me think about this..."},"done":false}
```

With tool calls:
```json
{"model":"llama3.2","message":{"role":"assistant","content":"","tool_calls":[{"function":{"name":"web_search","arguments":{"query":"gnome 47"}}}]},"done":false}
```

With images:
```json
{"model":"llama3.2-vision","messages":[{"role":"user","content":"Describe this image","images":["iVBORw0KGgo..."]}],"stream":true}
```

#### GET `/api/tags`
List installed models. Used for health checks and model dropdown.

**Response**:
```json
{"models":[{"name":"llama3.2:latest","modified_at":"...","size":1234567890}]}
```

#### GET `/api/show`
Get model details. Used to detect vision capability.

**Request**: `POST /api/show` with `{"name": "llama3.2-vision"}`

#### POST `/tokenize`
Token counting. Used for prompt character estimation.

**Request**: `{"model":"llama3.2","text":"Hello world"}`

**Response**: `{"tokens":[9906,1917]}`

---

### DeepSeek

**Default URL**: `https://api.deepseek.com`
**Authentication**: `Authorization: Bearer <api-key>`

#### POST `/chat/completions`
OpenAI-compatible chat completion.

**Request**:
```json
{
  "model": "deepseek-v4-pro",
  "messages": [
    { "role": "system", "content": "You are a helpful assistant." },
    { "role": "user", "content": "Hello" }
  ],
  "stream": true,
  "thinking": { "type": "enabled" },
  "reasoning_effort": "high",
  "response_format": { "type": "json_object" }
}
```

**Thinking disabled**: Omit `thinking` or set `thinking: { type: "disabled" }`.

**Response** (SSE, `data:` prefixed lines):
```
data: {"id":"...","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"Hello"}}]}
data: {"id":"...","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"!"}}]}
data: {"id":"...","object":"chat.completion.chunk","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}
```

#### GET `/user/balance`
Account balance check. Used by health monitor.

---

### Unsloth Studio

**Default URL**: `http://localhost:8888/v1`
**Authentication**: `Authorization: Bearer <api-key>` (optional)

#### POST `/chat/completions`
OpenAI-compatible chat completion with server-side tools.

**Request**:
```json
{
  "model": "default",
  "messages": [
    { "role": "user", "content": "Hello" }
  ],
  "stream": true,
  "enable_tools": true,
  "enabled_tools": ["web_search", "python", "terminal"],
  "session_id": "conv_1234567890",
  "tool_choice": { "type": "function", "function": { "name": "web_search" } }
}
```

**Response** (SSE, `data:` prefixed):
```
data: {"choices":[{"index":0,"delta":{"content":"Hello"}}]}
data: {"type":"tool_result","tool_name":"web_search","content":"..."}
```

#### POST `/tokenize`
Token counting for prompt estimation.

---

### OpenAI

**Default URL**: `https://api.openai.com/v1`
**Authentication**: `Authorization: Bearer <api-key>`

#### POST `/chat/completions`
Standard OpenAI chat completion API.

**Request**:
```json
{
  "model": "gpt-4o",
  "messages": [
    { "role": "user", "content": "Hello" }
  ],
  "stream": true,
  "tools": [...]
}
```

**Response**: Standard OpenAI SSE format with `data:` prefixed lines.

#### GET `/v1/models`
List available models. Used by health monitor.

---

### Anthropic

**Default URL**: `https://api.anthropic.com`
**Authentication**: `x-api-key: <api-key>`
**Headers**: `anthropic-version: 2023-06-01`

#### POST `/v1/messages`
**Request**:
```json
{
  "model": "claude-3-5-sonnet-20241022",
  "messages": [
    { "role": "user", "content": "Hello" }
  ],
  "system": "You are a helpful assistant.",
  "stream": true,
  "max_tokens": 4096,
  "tools": [...]
}
```

**Response** (SSE, `data:` prefixed):
```
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}
data: {"type":"content_block_stop","index":0}
data: {"type":"message_stop"}
```

Tool calls:
```
data: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","name":"web_search","id":"toolu_..."}}
data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"query\":\"gnome 47\"}"}}
data: {"type":"content_block_stop","index":0}
data: {"type":"message_stop"}
```

#### GET `/v1/models`
List models. Used by health monitor.

---

### SearxNG

**Default URL**: `http://localhost:8080`
**Authentication**: `Authorization: Bearer <token>` (optional)

#### GET `/search`
**Query parameters**: `q`, `format=json`, `categories`, `time_range`, `safesearch`, `language`, `engines`, `pageno`

**Response** (must enable JSON format in `settings.yml`):
```json
{
  "query": "gnome 47",
  "number_of_results": 1234,
  "results": [
    {
      "title": "GNOME 47 Release Notes",
      "url": "https://release.gnome.org/47/",
      "content": "GNOME 47 is the latest version...",
      "engine": "google",
      "score": 0.95,
      "category": "general"
    }
  ]
}
```

**Note**: SearxNG must have `formats: [json]` in `settings.yml` or it returns HTML.

---

### Crawl4AI

**Default URL**: `http://localhost:11235`
**Authentication**: `Authorization: Bearer <jwt-token>` (optional)

#### POST `/crawl`
Synchronous crawl.

**Request**:
```json
{
  "urls": "https://example.com/article",
  "browser_config": {
    "headless": true,
    "viewport_width": 1280,
    "viewport_height": 720,
    "user_agent_mode": "random",
    "simulate_user": false
  },
  "crawler_config": {
    "cache_mode": "bypass",
    "word_count_threshold": 10,
    "page_timeout": 60000,
    "markdown_generator": {
      "type": "DefaultMarkdownGenerator",
      "content_filter": {
        "type": "PruningContentFilter",
        "threshold": 0.5
      }
    },
    "extraction_strategy": {
      "type": "LLMExtractionStrategy",
      "params": {
        "provider": "openai/gpt-4o-mini",
        "schema": { "type": "object", "properties": { "title": { "type": "string" } } },
        "chunk_token_threshold": 4000,
        "overlap_rate": 0.1
      }
    }
  }
}
```

The `extraction_strategy` block is **optional** and only sent when `crawl4ai-extraction-mode` is `llm-schema` or `llm-block`. The REST API uses `extraction_strategy` (not the Python-side `extraction_config` name), wrapped in a `{ type, params }` envelope. The LLM API key is configured server-side on the Docker container — it is never sent through this request. The requested provider must be allowed on the server: set `LLM_PROVIDER=<provider value>` and the provider's API key (e.g. `DEEPSEEK_API_KEY`) in `.llm.env`, then restart the container. Note that on secure-by-default v0.9.x builds this `/crawl` path is blocked for `LLMExtractionStrategy`; Katab routes LLM modes through the sanctioned `/llm/job` endpoint instead, which constructs the strategy server-side.

**Response**:
```json
{
  "success": true,
  "result": {
    "url": "https://example.com/article",
    "title": "Article Title",
    "markdown": "Full page markdown...",
    "fit_markdown": "Pruned markdown...",
    "cleaned_html": "...",
    "json": { "title": "Extracted structured data..." },
    "llm": "Freeform LLM answer text..."
  }
}
```

When LLM extraction is active, the `json` field carries the schema-mode structured output and `llm` carries the block-mode freeform answer. Katab's `parseCrawlResults` maps these onto `structuredJson` / `llmResponse` and `buildCrawlResultBlock` renders them with a `[Structured JSON extracted by LLM...]` / `[LLM extraction...]` header.

#### POST `/crawl/job` + GET `/crawl/job/{id}`
Async crawl with polling. Used when synchronous crawl is slow.

#### POST `/llm/job` + GET `/llm/job/{id}` (LLM extraction — sanctioned path)
Async LLM extraction with polling. This is the **only** supported way to run LLM extraction on Crawl4AI v0.9.x secure-by-default builds — client-supplied `LLMExtractionStrategy` on `/crawl` is rejected as an untrusted request. The strategy is constructed **server-side** from the provider name; credentials come from the container environment, never from the request.

**Request** (JSON body):
```json
{
  "url": "https://example.com/article",
  "q": "Extract the key facts, claims, and arguments from this page and summarize them concisely.",
  "provider": "deepseek/deepseek-v4-flash",
  "cache": true,
  "schema": { "type": "object", "properties": { "title": { "type": "string" } } }
}
```
- `schema` is optional — only sent when `crawl4ai-extraction-mode` is `llm-schema`. Omit it for `llm-block` (freeform answer).
- `q` is the freeform instruction (`llm-block`) or a shaping prompt (`llm-schema`).
- `provider` must be allowed on the server: set `LLM_PROVIDER=<value>` and the provider's API key (e.g. `DEEPSEEK_API_KEY`) in `.llm.env`, then restart the container.

**Response**: `{ "task_id": "..." }` → poll `GET /llm/job/{task_id}` until `{ "status": "completed", "result": ... }` where `result` is the parsed JSON object (schema mode) or a string (block mode). A `status: "failed"` response carries `error`.

#### GET `/health`
Health check.

---

### RAG Service

**Default URL**: `http://localhost:11435`

Python FastAPI + ChromaDB service for local semantic search. Endpoints are expected but may vary by implementation.

#### GET `/health`
Health check.

#### POST `/search`
Semantic search.

**Request**:
```json
{
  "query": "key findings from last week",
  "top_k": 5,
  "collection": "documents"
}
```

**Response**:
```json
{
  "results": [
    {
      "content": "Relevant text chunk...",
      "metadata": { "source": "file.pdf", "page": 3 },
      "score": 0.92
    }
  ]
}
```

#### POST `/index`
Index new content.

**Request**:
```json
{
  "content": "Text to index...",
  "metadata": { "source": "conversation", "id": "conv_123" },
  "collection": "conversations"
}
```

#### POST `/prune`
Remove old entries.
