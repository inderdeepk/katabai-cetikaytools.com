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

const THINK_OPEN_TAGS = ['<thinking>', '<think>'];
const THINK_CLOSE_TAGS = ['</thinking>', '</think>'];

/**
 * Find the length of the longest suffix of `str` that is a strict prefix of
 * any tag in `tags`. Used to carry partial `<think>` / `</think>` tags across
 * SSE chunk boundaries without leaking them into visible text.
 */
function trailingPartialTagLength(str, tags) {
    const maxCheck = Math.min(str.length, 11); // '</thinking>'.length === 11
    for (let len = maxCheck; len >= 1; len--) {
        const suffix = str.slice(str.length - len);
        if (suffix[0] !== '<') {
            continue;
        }
        for (const tag of tags) {
            if (len < tag.length && tag.startsWith(suffix)) {
                return len;
            }
        }
    }
    return 0;
}

/**
 * Split a streamed text delta into visible text and inline thinking content,
 * carrying the thinking state across deltas. Handles both `<thinking>…</thinking>`
 * and the shorter `<think>…</think>` tag pair. NOTE: the tag literals here were
 * once corrupted ('igid'/'igr') — keep them exact.
 *
 * When a mutable `carryState` object (`{ carry: '', openTag: '' }`) is
 * supplied, partial opening/closing tags split across two SSE deltas are
 * buffered until the next delta completes or disproves them. Call
 * `flushThinkingCarry(isThinking, carryState)` at stream EOF to emit any
 * trailing unmatched `<...` fragment.
 *
 * @param {string} deltaText
 * @param {boolean} isThinking state carried from the previous delta
 * @param {{ carry?: string, openTag?: string }|null} [carryState]
 * @returns {{ text: string, think: string, isThinking: boolean, openedThinking: boolean }}
 */
export function splitThinkingTags(deltaText, isThinking = false, carryState = null) {
    const input = (carryState?.carry || '') + String(deltaText ?? '');
    if (carryState) {
        carryState.carry = '';
    }

    const textParts = [];
    const thinkParts = [];
    let openedThinking = false;
    let i = 0;
    let segStart = 0;
    let thinking = Boolean(isThinking);
    let openTag = carryState?.openTag || '';

    const flushSegment = (end) => {
        if (end <= segStart) {
            return;
        }
        if (thinking) {
            thinkParts.push(input.slice(segStart, end));
        } else {
            textParts.push(input.slice(segStart, end));
        }
    };

    while (i < input.length) {
        const lt = input.indexOf('<', i);
        if (lt < 0) {
            break;
        }
        if (!thinking) {
            const thinkingOpen = input.startsWith('<thinking>', lt);
            const thinkOpen = !thinkingOpen && input.startsWith('<think>', lt);
            if (thinkingOpen || thinkOpen) {
                flushSegment(lt);
                thinking = true;
                openedThinking = true;
                openTag = thinkingOpen ? 'thinking' : 'think';
                i = lt + (thinkingOpen ? 10 : 7);
                segStart = i;
                continue;
            }
        } else {
            const thinkingClose =
                (!openTag || openTag === 'thinking') && input.startsWith('</thinking>', lt);
            const thinkClose =
                !thinkingClose &&
                (!openTag || openTag === 'think') &&
                input.startsWith('</think>', lt);
            if (thinkingClose || thinkClose) {
                flushSegment(lt);
                thinking = false;
                openTag = '';
                i = lt + (thinkingClose ? 11 : 8);
                segStart = i;
                continue;
            }
        }
        i = lt + 1;
    }

    let endIdx = input.length;
    if (carryState && endIdx > segStart) {
        const expectedTags = !thinking
            ? THINK_OPEN_TAGS
            : openTag === 'thinking'
              ? ['</thinking>']
              : openTag === 'think'
                ? ['</think>']
                : THINK_CLOSE_TAGS;
        const partialLen = trailingPartialTagLength(input.slice(segStart), expectedTags);
        if (partialLen > 0) {
            carryState.carry = input.slice(endIdx - partialLen);
            endIdx -= partialLen;
        }
    }

    flushSegment(endIdx);

    if (carryState) {
        carryState.openTag = openTag;
    }

    return {
        text: textParts.join(''),
        think: thinkParts.join(''),
        isThinking: thinking,
        openedThinking,
    };
}

/**
 * Flush any buffered partial `<...` fragment left in `carryState` at EOF.
 * @param {boolean} isThinking
 * @param {{ carry?: string, openTag?: string }|null} carryState
 * @returns {{ text: string, think: string }}
 */
