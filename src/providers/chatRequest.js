// chatRequest.js — Pure pieces of the streaming (chat) request dialects.
//
// Extracted from _streamResponse: the Ollama sampling/context option
// construction, and the per-provider endpoint/headers/payload assemblies for
// openai-compatible (openai/unsloth), anthropic, and deepseek. The libsoup
// send, redirect handling, cancellables, the Ollama 404-pull prompt, and all
// UI stay in extension.js; these builders never touch the network.
//
// Behaviour note: two inherited quirks were fixed in the review pass after
// extraction (kept together across streaming + non-streaming modules):
//   1. endpoint suffixes are no longer doubled for path-suffixed base URLs
//   2. DeepSeek web-search schemas are only seeded when webSearch is advertised
// The tests pin the fixed behaviour.
import { buildToolSchemasFor } from '../tools/toolRegistry.js';
import { parseOllamaStopSequences, resolveOllamaEndpoint } from './ollamaCapabilities.js';

// Strip trailing slashes so the suffix checks below recognise an
// already-suffixed base URL (e.g. "…/api/chat") and do not append the suffix
// twice.  Keep in sync with nonStreamingRequest.js.
function normalizeBaseUrl(url) {
    return String(url ?? '').replace(/\/+$/, '');
}

function buildBaseHeaders(apiKey) {
    const headers = {};
    if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
    }
    return headers;
}

// Shared dialect tool assembly: each family gates independently and is
// appended in webSearch → crawl → exploreDocs → rag order. Guards against
// missing tool-name lists and never leaves an empty `payload.tools = []`
// (which OpenAI, DeepSeek, and Anthropic reject with HTTP 400).
function appendDialectToolGroups(payload, advertise = {}, toolNames = {}, dialect = 'openai') {
    const collected = [];
    if (advertise.webSearch && Array.isArray(toolNames.webSearch)) {
        collected.push(...buildToolSchemasFor(toolNames.webSearch, dialect));
    }
    if (advertise.crawl && Array.isArray(toolNames.crawl)) {
        collected.push(...buildToolSchemasFor(toolNames.crawl, dialect));
    }
    if (advertise.exploreDocs && Array.isArray(toolNames.exploreDocs)) {
        collected.push(...buildToolSchemasFor(toolNames.exploreDocs, dialect));
    }
    if (advertise.rag && Array.isArray(toolNames.rag)) {
        collected.push(...buildToolSchemasFor(toolNames.rag, dialect));
    }
    if (collected.length > 0) {
        payload.tools = collected;
    }
}

function hasAdvertisedTool(payload, toolName) {
    if (!toolName || !Array.isArray(payload.tools) || payload.tools.length === 0) {
        return false;
    }
    return payload.tools.some((t) => (t?.function?.name ?? t?.name) === toolName);
}

function toAnthropicBlocks(content) {
    if (Array.isArray(content)) {
        return content.filter(Boolean);
    }
    const text = String(content ?? '');
    return text ? [{ type: 'text', text }] : [];
}

/**
 * Coalesce consecutive same-role messages for Anthropic (e.g. multiple
 * `role: 'tool'` results converted to `role: 'user'` `tool_result` blocks) so
 * Anthropic's strict alternating user/assistant rule is never violated.
 */
export function normalizeAnthropicMessages(messages) {
    const filtered = (Array.isArray(messages) ? messages : []).filter(
        (m) => m && m.role !== 'system',
    );
    const merged = [];

    for (const msg of filtered) {
        const role = msg.role === 'assistant' ? 'assistant' : 'user';
        const prev = merged.length > 0 ? merged[merged.length - 1] : null;
        if (prev && prev.role === role) {
            const prevBlocks = toAnthropicBlocks(prev.content);
            const nextBlocks = toAnthropicBlocks(msg.content);
            prev.content = [...prevBlocks, ...nextBlocks];
        } else {
            // Preserve single-message content shape when there is no merge,
            // replacing empty strings with a safe placeholder only when needed.
            merged.push({
                role,
                content:
                    Array.isArray(msg.content) || (typeof msg.content === 'string' && msg.content)
                        ? msg.content
                        : typeof msg.content === 'string'
                          ? '(empty)'
                          : msg.content,
            });
        }
    }

    return merged;
}

function resolveAnthropicEndpoint(baseUrl) {
    let endpoint = normalizeBaseUrl(baseUrl);
    if (endpoint.endsWith('/v1/messages') || endpoint.endsWith('/messages')) {
        return endpoint;
    }
    if (endpoint.endsWith('/v1')) {
        return `${endpoint}/messages`;
    }
    return `${endpoint}/v1/messages`;
}

