// ── Local RAG / Knowledge Base Tools ──────────────────────────────────────────
// RAG runtime for communicating with the Katabai Python RAG service
// (FastAPI + ChromaDB + Ollama /api/embed) over HTTP.
//
// Pattern mirrors webSearchTools.js and crawl4aiTools.js:
//   - Runtime class with Soup.Session for async HTTP communication
//   - Config reader from GSettings with safe-getter pattern
//   - Command parser for /kb prefix
//   - Tool schema builder for autonomous function-calling
//   - Result block builder for formatted context injection
//
// Service lives at ~/.local/share/katabai/rag-service/server.py
// Default port: 11435 (avoids collision with Ollama's 11434)

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup';

import { getCachedSearchResults, cacheSearchResults } from './researchCache.js';

// ── Constants ─────────────────────────────────────────────────────────────────

export const RAG_TOOL_NAME = 'knowledge_search';
export const RAG_TOOL_COMMAND = '/kb';
export const RAG_TOOL_ICON = 'folder-documents-symbolic';

/**
 * Create a Gio.Icon for the knowledge base from the custom brain SVG.
 * Use this instead of icon_name when you need the custom brain graphic.
 * @param {string} extensionPath - path to the extension directory
 * @returns {Gio.Icon}
 */
export function createRagGicon(extensionPath) {
    return Gio.icon_new_for_string(`${extensionPath}/icons/katab-knowledge-symbolic.svg`);
}

const RAG_DEFAULT_TIMEOUT_SECONDS = 30;
const RAG_DEFAULT_CHUNK_SIZE = 800;
const RAG_DEFAULT_CHUNK_OVERLAP = 120;
const RAG_DEFAULT_TOP_K = 5;
const RAG_DEFAULT_EMBEDDING_MODEL = 'nomic-embed-text';
const RAG_DEFAULT_SERVICE_URL = 'http://localhost:11435';
const RAG_DEFAULT_RERANK_MODEL = 'bge-reranker-v2-m3';
const RAG_DEFAULT_RERANK_CANDIDATE_MULTIPLIER = 4;
const RAG_DEFAULT_FALLBACK_THRESHOLD = 0.6;

// ── Error type ─────────────────────────────────────────────────────────────────

/**
 * Structured error for RAG operations.
 * @param {string} message - Human-readable error description.
 * @param {{ code?: string, detail?: string }} [opts]
 */
export function RagError(message, { code = 'rag-error', detail = '' } = {}) {
    this.message = String(message || '');
    this.code = String(code || '');
    this.detail = String(detail || '');
    this.name = 'RagError';
}
RagError.prototype = Object.create(Error.prototype);
RagError.prototype.constructor = RagError;

// ── Config reader ─────────────────────────────────────────────────────────────

/**
 * Read RAG settings from GSettings with safe fallbacks.
 * @param {Gio.Settings} settings
 * @returns {{ enabled: boolean, serviceUrl: string, embeddingModel: string, chunkSize: number, chunkOverlap: number, topK: number, indexDocuments: boolean, indexConversations: boolean, indexResearchCache: boolean, autonomousEnabled: boolean, fallbackEnabled: boolean, fallbackThreshold: number, rerankEnabled: boolean, rerankModel: string, rerankCandidateMultiplier: number, hybridEnabled: boolean }}
 */
