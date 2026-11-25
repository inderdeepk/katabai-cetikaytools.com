// nonStreamingRequest.js — Pure request dialects for non-streaming LLM calls
// (planner, gap analysis, compression, synthesis outline, quality checks).
//
// This is the stream:false mirror of the streaming dialects in extension.js's
// _streamResponse.  Extracted so endpoint/header/payload construction and
// response/usage extraction are unit-testable without the GNOME Shell.
//
// Endpoint normalization strips trailing slashes before the suffix check, so
// an already-suffixed base URL (e.g. "http://host/api/chat") keeps its single
// suffix instead of receiving a second one.  Keep in sync with chatRequest.js.

import { resolveOllamaEndpoint } from './ollamaCapabilities.js';

/**
 * Build the HTTP request for a non-streaming chat completion.
 *
 * @param {object} options
 * @param {string} options.provider  'ollama' | 'deepseek' | 'openai' | 'unsloth' | 'anthropic'
 * @param {string} options.baseUrl   configured provider base URL
 * @param {string} options.model     resolved model id (may be an override)
 * @param {string} [options.apiKey]  bearer/x-api-key credential ('' for none)
 * @param {Array} options.messages   chat messages
 * @param {number} [options.maxTokens]
 * @param {number} [options.ollamaNumPredict]  explicit Ollama num_predict cap
 *   (OpenAI-compatible dialects use maxTokens; Ollama has no max_tokens field)
 * @param {string|number|null} [options.ollamaKeepAlive]  Ollama keep_alive value
 * @param {object|null} [options.ollamaOptions]  Ollama runner options (num_ctx, num_gpu, etc.)
 * @param {boolean|string|undefined} [options.ollamaThink]  resolved Ollama think parameter (omitted when undefined)
 * @param {string|object|undefined} [options.ollamaFormat]  Ollama format ('json' or JSON schema)
 * @returns {{ url: string, headers: Record<string,string>, payload: object }}
 */
export function buildNonStreamingChatRequest({
    provider,
    baseUrl,
    model,
    apiKey = '',
    messages,
    maxTokens = 256,
    ollamaNumPredict = null,
    ollamaKeepAlive = null,
    ollamaOptions = null,
    ollamaThink = undefined,
    ollamaFormat = undefined,
}) {
    let endpoint = String(baseUrl ?? '').replace(/\/+$/, '');

    const headers = { 'Content-Type': 'application/json' };
    let payload;

    if (provider === 'anthropic') {
        if (endpoint.endsWith('/v1/messages') || endpoint.endsWith('/messages')) {
            // already suffixed
        } else if (endpoint.endsWith('/v1')) {
            endpoint += '/messages';
        } else {
            endpoint += '/v1/messages';
        }
        headers['x-api-key'] = apiKey;
        headers['anthropic-version'] = '2023-06-01';
        const systemParts = [];
        const nonSystem = [];
        for (const message of Array.isArray(messages) ? messages : []) {
            if (!message) continue;
            if (message.role === 'system') {
                const text = typeof message.content === 'string' ? message.content.trim() : '';
                if (text) systemParts.push(text);
            } else {
                const prev = nonSystem.length > 0 ? nonSystem[nonSystem.length - 1] : null;
                if (
                    prev &&
                    prev.role === message.role &&
                    typeof prev.content === 'string' &&
                    typeof message.content === 'string'
                ) {
                    prev.content = `${prev.content}\n\n${message.content}`;
                } else {
                    nonSystem.push({ ...message });
                }
            }
        }
        payload = {
            model,
            max_tokens: maxTokens,
            messages: nonSystem,
        };
        if (systemParts.length > 0) {
            payload.system = systemParts.join('\n\n');
        }
    } else if (provider === 'ollama') {
        endpoint = resolveOllamaEndpoint(baseUrl, '/api/chat');
        if (apiKey) {
            headers['Authorization'] = `Bearer ${apiKey}`;
        }
        payload = { model, messages, stream: false };
        if (ollamaKeepAlive !== null && ollamaKeepAlive !== undefined && ollamaKeepAlive !== '') {
            payload.keep_alive = ollamaKeepAlive;
        }
        if (ollamaThink !== undefined && ollamaThink !== null) {
            payload.think = ollamaThink;
        }
        if (ollamaFormat !== undefined && ollamaFormat !== null && ollamaFormat !== '') {
            payload.format = ollamaFormat;
        }
        const mergedOptions =
            ollamaOptions && typeof ollamaOptions === 'object' ? { ...ollamaOptions } : {};
        if (Number.isFinite(ollamaNumPredict) && ollamaNumPredict > 0) {
            mergedOptions.num_predict = ollamaNumPredict;
        }
        if (Object.keys(mergedOptions).length > 0) {
            payload.options = mergedOptions;
        }
    } else {
        // openai / unsloth / deepseek (OpenAI-compatible chat completions)
        if (
            !endpoint.endsWith('chat/completions') &&
            !endpoint.includes('chat/completions') &&
            !endpoint.includes('v1/chat')
        ) {
            endpoint += '/chat/completions';
        }
        if (apiKey) {
            headers['Authorization'] = `Bearer ${apiKey}`;
        }
        payload = { model, messages, stream: false, max_tokens: maxTokens };
        if (provider === 'deepseek') {
            payload.thinking = { type: 'disabled' };
        }
    }

    return { url: endpoint, headers, payload };
}

/**
 * Extract the assistant text from a parsed non-streaming response body.
 * @returns {string} '' when the expected field is absent.
 */
export function extractNonStreamingText(provider, parsed) {
    if (provider === 'anthropic') {
        if (Array.isArray(parsed.content)) {
            return parsed.content
                .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
                .map((block) => block.text)
                .join('');
        }
        return '';
    }
    if (provider === 'ollama') {
        return parsed.message?.content || '';
    }
    return parsed.choices?.[0]?.message?.content || '';
}

/**
 * Extract the total billed token count from a parsed non-streaming response
 * body (0 when the provider omitted usage data).
 */
export function extractNonStreamingUsage(provider, parsed) {
    if (provider === 'ollama') {
        return (parsed.prompt_eval_count || 0) + (parsed.eval_count || 0);
    }
    if (provider === 'anthropic') {
        return (parsed.usage?.input_tokens || 0) + (parsed.usage?.output_tokens || 0);
    }
    // OpenAI / DeepSeek / Unsloth
    return (parsed.usage?.prompt_tokens || 0) + (parsed.usage?.completion_tokens || 0);
}