/**
 * Build the streaming request for the openai-compatible providers
 * ('openai' and 'unsloth').
 */
export function buildOpenAiCompatStreamRequest({
    provider, // 'openai' | 'unsloth'
    baseUrl,
    apiKey = '',
    model,
    messages,
    forcedTool = null,
    conversationId = null,
    unslothEnableWebSearch = false,
    advertise = {},
    toolNames = {},
}) {
    let endpoint = normalizeBaseUrl(baseUrl);
    if (!endpoint.endsWith('chat/completions') && !endpoint.includes('v1/chat')) {
        endpoint += '/chat/completions';
    }

    const headers = buildBaseHeaders(apiKey);
    headers['Content-Type'] = 'application/json';

    const payload = {
        model: model,
        messages: messages,
        stream: true,
    };

    if (provider === 'openai') {
        // Ask OpenAI to append a final usage chunk so token analytics
        // can record exact counts instead of estimates.
        payload.stream_options = { include_usage: true };
    }

    if (provider === 'unsloth') {
        payload.enable_tools = true;
        payload.enabled_tools = ['python', 'terminal'];
        if (unslothEnableWebSearch) {
            payload.enabled_tools.unshift('web_search');
        }
        payload.session_id = conversationId || `session_${Date.now()}`;
    }

    appendDialectToolGroups(payload, advertise, toolNames, 'openai');

    // Only emit forced `tool_choice` when the tool is actually advertised in
    // `payload.tools` (or enabled as a server-side tool on Unsloth); otherwise
    // OpenAI rejects `tool_choice` without matching `tools` with HTTP 400.
    if (forcedTool) {
        const isUnslothServerTool =
            provider === 'unsloth' &&
            Array.isArray(payload.enabled_tools) &&
            payload.enabled_tools.includes(forcedTool);
        if (hasAdvertisedTool(payload, forcedTool) || isUnslothServerTool) {
            payload.tool_choice = { type: 'function', function: { name: forcedTool } };
        }
    }

    return { endpoint, headers, payload };
}

/**
 * Build the Ollama warm-up request.  An empty prompt loads the model into
 * memory without generating anything; `keep_alive` keeps it resident for the
 * next real request.  Used while the user types so a cold model load is not
 * added to the first reply's turnaround time.
 */
export function buildOllamaPreloadRequest({
    baseUrl,
    apiKey = '',
    model,
    keepAlive = '5m',
    options = {},
}) {
    const endpoint = resolveOllamaEndpoint(baseUrl, '/api/generate');
    const headers = buildBaseHeaders(apiKey);
    headers['Content-Type'] = 'application/json';
    return {
        endpoint,
        headers,
        // `options` must mirror the chat request's runner options (num_ctx,
        // GPU layers, …) — Ollama reloads the model when they differ, which
        // would defeat the warm-up.
        payload: { model, prompt: '', stream: false, keep_alive: keepAlive, options },
    };
}

/**
 * Build an Ollama unload request (`keep_alive: 0`) to evict a model from
 * VRAM immediately.
 */
export function buildOllamaUnloadRequest({ baseUrl, apiKey = '', model }) {
    const endpoint = resolveOllamaEndpoint(baseUrl, '/api/generate');
    const headers = buildBaseHeaders(apiKey);
    headers['Content-Type'] = 'application/json';
    return {
        endpoint,
        headers,
        payload: { model, prompt: '', stream: false, keep_alive: 0 },
    };
}

/**
 * Build the streaming request for Anthropic (system prompt hoisted to the
 * top-level `system` field, system-role messages filtered, consecutive
 * same-role messages coalesced so multi-tool batches satisfy Anthropic's
 * strict alternation rule).
 */
export function buildAnthropicStreamRequest({
    baseUrl,
    apiKey = '',
    model,
    messages,
    systemPrompt = '',
    forcedTool = null,
    advertise = {},
    toolNames = {},
}) {
    const endpoint = resolveAnthropicEndpoint(baseUrl);

    // Anthropic specific headers
    const headers = buildBaseHeaders(apiKey);
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
    headers['Content-Type'] = 'application/json';

    // Format Anthropic messages: strip system prompts and merge consecutive
    // same-role messages (critical when parallel tool calls produce multiple
    // `role: 'tool'` → `role: 'user'` tool_result entries).
    const anthropicMessages = normalizeAnthropicMessages(messages);

    const payload = {
        model: model,
        messages: anthropicMessages,
        stream: true,
        max_tokens: 4096,
    };
    if (systemPrompt) {
        payload.system = systemPrompt;
    }

    appendDialectToolGroups(payload, advertise, toolNames, 'anthropic');

    if (forcedTool && hasAdvertisedTool(payload, forcedTool)) {
        payload.tool_choice = { type: 'tool', name: forcedTool };
    }

    return { endpoint, headers, payload };
}

