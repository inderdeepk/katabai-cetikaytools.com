// streamParse.test.js — Tests for the per-provider SSE chunk interpreters.
import {
    splitThinkingTags,
    parseOllamaChunk,
    parseOpenAiCompatChunk,
    parseAnthropicChunk,
    accumulateStreamingToolCalls,
    extractOllamaMetrics,
    extractDeepSeekMetrics,
} from '../src/providers/streamParse.js';
import { assert, assertEqual, runTests } from './testUtils.js';

const tests = [
    ['splitThinkingTags: plain text passes through untouched', () => {
        const split = splitThinkingTags('hello world', false);
        assertEqual(split.text, 'hello world', 'text');
        assertEqual(split.think, '', 'no think');
        assertEqual(split.isThinking, false, 'state unchanged');
        assertEqual(split.openedThinking, false, 'no open tag');
    }],

    ['splitThinkingTags: <thinking>…</thinking> splits think from text', () => {
        const split = splitThinkingTags('<thinking>deep thought</thinking>answer', false);
        assertEqual(split.think, 'deep thought', 'think content');
        assertEqual(split.text, 'answer', 'text content');
        assertEqual(split.isThinking, false, 'closed');
        assert(split.openedThinking, 'open tag seen');
    }],

    ['splitThinkingTags: short <think>…</think> pair works', () => {
        const split = splitThinkingTags('<think>short</think>done', false);
        assertEqual(split.think, 'short', 'think content');
        assertEqual(split.text, 'done', 'text content');
    }],

    ['splitThinkingTags: state carries across deltas', () => {
        const first = splitThinkingTags('pre<think>abc', false);
        assertEqual(first.text, 'pre', 'text before tag');
        assertEqual(first.think, 'abc', 'think inside');
        assertEqual(first.isThinking, true, 'still inside');
        const second = splitThinkingTags('def</think>ghi', first.isThinking);
        assertEqual(second.think, 'def', 'think continued');
        assertEqual(second.text, 'ghi', 'text after close');
        assertEqual(second.isThinking, false, 'closed');
        assertEqual(second.openedThinking, false, 'no new open tag');
    }],

    ['splitThinkingTags: unclosed think keeps collecting', () => {
        const first = splitThinkingTags('<thinking>abc', false);
        assertEqual(first.think, 'abc', 'collected');
        assertEqual(first.isThinking, true, 'open');
        const second = splitThinkingTags('more', true);
        assertEqual(second.think, 'more', 'continued');
        assertEqual(second.text, '', 'no text consumed');
    }],

    ['splitThinkingTags: near-miss tags are not treated as thinking', () => {
        const split = splitThinkingTags('a <thinkerb case', false);
        assertEqual(split.text, 'a <thinkerb case', 'unchanged');
        assertEqual(split.think, '', 'no think');
        assertEqual(split.openedThinking, false, 'no tag');
    }],

    ['parseOllamaChunk: content/thinking/reasoning/tool_calls extraction', () => {
        const chunk = parseOllamaChunk({ message: { content: 'hi', thinking: 'hmm' } });
        assertEqual(chunk.text, 'hi', 'content');
        assertEqual(chunk.think, 'hmm', 'thinking');
        assertEqual(chunk.done, false, 'not done');

        const alias = parseOllamaChunk({ message: { reasoning: 'why' } });
        assertEqual(alias.think, 'why', 'reasoning alias');

        const toolCalls = [{ function: { name: 'web_search' } }];
        const withTools = parseOllamaChunk({ message: { tool_calls: toolCalls } });
        assertEqual(withTools.toolCalls, toolCalls, 'tool calls passed through');
    }],

    ['parseOllamaChunk: done frame carries metrics', () => {
        const chunk = parseOllamaChunk({ done: true, eval_count: 10, prompt_eval_count: 5, eval_duration: 1000 });
        assertEqual(chunk.done, true, 'done');
        assertEqual(chunk.metrics.eval_count, 10, 'eval count');
        assertEqual(chunk.metrics.prompt_eval_count, 5, 'prompt eval count');

        const empty = parseOllamaChunk({ done: true });
        assertEqual(empty.done, true, 'done without metrics');
        assertEqual(empty.metrics, null, 'metrics null when no numbers');
    }],

    ['parseOllamaChunk: error frames bail before anything else', () => {
        const strErr = parseOllamaChunk({ error: 'context overflow', message: { content: 'x' }, done: true });
        assertEqual(strErr.error, 'context overflow', 'string error');
        assertEqual(strErr.text, '', 'message ignored');
        assertEqual(strErr.done, false, 'done ignored');

        const objErr = parseOllamaChunk({ error: { message: 'boom' } });
        assertEqual(objErr.error, 'boom', 'object error message');
        const unknown = parseOllamaChunk({ error: {} });
        assertEqual(unknown.error, 'Unknown Ollama error', 'fallback message');
    }],

    ['extractOllamaMetrics: numbers kept, non-numbers nulled, empty → null', () => {
        const metrics = extractOllamaMetrics({ total_duration: 5, eval_count: 3, load_duration: 'x' });
        assertEqual(metrics.total_duration, 5, 'number kept');
        assertEqual(metrics.eval_count, 3, 'number kept');
        assertEqual(metrics.load_duration, null, 'string nulled');
        assertEqual(metrics.eval_duration, null, 'missing nulled');
        assertEqual(extractOllamaMetrics({}), null, 'all-null → null');
    }],

    ['extractDeepSeekMetrics: full usage mapping', () => {
        const metrics = extractDeepSeekMetrics({
            prompt_tokens: 100,
            completion_tokens: 50,
            total_tokens: 150,
            completion_tokens_details: { reasoning_tokens: 20 },
            prompt_cache_hit_tokens: 30,
            prompt_cache_miss_tokens: 70,
        });
        assertEqual(metrics.prompt_tokens, 100, 'prompt');
        assertEqual(metrics.completion_tokens, 50, 'completion');
        assertEqual(metrics.total_tokens, 150, 'total');
        assertEqual(metrics.reasoning_tokens, 20, 'reasoning');
        assertEqual(metrics.cached_tokens_hit, 30, 'cache hit');
        assertEqual(metrics.cached_tokens_miss, 70, 'cache miss');
        assertEqual(extractDeepSeekMetrics(null), null, 'null → null');
        assertEqual(extractDeepSeekMetrics({ prompt_tokens: 'x' }), null, 'non-numbers → null');
    }],

    ['accumulateStreamingToolCalls: fragments merge by index', () => {
        const state = { accumulatedToolCalls: [] };
        accumulateStreamingToolCalls(state, [
            { index: 0, id: 'call_1', type: 'function', function: { name: 'web_search', arguments: '{"q"' } },
        ]);
        accumulateStreamingToolCalls(state, [
            { index: 0, function: { arguments: ':"cats"}' } },
        ]);
        assertEqual(state.accumulatedToolCalls.length, 1, 'single merged call');
        assertEqual(state.accumulatedToolCalls[0].id, 'call_1', 'id');
        assertEqual(state.accumulatedToolCalls[0].function.name, 'web_search', 'name');
        assertEqual(state.accumulatedToolCalls[0].function.arguments, '{"q":"cats"}', 'arguments concatenated');
    }],

    ['accumulateStreamingToolCalls: out-of-order indices sort ascending', () => {
        const state = { accumulatedToolCalls: [] };
        accumulateStreamingToolCalls(state, [{ index: 1, id: 'b', function: { name: 'second' } }]);
        accumulateStreamingToolCalls(state, [{ index: 0, id: 'a', function: { name: 'first' } }]);
        assertEqual(state.accumulatedToolCalls.map(tc => tc.id).join(','), 'a,b', 'sorted by index');
    }],

    ['accumulateStreamingToolCalls: missing index falls back to insertion order', () => {
        const state = { accumulatedToolCalls: [] };
        accumulateStreamingToolCalls(state, [{ id: 'x', function: { name: 'n' } }]);
        assertEqual(state.accumulatedToolCalls.length, 1, 'stored');
    }],

    ['accumulateStreamingToolCalls: non-array input is a no-op', () => {
        const state = { accumulatedToolCalls: [] };
        accumulateStreamingToolCalls(state, null);
        assertEqual(state.accumulatedToolCalls.length, 0, 'unchanged');
    }],

    ['parseOpenAiCompatChunk: delta content, reasoning, tool fragments, usage', () => {
        const chunk = parseOpenAiCompatChunk({
            choices: [{ delta: { content: 'hi', reasoning_content: 'why', tool_calls: [{ index: 0 }] } }],
            usage: { prompt_tokens: 1 },
        });
        assertEqual(chunk.text, 'hi', 'content');
        assertEqual(chunk.think, 'why', 'reasoning');
        assertEqual(chunk.toolCallFragments.length, 1, 'fragments');
        assertEqual(chunk.usage.prompt_tokens, 1, 'usage');
    }],

    ['parseOpenAiCompatChunk: tool_result renders the server-side block', () => {
        const chunk = parseOpenAiCompatChunk({ type: 'tool_result', tool_use_id: 'python', content: 'a\nb' });
        assert(chunk.serverToolResult.includes('Server-side tool executed (python)'), 'names the tool');
        assert(chunk.serverToolResult.includes('> a\n> b'), 'quotes each line');
        assertEqual(chunk.text, '', 'no text delta');
    }],

    ['parseAnthropicChunk: tool-use lifecycle assembles arguments', () => {
        const map = new Map();
        const start = parseAnthropicChunk({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_1', name: 'web_search' } }, map);
        assertEqual(start.completedToolCall, null, 'nothing completed yet');
        assertEqual(map.get(0).name, 'web_search', 'tracked');

        parseAnthropicChunk({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"q":' } }, map);
        parseAnthropicChunk({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"cats"}' } }, map);

        const stop = parseAnthropicChunk({ type: 'content_block_stop', index: 0 }, map);
        assertEqual(stop.completedToolCall.id, 'tu_1', 'id');
        assertEqual(stop.completedToolCall.function.name, 'web_search', 'name');
        assertEqual(JSON.parse(stop.completedToolCall.function.arguments).q, 'cats', 'arguments parsed and re-serialized');
    }],

    ['parseAnthropicChunk: invalid tool JSON falls back to empty args', () => {
        const map = new Map();
        parseAnthropicChunk({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'x', name: 'n' } }, map);
        parseAnthropicChunk({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'not-json' } }, map);
        const stop = parseAnthropicChunk({ type: 'content_block_stop', index: 0 }, map);
        assertEqual(stop.completedToolCall.function.arguments, '{}', 'empty object');
    }],

    ['parseAnthropicChunk: text deltas and usage events', () => {
        const map = new Map();
        const text = parseAnthropicChunk({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } }, map);
        assertEqual(text.text, 'hello', 'text');

        const started = parseAnthropicChunk({ type: 'message_start', message: { usage: { input_tokens: 12 } } }, map);
        assertEqual(started.promptTokens, 12, 'prompt tokens');

        const delta = parseAnthropicChunk({ type: 'message_delta', usage: { output_tokens: 34 } }, map);
        assertEqual(delta.outputTokens, 34, 'output tokens');

        const other = parseAnthropicChunk({ type: 'ping' }, map);
        assertEqual(other.text, '', 'unrelated frame inert');
        assertEqual(other.promptTokens, null, 'no prompt tokens');
        assertEqual(other.completedToolCall, null, 'no tool call');
    }],
];

await runTests(tests);
