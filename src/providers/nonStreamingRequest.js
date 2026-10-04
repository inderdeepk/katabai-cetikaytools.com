// nonStreamingRequest.js — Pure request dialects for non-streaming LLM calls
// (planner, gap analysis, compression, synthesis outline, quality checks).
//
// This is the stream:false mirror of the streaming dialects in extension.js's
// _streamResponse.  Extracted so endpoint/header/payload construction and
// response/usage extraction are unit-testable without the GNOME Shell.
//
// BEHAVIOR FROZEN: the endpoint normalization below reproduces the original
// logic exactly, including a pre-existing quirk — a base URL that already ends
// in a path suffix (e.g. "http://host/api/chat") receives an ADDITIONAL suffix
// because a trailing "/" is appended first.  Plain base URLs
// (http://host:port) are the supported configuration; see the test suite.

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
 * @returns {{ url: string, headers: Record<string,string>, payload: object }}
 */
export function buildNonStreamingChatRequest({ provider, baseUrl, model, apiKey = '', messages, maxTokens = 256 }) {
    let endpoint = String(baseUrl ?? '');
    if (!endpoint.endsWith('/')) endpoint += '/';

    const headers = { 'Content-Type': 'application/json' };
    let payload;

    if (provider === 'anthropic') {
        if (!endpoint.endsWith('messages') && !endpoint.includes('v1/messages')) {
            endpoint += 'v1/messages';
        }
        headers['x-api-key'] = apiKey;
        headers['anthropic-version'] = '2023-06-01';
        payload = {
            model,
            max_tokens: maxTokens,
            messages: messages.filter(message => message.role !== 'system'),
        };
    } else if (provider === 'ollama') {
        if (!endpoint.endsWith('api/chat')) {
            endpoint += 'api/chat';
        }
        // Non-streaming calls (planner, gap analysis, compression) need
        // fast, structured responses.  Disable think mode so the model
        // produces output directly instead of getting stuck in a thinking
        // phase that can time out or consume all output tokens.
        payload = { model, messages, stream: false, think: false };
    } else {
        // openai / unsloth / deepseek (OpenAI-compatible chat completions)
        if (!endpoint.endsWith('chat/completions') && !endpoint.includes('chat/completions') && !endpoint.includes('v1/chat')) {
            endpoint += 'chat/completions';
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
                .filter(block => block && block.type === 'text' && typeof block.text === 'string')
                .map(block => block.text)
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