/**
 * Build the streaming request for Ollama (/api/chat). The capability probe and
 * all send-side effects stay in the extension; `keepAlive` is expected to be
 * pre-normalized via normalizeOllamaKeepAlive, and `think` via
 * resolveOllamaThinkParam (omitted when undefined so non-thinking models never
 * fail with HTTP 400).
 */
export function buildOllamaStreamRequest({
    baseUrl,
    apiKey = '',
    model,
    messages,
    keepAlive = '5m',
    think = undefined,
    format = undefined,
    options = {},
    advertise = {},
    toolNames = {},
}) {
    const endpoint = resolveOllamaEndpoint(baseUrl, '/api/chat');
    const headers = buildBaseHeaders(apiKey);
    headers['Content-Type'] = 'application/json';

    const payload = {
        model: model,
        messages: messages,
        stream: true,
        keep_alive: keepAlive,
    };

    if (think !== undefined && think !== null) {
        payload.think = think;
    }

    if (options && typeof options === 'object' && Object.keys(options).length > 0) {
        payload.options = options;
    }

    if (format && (typeof format === 'string' || typeof format === 'object')) {
        payload.format = format;
    }

    appendDialectToolGroups(payload, advertise, toolNames, 'openai');

    return { endpoint, headers, payload };
}

/**
 * Build the streaming request for DeepSeek. `messages` must already carry the
 * merged system prompt; `thinking` mirrors the dialog's
 * `deepseekEffectiveThinking` decision and `userId` the `_buildDeepSeekUserId()`
 * value (both computed by the caller — they depend on dialog state).
 */
export function buildDeepSeekStreamRequest({
    baseUrl,
    apiKey = '',
    model,
    messages,
    thinking = false,
    reasoningEffort = 'high',
    jsonMode = false,
    forcedTool = null,
    maxTokens,
    userId = '',
    advertise = {},
    toolNames = {},
}) {
    let endpoint = normalizeBaseUrl(baseUrl);
    if (!endpoint.endsWith('chat/completions') && !endpoint.includes('chat/completions')) {
        endpoint += '/chat/completions';
    }

    const headers = buildBaseHeaders(apiKey);
    headers['Content-Type'] = 'application/json';

    // When thinking is enabled the API requires reasoning_content on every
    // assistant message. Clone affected entries instead of mutating caller
    // message objects in place.
    let requestMessages = Array.isArray(messages) ? messages : [];
    if (
        thinking &&
        requestMessages.some(
            (msg) => msg && msg.role === 'assistant' && msg.reasoning_content === undefined,
        )
    ) {
        requestMessages = requestMessages.map((msg) =>
            msg && msg.role === 'assistant' && msg.reasoning_content === undefined
                ? { ...msg, reasoning_content: '' }
                : msg,
        );
    }

    const payload = {
        model: model,
        messages: requestMessages,
        stream: true,
        max_tokens: maxTokens,
        stream_options: { include_usage: true },
        thinking: { type: thinking ? 'enabled' : 'disabled' },
        user_id: userId,
    };

    if (thinking) {
        payload.reasoning_effort = reasoningEffort;
    }

    // JSON mode: inject prompt guard if the word 'json' is absent from the system message.
    if (jsonMode) {
        payload.response_format = { type: 'json_object' };
        const systemMsg = payload.messages.find((m) => m.role === 'system');
        if (systemMsg && !/json/i.test(systemMsg.content || '')) {
            // Clone to avoid mutating _messageHistory
            payload.messages = payload.messages.map((m) =>
                m === systemMsg
                    ? {
                          ...m,
                          content:
                              (m.content || '') +
                              '\n\nEnsure the output is formatted as a valid JSON object.',
                      }
                    : m,
            );
        } else if (!systemMsg) {
            // No system message — prepend a minimal one satisfying the requirement
            payload.messages = [
                {
                    role: 'system',
                    type: 'system',
                    content: 'Ensure the output is formatted as a valid JSON object.',
                },
                ...payload.messages,
            ];
        }
    }

    // Tools and JSON mode are mutually exclusive on DeepSeek.  Each tool
    // family gates independently — web search may be off (or suppressed by a
    // strong KB hit) while crawl/exploreDocs/RAG tools are still active.
    const hasTools =
        (advertise.webSearch || advertise.crawl || advertise.exploreDocs || advertise.rag) &&
        !jsonMode;
    if (hasTools) {
        appendDialectToolGroups(payload, advertise, toolNames, 'openai');
        if (Array.isArray(payload.tools) && payload.tools.length > 0) {
            payload.tool_choice =
                forcedTool && hasAdvertisedTool(payload, forcedTool)
                    ? { type: 'function', function: { name: forcedTool } }
                    : 'auto';
        }
    }

    return { endpoint, headers, payload };
}