export function flushThinkingCarry(isThinking, carryState) {
    const carry = carryState?.carry || '';
    if (carryState) {
        carryState.carry = '';
    }
    if (!carry) {
        return { text: '', think: '' };
    }
    return isThinking ? { text: '', think: carry } : { text: carry, think: '' };
}

/**
 * Interpret one parsed Ollama /api/chat stream frame.
 * On `parsed.error` the rest of the frame is ignored (matches the original
 * inline flow, which bailed out after stashing the error).
 *
 * @returns {{ error: string|null, text: string, think: string,
 *             toolCalls: object[]|null, done: boolean, doneReason: string|null,
 *             metrics: object|null }}
 */
export function parseOllamaChunk(parsed) {
    const result = {
        error: null,
        text: '',
        think: '',
        toolCalls: null,
        done: false,
        doneReason: null,
        metrics: null,
    };

    if (!parsed || typeof parsed !== 'object') {
        return result;
    }

    if (parsed.error) {
        result.error =
            typeof parsed.error === 'string'
                ? parsed.error
                : parsed.error.message || 'Unknown Ollama error';
        return result;
    }

    if (parsed.message && typeof parsed.message === 'object') {
        if (typeof parsed.message.content === 'string' && parsed.message.content) {
            result.text = parsed.message.content;
        }
        // Ollama returns the thinking trace in `message.thinking` (canonical
        // field name). Older or alternative model runners may use `message.reasoning`.
        const thinkText = parsed.message.thinking || parsed.message.reasoning;
        if (typeof thinkText === 'string' && thinkText) {
            result.think = thinkText;
        }
        if (Array.isArray(parsed.message.tool_calls) && parsed.message.tool_calls.length > 0) {
            result.toolCalls = parsed.message.tool_calls;
        }
    }

    if (parsed.done === true) {
        result.done = true;
        result.doneReason =
            typeof parsed.done_reason === 'string' && parsed.done_reason
                ? parsed.done_reason
                : null;
        result.metrics = extractOllamaMetrics(parsed);
    }

    return result;
}

/**
 * Interpret one parsed OpenAI-compatible stream frame (OpenAI, Unsloth,
 * DeepSeek). `think` is only meaningful for DeepSeek — callers for the other
 * providers ignore it (matching the original per-provider branches).
 *
 * @returns {{ error: string|null, finishReason: string|null, serverToolResult: string|null,
 *             text: string, think: string, toolCallFragments: object[]|null, usage: object|null }}
 */
export function parseOpenAiCompatChunk(parsed) {
    const result = {
        error: null,
        finishReason: null,
        serverToolResult: null,
        text: '',
        think: '',
        toolCallFragments: null,
        usage: null,
    };

    if (!parsed || typeof parsed !== 'object') {
        return result;
    }

    if (parsed.error) {
        result.error =
            typeof parsed.error === 'string'
                ? parsed.error
                : parsed.error.message || 'Provider stream error';
        return result;
    }

    if (parsed.type === 'tool_result') {
        let toolContent = 'No output.';
        if (typeof parsed.content === 'string' && parsed.content) {
            toolContent = parsed.content;
        } else if (parsed.content !== undefined && parsed.content !== null) {
            try {
                toolContent = JSON.stringify(parsed.content, null, 2);
            } catch (_e) {
                toolContent = String(parsed.content);
            }
        }
        const toolName = parsed.tool_use_id || 'Tool';
        result.serverToolResult = `\n\n> **Server-side tool executed (${toolName})**:\n> \`\`\`\n> ${toolContent.split('\n').join('\n> ')}\n> \`\`\`\n\n`;
    } else if (Array.isArray(parsed.choices) && parsed.choices.length > 0) {
        const choice = parsed.choices[0];
        if (typeof choice?.finish_reason === 'string' && choice.finish_reason) {
            result.finishReason = choice.finish_reason;
        }
        const delta = choice?.delta;
        if (delta && typeof delta === 'object') {
            // reasoning_content arrives before content during thinking
            if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
                result.think = delta.reasoning_content;
            }
            if (typeof delta.content === 'string' && delta.content) {
                result.text = delta.content;
            }
            // OpenAI-compatible providers stream tool-call fragments by index.
            if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
                result.toolCallFragments = delta.tool_calls;
            }
        }
    }

    if (parsed.usage && typeof parsed.usage === 'object') {
        result.usage = parsed.usage;
    }

    return result;
}

