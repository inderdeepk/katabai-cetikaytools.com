// crawl4aiTools.test.js — Tests for Crawl4AI command parsing & formatting helpers
import {
    parseCrawl4AICommand,
    buildCrawlResultBlock,
    readCrawl4AIConfig,
} from '../src/tools/crawl4aiTools.js';
import { assert, assertEqual, assertDeepEqual, runTests, createMockSettings } from './testUtils.js';

const tests = [
    // ── parseCrawl4AICommand ───────────────────────────────────────────────

    ['parseCrawl4AICommand: prefix URL form', () => {
        const result = parseCrawl4AICommand('/crawl https://example.com/page');
        assert(result.isCommand, 'is command');
        assertEqual(result.url, 'https://example.com/page', 'URL extracted');
        assertEqual(result.query, '', 'no query');
    }],

    ['parseCrawl4AICommand: prefix query form', () => {
        const result = parseCrawl4AICommand('/crawl latest python release notes');
        assert(result.isCommand, 'is command');
        assertEqual(result.url, '', 'no URL');
        assertEqual(result.query, 'latest python release notes', 'query extracted');
    }],

    ['parseCrawl4AICommand: suffix URL form', () => {
        const result = parseCrawl4AICommand('https://example.com /crawl');
        assert(result.isCommand, 'is command');
        assertEqual(result.url, 'https://example.com', 'URL extracted from suffix');
    }],

    ['parseCrawl4AICommand: suffix query form', () => {
        const result = parseCrawl4AICommand('some search query /crawl');
        assert(result.isCommand, 'is command');
        assertEqual(result.query, 'some search query', 'query extracted from suffix');
    }],

    ['parseCrawl4AICommand: command only', () => {
        const result = parseCrawl4AICommand('/crawl');
        assert(result.isCommand, 'is command');
        assertEqual(result.url, '', 'empty URL');
        assertEqual(result.query, '', 'empty query');
    }],

    ['parseCrawl4AICommand: not a command', () => {
        assertEqual(parseCrawl4AICommand('just a regular message'), null, 'not command');
        assertEqual(parseCrawl4AICommand(''), null, 'empty');
        assertEqual(parseCrawl4AICommand(null), null, 'null');
    }],

    // ── buildCrawlResultBlock ──────────────────────────────────────────────

    ['buildCrawlResultBlock: successful scrape', () => {
        const block = buildCrawlResultBlock({
            success: true,
            url: 'https://example.com',
            fitMarkdown: '# Title\n\nSome content here.',
            truncated: false,
        });
        assert(block.includes('https://example.com'), 'URL included');
        assert(block.includes('Title'), 'content included');
        assert(block.includes('untrusted'), 'safety guard');
    }],

    ['buildCrawlResultBlock: failed scrape', () => {
        const block = buildCrawlResultBlock({
            success: false,
            url: 'https://example.com',
            errorMessage: 'Connection refused',
        });
        assert(block.includes('Scrape failed'), 'failure message');
        assert(block.includes('Connection refused'), 'error detail');
    }],

    ['buildCrawlResultBlock: null/undefined result', () => {
        const block = buildCrawlResultBlock(null);
        assert(block.includes('Scrape failed'), 'null handled');
    }],

    ['buildCrawlResultBlock: truncated content', () => {
        const block = buildCrawlResultBlock({
            success: true,
            url: 'https://example.com',
            fitMarkdown: 'Some content',
            truncated: true,
        });
        assert(block.includes('truncated'), 'truncation note');
    }],

    // ── readCrawl4AIConfig ────────────────────────────────────────────────

    ['readCrawl4AIConfig: all keys', () => {
        const settings = createMockSettings({
            'crawl4ai-enabled': true,
            'crawl4ai-url': 'http://localhost:11235',
            'crawl4ai-api-token': 'tok123',
            'crawl4ai-fit-markdown-mode': 'bm25',
            'crawl4ai-bm25-threshold': 0.7,
            'crawl4ai-cache-mode': 'enabled',
            'crawl4ai-word-count-threshold': 20,
            'crawl4ai-page-timeout': 90,
            'crawl4ai-max-chars': 30000,
            'crawl4ai-simulate-user': false,
            'crawl4ai-autonomous-enabled': true,
            'crawl4ai-allow-local-addresses': false,
            'crawl4ai-job-poll-ms': 1500,
            'crawl4ai-capture-network': true,
        });
        const cfg = readCrawl4AIConfig(settings);
        assertEqual(cfg.enabled, true, 'enabled');
        assertEqual(cfg.url, 'http://localhost:11235', 'url');
        assertEqual(cfg.apiToken, 'tok123', 'apiToken');
        assertEqual(cfg.fitMarkdownMode, 'bm25', 'fitMarkdownMode');
        assertEqual(cfg.bm25Threshold, 0.7, 'bm25Threshold');
        assertEqual(cfg.cacheMode, 'enabled', 'cacheMode');
        assertEqual(cfg.wordCountThreshold, 20, 'wordCountThreshold');
        assertEqual(cfg.pageTimeout, 90, 'pageTimeout');
        assertEqual(cfg.maxChars, 30000, 'maxChars');
        assertEqual(cfg.autonomousEnabled, true, 'autonomousEnabled');
        assertEqual(cfg.allowLocal, false, 'allowLocal');
        assertEqual(cfg.captureNetwork, true, 'captureNetwork');
        // jobPollMs should be clamped within [500, 30000]
        assertEqual(cfg.jobPollMs, 1500, 'jobPollMs');
    }],

    ['readCrawl4AIConfig: missing keys use defaults', () => {
        const settings = createMockSettings({});
        const cfg = readCrawl4AIConfig(settings);
        assertEqual(cfg.enabled, false, 'enabled defaults false');
        assertEqual(cfg.fitMarkdownMode, 'pruning', 'fitMarkdownMode defaults pruning');
        assertEqual(cfg.cacheMode, 'bypass', 'cacheMode defaults bypass');
    }],
];

runTests(tests);
