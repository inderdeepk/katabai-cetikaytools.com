// chatRequest.test.js — Tests for the streaming request dialect helpers.
import {
    buildOllamaOptions,
    normalizeOllamaKeepAlive,
    buildOpenAiCompatStreamRequest,
    buildAnthropicStreamRequest,
    buildDeepSeekStreamRequest,
    buildOllamaStreamRequest,
    buildOllamaPreloadRequest,
    buildOllamaUnloadRequest,
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
    [
        'ollama options: builds modern sampling/context/seed/stop set and omits deprecated/zero-thread keys',
        () => {
            const options = buildOllamaOptions(
                makeGetOpt({
                    temperature: 0.7,
                    'num-ctx': 8192,
                    'num-predict': -1,
                    'num-keep': 0,
                    'use-mmap': true,
                    'num-gpu': -1,
                    'num-thread': 0,
                    'top-k': 40,
                    'top-p': 0.9,
                    'min-p': 0.05,
                    seed: 42,
                    stop: 'END, ###',
                    'repeat-last-n': 64,
                    'repeat-penalty': 1.1,
                    'presence-penalty': 0.0,
                    'frequency-penalty': 0.0,
                }),
            );
            assertEqual(
                Object.keys(options).length,
                15,
                'all 15 active keys present (num_thread=0 omitted)',
            );
            assertEqual(options.temperature, 0.7, 'temperature');
            assertEqual(options.num_ctx, 8192, 'num_ctx');
            assertEqual(options.use_mmap, true, 'use_mmap');
            assertEqual(options.repeat_last_n, 64, 'repeat_last_n unchanged');
            assertEqual(options.seed, 42, 'seed forwarded');
            assertEqual(options.stop.join(','), 'END,###', 'stop sequences parsed');
            assert(!('num_thread' in options), 'num_thread=0 omitted for auto-detect');
            assert(!('mirostat' in options), 'deprecated mirostat removed');
            assert(!('tfs_z' in options), 'deprecated tfs_z removed');
            assert(!('use_mlock' in options), 'deprecated use_mlock removed');

            const defaultsMode = buildOllamaOptions(
                makeGetOpt({
                    temperature: 0.7,
                    'num-ctx': 8192,
                    'top-k': 40,
                    seed: 7,
                }),
                { useModelDefaults: true },
            );
            assertEqual(defaultsMode.num_ctx, 8192, 'num_ctx kept in model defaults mode');
            assertEqual(defaultsMode.seed, 7, 'seed kept in model defaults mode');
            assert(
                !('temperature' in defaultsMode),
                'temperature omitted when useModelDefaults=true',
            );
            assert(!('top_k' in defaultsMode), 'top_k omitted when useModelDefaults=true');

            const runnerOnly = buildOllamaOptions(
                makeGetOpt({
                    temperature: 0.7,
                    'num-ctx': 8192,
                    'num-gpu': -1,
                    'num-thread': 8,
                    seed: 7,
                }),
                { runnerOnly: true },
            );
            assertEqual(runnerOnly.num_ctx, 8192, 'runnerOnly keeps num_ctx');
            assertEqual(runnerOnly.num_thread, 8, 'runnerOnly keeps positive num_thread');
            assert(!('temperature' in runnerOnly), 'runnerOnly omits samplers');
            assert(!('seed' in runnerOnly), 'runnerOnly omits seed');
        },
    ],

    [
        'ollama options: null/undefined entries are pruned',
        () => {
            const options = buildOllamaOptions(makeGetOpt({ temperature: 0.5 }));
            assertEqual(Object.keys(options).join(','), 'temperature', 'only set keys remain');
            assert(!('num_ctx' in options), 'unset key removed');
        },
    ],

    [
        'ollama options: repeat_last_n = -1 translates to num_ctx',
        () => {
            const options = buildOllamaOptions(
                makeGetOpt({
                    'repeat-last-n': -1,
                    'num-ctx': 4096,
                }),
            );
            assertEqual(options.repeat_last_n, 4096, 'translated to num_ctx');
        },
    ],

    [
        'ollama options: repeat_last_n = -1 falls back to 64 without a usable num_ctx',
        () => {
            assertEqual(
                buildOllamaOptions(makeGetOpt({ 'repeat-last-n': -1 })).repeat_last_n,
                64,
                'no num_ctx',
            );
            assertEqual(
                buildOllamaOptions(makeGetOpt({ 'repeat-last-n': -1, 'num-ctx': 0 })).repeat_last_n,
                64,
                'zero num_ctx',
            );
        },
    ],

    [
        'ollama options: non-negative repeat_last_n preserved (including 0)',
        () => {
            assertEqual(
                buildOllamaOptions(makeGetOpt({ 'repeat-last-n': 0, 'num-ctx': 4096 }))
                    .repeat_last_n,
                0,
                'zero kept',
            );
            assertEqual(
                buildOllamaOptions(makeGetOpt({ 'repeat-last-n': 128 })).repeat_last_n,
                128,
                'value kept',
            );
        },
    ],

    [
        'keep_alive: empty and -1 map to the indefinite duration, others pass through',
        () => {
            assertEqual(normalizeOllamaKeepAlive(''), '999999h', 'empty → indefinite');
            assertEqual(normalizeOllamaKeepAlive('-1'), '999999h', '-1 → indefinite');
            assertEqual(normalizeOllamaKeepAlive(null), '999999h', 'null → indefinite');
            assertEqual(normalizeOllamaKeepAlive('5m'), '5m', 'duration kept');
            assertEqual(normalizeOllamaKeepAlive('999999h'), '999999h', 'indefinite kept');
        },
    ],

    [
        'openai: endpoint, auth headers, stream_options',
        () => {
            const built = buildOpenAiCompatStreamRequest({
                provider: 'openai',
                baseUrl: 'https://api.openai.com/v1',
                apiKey: 'sk-test',
                model: 'gpt-4o',
                messages: [{ role: 'user', content: 'hi' }],
            });
            assertEqual(
                built.endpoint,
                'https://api.openai.com/v1/chat/completions',
                'endpoint suffix',
            );
            assertEqual(built.headers['Authorization'], 'Bearer sk-test', 'bearer auth');
            assertEqual(built.headers['Content-Type'], 'application/json', 'content type');
            assertEqual(built.payload.model, 'gpt-4o', 'model');
            assertEqual(built.payload.stream, true, 'stream');
            assertEqual(built.payload.stream_options.include_usage, true, 'usage chunk');
            assertEqual(built.payload.messages.length, 1, 'messages passed through');
            assert(!('tools' in built.payload), 'no tools when nothing advertised');
        },
    ],

    [
        'openai: tools gate per family and omit the disabled ones',
        () => {
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
        },
    ],

    [
        'unsloth: server-side tools, session id, forced tool_choice',
        () => {
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
            assertEqual(
                built.payload.enabled_tools.join(','),
                'web_search,python,terminal',
                'web search first',
            );
            assertEqual(built.payload.session_id, 'conv_42', 'session id from conversation');
            assertEqual(
                built.payload.tool_choice.function.name,
                WEB_SEARCH_TOOL_NAME,
                'forced tool choice',
            );
            assert(!('stream_options' in built.payload), 'unsloth has no usage chunk flag');

            const fallback = buildOpenAiCompatStreamRequest({
                provider: 'unsloth',
                baseUrl: 'http://localhost:8888/v1',
                model: 'default',
                messages: [],
                unslothEnableWebSearch: false,
            });
            assertEqual(
                fallback.payload.enabled_tools.join(','),
                'python,terminal',
                'web search left out',
            );
            assert(/^session_\d+$/.test(fallback.payload.session_id), 'generated session id');
        },
    ],

    [
        'anthropic: endpoint, headers, hoisted system prompt, filtered messages',
        () => {
            const built = buildAnthropicStreamRequest({
                baseUrl: 'https://api.anthropic.com',
                apiKey: 'ak-test',
                model: 'claude-3-5-sonnet-20241022',
                messages: [
                    { role: 'system', content: 'sys' },
                    { role: 'user', content: 'hi' },
                ],
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
        },
    ],

    [
        'deepseek: payload shape, thinking, reasoning backfill',
        () => {
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
            assertEqual(
                built.endpoint,
                'https://api.deepseek.com/chat/completions',
                'endpoint suffix',
            );
            assertEqual(built.headers['Authorization'], 'Bearer dk', 'bearer auth');
            assertEqual(built.payload.max_tokens, 384000, 'output cap');
            assertEqual(built.payload.thinking.type, 'enabled', 'thinking on');
            assertEqual(built.payload.reasoning_effort, 'high', 'reasoning effort when thinking');
            assertEqual(built.payload.user_id, 'katab-tester', 'user id');
            assertEqual(built.payload.stream_options.include_usage, true, 'usage chunk');
            assertEqual(
                built.payload.messages[0].reasoning_content,
                '',
                'assistant reasoning_content backfilled in payload',
            );
            assertEqual(
                messages[0].reasoning_content,
                undefined,
                'caller messages array not mutated in place',
            );

            const off = buildDeepSeekStreamRequest({
                baseUrl: 'https://api.deepseek.com',
                model: 'm',
                messages: [],
                thinking: false,
                maxTokens: 1,
            });
            assertEqual(off.payload.thinking.type, 'disabled', 'thinking off');
            assert(!('reasoning_effort' in off.payload), 'no reasoning effort when thinking off');
        },
    ],

    [
        'deepseek: JSON mode injects the guard only when needed',
        () => {
            const base = {
                baseUrl: 'https://api.deepseek.com',
                model: 'm',
                jsonMode: true,
                maxTokens: 1,
            };
            const appended = buildDeepSeekStreamRequest({
                ...base,
                messages: [
                    { role: 'system', content: 'You are helpful.' },
                    { role: 'user', content: 'q' },
                ],
            });
            assertEqual(
                appended.payload.response_format.type,
                'json_object',
                'response_format set',
            );
            assert(
                appended.payload.messages[0].content.includes('valid JSON object'),
                'guard appended',
            );

            const kept = buildDeepSeekStreamRequest({
                ...base,
                messages: [{ role: 'system', content: 'Return JSON.' }],
            });
            assertEqual(
                kept.payload.messages[0].content,
                'Return JSON.',
                'json-mentioning system untouched',
            );

            const prepended = buildDeepSeekStreamRequest({
                ...base,
                messages: [{ role: 'user', content: 'q' }],
            });
            assertEqual(prepended.payload.messages[0].role, 'system', 'minimal system prepended');
        },
    ],

    [
        'deepseek: tools gate per family and JSON/tools exclusivity hold',
        () => {
            const built = buildDeepSeekStreamRequest({
                baseUrl: 'https://api.deepseek.com',
                model: 'm',
                maxTokens: 1,
                messages: [],
                advertise: { crawl: true, webSearch: false },
                toolNames: NAMES,
            });
            const names = built.payload.tools.map(toolNameOf);
            // Fixed in the review pass: the web-search group is only seeded when
            // the webSearch advertisement flag is set (matches openai/ollama).
            assert(!names.includes(WEB_SEARCH_TOOL_NAME), 'web search not seeded');
            assert(!names.includes(READ_URL_TOOL_NAME), 'read_url not seeded');
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
        },
    ],

    [
        'ollama: endpoint, payload, think omission/levels, structured format, auth',
        () => {
            const built = buildOllamaStreamRequest({
                baseUrl: 'http://localhost:11434',
                model: 'llama3',
                messages: [{ role: 'user', content: 'hi' }],
                options: { temperature: 0.7 },
            });
            assertEqual(built.endpoint, 'http://localhost:11434/api/chat', 'endpoint suffix');
            assertEqual(built.headers['Content-Type'], 'application/json', 'content type');
            assert(!('Authorization' in built.headers), 'no auth for local ollama without key');
            assertEqual(built.payload.model, 'llama3', 'model');
            assertEqual(built.payload.stream, true, 'stream');
            assertEqual(built.payload.keep_alive, '5m', 'default keep alive');
            assert(!('think' in built.payload), 'think omitted when undefined');
            assertEqual(built.payload.options.temperature, 0.7, 'options passed through');
            assert(!('format' in built.payload), 'no format when empty');
            assert(!('raw' in built.payload), 'raw never emitted on /api/chat');

            const withSchemaAndAuth = buildOllamaStreamRequest({
                baseUrl: 'https://ollama.com/api/chat',
                apiKey: 'ol-key',
                model: 'gemma4:31b',
                messages: [],
                keepAlive: '999999h',
                think: 'high',
                format: { type: 'object', properties: { answer: { type: 'string' } } },
            });
            assertEqual(
                withSchemaAndAuth.endpoint,
                'https://ollama.com/api/chat',
                'suffix not doubled',
            );
            assertEqual(withSchemaAndAuth.headers['Authorization'], 'Bearer ol-key', 'bearer auth');
            assertEqual(withSchemaAndAuth.payload.keep_alive, '999999h', 'keep alive override');
            assertEqual(withSchemaAndAuth.payload.think, 'high', 'think level forwarded');
            assertEqual(withSchemaAndAuth.payload.format.type, 'object', 'JSON schema format set');
            assert(!('options' in withSchemaAndAuth.payload), 'empty options omitted');
        },
    ],

    [
        'endpoint normalization: trailing slashes and existing suffixes',
        () => {
            const openai = buildOpenAiCompatStreamRequest({
                provider: 'openai',
                baseUrl: 'https://api.openai.com/v1/chat/completions',
                model: 'm',
                messages: [],
            });
            assertEqual(
                openai.endpoint,
                'https://api.openai.com/v1/chat/completions',
                'openai suffix kept',
            );
            const openaiSlash = buildOpenAiCompatStreamRequest({
                provider: 'openai',
                baseUrl: 'https://api.openai.com/v1/',
                model: 'm',
                messages: [],
            });
            assertEqual(
                openaiSlash.endpoint,
                'https://api.openai.com/v1/chat/completions',
                'openai trailing slash + single suffix',
            );
            const anthropic = buildAnthropicStreamRequest({
                baseUrl: 'https://api.anthropic.com/v1/messages/',
                model: 'm',
                messages: [],
            });
            assertEqual(
                anthropic.endpoint,
                'https://api.anthropic.com/v1/messages',
                'anthropic suffix kept, slash stripped',
            );
            const deepseek = buildDeepSeekStreamRequest({
                baseUrl: 'https://api.deepseek.com/chat/completions',
                model: 'm',
                messages: [],
                maxTokens: 1,
            });
            assertEqual(
                deepseek.endpoint,
                'https://api.deepseek.com/chat/completions',
                'deepseek suffix kept',
            );
            const ollama = buildOllamaStreamRequest({
                baseUrl: 'http://localhost:11434/api/chat/',
                model: 'm',
                messages: [],
            });
            assertEqual(
                ollama.endpoint,
                'http://localhost:11434/api/chat',
                'ollama suffix kept, slash stripped',
            );
        },
    ],

    [
        'ollama warm-up: empty prompt loads the model without generating',
        () => {
            const built = buildOllamaPreloadRequest({
                baseUrl: 'http://localhost:11434/',
                model: 'llama3.2',
                keepAlive: '30m',
                options: { num_ctx: 8192, num_gpu: -1 },
            });
            assertEqual(built.endpoint, 'http://localhost:11434/api/generate', 'preload endpoint');
            assertEqual(built.payload.model, 'llama3.2', 'model');
            assertEqual(built.payload.prompt, '', 'empty prompt');
            assertEqual(built.payload.stream, false, 'single JSON response');
            assertEqual(built.payload.keep_alive, '30m', 'keep-alive forwarded');
            assertEqual(built.payload.options.num_ctx, 8192, 'runner options mirrored');
            assertEqual(built.headers['Content-Type'], 'application/json', 'json header');

            const suffixed = buildOllamaPreloadRequest({
                baseUrl: 'http://localhost:11434/api/generate',
                model: 'm',
            });
            assertEqual(
                suffixed.endpoint,
                'http://localhost:11434/api/generate',
                'already-suffixed endpoint not doubled',
            );
            assertEqual(suffixed.payload.keep_alive, '5m', 'default keep-alive');
            assertEqual(JSON.stringify(suffixed.payload.options), '{}', 'options default');

            const chatBase = buildOllamaPreloadRequest({
                baseUrl: 'http://localhost:11434/api/chat',
                model: 'm',
            });
            assertEqual(
                chatBase.endpoint,
                'http://localhost:11434/api/generate',
                'chat base URL mapped to generate',
            );

            const unload = buildOllamaUnloadRequest({
                baseUrl: 'http://localhost:11434/api',
                apiKey: 'secret',
                model: 'qwen3',
            });
            assertEqual(unload.endpoint, 'http://localhost:11434/api/generate', 'unload endpoint');
            assertEqual(unload.headers['Authorization'], 'Bearer secret', 'unload auth');
            assertEqual(unload.payload.keep_alive, 0, 'keep_alive 0 unloads');
            assertEqual(unload.payload.prompt, '', 'empty prompt');
        },
    ],

    [
        'ollama: tools gate per family (no web-search seeding quirk)',
        () => {
            const built = buildOllamaStreamRequest({
                baseUrl: 'http://localhost:11434',
                model: 'm',
                messages: [],
                advertise: { crawl: true, webSearch: false },
                toolNames: NAMES,
            });
            const names = built.payload.tools.map(toolNameOf);
            assert(!names.includes(WEB_SEARCH_TOOL_NAME), 'web search not seeded');
            assert(names.includes(CRAWL4AI_TOOL_NAME), 'crawl advertised');
        },
    ],
];

await runTests(tests);
