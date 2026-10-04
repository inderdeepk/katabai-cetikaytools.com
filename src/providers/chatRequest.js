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

// Shared openai-dialect tool assembly: each family gates independently and is
// appended in webSearch → crawl → exploreDocs → rag order (openai + anthropic
// branches of the original inline builder).
function appendDialectToolGroups(payload, advertise, toolNames, dialect) {
    if (advertise.webSearch) {
        payload.tools = buildToolSchemasFor(toolNames.webSearch, dialect);
    }
    if (advertise.crawl) {
        payload.tools = [...(payload.tools || []), ...buildToolSchemasFor(toolNames.crawl, dialect)];
    }
    if (advertise.exploreDocs) {
        payload.tools = [...(payload.tools || []), ...buildToolSchemasFor(toolNames.exploreDocs, dialect)];
    }
    if (advertise.rag) {
        payload.tools = [...(payload.tools || []), ...buildToolSchemasFor(toolNames.rag, dialect)];
    }
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

    if (forcedTool) {
        payload.tool_choice = { type: 'function', function: { name: forcedTool } };
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

    return { endpoint, headers, payload };
}

/**
 * Build the streaming request for Anthropic (system prompt hoisted to the
 * top-level `system` field, system-role messages filtered from the array).
 */
export function buildAnthropicStreamRequest({
    baseUrl,
    apiKey = '',
    model,
    messages,
    systemPrompt = '',
    advertise = {},
    toolNames = {},
}) {
    let endpoint = normalizeBaseUrl(baseUrl);
    if (!endpoint.endsWith('messages') && !endpoint.includes('v1/messages')) {
        endpoint += '/v1/messages';
    }

    // Anthropic specific headers
    const headers = buildBaseHeaders(apiKey);
    headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
    headers['Content-Type'] = 'application/json';

    // Format Anthropic messages (remove system prompts from history or map them)
    const anthropicMessages = messages.filter(m => m.role !== 'system');

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

    return { endpoint, headers, payload };
}

/**
 * Build the streaming request for Ollama (/api/chat). The vision-capability
 * probe and all send-side effects stay in the extension; `keepAlive` is
 * expected to be pre-normalized via normalizeOllamaKeepAlive.
 */
export function buildOllamaStreamRequest({
    baseUrl,
    model,
    messages,
    keepAlive = '5m',
    think = true,
    format = '',
    raw = false,
    options = {},
    advertise = {},
    toolNames = {},
}) {
    let endpoint = normalizeBaseUrl(baseUrl);
    if (!endpoint.endsWith('api/chat')) {
        endpoint += '/api/chat';
    }

    const headers = { 'Content-Type': 'application/json' };

    const payload = {
        model: model,
        messages: messages,
        stream: true,
        keep_alive: keepAlive,
        think: think,
        options: options,
    };

    if (format) {
        payload.format = format;
    }

    if (raw) {
        payload.raw = true;
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
    // assistant message. _sanitizeHistoryMessage already ensures every
    // assistant message carries at least an empty string when thinking is
    // on. This loop is a defense-in-depth pass for any messages that may
    // have slipped through (e.g. from old conversation files).
    if (thinking) {
        for (const msg of messages) {
            if (msg.role === 'assistant' && msg.reasoning_content === undefined) {
                msg.reasoning_content = '';
            }
        }
    }

    const payload = {
        model: model,
        messages: messages,
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
        const systemMsg = payload.messages.find(m => m.role === 'system');
        if (systemMsg && !/json/i.test(systemMsg.content || '')) {
            // Clone to avoid mutating _messageHistory
            payload.messages = payload.messages.map(m =>
                m === systemMsg
                    ? { ...m, content: (m.content || '') + '\n\nEnsure the output is formatted as a valid JSON object.' }
                    : m
            );
        } else if (!systemMsg) {
            // No system message — prepend a minimal one satisfying the requirement
            payload.messages = [
                { role: 'system', content: 'Ensure the output is formatted as a valid JSON object.' },
                ...payload.messages
            ];
        }
    }

    // Tools and JSON mode are mutually exclusive on DeepSeek.  Each tool
    // family gates independently — web search may be off (or suppressed by a
    // strong KB hit) while crawl/RAG tools are still active.
    const hasTools = (advertise.webSearch || advertise.crawl || advertise.rag) && !jsonMode;
    if (hasTools) {
        appendDialectToolGroups(payload, advertise, toolNames, 'openai');
        payload.tool_choice = 'auto';
    }

    return { endpoint, headers, payload };
}

/**
 * Build the Ollama `options` object from a settings getter.
 *
 * @param {(prop: string, type: 'int'|'double'|'boolean') => (number|boolean|null)} getOpt
 *        reads `ollama-<prop>` with the given type; returns null when unset.
 * @returns {object} options with null/undefined entries removed and the
 *          repeat_last_n sentinel translated.
 */
export function buildOllamaOptions(getOpt) {
    const options = {
        temperature: getOpt('temperature', 'double'),
        num_ctx: getOpt('num-ctx', 'int'),
        num_predict: getOpt('num-predict', 'int'),
        num_keep: getOpt('num-keep', 'int'),
        use_mmap: getOpt('use-mmap', 'boolean'),
        use_mlock: getOpt('use-mlock', 'boolean'),
        num_gpu: getOpt('num-gpu', 'int'),
        num_thread: getOpt('num-thread', 'int'),
        top_k: getOpt('top-k', 'int'),
        top_p: getOpt('top-p', 'double'),
        min_p: getOpt('min-p', 'double'),
        tfs_z: getOpt('tfs-z', 'double'),
        mirostat: getOpt('mirostat', 'int'),
        mirostat_tau: getOpt('mirostat-tau', 'double'),
        mirostat_eta: getOpt('mirostat-eta', 'double'),
        repeat_last_n: getOpt('repeat-last-n', 'int'),
        repeat_penalty: getOpt('repeat-penalty', 'double'),
        presence_penalty: getOpt('presence-penalty', 'double'),
        frequency_penalty: getOpt('frequency-penalty', 'double'),
    };

    // Remove nulls just in case, though GSettings should provide defaults
    Object.keys(options).forEach(key => {
        if (options[key] === null || options[key] === undefined) {
            delete options[key];
        }
    });

    // Newer Ollama releases (via llama.cpp) reject repeat_last_n = -1 with
    // HTTP 400: "Value must be between 0 <= value <= 2147483647, but got -1".
    // -1 historically meant "scan the full active context", so translate it
    // to num_ctx to preserve that behavior without tripping the validation.
    if (options.repeat_last_n === -1) {
        options.repeat_last_n = (typeof options.num_ctx === 'number' && options.num_ctx > 0)
            ? options.num_ctx
            : 64;
    }

    return options;
}

/**
 * Normalize the Ollama keep_alive setting to a duration string with a unit.
 * The API rejects a bare "-1"; convert it to the indefinite equivalent.
 *
 * @param {string} keepAlive raw `ollama-keep-alive` value
 * @returns {string} e.g. '5m' or '999999h'
 */
export function normalizeOllamaKeepAlive(keepAlive) {
    if (!keepAlive || keepAlive === '-1') {
        return '999999h';
    }
    return keepAlive;
}