export function readRagConfig(settings) {
    const getBool = (key, fallback = false) => {
        try { return settings.get_boolean(key); } catch (_) { return fallback; }
    };
    const getString = (key, fallback = '') => {
        try { return settings.get_string(key); } catch (_) { return fallback; }
    };
    const getInt = (key, fallback = 0) => {
        try { return settings.get_int(key); } catch (_) { return fallback; }
    };
    const getDouble = (key, fallback = 0.0) => {
        try { return settings.get_double(key); } catch (_) { return fallback; }
    };

    // Fallback: if rag-ollama-url is unset or still at its GSettings default,
    // use the main ollama-url so users don't need to configure two URLs.
    const ragOllamaUrl = getString('rag-ollama-url', 'http://localhost:11434');
    const mainOllamaUrl = getString('ollama-url', 'http://localhost:11434');
    const effectiveOllamaUrl = (ragOllamaUrl && ragOllamaUrl !== 'http://localhost:11434')
        ? ragOllamaUrl
        : (mainOllamaUrl || 'http://localhost:11434');

    return {
        enabled: getBool('rag-enabled', false),
        memoryEnabled: getBool('rag-memory-enabled', true),
        serviceUrl: getString('rag-service-url', RAG_DEFAULT_SERVICE_URL),
        ollamaUrl: effectiveOllamaUrl,
        embeddingModel: getString('rag-embedding-model', RAG_DEFAULT_EMBEDDING_MODEL),
        chunkSize: getInt('rag-chunk-size', RAG_DEFAULT_CHUNK_SIZE),
        chunkOverlap: getInt('rag-chunk-overlap', RAG_DEFAULT_CHUNK_OVERLAP),
        topK: getInt('rag-top-k', RAG_DEFAULT_TOP_K),
        maxChunksPerCollection: getInt('rag-max-chunks-per-collection', 10000),
        maxTotalSizeMb: getInt('rag-max-total-size-mb', 500),
        autoPrune: getBool('rag-auto-prune', true),
        indexDocuments: getBool('rag-index-documents', true),
        indexConversations: getBool('rag-index-conversations', false),
        indexResearchCache: getBool('rag-index-research-cache', true),
        autonomousEnabled: getBool('rag-autonomous-enabled', true),
        autoUpdateEnabled: getBool('rag-auto-update-enabled', false),
        // Phase 3: advanced retrieval
        fallbackEnabled: getBool('rag-fallback-enabled', true),
        fallbackThreshold: getDouble('rag-fallback-threshold', RAG_DEFAULT_FALLBACK_THRESHOLD),
        rerankEnabled: getBool('rag-rerank-enabled', false),
        rerankModel: getString('rag-rerank-model', RAG_DEFAULT_RERANK_MODEL),
        rerankCandidateMultiplier: getInt('rag-rerank-candidate-multiplier', RAG_DEFAULT_RERANK_CANDIDATE_MULTIPLIER),
        hybridEnabled: getBool('rag-hybrid-enabled', false),
    };
}

// ── Command parser ────────────────────────────────────────────────────────────

/**
 * Parse a user prompt to detect whether it starts with the /kb command.
 * @param {string} promptText
 * @returns {{ isCommand: boolean, query: string }}
 */
export function parseRagCommand(promptText) {
    const text = String(promptText || '').trim();
    const prefix = /^\/kb\s+/i;
    if (prefix.test(text)) {
        return {
            isCommand: true,
            query: text.replace(prefix, '').trim(),
        };
    }
    return { isCommand: false, query: '' };
}

// ── Coverage scoring ──────────────────────────────────────────────────────────

/**
 * Compute a coverage/quality score from RAG search results.
 * Uses the average score of the top 3 results (or max of top 1 if fewer).
 * Returns 0.0 for empty result sets.
 *
 * @param {Array<{ score: number }>} results
 * @returns {number} 0.0–1.0
 */
export function computeRagCoverageScore(results) {
    if (!results || results.length === 0) return 0.0;
    const topN = results.slice(0, 3);
    const sum = topN.reduce((acc, r) => acc + (r.score || 0), 0);
    return Math.min(1.0, sum / topN.length);
}

// ── Tool schema builder ───────────────────────────────────────────────────────

/**
 * Build an OpenAI- or Anthropic-style JSON Schema for the knowledge_search tool.
 * @param {{ provider: string }} opts
 * @returns {object}
 */
export function buildRagToolSchema({ provider } = {}) {
    const params = {
        type: 'object',
        properties: {
            query: {
                type: 'string',
                description: 'The search query to find semantically relevant information in the local knowledge base (past documents, conversations, and research).',
            },
        },
        required: ['query'],
    };

    if (provider === 'anthropic') {
        return {
            name: RAG_TOOL_NAME,
            description: 'Search the local knowledge base for semantically relevant information from past documents, conversations, and research cache.',
            input_schema: params,
        };
    }
    // OpenAI-style (used by openai, ollama, deepseek, unsloth)
    return {
        type: 'function',
        function: {
            name: RAG_TOOL_NAME,
            description: 'Search the local knowledge base for semantically relevant information from past documents, conversations, and research cache.',
            parameters: params,
        },
    };
}

