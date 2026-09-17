// sessionMemory.test.js — Tests for the rolling session-memory module
import {
    estimateProviderCharBudget,
    isSessionMemoryMessage,
    splitHistoryForBudget,
    buildMemoryUpdateMessages,
    parseMemoryResponse,
} from '../src/core/sessionMemory.js';
import { assert, assertEqual, createMockSettings, runTests } from './testUtils.js';

const userMsg = (text) => ({ role: 'user', content: text });
const asstMsg = (text) => ({ role: 'assistant', content: text });

const tests = [
    // ── estimateProviderCharBudget ─────────────────────────────────────────

    ['budget: ollama uses num-ctx with output reserve', () => {
        const settings = createMockSettings({ 'ollama-num-ctx': 4096 });
        const budget = estimateProviderCharBudget('ollama', settings);
        assert(budget > 0 && budget < 4096 * 4, 'ollama budget is positive and reserved');
        assertEqual(budget, Math.floor(4096 * 0.8 * 3.5), 'exact 0.8 × 3.5 factor');
    }],

    ['budget: unsloth uses num-ctx', () => {
        const settings = createMockSettings({ 'unsloth-num-ctx': 8192 });
        const budget = estimateProviderCharBudget('unsloth', settings);
        assertEqual(budget, Math.floor(8192 * 0.8 * 3.5), 'unsloth budget from num-ctx');
    }],

    ['budget: openai model map + fallback', () => {
        const gpt4o = createMockSettings({ 'openai-model': 'gpt-4o' });
        assertEqual(estimateProviderCharBudget('openai', gpt4o),
            Math.floor(128000 * 0.8 * 3.5), 'gpt-4o budget');
        const unknown = createMockSettings({ 'openai-model': 'some-future-model' });
        assertEqual(estimateProviderCharBudget('openai', unknown),
            Math.floor(32000 * 0.8 * 3.5), 'unknown openai model fallback');
    }],

    ['budget: anthropic model map', () => {
        const claude = createMockSettings({ 'anthropic-model': 'claude-3-7-sonnet-20250219' });
        assertEqual(estimateProviderCharBudget('anthropic', claude),
            Math.floor(200000 * 0.8 * 3.5), 'claude budget');
    }],

    ['budget: unknown provider / missing settings → conservative fallback', () => {
        assertEqual(estimateProviderCharBudget('unknown-provider', null), 200000, 'unknown provider fallback');
        // Known provider with null settings resolves via its default model.
        assertEqual(estimateProviderCharBudget('openai', null),
            Math.floor(128000 * 0.8 * 3.5), 'openai defaults to gpt-4o budget');
    }],

    // ── splitHistoryForBudget ──────────────────────────────────────────────

    ['split: under budget keeps everything, no memory', () => {
        const msgs = [userMsg('hi'), asstMsg('hello'), userMsg('bye')];
        const result = splitHistoryForBudget(msgs, 100000, '');
        assertEqual(result.foldedCount, 0, 'nothing folded');
        assertEqual(result.tail.length, 3, 'all messages kept');
        assertEqual(result.memoryMsg, null, 'no memory message');
    }],

    ['split: memory message emitted when provided', () => {
        const msgs = [userMsg('hi'), asstMsg('hello')];
        const result = splitHistoryForBudget(msgs, 100000, 'SESSION MEMORY');
        assert(result.memoryMsg, 'memory message present');
        assertEqual(result.memoryMsg.role, 'system', 'memory role is system');
        assertEqual(result.memoryMsg.content, 'SESSION MEMORY', 'memory content preserved');
    }],

    ['split: over budget drops oldest, keeps newest user', () => {
        const msgs = [
            userMsg('turn 1 long question '.repeat(20)),
            asstMsg('turn 1 answer '.repeat(20)),
            userMsg('turn 2 long question '.repeat(20)),
            asstMsg('turn 2 answer '.repeat(20)),
            userMsg('turn 3 newest question '.repeat(20)),
            asstMsg('turn 3 answer '.repeat(20)),
        ];
        const result = splitHistoryForBudget(msgs, 500, '');
        assert(result.foldedCount > 0, 'something was folded');
        assertEqual(result.tail[0].role, 'user', 'tail starts at a user message');
        assert(result.tail.some(m => m.content.includes('turn 3 newest')), 'newest user kept');
        assert(!result.tail.some(m => m.content.includes('turn 1 long')), 'oldest dropped');
    }],

    ['split: never drops the newest user message even if huge', () => {
        const huge = 'x'.repeat(2000);
        const msgs = [userMsg('a'), userMsg(huge)];
        const result = splitHistoryForBudget(msgs, 500, '');
        assertEqual(result.tail.length, 1, 'only newest user kept');
        assertEqual(result.tail[0].content, huge, 'newest user retained');
    }],

    ['split: empty memoryText yields null memoryMsg', () => {
        const result = splitHistoryForBudget([userMsg('hi')], 1000, '   ');
        assertEqual(result.memoryMsg, null, 'whitespace memory → null');
    }],

    // ── isSessionMemoryMessage ─────────────────────────────────────────────

    ['isSessionMemoryMessage: marker detection', () => {
        assertEqual(isSessionMemoryMessage({ role: 'system', _sessionMemory: true }), true, 'flagged');
        assertEqual(isSessionMemoryMessage({ role: 'system' }), false, 'not flagged');
        assertEqual(isSessionMemoryMessage(null), false, 'null safe');
    }],

    // ── buildMemoryUpdateMessages ──────────────────────────────────────────

    ['buildMemoryUpdateMessages: merges memory + folded transcript', () => {
        const messages = buildMemoryUpdateMessages('OLD MEMORY', [userMsg('new question'), asstMsg('new answer')]);
        assertEqual(messages.length, 1, 'single user message');
        assertEqual(messages[0].role, 'user', 'role user works across providers');
        assert(messages[0].content.includes('OLD MEMORY'), 'existing memory included');
        assert(messages[0].content.includes('[user] new question'), 'user transcript included');
        assert(messages[0].content.includes('[assistant] new answer'), 'assistant transcript included');
    }],

    ['buildMemoryUpdateMessages: no existing memory', () => {
        const messages = buildMemoryUpdateMessages('', [userMsg('first')]);
        assertEqual(messages.length, 1, 'single message');
        assert(!messages[0].content.includes('CURRENT SESSION MEMORY'), 'no empty memory header');
        assert(messages[0].content.includes('[user] first'), 'transcript included');
    }],

    // ── parseMemoryResponse ────────────────────────────────────────────────

    ['parseMemoryResponse: trims and returns content', () => {
        assertEqual(parseMemoryResponse('  summary  '), 'summary', 'trimmed');
    }],

    ['parseMemoryResponse: empty → null', () => {
        assertEqual(parseMemoryResponse('   '), null, 'whitespace → null');
        assertEqual(parseMemoryResponse(null), null, 'null → null');
    }],

    ['parseMemoryResponse: caps oversized memory', () => {
        const long = 'y'.repeat(6000);
        const parsed = parseMemoryResponse(long);
        assert(parsed.length <= 4000, 'capped to max chars');
    }],
];

await runTests(tests);
