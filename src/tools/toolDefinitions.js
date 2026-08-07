// toolDefinitions.js — Concrete tool definitions for Katab
//
// Each tool gets a full ToolDefinition with JSON Schema, danger level,
// and a placeholder handler that's swapped out at init time.
// Imported by extension.js which calls _initToolRegistry() to wire
// runtime dependencies.

import {
    registerTool,
    createNotReadyHandler,
    DANGER_READ_ONLY,
    DANGER_POTENTIALLY_UNSAFE,
} from './toolRegistry.js';

// ── Local RAG (re-export for consumption) ─────────────────────────────────────
import {
    RAG_TOOL_NAME,
    RAG_TOOL_COMMAND,
    RAG_TOOL_ICON,
} from './ragTools.js';

// ── Explore Docs (agent-directed documentation navigation) ───────────────────
import { EXPLORE_DOCS_TOOL_NAME } from './exploreDocsTools.js';

// ── Web Search (SearxNG) ──────────────────────────────────────────────────────

const WEB_SEARCH_PARAMS = {
    type: 'object',
    properties: {
        query: {
            type: 'string',
            description: 'The search query string. Be specific — use keywords and phrases likely to appear on result pages. For technical queries, include version numbers or years.',
        },
        categories: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional SearxNG categories to filter by (e.g. ["general"], ["science"], ["news"]). Omit for default.',
        },
        time_range: {
            type: 'string',
            enum: ['', 'day', 'week', 'month', 'year'],
            description: 'Optional time filter. Leave empty for any time.',
        },
        limit: {
            type: 'integer',
            minimum: 1,
            maximum: 20,
            description: 'Max results to return (default 10, capped at 20).',
        },
    },
    required: ['query'],
};

registerTool({
    name: 'web_search',
    description:
        'Search the web using a private SearxNG metasearch engine. ' +
        'Returns result titles, URLs, and snippets. ' +
        'Use this to find current information, verify facts, or discover sources. ' +
        'After searching, use read_url to fetch full page content for the most promising results.',
    parameters: WEB_SEARCH_PARAMS,
    dangerLevel: DANGER_READ_ONLY,
    handler: createNotReadyHandler('web_search'),
    uiLabel: 'Search',
    uiIcon: 'system-search-symbolic',
    command: '/search',
    resultTruncationKey: 'search',
    isMeta: false,
    providerScoped: false,
});

// ── Read URL (SearxNG page fetch) ─────────────────────────────────────────────

const READ_URL_PARAMS = {
    type: 'object',
    properties: {
        url: {
            type: 'string',
            description: 'The absolute HTTP(S) URL of the page to fetch and extract readable text from.',
        },
    },
    required: ['url'],
};

registerTool({
    name: 'read_url',
    description:
        'Fetch and extract the main content from a web page as readable text. ' +
        'Use this after web_search to read promising results in full. ' +
        'Strips navigation, ads, and boilerplate, keeping only the core content.',
    parameters: READ_URL_PARAMS,
    dangerLevel: DANGER_READ_ONLY,
    handler: createNotReadyHandler('read_url'),
    uiLabel: 'Read',
    uiIcon: 'insert-link-symbolic',
    command: null,
    resultTruncationKey: 'readUrl',
    isMeta: false,
    providerScoped: false,
});

// ── Crawl URL (Crawl4AI deep scraping) ────────────────────────────────────────

const CRAWL_URL_PARAMS = {
    type: 'object',
    properties: {
        url: {
            type: 'string',
            description: 'The absolute HTTP(S) URL of the web page to deep-scrape with a real browser.',
        },
        query: {
            type: 'string',
            description: 'Optional. When using BM25 fit mode, this query focuses extraction on the most relevant portions of the page.',
        },
    },
    required: ['url'],
};

registerTool({
    name: 'crawl_url',
    description:
        'Deep-scrape a single web page and return clean, readable Markdown. ' +
        'Use this after web_search to read a promising result in full depth. ' +
        'The page is rendered in a real browser (JavaScript, SPAs, lazy-loading), ' +
        'then stripped of navigation, ads, and boilerplate leaving only the core content. ' +
        'When LLM extraction is enabled, the result may instead contain structured ' +
        'JSON or an LLM-guided answer extracted from the page.',
    parameters: CRAWL_URL_PARAMS,
    dangerLevel: DANGER_READ_ONLY,
    handler: createNotReadyHandler('crawl_url'),
    uiLabel: 'Scrape',
    uiIcon: 'document-open-symbolic',
    command: '/crawl',
    resultTruncationKey: 'crawl',
    isMeta: false,
    providerScoped: false,
});

// ── Document (local file attachment) ──────────────────────────────────────────

registerTool({
    name: 'document',
    description:
        'Attach and parse a local file (txt, md, pdf, docx, png, jpg). ' +
        'The file content is included in the conversation context so the AI can read, analyze, or summarize it.',
    parameters: null, // No API schema — this is a pre-send tool
    dangerLevel: DANGER_POTENTIALLY_UNSAFE,
    handler: createNotReadyHandler('document'),
    uiLabel: 'Docs',
    uiIcon: 'folder-open-symbolic',
    command: '/doc',
    resultTruncationKey: null,
    isMeta: false,
    providerScoped: false,
});

// ── Deep Research (meta-mode) ─────────────────────────────────────────────────

registerTool({
    name: 'deep_research',
    description:
        'Meta-mode that raises tool-call iteration limits and context thresholds ' +
        'for exhaustive multi-source research. Activate when the user needs comprehensive, ' +
        'deeply researched answers across many sources.',
    parameters: null, // No API schema — this is a mode toggle
    dangerLevel: DANGER_READ_ONLY,
    handler: createNotReadyHandler('deep_research'),
    uiLabel: 'Research',
    uiIcon: 'content-loading-symbolic',
    command: '/research',
    resultTruncationKey: null,
    isMeta: true,
    providerScoped: false,
});