// ── Result block builder ──────────────────────────────────────────────────────

function getLocalDateStamp() {
    try {
        const dt = GLib.DateTime.new_now_local();
        return dt.format('%Y-%m-%d');
    } catch (_) {
        return new Date().toISOString().slice(0, 10);
    }
}

/**
 * Collapse multi-line/indented text into a single continuous line
 * with spaces. Used to fit content into the markdown context without
 * breaking formatting.
 * @param {string} s
 * @returns {string}
 */
function fitMarkdown(s) {
    return String(s || '').replace(/\s+/g, ' ').trim();
}

/**
 * Truncate text to a maximum character count, preserving word boundaries.
 * @param {string} text
 * @param {number} maxChars
 * @returns {string}
 */
function truncateText(text, maxChars = 200) {
    if (!text) return '';
    if (text.length <= maxChars) return text;
    const cut = text.lastIndexOf(' ', maxChars);
    return (cut > maxChars / 2 ? text.slice(0, cut) : text.slice(0, maxChars)) + '…';
}

/**
 * Convert a RAG search response into a formatted context block for the LLM.
 * @param {string} query - The original search query.
 * @param {{ results: Array<{ id: string, content: string, metadata: object, score: number }> }} payload
 * @param {{ includeGuard?: boolean, mode?: string }} [opts]
 * @returns {string}
 */
export function buildRagResultBlock(query, payload, { includeGuard = true, mode = '' } = {}) {
    const results = Array.isArray(payload?.results) ? payload.results : [];
    const searchDate = getLocalDateStamp();

    // Build retrieval mode tag
    const modeTag = mode ? ` [${mode}]` : '';

    if (results.length === 0) {
        return `Knowledge base search${modeTag} on ${searchDate} for "${query}" returned no results.`;
    }

    const lines = [
        `Knowledge base results${modeTag} for "${query}" (searched ${searchDate}):`,
    ];
    if (includeGuard) {
        lines.push('');
        lines.push('IMPORTANT: The information below is from YOUR personal knowledge base — past');
        lines.push('conversations, research, and documents YOU have worked with. Use this');
        lines.push('information to answer the user. Do NOT call web_search or crawl_url for');
        lines.push('this query — the relevant information is already here.');
    }
    lines.push('');

    results.forEach((result, index) => {
        const meta = result.metadata || {};
        const sourceLabel = meta.source || meta.source_id || 'document';
        const timestamp = meta.timestamp || '';
        const title = meta.title || '';
        const url = meta.url || '';

        let header = `${index + 1}. [Score: ${(result.score * 100).toFixed(0)}%]`;
        if (title) header += ` "${title}"`;
        if (sourceLabel) header += ` (source: ${sourceLabel})`;
        if (timestamp) header += ` [${timestamp}]`;

        lines.push(header);
        if (url) lines.push(`   URL: ${url}`);
        lines.push(`   Content: ${fitMarkdown(truncateText(result.content, 500))}`);
        lines.push('');
    });

    return lines.join('\n');
}

// ── RAG Runtime ───────────────────────────────────────────────────────────────

/**
 * Async runtime for communicating with the Katabai Python RAG service.
 *
 * @example
 *   const runtime = new RagRuntime({ timeoutSeconds: 30 });
 *   const health = await runtime.health(config);
 *   const results = await runtime.search('what is the meaning of life?', config);
 */
export class RagRuntime {
    /**
     * @param {{ session?: Soup.Session, timeoutSeconds?: number }} [opts]
     */
    constructor({ session = null, timeoutSeconds = RAG_DEFAULT_TIMEOUT_SECONDS } = {}) {
        this._session = session || new Soup.Session();
        this._session.timeout = Math.max(timeoutSeconds || RAG_DEFAULT_TIMEOUT_SECONDS, 5);
        this._session.user_agent = 'Katab/1.0 (GNOME Shell extension; +https://cetikaytools.com)';
    }