/**
 * Build the Ollama `options` object from a settings getter.
 *
 * @param {(prop: string, type: 'int'|'double'|'boolean'|'string') => (number|boolean|string|null)} getOpt
 *        reads `ollama-<prop>` with the given type; returns null when unset.
 * @param {object} [flags]
 * @param {boolean} [flags.runnerOnly=false]  When true, emit only runner/context
 *        options (`num_ctx`, `num_predict`, `num_keep`, `use_mmap`, `num_gpu`,
 *        `num_thread`) so non-streaming helper requests share the exact loaded
 *        runner configuration without sampler noise.
 * @param {boolean} [flags.useModelDefaults=false]  When true, omit sampling and
 *        repetition overrides so Ollama uses the model's packaged Modelfile defaults.
 * @returns {object} options with null/undefined/deprecated entries removed and
 *          the repeat_last_n sentinel translated.
 */
export function buildOllamaOptions(getOpt, { runnerOnly = false, useModelDefaults = false } = {}) {
    const options = {
        num_ctx: getOpt('num-ctx', 'int'),
        num_predict: getOpt('num-predict', 'int'),
        num_keep: getOpt('num-keep', 'int'),
        use_mmap: getOpt('use-mmap', 'boolean'),
        num_gpu: getOpt('num-gpu', 'int'),
        num_thread: getOpt('num-thread', 'int'),
    };

    if (!runnerOnly) {
        if (!useModelDefaults) {
            Object.assign(options, {
                temperature: getOpt('temperature', 'double'),
                top_k: getOpt('top-k', 'int'),
                top_p: getOpt('top-p', 'double'),
                min_p: getOpt('min-p', 'double'),
                repeat_last_n: getOpt('repeat-last-n', 'int'),
                repeat_penalty: getOpt('repeat-penalty', 'double'),
                presence_penalty: getOpt('presence-penalty', 'double'),
                frequency_penalty: getOpt('frequency-penalty', 'double'),
            });
        }
        const seed = getOpt('seed', 'int');
        if (typeof seed === 'number' && Number.isFinite(seed) && seed >= 0) {
            options.seed = seed;
        }
        const stopRaw = getOpt('stop', 'string');
        const stopList = parseOllamaStopSequences(stopRaw);
        if (stopList) {
            options.stop = stopList;
        }
    }

    // Remove nulls just in case, though GSettings should provide defaults
    Object.keys(options).forEach((key) => {
        if (options[key] === null || options[key] === undefined) {
            delete options[key];
        }
    });

    // num_thread = 0 means auto-detect optimal physical cores — omit so Ollama chooses.
    if (typeof options.num_thread === 'number' && options.num_thread <= 0) {
        delete options.num_thread;
    }

    // Newer Ollama releases (via llama.cpp) reject repeat_last_n = -1 with
    // HTTP 400: "Value must be between 0 <= value <= 2147483647, but got -1".
    // -1 historically meant "scan the full active context", so translate it
    // to num_ctx to preserve that behavior without tripping the validation.
    if (options.repeat_last_n === -1) {
        options.repeat_last_n =
            typeof options.num_ctx === 'number' && options.num_ctx > 0 ? options.num_ctx : 64;
    }

    return options;
}

/**
 * Normalize the Ollama keep_alive setting to a duration string with a unit.
 * The API rejects a bare "-1"; convert it to the indefinite equivalent.
 * Numeric 0 / "0" (unload immediately) is preserved explicitly.
 *
 * @param {string|number|null} keepAlive raw `ollama-keep-alive` value
 * @returns {string|number} e.g. '5m', 0, or '999999h'
 */
export function normalizeOllamaKeepAlive(keepAlive) {
    if (keepAlive === 0 || keepAlive === '0') {
        return keepAlive;
    }
    if (keepAlive === null || keepAlive === undefined) {
        return '999999h';
    }
    const trimmed = String(keepAlive).trim();
    if (!trimmed || trimmed === '-1') {
        return '999999h';
    }
    return trimmed;
}
