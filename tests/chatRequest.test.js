// chatRequest.test.js — Tests for the streaming request dialect helpers.
import {
    buildOllamaOptions,
    normalizeOllamaKeepAlive,
    buildOpenAiCompatStreamRequest,
    buildAnthropicStreamRequest,
    buildDeepSeekStreamRequest,
} from '../src/providers/chatRequest.js';
// Side-effect import: registers all tool definitions so buildToolSchemasFor
// resolves real schemas (extension.js imports it the same way).
import {
    WEB_SEARCH_TOOL_NAME,
    READ_URL_TOOL_NAME,
    CRAWL4AI_TOOL_NAME,
    EXPLORE_DOCS_TOOL_NAME,
    UPDATE_KNOWLEDGE_TOOL_NAME,
    FORGET_KNOWLEDGE_TOOL_NAME,
} from '../src/tools/toolDefinitions.js';
import { RAG_TOOL_NAME } from '../src/tools/ragTools.js';
import { assert, assertEqual, runTests } from './testUtils.js';

const NAMES = {
    webSearch: [WEB_SEARCH_TOOL_NAME, READ_URL_TOOL_NAME],
    crawl: [CRAWL4AI_TOOL_NAME],
    exploreDocs: [EXPLORE_DOCS_TOOL_NAME],
    rag: [RAG_TOOL_NAME, UPDATE_KNOWLEDGE_TOOL_NAME, FORGET_KNOWLEDGE_TOOL_NAME],
};

const toolNameOf = (tool) => tool.function?.name ?? tool.name;

function makeGetOpt(values = {}) {
    return (prop, _type) => (prop in values ? values[prop] : null);
}