// ── Knowledge Base Search (Local RAG) ─────────────────────────────────────────

const KNOWLEDGE_SEARCH_PARAMS = {
    type: 'object',
    properties: {
        query: {
            type: 'string',
            description: 'The search query to find semantically relevant information in the local knowledge base. Use natural language — the search is semantic, not keyword-based.',
        },
    },
    required: ['query'],
};

registerTool({
    name: RAG_TOOL_NAME,
    description:
        'Search your personal knowledge base for semantically relevant information. ' +
        'The knowledge base contains past document attachments, research results, and optionally conversation history. ' +
        'Use this before web_search when the answer might already exist in local files or past research.',
    parameters: KNOWLEDGE_SEARCH_PARAMS,
    dangerLevel: DANGER_READ_ONLY,
    handler: createNotReadyHandler(RAG_TOOL_NAME),
    uiLabel: 'Knowledge',
    uiIcon: RAG_TOOL_ICON,
    command: RAG_TOOL_COMMAND,
    resultTruncationKey: 'knowledge',
    isMeta: false,
    providerScoped: false,
});

// ── Knowledge Base Update (Phase 2: self-maintaining memory) ─────────────────

export const UPDATE_KNOWLEDGE_TOOL_NAME = 'update_knowledge';

const UPDATE_KNOWLEDGE_PARAMS = {
    type: 'object',
    properties: {
        about: {
            type: 'string',
            description: 'A short label describing what topic or fact is being updated (e.g., "user GPU setup", "preferred language").',
        },
        new_fact: {
            type: 'string',
            description: 'The corrected or updated information to store. Be specific and complete — this replaces the old understanding.',
        },
    },
    required: ['about', 'new_fact'],
};

registerTool({
    name: UPDATE_KNOWLEDGE_TOOL_NAME,
    description:
        'Update your knowledge base when you discover that previously stored information is outdated, ' +
        'incorrect, or incomplete. Call this when the user tells you something that contradicts ' +
        'what is in your memory, when they explicitly ask you to remember or update something, ' +
        'or when you find conflicting information between the knowledge base and the current conversation. ' +
        'Only call this after you have confirmed with the user via knowledge_search that old information exists.',
    parameters: UPDATE_KNOWLEDGE_PARAMS,
    dangerLevel: DANGER_POTENTIALLY_UNSAFE,
    handler: createNotReadyHandler(UPDATE_KNOWLEDGE_TOOL_NAME),
    uiLabel: null,
    uiIcon: null,
    command: null,
    resultTruncationKey: null,
    isMeta: false,
    providerScoped: false,
});

// ── Explore Docs (agent-directed documentation navigation) ───────────────────
// Agent-only tool (no footer button / slash command): the agent crawls a docs
// landing page, reads the extracted table of contents, then uses crawl_url on
// the specific pages it selected.  Advertised alongside crawl_url.

const EXPLORE_DOCS_PARAMS = {
    type: 'object',
    properties: {
        url: {
            type: 'string',
            description: 'The absolute http(s) URL of the documentation landing page to explore (e.g. https://docs.example.org/).',
        },
        query: {
            type: 'string',
            description: 'Optional. The research topic you are looking for. Used to highlight the most relevant links in the table of contents.',
        },
    },
    required: ['url'],
};

registerTool({
    name: EXPLORE_DOCS_TOOL_NAME,
    description:
        'Explore a documentation website and return its table of contents. ' +
        'Crawls the given landing page, extracts the sidebar/internal navigation links, ' +
        'and (when a query is provided) highlights the most relevant pages. ' +
        'Use this when you know the docs site URL (e.g. https://docs.project.org/) and want to ' +
        'navigate it efficiently: explore the structure first, then use crawl_url on the specific ' +
        'pages you selected. Prefer this over blindly crawling random URLs when working with documentation.',
    parameters: EXPLORE_DOCS_PARAMS,
    dangerLevel: DANGER_READ_ONLY,
    handler: createNotReadyHandler(EXPLORE_DOCS_TOOL_NAME),
    uiLabel: null,
    uiIcon: null,
    command: null,
    resultTruncationKey: 'crawl',
    isMeta: false,
    providerScoped: false,
});

// ── Tool name constants (backward-compatible exports) ─────────────────────────

export const WEB_SEARCH_TOOL_NAME = 'web_search';
export const READ_URL_TOOL_NAME = 'read_url';
export const CRAWL4AI_TOOL_NAME = 'crawl_url';
export const DEEP_RESEARCH_TOOL_NAME = 'deep_research';
export const KNOWLEDGE_SEARCH_TOOL_NAME = RAG_TOOL_NAME;
// Re-export the explore_docs name (imported from exploreDocsTools.js above).
export { EXPLORE_DOCS_TOOL_NAME };

// ── Command constants ─────────────────────────────────────────────────────────

export const WEB_SEARCH_TOOL_COMMAND = '/search';
export const CRAWL4AI_TOOL_COMMAND = '/crawl';
export const DEEP_RESEARCH_TOOL_COMMAND = '/research';
export const KNOWLEDGE_SEARCH_TOOL_COMMAND = RAG_TOOL_COMMAND;

// ── Icon constants ────────────────────────────────────────────────────────────

export const WEB_SEARCH_TOOL_ICON = 'system-search-symbolic';
export const CRAWL4AI_TOOL_ICON = 'document-open-symbolic';
export const DEEP_RESEARCH_TOOL_ICON = 'content-loading-symbolic';
export const KNOWLEDGE_SEARCH_TOOL_ICON = RAG_TOOL_ICON;