    /**
     * Internal helper: send a request and parse the JSON response.
     * @param {string} method - HTTP method
     * @param {string} url - Full URL
     * @param {object|null} bodyJson - Optional JSON body
     * @param {Gio.Cancellable|null} cancellable
     * @returns {Promise<{ status: number, body: object|string }>}
     */
    async _request(method, url, bodyJson = null, cancellable = null) {
        const message = Soup.Message.new(method, url);
        message.request_headers.append('Accept', 'application/json');

        if (bodyJson !== null) {
            const jsonStr = JSON.stringify(bodyJson);
            message.set_request_body_from_bytes(
                'application/json',
                GLib.Bytes.new(jsonStr)
            );
        }

        try {
            const responseBytes = await new Promise((resolve, reject) => {
                this._session.send_and_read_async(
                    message,
                    GLib.PRIORITY_DEFAULT,
                    cancellable || null,
                    (session, result) => {
                        try {
                            const bytes = session.send_and_read_finish(result);
                            resolve(bytes);
                        } catch (e) {
                            reject(e);
                        }
                    }
                );
            });

            const status = message.get_status();
            const decoder = new TextDecoder('utf-8');
            const text = decoder.decode(responseBytes.get_data() || new Uint8Array());

            let body;
            try {
                body = JSON.parse(text);
            } catch (_) {
                body = text;
            }

            if (status !== Soup.Status.OK && status !== Soup.Status.CREATED) {
                const detail = typeof body === 'object' ? (body.detail || body.message || text.slice(0, 500)) : text.slice(0, 500);
                throw new RagError(`RAG service returned HTTP ${status}`, { code: 'http-error', detail });
            }

            return { status, body };
        } catch (e) {
            if (e instanceof RagError) throw e;
            const msg = String(e?.message || e || '');
            if (msg.includes('cancelled') || msg.includes('cancellable')) {
                throw new RagError('RAG request cancelled', { code: 'cancelled', detail: msg });
            }
            throw new RagError(`RAG service connection failed: ${msg}`, { code: 'connection-failed', detail: msg });
        }
    }

    /**
     * Check RAG service health.
     * @param {{ serviceUrl: string }} config
     * @param {Gio.Cancellable|null} [cancellable]
     * @returns {Promise<{ ok: boolean, version?: string, collections?: object, code?: string, message?: string }>}
     */
    async health(config, cancellable = null) {
        const url = `${config.serviceUrl.replace(/\/+$/, '')}/health`;
        try {
            const { body } = await this._request('GET', url, null, cancellable);
            return {
                ok: Boolean(body?.ok),
                version: body?.version || '',
                collections: body?.collections || {},
            };
        } catch (e) {
            return {
                ok: false,
                code: e.code || 'health-failed',
                message: e.message || 'Unknown error',
            };
        }
    }

    /**
     * Index texts into a named ChromaDB collection.
     * @param {Array<{ id: string, content: string, metadata?: object }>} texts
     * @param {string} collection - Collection name (documents, conversations, research_cache)
     * @param {{ serviceUrl: string, chunkSize?: number, chunkOverlap?: number, embeddingModel?: string }} config
     * @param {Gio.Cancellable|null} [cancellable]
     * @returns {Promise<{ indexed: number, chunks: number }>}
     */
    async index(texts, collection, config, cancellable = null) {
        if (!texts || texts.length === 0) {
            return { indexed: 0, chunks: 0 };
        }

        const url = `${config.serviceUrl.replace(/\/+$/, '')}/index`;
        const payload = {
            texts: texts.map(t => ({
                id: String(t.id || ''),
                content: String(t.content || ''),
                metadata: t.metadata || {},
            })),
            collection: String(collection || 'documents'),
            chunk_size: config.chunkSize || RAG_DEFAULT_CHUNK_SIZE,
            chunk_overlap: config.chunkOverlap || RAG_DEFAULT_CHUNK_OVERLAP,
            embedding_model: config.embeddingModel || RAG_DEFAULT_EMBEDDING_MODEL,
            ollama_url: config.ollamaUrl || 'http://localhost:11434',
            max_chunks_per_collection: config.maxChunksPerCollection ?? 10000,
            max_total_size_mb: config.maxTotalSizeMb ?? 500,
            auto_prune: config.autoPrune ?? true,
            // Replace old chunks when re-indexing the same document IDs
            replace_ids: texts.map(t => String(t.id || '')),
        };

        const { body } = await this._request('POST', url, payload, cancellable);
        return {
            indexed: body?.indexed || 0,
            chunks: body?.chunks || 0,
            rejected: body?.rejected || 0,
            reason: body?.reason || '',
        };
    }