const tests = [
    ['ollama options: builds the full sampling/context set', () => {
        const options = buildOllamaOptions(makeGetOpt({
            'temperature': 0.7,
            'num-ctx': 8192,
            'num-predict': -1,
            'num-keep': 0,
            'use-mmap': true,
            'use-mlock': false,
            'num-gpu': -1,
            'num-thread': 4,
            'top-k': 40,
            'top-p': 0.9,
            'min-p': 0.05,
            'tfs-z': 1.0,
            'mirostat': 0,
            'mirostat-tau': 5.0,
            'mirostat-eta': 0.1,
            'repeat-last-n': 64,
            'repeat-penalty': 1.1,
            'presence-penalty': 0.0,
            'frequency-penalty': 0.0,
        }));
        assertEqual(Object.keys(options).length, 19, 'all 19 keys present');
        assertEqual(options.temperature, 0.7, 'temperature');
        assertEqual(options.num_ctx, 8192, 'num_ctx');
        assertEqual(options.use_mmap, true, 'use_mmap');
        assertEqual(options.repeat_last_n, 64, 'repeat_last_n unchanged');
    }],

    ['ollama options: null/undefined entries are pruned', () => {
        const options = buildOllamaOptions(makeGetOpt({ 'temperature': 0.5 }));
        assertEqual(Object.keys(options).join(','), 'temperature', 'only set keys remain');
        assert(!('num_ctx' in options), 'unset key removed');
    }],

    ['ollama options: repeat_last_n = -1 translates to num_ctx', () => {
        const options = buildOllamaOptions(makeGetOpt({
            'repeat-last-n': -1,
            'num-ctx': 4096,
        }));
        assertEqual(options.repeat_last_n, 4096, 'translated to num_ctx');
    }],

    ['ollama options: repeat_last_n = -1 falls back to 64 without a usable num_ctx', () => {
        assertEqual(buildOllamaOptions(makeGetOpt({ 'repeat-last-n': -1 })).repeat_last_n, 64, 'no num_ctx');
        assertEqual(buildOllamaOptions(makeGetOpt({ 'repeat-last-n': -1, 'num-ctx': 0 })).repeat_last_n, 64, 'zero num_ctx');
    }],

    ['ollama options: non-negative repeat_last_n preserved (including 0)', () => {
        assertEqual(buildOllamaOptions(makeGetOpt({ 'repeat-last-n': 0, 'num-ctx': 4096 })).repeat_last_n, 0, 'zero kept');
        assertEqual(buildOllamaOptions(makeGetOpt({ 'repeat-last-n': 128 })).repeat_last_n, 128, 'value kept');
    }],

    ['keep_alive: empty and -1 map to the indefinite duration, others pass through', () => {
        assertEqual(normalizeOllamaKeepAlive(''), '999999h', 'empty → indefinite');
        assertEqual(normalizeOllamaKeepAlive('-1'), '999999h', '-1 → indefinite');
        assertEqual(normalizeOllamaKeepAlive(null), '999999h', 'null → indefinite');
        assertEqual(normalizeOllamaKeepAlive('5m'), '5m', 'duration kept');
        assertEqual(normalizeOllamaKeepAlive('999999h'), '999999h', 'indefinite kept');
    }],

    ['openai: endpoint, auth headers, stream_options', () => {
        const built = buildOpenAiCompatStreamRequest({
            provider: 'openai',
            baseUrl: 'https://api.openai.com/v1',
            apiKey: 'sk-test',
            model: 'gpt-4o',
            messages: [{ role: 'user', content: 'hi' }],
        });
        assertEqual(built.endpoint, 'https://api.openai.com/v1/chat/completions', 'endpoint suffix');
        assertEqual(built.headers['Authorization'], 'Bearer sk-test', 'bearer auth');
        assertEqual(built.headers['Content-Type'], 'application/json', 'content type');
        assertEqual(built.payload.model, 'gpt-4o', 'model');
        assertEqual(built.payload.stream, true, 'stream');
        assertEqual(built.payload.stream_options.include_usage, true, 'usage chunk');
        assertEqual(built.payload.messages.length, 1, 'messages passed through');
        assert(!('tools' in built.payload), 'no tools when nothing advertised');
    }],

    ['openai: tools gate per family and omit the disabled ones', () => {
        const built = buildOpenAiCompatStreamRequest({
            provider: 'openai',
            baseUrl: 'http://localhost:1234/v1',
            model: 'm',
            messages: [],
            advertise: { crawl: true, exploreDocs: true, rag: true, webSearch: false },
            toolNames: NAMES,
        });
        const names = built.payload.tools.map(toolNameOf);
        assert(!names.includes(WEB_SEARCH_TOOL_NAME), 'web search not advertised');
        assert(names.includes(CRAWL4AI_TOOL_NAME), 'crawl advertised');
        assert(names.includes(EXPLORE_DOCS_TOOL_NAME), 'explore docs advertised');
        assert(names.includes(RAG_TOOL_NAME), 'rag advertised');
        assert(!('Authorization' in built.headers), 'no auth header without a key');
    }],

    ['unsloth: server-side tools, session id, forced tool_choice', () => {
        const built = buildOpenAiCompatStreamRequest({
            provider: 'unsloth',
            baseUrl: 'http://localhost:8888/v1',
            model: 'default',
            messages: [],
            forcedTool: WEB_SEARCH_TOOL_NAME,
            conversationId: 'conv_42',
            unslothEnableWebSearch: true,
        });
        assertEqual(built.payload.enable_tools, true, 'server-side tools enabled');
        assertEqual(built.payload.enabled_tools.join(','), 'web_search,python,terminal', 'web search first');
        assertEqual(built.payload.session_id, 'conv_42', 'session id from conversation');
        assertEqual(built.payload.tool_choice.function.name, WEB_SEARCH_TOOL_NAME, 'forced tool choice');
        assert(!('stream_options' in built.payload), 'unsloth has no usage chunk flag');

        const fallback = buildOpenAiCompatStreamRequest({
            provider: 'unsloth',
            baseUrl: 'http://localhost:8888/v1',
            model: 'default',
            messages: [],
            unslothEnableWebSearch: false,
        });
        assertEqual(fallback.payload.enabled_tools.join(','), 'python,terminal', 'web search left out');
        assert(/^session_\d+$/.test(fallback.payload.session_id), 'generated session id');
    }],

    ['anthropic: endpoint, headers, hoisted system prompt, filtered messages', () => {
        const built = buildAnthropicStreamRequest({
            baseUrl: 'https://api.anthropic.com',
            apiKey: 'ak-test',
            model: 'claude-3-5-sonnet-20241022',
            messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }],
            systemPrompt: 'merged system text',
            advertise: { webSearch: true },
            toolNames: NAMES,
        });
        assertEqual(built.endpoint, 'https://api.anthropic.com/v1/messages', 'endpoint suffix');
        assertEqual(built.headers['x-api-key'], 'ak-test', 'api key header');
        assertEqual(built.headers['anthropic-version'], '2023-06-01', 'version header');
        assertEqual(built.headers['Authorization'], 'Bearer ak-test', 'bearer auth kept');
        assertEqual(built.payload.max_tokens, 4096, 'max tokens');
        assertEqual(built.payload.system, 'merged system text', 'system hoisted');
        assertEqual(built.payload.messages.length, 1, 'system message filtered');
        assertEqual(built.payload.messages[0].role, 'user', 'user message kept');
        assertEqual(built.payload.tools.length, 2, 'web search + read page');
        assert(!('function' in built.payload.tools[0]), 'anthropic schema shape');
        assert(typeof built.payload.tools[0].input_schema === 'object', 'input_schema present');

        const noSystem = buildAnthropicStreamRequest({
            baseUrl: 'https://api.anthropic.com',
            model: 'm',
            messages: [{ role: 'user', content: 'hi' }],
        });
        assert(!('system' in noSystem.payload), 'no system field when prompt is empty');
    }],

    ['deepseek: payload shape, thinking, reasoning backfill', () => {
        const messages = [
            { role: 'assistant', content: 'ok' },
            { role: 'user', content: 'go' },
        ];
        const built = buildDeepSeekStreamRequest({
            baseUrl: 'https://api.deepseek.com',
            apiKey: 'dk',
            model: 'deepseek-flash',
            messages,
            thinking: true,
            reasoningEffort: 'high',
            maxTokens: 384000,
            userId: 'katab-tester',
        });
        assertEqual(built.endpoint, 'https://api.deepseek.com/chat/completions', 'endpoint suffix');
        assertEqual(built.headers['Authorization'], 'Bearer dk', 'bearer auth');
        assertEqual(built.payload.max_tokens, 384000, 'output cap');
        assertEqual(built.payload.thinking.type, 'enabled', 'thinking on');
        assertEqual(built.payload.reasoning_effort, 'high', 'reasoning effort when thinking');
        assertEqual(built.payload.user_id, 'katab-tester', 'user id');
        assertEqual(built.payload.stream_options.include_usage, true, 'usage chunk');
        assertEqual(messages[0].reasoning_content, '', 'assistant reasoning_content backfilled');

        const off = buildDeepSeekStreamRequest({
            baseUrl: 'https://api.deepseek.com',
            model: 'm',
            messages: [],
            thinking: false,
            maxTokens: 1,
        });
        assertEqual(off.payload.thinking.type, 'disabled', 'thinking off');
        assert(!('reasoning_effort' in off.payload), 'no reasoning effort when thinking off');
    }],

    ['deepseek: JSON mode injects the guard only when needed', () => {
        const base = { baseUrl: 'https://api.deepseek.com', model: 'm', jsonMode: true, maxTokens: 1 };
        const appended = buildDeepSeekStreamRequest({
            ...base,
            messages: [{ role: 'system', content: 'You are helpful.' }, { role: 'user', content: 'q' }],
        });
        assertEqual(appended.payload.response_format.type, 'json_object', 'response_format set');
        assert(appended.payload.messages[0].content.includes('valid JSON object'), 'guard appended');

        const kept = buildDeepSeekStreamRequest({
            ...base,
            messages: [{ role: 'system', content: 'Return JSON.' }],
        });
        assertEqual(kept.payload.messages[0].content, 'Return JSON.', 'json-mentioning system untouched');

        const prepended = buildDeepSeekStreamRequest({
            ...base,
            messages: [{ role: 'user', content: 'q' }],
        });
        assertEqual(prepended.payload.messages[0].role, 'system', 'minimal system prepended');
    }],

    ['deepseek: frozen quirks — web-search seeding and JSON/tools exclusivity', () => {
        const built = buildDeepSeekStreamRequest({
            baseUrl: 'https://api.deepseek.com',
            model: 'm',
            maxTokens: 1,
            messages: [],
            advertise: { crawl: true, webSearch: false },
            toolNames: NAMES,
        });
        const names = built.payload.tools.map(toolNameOf);
        // Frozen quirk: the web-search group is seeded whenever tools are
        // enabled, even though the webSearch advertisement flag is false.
        // Recorded as a follow-up — not fixed in this refactor.
        assert(names.includes(WEB_SEARCH_TOOL_NAME), 'web search seeded (quirk)');
        assert(names.includes(READ_URL_TOOL_NAME), 'read_url seeded (quirk)');
        assert(names.includes(CRAWL4AI_TOOL_NAME), 'crawl appended');
        assertEqual(built.payload.tool_choice, 'auto', 'auto tool choice');

        const json = buildDeepSeekStreamRequest({
            baseUrl: 'https://api.deepseek.com',
            model: 'm',
            maxTokens: 1,
            messages: [],
            jsonMode: true,
            advertise: { webSearch: true },
            toolNames: NAMES,
        });
        assert(!('tools' in json.payload), 'tools suppressed in JSON mode');
        assert(!('tool_choice' in json.payload), 'no tool_choice in JSON mode');
    }],
];

await runTests(tests);
