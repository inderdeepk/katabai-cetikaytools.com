// nonStreamingRequest.test.js — Golden tests for the non-streaming request
// dialects (planner / gap analysis / compression / outline calls).
import {
    buildNonStreamingChatRequest,
    extractNonStreamingText,
    extractNonStreamingUsage,
} from '../src/providers/nonStreamingRequest.js';
import { assert, assertEqual, runTests } from './testUtils.js';

const msg = (role, content) => ({ role, content });
const MESSAGES = [msg('system', 'sys'), msg('user', 'hello')];

const tests = [
    // ── anthropic ──────────────────────────────────────────────────────────

    ['anthropic: base URL gains /v1/messages; system filtered; headers set', () => {
        const req = buildNonStreamingChatRequest({
            provider: 'anthropic',
            baseUrl: 'https://api.anthropic.com',
            model: 'claude-3-5-sonnet-20241022',
            apiKey: 'sk-ant',
            messages: MESSAGES,
            maxTokens: 512,
        });
        assertEqual(req.url, 'https://api.anthropic.com/v1/messages', 'endpoint');
        assertEqual(req.headers['x-api-key'], 'sk-ant', 'x-api-key header');
        assertEqual(req.headers['anthropic-version'], '2023-06-01', 'version header');
        assertEqual(req.payload.max_tokens, 512, 'max_tokens');
        assertEqual(req.payload.messages.length, 1, 'system message filtered');
        assertEqual(req.payload.messages[0].role, 'user', 'user message kept');
    }],

    ['anthropic: URL already containing v1/messages is not suffixed again', () => {
        const req = buildNonStreamingChatRequest({
            provider: 'anthropic',
            baseUrl: 'https://proxy.example/v1/messages',
            model: 'claude',
            apiKey: 'k',
            messages: MESSAGES,
        });
        assertEqual(req.url, 'https://proxy.example/v1/messages/', 'trailing slash only');
    }],

    // ── ollama ─────────────────────────────────────────────────────────────

    ['ollama: api/chat suffix, stream false, think false', () => {
        const req = buildNonStreamingChatRequest({
            provider: 'ollama',
            baseUrl: 'http://localhost:11434',
            model: 'llama3',
            messages: MESSAGES,
        });
        assertEqual(req.url, 'http://localhost:11434/api/chat', 'endpoint');
        assertEqual(req.payload.stream, false, 'stream false');
        assertEqual(req.payload.think, false, 'think disabled');
        assert(!('Authorization' in req.headers), 'no auth header');
    }],

    // ── OpenAI-compatible providers ────────────────────────────────────────

    ['openai: /v1 base gains chat/completions and bearer auth', () => {
        const req = buildNonStreamingChatRequest({
            provider: 'openai',
            baseUrl: 'https://api.openai.com/v1',
            model: 'gpt-4o',
            apiKey: 'sk-openai',
            messages: MESSAGES,
            maxTokens: 256,
        });
        assertEqual(req.url, 'https://api.openai.com/v1/chat/completions', 'endpoint');
        assertEqual(req.headers['Authorization'], 'Bearer sk-openai', 'bearer header');
        assertEqual(req.payload.stream, false, 'stream false');
        assertEqual(req.payload.max_tokens, 256, 'max_tokens');
    }],

    ['deepseek: adds thinking disabled; no key means no Authorization header', () => {
        const req = buildNonStreamingChatRequest({
            provider: 'deepseek',
            baseUrl: 'https://api.deepseek.com',
            model: 'deepseek-flash',
            messages: MESSAGES,
        });
        assertEqual(req.url, 'https://api.deepseek.com/chat/completions', 'endpoint');
        assertEqual(req.payload.thinking.type, 'disabled', 'thinking disabled');
        assert(!('Authorization' in req.headers), 'no auth header without key');
    }],

    ['unsloth: treated as OpenAI-compatible', () => {
        const req = buildNonStreamingChatRequest({
            provider: 'unsloth',
            baseUrl: 'http://localhost:8888/v1',
            model: 'default',
            messages: MESSAGES,
        });
        assertEqual(req.url, 'http://localhost:8888/v1/chat/completions', 'endpoint');
        assert(!('thinking' in req.payload), 'no deepseek thinking block');
    }],

    ['endpoint quirk: path-suffixed base URL receives a doubled suffix (pre-existing behavior)', () => {
        // Documented legacy behavior: a trailing "/" is appended before the
        // suffix check, so "…/api/chat" becomes "…/api/chat/api/chat".
        // Base URLs (http://host:port) are the supported configuration.
        const req = buildNonStreamingChatRequest({
            provider: 'ollama',
            baseUrl: 'http://host/api/chat',
            model: 'm',
            messages: MESSAGES,
        });
        assertEqual(req.url, 'http://host/api/chat/api/chat', 'quirk frozen by test');
    }],

    // ── response extraction ────────────────────────────────────────────────

    ['extract text: anthropic joins text blocks and skips others', () => {
        const parsed = { content: [
            { type: 'text', text: 'Hello ' },
            { type: 'tool_use', id: 'x' },
            { type: 'text', text: 'world' },
        ] };
        assertEqual(extractNonStreamingText('anthropic', parsed), 'Hello world', 'joined text blocks');
        assertEqual(extractNonStreamingText('anthropic', {}), '', 'missing content');
    }],

    ['extract text: ollama and openai shapes', () => {
        assertEqual(extractNonStreamingText('ollama', { message: { content: 'local' } }), 'local', 'ollama');
        assertEqual(extractNonStreamingText('ollama', {}), '', 'ollama missing');
        assertEqual(extractNonStreamingText('openai', { choices: [{ message: { content: 'cloud' } }] }), 'cloud', 'openai');
        assertEqual(extractNonStreamingText('deepseek', { choices: [] }), '', 'empty choices');
    }],

    ['extract usage: per-provider token math, absent data yields 0', () => {
        assertEqual(extractNonStreamingUsage('ollama', { prompt_eval_count: 100, eval_count: 20 }), 120, 'ollama sum');
        assertEqual(extractNonStreamingUsage('anthropic', { usage: { input_tokens: 10, output_tokens: 5 } }), 15, 'anthropic sum');
        assertEqual(extractNonStreamingUsage('openai', { usage: { prompt_tokens: 7, completion_tokens: 3 } }), 10, 'openai sum');
        assertEqual(extractNonStreamingUsage('openai', {}), 0, 'missing usage');
    }],
];

await runTests(tests);
