// webSearchTools.test.js — Tests for SearxNG query heuristics & helpers
import {
    needsExpansion,
    detectMultiPartQuery,
    classifyQueryIntent,
    ENGINE_ROUTES,
    parseWebSearchCommand,
    buildWebSearchResultBlock,
    buildReadUrlResultBlock,
    readWebSearchConfig,
} from '../src/tools/webSearchTools.js';
import { assert, assertEqual, assertDeepEqual, runTests, createMockSettings } from './testUtils.js';

const tests = [
    // ── needsExpansion ─────────────────────────────────────────────────────

    ['needsExpansion: conversational queries', () => {
        // needsExpansion requires 2+ indicators
        assert(needsExpansion('what is the weather today?'), 'question word + question mark');
        // "How do I compile a C program" — 6 words, question word = 1 indicator. Not enough for expansion.
        assert(!needsExpansion('How do I compile a C program'), 'only 1 indicator');
        assert(!needsExpansion('Why is the sky blue'), 'only one indicator');
    }],

    ['needsExpansion: long conversational queries', () => {
        assert(needsExpansion('Can you please tell me about the history of the Roman Empire and its major achievements and legacy in modern society'), 'polite + long');
        assert(!needsExpansion('explain to me how quantum computing works in simple terms'), 'only politeness indicator');
    }],

    ['needsExpansion: single indicator cases', () => {
        assert(needsExpansion('what'), 'two indicators: short + question word');
        assert(!needsExpansion('GitHub'), 'single word, no indicators');
        assert(!needsExpansion('python django rest framework'), 'keyword phrase, 0 indicators');
    }],

    // ── detectMultiPartQuery ───────────────────────────────────────────────

    ['detectMultiPartQuery: comparisons', () => {
        assert(detectMultiPartQuery('Python vs JavaScript performance'), 'vs detected');
        assert(detectMultiPartQuery('Rust versus Go compared to C++'), 'versus + compared');
    }],

    ['detectMultiPartQuery: compound queries', () => {
        assert(detectMultiPartQuery('best restaurants in Paris and also hotels'), 'and also');
        assert(detectMultiPartQuery('Python: asyncio and threading and multiprocessing'), 'colon + multiple and');
    }],

    ['detectMultiPartQuery: plain queries (should not detect)', () => {
        assert(!detectMultiPartQuery('how to write a Python function'), 'simple query');
        assert(!detectMultiPartQuery(''), 'empty');
    }],

    // ── classifyQueryIntent ────────────────────────────────────────────────

    ['classifyQueryIntent: code queries', () => {
        assertEqual(classifyQueryIntent('how to fix undefined reference error in C'), 'code');
        assertEqual(classifyQueryIntent('npm install react fails with syntax error'), 'code');
        assertEqual(classifyQueryIntent('dockerfile best practices'), 'code');
        assertEqual(classifyQueryIntent('api endpoint rest graphql comparison'), 'code');
    }],

    ['classifyQueryIntent: news queries', () => {
        assertEqual(classifyQueryIntent('breaking news today about technology'), 'news');
        assertEqual(classifyQueryIntent('latest announcement from OpenAI 2025'), 'news');
        assertEqual(classifyQueryIntent('just released python 3.14'), 'news');
    }],

    ['classifyQueryIntent: academic queries', () => {
        assertEqual(classifyQueryIntent('recent arxiv paper on attention mechanisms'), 'academic');
        assertEqual(classifyQueryIntent('study about climate change research'), 'academic');
        assertEqual(classifyQueryIntent('phd thesis on machine learning'), 'academic');
    }],

    ['classifyQueryIntent: factual queries', () => {
        assertEqual(classifyQueryIntent('what is the capital of France'), 'facts');
        assertEqual(classifyQueryIntent('define photosynthesis'), 'facts');
        assertEqual(classifyQueryIntent('who is the president of Brazil'), 'facts');
    }],

    ['classifyQueryIntent: general fallback', () => {
        assertEqual(classifyQueryIntent('hello world'), 'general');
        assertEqual(classifyQueryIntent(''), 'general');
    }],

    // ── ENGINE_ROUTES ─────────────────────────────────────────────────────

    ['ENGINE_ROUTES: all 5 route keys exist with valid structure', () => {
        const keys = ['code', 'facts', 'news', 'academic', 'general'];
        for (const key of keys) {
            assert(ENGINE_ROUTES[key] !== undefined, `${key} route exists`);
            assert(typeof ENGINE_ROUTES[key] === 'object', `${key} is object`);
            assert(ENGINE_ROUTES[key].categories || ENGINE_ROUTES[key].engines, `${key} has engines or categories`);
        }
    }],

    // ── parseWebSearchCommand ──────────────────────────────────────────────

    ['parseWebSearchCommand: prefix form', () => {
        const result = parseWebSearchCommand('/search what is gnome');
        assert(result.isCommand, 'is command');
        assertEqual(result.query, 'what is gnome', 'query extracted');
    }],

    ['parseWebSearchCommand: suffix form', () => {
        const result = parseWebSearchCommand('what is gnome /search');
        assert(result.isCommand, 'is command');
        assertEqual(result.query, 'what is gnome', 'query extracted');
    }],

    ['parseWebSearchCommand: command only (no query)', () => {
        const result = parseWebSearchCommand('/search');
        assert(result.isCommand, 'is command');
        assertEqual(result.query, '', 'empty query');
    }],

    ['parseWebSearchCommand: not a command', () => {
        const result = parseWebSearchCommand('just a regular message');
        assertEqual(result, null, 'not a command');
    }],

    ['parseWebSearchCommand: empty text', () => {
        assertEqual(parseWebSearchCommand(''), null, 'empty');
        assertEqual(parseWebSearchCommand(null), null, 'null');
    }],

    ['parseWebSearchCommand: "searches" is not a command', () => {
        const result = parseWebSearchCommand('my searches yesterday');
        assertEqual(result, null, 'word ending in /search not matched');
    }],

    // ── buildWebSearchResultBlock ──────────────────────────────────────────

    ['buildWebSearchResultBlock: with results', () => {
        const block = buildWebSearchResultBlock('test query', [
            { title: 'Result 1', url: 'https://a.com', content: 'Snippet 1' },
            { title: 'Result 2', url: 'https://b.com', content: 'Snippet 2' },
        ]);
        assert(block.includes('test query'), 'query included');
        assert(block.includes('Result 1'), 'first result');
        assert(block.includes('Result 2'), 'second result');
        assert(block.includes('https://a.com'), 'URL included');
        assert(block.includes('untrusted'), 'safety guard included');
    }],

    ['buildWebSearchResultBlock: empty results', () => {
        const block = buildWebSearchResultBlock('no results', []);
        assert(block.includes('returned no results'), 'empty message');
        assert(!block.includes('Result'), 'no result formatting');
    }],

    ['buildWebSearchResultBlock: with unresponsive engines', () => {
        const block = buildWebSearchResultBlock('test', [
            { title: 'R1', url: 'https://a.com', content: 'S1' },
        ]);
        assert(block.includes('use read_url'), 'read_url hint included');
    }],

    ['buildWebSearchResultBlock: guard rails at high search count', () => {
        const block = buildWebSearchResultBlock('test', [
            { title: 'R1', url: 'https://a.com', content: 'S1' },
        ], { totalSearchesThisTurn: 5 });
        assert(block.includes('STOP SEARCHING'), 'stop message at 5 searches');
    }],

    // ── buildReadUrlResultBlock ────────────────────────────────────────────

    ['buildReadUrlResultBlock: with content', () => {
        const block = buildReadUrlResultBlock({
            url: 'https://example.com',
            text: 'This is the page content.',
            truncated: false,
        });
        assert(block.includes('https://example.com'), 'URL included');
        assert(block.includes('page content'), 'text content included');
        assert(block.includes('untrusted'), 'safety guard');
    }],

    // ── readWebSearchConfig ────────────────────────────────────────────────

    ['readWebSearchConfig: all keys', () => {
        const settings = createMockSettings({
            'web-search-enabled': true,
            'web-search-url': 'http://localhost:8080',
            'web-search-result-limit': 10,
            'web-search-time-range': 'week',
            'web-search-safesearch': 2,
            'web-search-language': 'en',
            'web-search-categories': 'general,science',
            'web-search-engines': 'google',
            'web-search-api-key': 'secret',
            'web-search-fetch-page-enabled': true,
            'web-search-multiquery-enabled': false,
            'web-search-autonomous-enabled': true,
            'web-search-allow-local-addresses': false,
        });
        const cfg = readWebSearchConfig(settings);
        assertEqual(cfg.enabled, true, 'enabled');
        assertEqual(cfg.url, 'http://localhost:8080', 'url');
        assertEqual(cfg.resultLimit, 10, 'resultLimit');
        assertEqual(cfg.timeRange, 'week', 'timeRange');
        assertEqual(cfg.safesearch, 2, 'safesearch');
        assertEqual(cfg.language, 'en', 'language');
        assertEqual(cfg.fetchPageEnabled, true, 'fetchPageEnabled');
        assertEqual(cfg.allowLocal, false, 'allowLocal');
    }],

    ['readWebSearchConfig: missing keys use defaults', () => {
        const settings = createMockSettings({});
        const cfg = readWebSearchConfig(settings);
        assertEqual(cfg.enabled, false, 'enabled defaults to false');
        assertEqual(cfg.url, '', 'url defaults to empty');
        assertEqual(cfg.resultLimit, 0, 'resultLimit defaults to 0');
    }],
];

await runTests(tests);
