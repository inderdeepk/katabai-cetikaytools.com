// ollamaCapabilities.test.js — Unit tests for Ollama endpoint resolution,
// `/api/show` capability parsing, `think` resolution, Structured Outputs
// schema validation, `/api/ps` + `/api/tags` normalizers, and error matchers.
import {
    resolveOllamaEndpoint,
    isOllamaCloudEndpoint,
    isOllamaCloudModel,
    looksLikeOllamaVisionModel,
    parseOllamaShowResponse,
    resolveOllamaThinkParam,
    validateOllamaFormatSchema,
    parseOllamaFormat,
    parseOllamaStopSequences,
    parseOllamaPsResponse,
    parseOllamaTagsResponse,
    formatBytesCompact,
    isOllamaUnsupportedThinkingError,
    isOllamaUnsupportedToolsError,
} from '../src/providers/ollamaCapabilities.js';
import { assertEqual, assertDeepEqual, runTests } from './testUtils.js';

const tests = [
    [
        'resolveOllamaEndpoint: normalizes bare, /api, /api/chat, /v1, and trailing slashes',
        () => {
            assertEqual(
                resolveOllamaEndpoint('http://localhost:11434', '/api/chat'),
                'http://localhost:11434/api/chat',
                'bare host',
            );
            assertEqual(
                resolveOllamaEndpoint('http://localhost:11434/', '/api/show'),
                'http://localhost:11434/api/show',
                'trailing slash',
            );
            assertEqual(
                resolveOllamaEndpoint('http://localhost:11434/api/', '/api/tags'),
                'http://localhost:11434/api/tags',
                '/api suffix stripped before appending',
            );
            assertEqual(
                resolveOllamaEndpoint('http://localhost:11434/api/chat', '/api/generate'),
                'http://localhost:11434/api/generate',
                '/api/chat stripped before appending /api/generate',
            );
            assertEqual(
                resolveOllamaEndpoint('https://ollama.com/api', '/v1/chat/completions'),
                'https://ollama.com/v1/chat/completions',
                'ollama cloud /api mapped to /v1/chat/completions',
            );
        },
    ],

    [
        'cloud detection: endpoint hosts and :cloud/-cloud model tags',
        () => {
            assertEqual(isOllamaCloudEndpoint('https://ollama.com'), true, 'ollama.com');
            assertEqual(isOllamaCloudEndpoint('https://api.ollama.com'), true, 'api.ollama.com');
            assertEqual(
                isOllamaCloudEndpoint('https://api.ollama.cloud'),
                true,
                'api.ollama.cloud',
            );
            assertEqual(isOllamaCloudEndpoint('http://localhost:11434'), false, 'localhost');
            assertEqual(isOllamaCloudModel('gemma4:31b:cloud'), true, ':cloud tag');
            assertEqual(isOllamaCloudModel('qwen3-coder-cloud'), true, '-cloud suffix');
            assertEqual(isOllamaCloudModel('qwen3:8b'), false, 'local tag');
        },
    ],

    [
        'looksLikeOllamaVisionModel: recognizes modern multimodal families',
        () => {
            assertEqual(looksLikeOllamaVisionModel('gemma4:8b'), true, 'gemma4');
            assertEqual(looksLikeOllamaVisionModel('llama3.2-vision:11b'), true, 'llama3.2-vision');
            assertEqual(looksLikeOllamaVisionModel('qwen3-vl:8b'), true, 'qwen3-vl');
            assertEqual(looksLikeOllamaVisionModel('llama3.2:3b'), false, 'text-only llama3.2');
        },
    ],

    [
        'parseOllamaShowResponse: extracts modern capabilities, thinking.values, and context_length',
        () => {
            const parsed = parseOllamaShowResponse(
                {
                    capabilities: ['completion', 'thinking', 'vision', 'tools'],
                    thinking: {
                        values: ['low', 'medium', 'high'],
                        default: 'medium',
                    },
                    details: {
                        family: 'gemma4',
                        parameter_size: '8.0B',
                        quantization_level: 'Q4_K_M',
                    },
                    model_info: {
                        'gemma4.context_length': 131072,
                        'gemma4.block_count': 42,
                    },
                },
                'gemma4',
            );
            assertEqual(parsed.vision, true, 'vision true');
            assertEqual(parsed.tools, true, 'tools true');
            assertEqual(parsed.thinking, true, 'thinking true');
            assertDeepEqual(parsed.thinkingValues, ['low', 'medium', 'high'], 'thinking values');
            assertEqual(parsed.thinkingDefault, 'medium', 'thinking default');
            assertEqual(parsed.contextLength, 131072, 'context length extracted');
            assertEqual(parsed.family, 'gemma4', 'family');
            assertEqual(parsed.parameterSize, '8.0B', 'parameter size');
            assertEqual(parsed.quantizationLevel, 'Q4_K_M', 'quantization');
        },
    ],

    [
        'parseOllamaShowResponse: non-thinking non-tool model reports false authoritatively',
        () => {
            const parsed = parseOllamaShowResponse(
                {
                    capabilities: ['completion'],
                    model_info: { 'llama.context_length': 8192 },
                },
                'llama3.2',
            );
            assertEqual(parsed.vision, false, 'no vision');
            assertEqual(parsed.tools, false, 'no tools');
            assertEqual(parsed.thinking, false, 'no thinking');
            assertEqual(parsed.contextLength, 8192, 'llama context length');
        },
    ],

    [
        'resolveOllamaThinkParam: safe across non-thinking, boolean, effort-level, and unknown models',
        () => {
            assertEqual(
                resolveOllamaThinkParam({ enabled: true, capabilities: null }),
                undefined,
                'unknown capabilities omits think to avoid HTTP 400',
            );
            assertEqual(
                resolveOllamaThinkParam({
                    enabled: true,
                    capabilities: { thinking: false },
                }),
                undefined,
                'non-thinking model omits think',
            );
            assertEqual(
                resolveOllamaThinkParam({
                    enabled: true,
                    level: 'auto',
                    capabilities: {
                        thinking: true,
                        thinkingValues: [false, true],
                        thinkingDefault: true,
                    },
                }),
                true,
                'boolean thinking model enabled',
            );
            assertEqual(
                resolveOllamaThinkParam({
                    enabled: false,
                    capabilities: {
                        thinking: true,
                        thinkingValues: [false, true],
                        thinkingDefault: true,
                    },
                }),
                false,
                'boolean thinking model disabled',
            );
            assertEqual(
                resolveOllamaThinkParam({
                    enabled: true,
                    level: 'high',
                    capabilities: {
                        thinking: true,
                        thinkingValues: ['low', 'medium', 'high'],
                        thinkingDefault: 'medium',
                    },
                }),
                'high',
                'graded thinking model uses requested level',
            );
            assertEqual(
                resolveOllamaThinkParam({
                    enabled: true,
                    level: 'max',
                    capabilities: {
                        thinking: true,
                        thinkingValues: ['low', 'medium', 'high'],
                        thinkingDefault: 'medium',
                    },
                }),
                'high',
                'max falls back to high when max is not in thinkingValues',
            );
            assertEqual(
                resolveOllamaThinkParam({
                    enabled: false,
                    forceDisable: true,
                    capabilities: {
                        thinking: true,
                        thinkingValues: ['low', 'medium', 'high'],
                        thinkingDefault: 'medium',
                    },
                }),
                'low',
                'model without false value falls back to lowest level on disable',
            );
        },
    ],

    [
        'format & stop sequences: JSON Schema validation and comma/newline splitting',
        () => {
            assertEqual(parseOllamaFormat('', ''), undefined, 'empty format → undefined');
            assertEqual(parseOllamaFormat('json', ''), 'json', 'json mode');
            const schema = '{"type":"object","properties":{"ok":{"type":"boolean"}}}';
            assertEqual(validateOllamaFormatSchema(schema).valid, true, 'valid schema');
            assertEqual(parseOllamaFormat('schema', schema).type, 'object', 'parsed schema object');
            assertEqual(
                parseOllamaFormat('schema', '{bad json'),
                'json',
                'invalid schema falls back to json',
            );
            assertEqual(validateOllamaFormatSchema('[1,2]').valid, false, 'array schema rejected');
            assertDeepEqual(
                parseOllamaStopSequences('END, ###\nSTOP'),
                ['END', '###', 'STOP'],
                'stop sequences parsed',
            );
            assertEqual(parseOllamaStopSequences('   '), null, 'blank stop → null');
        },
    ],

    [
        'parseOllamaPsResponse & parseOllamaTagsResponse & formatBytesCompact',
        () => {
            const ps = parseOllamaPsResponse({
                models: [
                    {
                        name: 'gemma4:8b',
                        model: 'gemma4:8b',
                        size: 5_000_000_000,
                        size_vram: 4_831_838_208,
                        context_length: 32768,
                        expires_at: '2026-11-24T23:05:00Z',
                        details: { parameter_size: '8.0B', quantization_level: 'Q4_K_M' },
                    },
                ],
            });
            assertEqual(ps.length, 1, '1 running model');
            assertEqual(ps[0].contextLength, 32768, 'context length');
            assertEqual(formatBytesCompact(ps[0].sizeVram), '4.5 GB', 'formatted VRAM');

            const tags = parseOllamaTagsResponse({
                models: [{ name: 'gemma4:31b:cloud', size: 0, details: { parameter_size: '31B' } }],
            });
            assertEqual(tags[0].isCloud, true, 'cloud tag flagged');
        },
    ],

    [
        'error matchers detect Ollama HTTP 400 unsupported thinking / tools',
        () => {
            assertEqual(
                isOllamaUnsupportedThinkingError('"llama3.2" does not support thinking'),
                true,
                'unsupported thinking detected',
            );
            assertEqual(
                isOllamaUnsupportedToolsError('"deepseek-r1" does not support tools'),
                true,
                'unsupported tools detected',
            );
            assertEqual(isOllamaUnsupportedThinkingError('connection refused'), false, 'unrelated');
        },
    ],
];

await runTests(tests);