    /**
     * Search the knowledge base semantically.
     * @param {string} query - The search query.
     * @param {{ serviceUrl: string, topK?: number, embeddingModel?: string, rerankEnabled?: boolean, rerankModel?: string, rerankCandidateMultiplier?: number, hybridEnabled?: boolean }} config
     * @param {Gio.Cancellable|null} [cancellable]
     * @returns {Promise<{ results: Array<{ id: string, content: string, metadata: object, score: number }>, mode?: string }>}
     */
    async search(query, config, cancellable = null) {
        if (!query || !String(query).trim()) {
            return { results: [] };
        }

        const url = `${config.serviceUrl.replace(/\/+$/, '')}/search`;
        const topK = config.topK || RAG_DEFAULT_TOP_K;
        const rerankK = topK * (config.rerankCandidateMultiplier || RAG_DEFAULT_RERANK_CANDIDATE_MULTIPLIER);

        const payload = {
            query: String(query).trim(),
            collection: undefined, // search all collections
            k: topK,
            embedding_model: config.embeddingModel || RAG_DEFAULT_EMBEDDING_MODEL,
            ollama_url: config.ollamaUrl || 'http://localhost:11434',
            // Phase 3: advanced retrieval
            rerank: Boolean(config.rerankEnabled),
            rerank_model: config.rerankModel || RAG_DEFAULT_RERANK_MODEL,
            rerank_k: Math.max(topK, Math.min(rerankK, 50)),
            hybrid: Boolean(config.hybridEnabled),
        };

        // Build retrieval mode tag for result block
        let mode = 'dense';
        if (config.hybridEnabled && config.rerankEnabled) {
            mode = 'dense+bm25+reranked';
        } else if (config.hybridEnabled) {
            mode = 'dense+bm25';
        } else if (config.rerankEnabled) {
            mode = 'dense+reranked';
        }

        const { body } = await this._request('POST', url, payload, cancellable);
        return {
            results: Array.isArray(body?.results) ? body.results : [],
            mode,
        };
    }

    /**
     * Delete a named ChromaDB collection.
     * @param {string} name - Collection name to delete.
     * @param {{ serviceUrl: string }} config
     * @param {Gio.Cancellable|null} [cancellable]
     * @returns {Promise<{ ok: boolean }>}
     */
    async deleteCollection(name, config, cancellable = null) {
        const url = `${config.serviceUrl.replace(/\/+$/, '')}/collection/${encodeURIComponent(name)}`;
        await this._request('DELETE', url, null, cancellable);
        return { ok: true };
    }

    /**
     * Drop ALL ChromaDB collections, wiping the entire knowledge base.
     * @param {{ serviceUrl: string }} config
     * @param {Gio.Cancellable|null} [cancellable]
     * @returns {Promise<{ ok: boolean, dropped: string[] }>}
     */
    async clearAll(config, cancellable = null) {
        const url = `${config.serviceUrl.replace(/\/+$/, '')}/clear`;
        const { body } = await this._request('POST', url, {}, cancellable);
        return { ok: body?.ok || false, dropped: body?.dropped || [] };
    }

    /**
     * Export all indexed data as structured JSON.
     * @param {{ serviceUrl: string }} config
     * @param {Gio.Cancellable|null} [cancellable]
     * @returns {Promise<{ collections: object }>}
     */
    async exportData(config, cancellable = null) {
        const url = `${config.serviceUrl.replace(/\/+$/, '')}/export`;
        const { body } = await this._request('GET', url, null, cancellable);
        return { collections: body?.collections || {} };
    }
}
