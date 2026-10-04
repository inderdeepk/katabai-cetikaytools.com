// streamParse.js — Pure per-provider SSE chunk interpretation for streaming.
//
// Extracted from _readSSE: the per-line parsing logic that turns a decoded SSE
// line's JSON into a small event object, plus the thinking-tag splitter, the
// streaming tool-call fragment merge, and the provider metrics extractors.
// The read loop, EOF finalization, UI updates, usage accumulation, and
// logging all stay in extension.js — these functions do no I/O and touch no
// widgets. Behaviour is an exact extraction; quirks are frozen by tests.

function numberOrNull(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Split a streamed text delta into visible text and inline thinking content,
 * carrying the thinking state across deltas. Handles both `<thinking>…</thinking>`
 * and the shorter `<think>…</think>` tag pair. NOTE: the tag literals here were
 * once corrupted ('igid'/'igr') — keep them exact.
 *
 * @param {string} deltaText
 * @param {boolean} isThinking state carried from the previous delta
 * @returns {{ text: string, think: string, isThinking: boolean, openedThinking: boolean }}
 */
export function splitThinkingTags(deltaText, isThinking = false) {
    let text = '';
    let think = '';
    let openedThinking = false;
    let i = 0;
    let thinking = isThinking;
    while (i < deltaText.length) {
        if (!thinking) {
            const thinkingOpen = deltaText.startsWith('<thinking>', i);
            if (thinkingOpen || deltaText.startsWith('<think>', i)) {
                thinking = true;
                openedThinking = true;
                i += thinkingOpen ? 10 : 7; // skip tag
                continue;
            }
        } else {
            const thinkingClose = deltaText.startsWith('</thinking>', i);
            if (thinkingClose || deltaText.startsWith('</think>', i)) {
                thinking = false;
                i += thinkingClose ? 11 : 8; // skip tag
                continue;
            }
        }
        if (thinking) {
            think += deltaText[i];
        } else {
            text += deltaText[i];
        }
        i++;
    }
    return { text, think, isThinking: thinking, openedThinking };
}

/**
 * Interpret one parsed Ollama /api/chat stream frame.
 * On `parsed.error` the rest of the frame is ignored (matches the original
 * inline flow, which bailed out after stashing the error).
 *
 * @returns {{ error: string|null, text: string, think: string,
 *             toolCalls: object[]|null, done: boolean, metrics: object|null }}
 */
export function parseOllamaChunk(parsed) {
    const result = { error: null, text: '', think: '', toolCalls: null, done: false, metrics: null };

    if (parsed.error) {
        result.error = typeof parsed.error === 'string'
            ? parsed.error
            : (parsed.error.message || 'Unknown Ollama error');
        return result;
    }

    if (parsed.message) {
        if (parsed.message.content) {
            result.text = parsed.message.content;
        }
        // Ollama returns the thinking trace in `message.thinking` (canonical
        // field name). Older or alternative model runners may use `message.reasoning`.
        const thinkText = parsed.message.thinking || parsed.message.reasoning;
        if (thinkText) {
            result.think = thinkText;
        }
        if (parsed.message.tool_calls) {
            result.toolCalls = parsed.message.tool_calls;
        }
    }

    if (parsed.done === true) {
        result.done = true;
        result.metrics = extractOllamaMetrics(parsed);
    }

    return result;
}

/**
 * Interpret one parsed OpenAI-compatible stream frame (OpenAI, Unsloth,
 * DeepSeek). `think` is only meaningful for DeepSeek — callers for the other
 * providers ignore it (matching the original per-provider branches).
 *
 * @returns {{ serverToolResult: string|null, text: string, think: string,
 *             toolCallFragments: object[]|null, usage: object|null }}
 */
export function parseOpenAiCompatChunk(parsed) {
    const result = { serverToolResult: null, text: '', think: '', toolCallFragments: null, usage: null };

    if (parsed.type === 'tool_result') {
        const toolContent = parsed.content || 'No output.';
        const toolName = parsed.tool_use_id || 'Tool';
        result.serverToolResult = `\n\n> **Server-side tool executed (${toolName})**:\n> \`\`\`\n> ${toolContent.split('\n').join('\n> ')}\n> \`\`\`\n\n`;
    } else if (parsed.choices && parsed.choices.length > 0) {
        const delta = parsed.choices[0].delta;
        if (delta) {
            // reasoning_content arrives before content during thinking
            if (delta.reasoning_content) {
                result.think = delta.reasoning_content;
            }
            if (delta.content) {
                result.text = delta.content;
            }
            // OpenAI-compatible providers stream tool-call fragments by index.
            if (delta.tool_calls) {
                result.toolCallFragments = delta.tool_calls;
            }
        }
    }

    if (parsed.usage) {
        result.usage = parsed.usage;
    }

    return result;
}

/**
 * Interpret one parsed Anthropic SSE frame. Tool-use state is tracked in the
 * caller-supplied `toolUseMap` (index → { id, name, argsJson }).
 *
 * @returns {{ text: string, promptTokens: number|null, outputTokens: number|null,
 *             completedToolCall: object|null }}
 */
export function parseAnthropicChunk(parsed, toolUseMap) {
    const result = { text: '', promptTokens: null, outputTokens: null, completedToolCall: null };

    if (parsed.type === 'content_block_start' && parsed.content_block?.type === 'tool_use') {
        toolUseMap.set(parsed.index, {
            id: parsed.content_block.id,
            name: parsed.content_block.name,
            argsJson: '',
        });
    } else if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'input_json_delta') {
        const toolBlock = toolUseMap.get(parsed.index);
        if (toolBlock) {
            toolBlock.argsJson += parsed.delta.partial_json || '';
        }
    } else if (parsed.type === 'content_block_delta' && parsed.delta && parsed.delta.text) {
        result.text = parsed.delta.text;
    } else if (parsed.type === 'content_block_stop') {
        const toolBlock = toolUseMap.get(parsed.index);
        if (toolBlock) {
            let toolInput = {};
            try {
                toolInput = toolBlock.argsJson ? JSON.parse(toolBlock.argsJson) : {};
            } catch (_e) {
                toolInput = {};
            }
            result.completedToolCall = {
                id: toolBlock.id,
                type: 'function',
                function: { name: toolBlock.name, arguments: JSON.stringify(toolInput) },
            };
        }
    } else if (parsed.type === 'message_start' && parsed.message?.usage) {
        // Anthropic reports prompt tokens up front on message_start.
        result.promptTokens = Number(parsed.message.usage.input_tokens) || 0;
    } else if (parsed.type === 'message_delta' && parsed.usage?.output_tokens !== undefined) {
        // message_delta carries the cumulative output token count.
        result.outputTokens = Number(parsed.usage.output_tokens) || 0;
    }

    return result;
}