function finalizeAnthropicToolBlock(toolBlock) {
    let toolInput = {};
    let invalidJson = false;
    const rawJson = toolBlock.argsJson || '';

    if (rawJson.trim()) {
        try {
            const parsedInput = JSON.parse(rawJson);
            if (parsedInput && typeof parsedInput === 'object' && !Array.isArray(parsedInput)) {
                toolInput = parsedInput;
            } else {
                invalidJson = true;
            }
        } catch (_e) {
            invalidJson = true;
        }
    } else if (
        toolBlock.initialInput &&
        typeof toolBlock.initialInput === 'object' &&
        !Array.isArray(toolBlock.initialInput)
    ) {
        toolInput = toolBlock.initialInput;
    }

    const completed = {
        id: toolBlock.id,
        type: 'function',
        function: { name: toolBlock.name, arguments: JSON.stringify(toolInput) },
    };
    if (invalidJson) {
        Object.defineProperty(completed, '_invalidJson', {
            value: true,
            enumerable: false,
            configurable: true,
        });
        Object.defineProperty(completed, '_rawArguments', {
            value: rawJson,
            enumerable: false,
            configurable: true,
        });
    }
    return completed;
}

/**
 * Flush any unclosed Anthropic tool_use blocks remaining in `toolUseMap` if the
 * stream reaches EOF before receiving `content_block_stop`.
 * @param {Map<number, Object>} toolUseMap
 * @returns {Object[]}
 */
export function flushPendingAnthropicToolCalls(toolUseMap) {
    if (!(toolUseMap instanceof Map) || toolUseMap.size === 0) {
        return [];
    }
    const entries = [...toolUseMap.entries()].sort((a, b) => a[0] - b[0]);
    toolUseMap.clear();
    return entries.map(([, block]) => finalizeAnthropicToolBlock(block));
}

/**
 * Interpret one parsed Anthropic SSE frame. Tool-use state is tracked in the
 * caller-supplied `toolUseMap` (index → { id, name, argsJson, initialInput }).
 *
 * @returns {{ error: string|null, text: string, think: string, stopReason: string|null,
 *             promptTokens: number|null, outputTokens: number|null,
 *             completedToolCall: object|null }}
 */
export function parseAnthropicChunk(parsed, toolUseMap) {
    const result = {
        error: null,
        text: '',
        think: '',
        stopReason: null,
        promptTokens: null,
        outputTokens: null,
        completedToolCall: null,
    };

    if (!parsed || typeof parsed !== 'object') {
        return result;
    }

    if (parsed.type === 'error') {
        result.error =
            typeof parsed.error === 'string'
                ? parsed.error
                : parsed.error?.message || 'Anthropic stream error';
        return result;
    }

    if (parsed.type === 'content_block_start' && parsed.content_block?.type === 'tool_use') {
        const initialInput =
            parsed.content_block.input &&
            typeof parsed.content_block.input === 'object' &&
            !Array.isArray(parsed.content_block.input) &&
            Object.keys(parsed.content_block.input).length > 0
                ? parsed.content_block.input
                : null;
        toolUseMap.set(parsed.index, {
            id: parsed.content_block.id,
            name: parsed.content_block.name,
            argsJson: '',
            initialInput,
        });
    } else if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'input_json_delta') {
        const toolBlock = toolUseMap.get(parsed.index);
        if (toolBlock) {
            toolBlock.argsJson += parsed.delta.partial_json || '';
        }
    } else if (
        parsed.type === 'content_block_delta' &&
        parsed.delta?.type === 'thinking_delta' &&
        typeof parsed.delta.thinking === 'string'
    ) {
        result.think = parsed.delta.thinking;
    } else if (parsed.type === 'content_block_delta' && parsed.delta && parsed.delta.text) {
        result.text = parsed.delta.text;
    } else if (parsed.type === 'content_block_stop') {
        const toolBlock = toolUseMap.get(parsed.index);
        if (toolBlock) {
            toolUseMap.delete(parsed.index);
            result.completedToolCall = finalizeAnthropicToolBlock(toolBlock);
        }
    } else if (parsed.type === 'message_start' && parsed.message?.usage) {
        // Anthropic reports prompt tokens up front on message_start (including
        // prompt-cache creation/read tokens when present).
        const u = parsed.message.usage;
        result.promptTokens =
            (Number(u.input_tokens) || 0) +
            (Number(u.cache_creation_input_tokens) || 0) +
            (Number(u.cache_read_input_tokens) || 0);
    } else if (parsed.type === 'message_delta') {
        if (typeof parsed.delta?.stop_reason === 'string' && parsed.delta.stop_reason) {
            result.stopReason = parsed.delta.stop_reason;
        }
        if (parsed.usage?.output_tokens !== undefined) {
            // message_delta carries the cumulative output token count.
            result.outputTokens = Number(parsed.usage.output_tokens) || 0;
        }
    }

    return result;
}