/**
 * Merge OpenAI-style streaming tool-call fragments into the response state's
 * accumulated tool calls (index-based assembly). Mutates `responseState`
 * (`_toolCallsByIndex`, `accumulatedToolCalls`) exactly like the original
 * method did.
 */
export function accumulateStreamingToolCalls(responseState, deltaToolCalls) {
    if (!Array.isArray(deltaToolCalls)) {
        return;
    }
    if (!responseState._toolCallsByIndex) {
        responseState._toolCallsByIndex = new Map();
    }

    for (const tc of deltaToolCalls) {
        const index = Number.isInteger(tc.index) ? tc.index : responseState._toolCallsByIndex.size;
        let entry = responseState._toolCallsByIndex.get(index);
        if (!entry) {
            entry = { id: '', type: 'function', function: { name: '', arguments: '' } };
            responseState._toolCallsByIndex.set(index, entry);
        }
        if (tc.id) {
            entry.id = tc.id;
        }
        if (tc.type) {
            entry.type = tc.type;
        }
        if (tc.function) {
            if (tc.function.name) {
                entry.function.name = tc.function.name;
            }
            if (tc.function.arguments) {
                entry.function.arguments += tc.function.arguments;
            }
        }
    }

    responseState.accumulatedToolCalls = [...responseState._toolCallsByIndex.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, value]) => value);
}

/**
 * Extract Ollama final-metrics from a `done: true` frame. Returns null when
 * none of the fields carry a finite number.
 */
export function extractOllamaMetrics(payload) {
    const metrics = {
        total_duration: numberOrNull(payload.total_duration),
        load_duration: numberOrNull(payload.load_duration),
        prompt_eval_count: numberOrNull(payload.prompt_eval_count),
        prompt_eval_duration: numberOrNull(payload.prompt_eval_duration),
        eval_count: numberOrNull(payload.eval_count),
        eval_duration: numberOrNull(payload.eval_duration),
    };

    return Object.values(metrics).some(value => value !== null) ? metrics : null;
}

/**
 * Extract DeepSeek usage metrics from a stream usage chunk. Returns null when
 * the chunk is missing or carries no finite numbers.
 */
export function extractDeepSeekMetrics(usageChunk) {
    if (!usageChunk) {
        return null;
    }

    const metrics = {
        prompt_tokens: numberOrNull(usageChunk.prompt_tokens),
        completion_tokens: numberOrNull(usageChunk.completion_tokens),
        total_tokens: numberOrNull(usageChunk.total_tokens),
        reasoning_tokens: numberOrNull(usageChunk.completion_tokens_details?.reasoning_tokens ?? null),
        cached_tokens_hit: numberOrNull(usageChunk.prompt_cache_hit_tokens ?? null),
        cached_tokens_miss: numberOrNull(usageChunk.prompt_cache_miss_tokens ?? null),
    };

    return Object.values(metrics).some(value => value !== null) ? metrics : null;
}