/**
 * Merge OpenAI-style streaming tool-call fragments into the response state's
 * accumulated tool calls (index-based assembly). Mutates `responseState`
 * (`_toolCallsByIndex`, `accumulatedToolCalls`).
 *
 * Also handles OpenAI-compatible proxies/runners that omit `tc.index` (matching
 * by `tc.id`, or appending nameless continuation fragments to the latest entry),
 * incremental `function.name` deltas, and object-valued `function.arguments`.
 */
export function accumulateStreamingToolCalls(responseState, deltaToolCalls) {
    if (!Array.isArray(deltaToolCalls)) {
        return;
    }
    if (!responseState._toolCallsByIndex) {
        responseState._toolCallsByIndex = new Map();
    }

    const map = responseState._toolCallsByIndex;

    for (const tc of deltaToolCalls) {
        if (!tc || typeof tc !== 'object') {
            continue;
        }

        let index;
        if (Number.isInteger(tc.index) && tc.index >= 0) {
            index = tc.index;
        } else if (tc.id) {
            let foundIdx = -1;
            for (const [k, existing] of map.entries()) {
                if (existing.id && existing.id === tc.id) {
                    foundIdx = k;
                    break;
                }
            }
            index = foundIdx >= 0 ? foundIdx : map.size;
        } else if (!tc.function?.name && map.size > 0) {
            // Unindexed argument continuation fragment — append to the most
            // recently started tool call instead of shattering it into N calls.
            index = Math.max(...map.keys());
        } else {
            index = map.size;
        }

        let entry = map.get(index);
        if (!entry) {
            entry = { id: '', type: 'function', function: { name: '', arguments: '' } };
            map.set(index, entry);
        }
        if (tc.id) {
            entry.id = tc.id;
        }
        if (tc.type) {
            entry.type = tc.type;
        }
        if (tc.function && typeof tc.function === 'object') {
            if (typeof tc.function.name === 'string' && tc.function.name) {
                if (!entry.function.name) {
                    entry.function.name = tc.function.name;
                } else if (tc.function.name !== entry.function.name) {
                    entry.function.name += tc.function.name;
                }
            }
            if (tc.function.arguments !== undefined && tc.function.arguments !== null) {
                if (typeof tc.function.arguments === 'string') {
                    entry.function.arguments += tc.function.arguments;
                } else if (typeof tc.function.arguments === 'object') {
                    try {
                        entry.function.arguments = JSON.stringify(tc.function.arguments);
                    } catch (_e) {
                        /* ignore non-serializable object */
                    }
                }
            }
        }
    }

    responseState.accumulatedToolCalls = [...map.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, value]) => value);
}

/**
 * Extract Ollama final-metrics from a `done: true` frame. Returns null when
 * none of the numeric fields carry a finite number.
 */
export function extractOllamaMetrics(payload) {
    if (!payload || typeof payload !== 'object') {
        return null;
    }
    const metrics = {
        total_duration: numberOrNull(payload.total_duration),
        load_duration: numberOrNull(payload.load_duration),
        prompt_eval_count: numberOrNull(payload.prompt_eval_count),
        prompt_eval_duration: numberOrNull(payload.prompt_eval_duration),
        eval_count: numberOrNull(payload.eval_count),
        eval_duration: numberOrNull(payload.eval_duration),
    };

    const hasNumericMetric = Object.values(metrics).some((value) => value !== null);
    if (!hasNumericMetric) {
        return null;
    }
    if (typeof payload.done_reason === 'string' && payload.done_reason) {
        metrics.done_reason = payload.done_reason;
    }
    return metrics;
}

/**
 * Extract DeepSeek usage metrics from a stream usage chunk. Returns null when
 * the chunk is missing or carries no finite numbers.
 */
export function extractDeepSeekMetrics(usageChunk) {
    if (!usageChunk || typeof usageChunk !== 'object') {
        return null;
    }

    const metrics = {
        prompt_tokens: numberOrNull(usageChunk.prompt_tokens),
        completion_tokens: numberOrNull(usageChunk.completion_tokens),
        total_tokens: numberOrNull(usageChunk.total_tokens),
        reasoning_tokens: numberOrNull(
            usageChunk.completion_tokens_details?.reasoning_tokens ?? null,
        ),
        cached_tokens_hit: numberOrNull(usageChunk.prompt_cache_hit_tokens ?? null),
        cached_tokens_miss: numberOrNull(usageChunk.prompt_cache_miss_tokens ?? null),
    };

    return Object.values(metrics).some((value) => value !== null) ? metrics : null;
}
