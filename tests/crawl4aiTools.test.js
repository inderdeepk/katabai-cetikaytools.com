// crawl4aiTools.test.js — Tests for Crawl4AI command parsing & formatting helpers
import GLib from 'gi://GLib';
import Soup from 'gi://Soup';

import {
    parseCrawl4AICommand,
    stripCrawl4AICommand,
    buildCrawlResultBlock,
    buildCrawlPayload,
    buildLLMExtractionStrategy,
    parseCrawlResults,
    isLLMExtractionMode,
    buildLlmJobInstruction,
    normalizeLlmJobResult,
    getCrawlResultText,
    extractPageLinks,
    normalizeInternalLinks,
    getCrawlResultLinks,
    isPdfUrl,
    looksLikePdf,
    looksLikePdfFailure,
    readCrawl4AIConfig,
    parseNetworkRequests,
    Crawl4AIRuntime,
    httpStatusPhrase,
    parseRetryAfterMs,
    parseRateLimitResetMs,
    isRetryableCrawlError,
    computeCrawlRetryDelayMs,
    isTransientCrawlResultFailure,
    isLlmFallbackWorthyError,
} from '../src/tools/crawl4aiTools.js';
import { _setCachePathForTesting } from '../src/research/researchCache.js';
import {
    assert,
    assertEqual,
    assertDeepEqual,
    runTests,
    createMockSettings,
    makeTempDir,
    removeTempDir,
} from './testUtils.js';

// Redirect the persistent research cache into a throwaway directory so the
// integration tests below never read or write the real cache file.
const TEMP_DIR = makeTempDir('katabai-crawl4ai-XXXXXX');
_setCachePathForTesting(GLib.build_filenamev([TEMP_DIR, 'research-cache.json']));

// ── Mock Crawl4AI server helpers (integration tests) ─────────────────────────

function startMockServer(handler) {
    const server = new Soup.Server();
    server.add_handler(null, (_srv, msg) => handler(msg));
    server.listen_local(0, Soup.ServerListenOptions.IPV4_ONLY);
    const port = server.get_uris()[0].get_port();
    return { server, port, close: () => server.disconnect() };
}

function respondJson(msg, status, payload, headers = {}) {
    msg.set_status(status, null);
    for (const [name, value] of Object.entries(headers)) {
        msg.get_response_headers().append(name, value);
    }
    msg.set_response(
        'application/json',
        Soup.MemoryUse.COPY,
        new TextEncoder().encode(JSON.stringify(payload)),
    );
}

function crawlSuccess(url) {
    return {
        results: [
            {
                url,
                success: true,
                status_code: 200,
                markdown: { raw_markdown: `# ${url}`, fit_markdown: `# ${url}` },
                links: { internal: [], external: [] },
            },
        ],
    };
}

function mockConfig(port) {
    return { ...baseConfig, url: `http://127.0.0.1:${port}`, apiToken: '', allowLocal: true };
}

// Shared minimal Crawl4AI config used by payload/parsing tests.
const baseConfig = {
    fitMarkdownMode: 'pruning',
    cacheMode: 'bypass',
    wordCountThreshold: 10,
    pageTimeout: 60,
    maxChars: 24000,
    captureNetwork: false,
    simulateUser: false,
    bm25Threshold: 0.5,
    extractionMode: 'markdown',
    llmProvider: 'deepseek/deepseek-flash',
    llmInstruction: '',
    llmSchemaJson: '',
    llmChunkTokenThreshold: 4000,
    llmOverlapRate: 0.1,
};

const tests = [
    // ── parseCrawl4AICommand ───────────────────────────────────────────────

    [
        'parseCrawl4AICommand: prefix URL form',
        () => {
            const result = parseCrawl4AICommand('/crawl https://example.com/page');
            assert(result.isCommand, 'is command');
            assertEqual(result.url, 'https://example.com/page', 'URL extracted');
            assertEqual(result.query, '', 'no query');
        },
    ],

    [
        'parseCrawl4AICommand: prefix query form',
        () => {
            const result = parseCrawl4AICommand('/crawl latest python release notes');
            assert(result.isCommand, 'is command');
            assertEqual(result.url, '', 'no URL');
            assertEqual(result.query, 'latest python release notes', 'query extracted');
        },
    ],

    [
        'parseCrawl4AICommand: suffix URL form',
        () => {
            const result = parseCrawl4AICommand('https://example.com /crawl');
            assert(result.isCommand, 'is command');
            assertEqual(result.url, 'https://example.com', 'URL extracted from suffix');
        },
    ],

    [
        'parseCrawl4AICommand: suffix query form',
        () => {
            const result = parseCrawl4AICommand('some search query /crawl');
            assert(result.isCommand, 'is command');
            assertEqual(result.query, 'some search query', 'query extracted from suffix');
        },
    ],

    [
        'parseCrawl4AICommand: command only',
        () => {
            const result = parseCrawl4AICommand('/crawl');
            assert(result.isCommand, 'is command');
            assertEqual(result.url, '', 'empty URL');
            assertEqual(result.query, '', 'empty query');
        },
    ],

    [
        'parseCrawl4AICommand: not a command',
        () => {
            assertEqual(parseCrawl4AICommand('just a regular message'), null, 'not command');
            assertEqual(parseCrawl4AICommand(''), null, 'empty');
            assertEqual(parseCrawl4AICommand(null), null, 'null');
        },
    ],

    [
        'parseCrawl4AICommand: inline URL form (mid-sentence)',
        () => {
            const result = parseCrawl4AICommand(
                'tell me the latest models. /crawl https://example.com',
            );
            assert(result.isCommand, 'is command');
            assertEqual(result.url, 'https://example.com', 'URL extracted from inline');
            assertEqual(result.query, '', 'no query');
        },
    ],

    [
        'parseCrawl4AICommand: inline URL with trailing punctuation',
        () => {
            const result = parseCrawl4AICommand('Read this: /crawl https://example.com/page.');
            assert(result.isCommand, 'is command');
            assertEqual(result.url, 'https://example.com/page', 'trailing period stripped');
        },
    ],

    [
        'parseCrawl4AICommand: inline URL at start still uses prefix path',
        () => {
            const result = parseCrawl4AICommand('/crawl https://example.com');
            assert(result.isCommand, 'is command');
            assertEqual(result.url, 'https://example.com', 'prefix URL still works');
        },
    ],

    [
        'parseCrawl4AICommand: conversational mention is not a command',
        () => {
            assertEqual(
                parseCrawl4AICommand('how does /crawl work?'),
                null,
                'no URL inline → not a command',
            );
            assertEqual(
                parseCrawl4AICommand('compare /crawl and /search tools'),
                null,
                'no URL → not command',
            );
        },
    ],

    // ── stripCrawl4AICommand ───────────────────────────────────────────────

    [
        'stripCrawl4AICommand: inline URL form keeps surrounding text',
        () => {
            assertEqual(
                stripCrawl4AICommand(
                    'tell me what this page is about /crawl https://docs.example.com/settings',
                ),
                'tell me what this page is about',
                'inline URL stripped',
            );
        },
    ],

    [
        'stripCrawl4AICommand: prefix URL form',
        () => {
            assertEqual(
                stripCrawl4AICommand('/crawl https://example.com/page'),
                '',
                'prefix URL → empty',
            );
        },
    ],

    [
        'stripCrawl4AICommand: prefix query form',
        () => {
            assertEqual(
                stripCrawl4AICommand('/crawl latest python release notes'),
                '',
                'prefix query → empty',
            );
        },
    ],

    [
        'stripCrawl4AICommand: suffix URL form',
        () => {
            assertEqual(
                stripCrawl4AICommand('read this page /crawl'),
                'read this page',
                'suffix command stripped',
            );
        },
    ],

    [
        'stripCrawl4AICommand: command only',
        () => {
            assertEqual(stripCrawl4AICommand('/crawl'), '', 'command only → empty');
        },
    ],

    [
        'stripCrawl4AICommand: not a command',
        () => {
            assertEqual(
                stripCrawl4AICommand('just a regular message'),
                'just a regular message',
                'unchanged',
            );
            assertEqual(stripCrawl4AICommand(''), '', 'empty unchanged');
            assertEqual(stripCrawl4AICommand(null), '', 'null → empty');
        },
    ],

    [
        'stripCrawl4AICommand: inline with trailing punctuation',
        () => {
            assertEqual(
                stripCrawl4AICommand('Read this: /crawl https://example.com/page.'),
                'Read this:',
                'inline URL with trailing period stripped',
            );
        },
    ],

    [
        'stripCrawl4AICommand: conversational mention unchanged',
        () => {
            assertEqual(
                stripCrawl4AICommand('how does /crawl work?'),
                'how does /crawl work?',
                'conversational mention left intact',
            );
        },
    ],

    // ── buildCrawlResultBlock ──────────────────────────────────────────────

    [
        'buildCrawlResultBlock: successful scrape',
        () => {
            const block = buildCrawlResultBlock({
                success: true,
                url: 'https://example.com',
                fitMarkdown: '# Title\n\nSome content here.',
                truncated: false,
            });
            assert(block.includes('https://example.com'), 'URL included');
            assert(block.includes('Title'), 'content included');
            assert(block.includes('untrusted'), 'safety guard');
        },
    ],

    [
        'buildCrawlResultBlock: failed scrape',
        () => {
            const block = buildCrawlResultBlock({
                success: false,
                url: 'https://example.com',
                errorMessage: 'Connection refused',
            });
            assert(block.includes('Scrape failed'), 'failure message');
            assert(block.includes('Connection refused'), 'error detail');
        },
    ],

    [
        'buildCrawlResultBlock: null/undefined result',
        () => {
            const block = buildCrawlResultBlock(null);
            assert(block.includes('Scrape failed'), 'null handled');
        },
    ],

    [
        'buildCrawlResultBlock: truncated content',
        () => {
            const block = buildCrawlResultBlock({
                success: true,
                url: 'https://example.com',
                fitMarkdown: 'Some content',
                truncated: true,
            });
            assert(block.includes('truncated'), 'truncation note');
        },
    ],

    // ── readCrawl4AIConfig ────────────────────────────────────────────────

    [
        'readCrawl4AIConfig: all keys',
        () => {
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
        },
    ],

    [
        'readCrawl4AIConfig: missing keys use defaults',
        () => {
            const settings = createMockSettings({});
            const cfg = readCrawl4AIConfig(settings);
            assertEqual(cfg.enabled, false, 'enabled defaults false');
            assertEqual(cfg.fitMarkdownMode, 'pruning', 'fitMarkdownMode defaults pruning');
            assertEqual(cfg.cacheMode, 'bypass', 'cacheMode defaults bypass');
        },
    ],

    [
        'readCrawl4AIConfig: LLM extraction keys',
        () => {
            const settings = createMockSettings({
                'crawl4ai-extraction-mode': 'llm-schema',
                'crawl4ai-llm-provider': 'openai/gpt-4o',
                'crawl4ai-llm-instruction': 'Summarize',
                'crawl4ai-llm-schema-json': '{"type":"object"}',
                'crawl4ai-llm-chunk-token-threshold': 8000,
                'crawl4ai-llm-overlap-rate': 0.2,
            });
            const cfg = readCrawl4AIConfig(settings);
            assertEqual(cfg.extractionMode, 'llm-schema', 'extractionMode');
            assertEqual(cfg.llmProvider, 'openai/gpt-4o', 'llmProvider');
            assertEqual(cfg.llmInstruction, 'Summarize', 'llmInstruction');
            assertEqual(cfg.llmSchemaJson, '{"type":"object"}', 'llmSchemaJson');
            assertEqual(cfg.llmChunkTokenThreshold, 8000, 'llmChunkTokenThreshold');
            assertEqual(cfg.llmOverlapRate, 0.2, 'llmOverlapRate');
        },
    ],

    [
        'readCrawl4AIConfig: missing LLM keys use defaults',
        () => {
            const settings = createMockSettings({});
            const cfg = readCrawl4AIConfig(settings);
            assertEqual(cfg.extractionMode, 'markdown', 'extractionMode defaults markdown');
            assertEqual(cfg.llmProvider, 'deepseek/deepseek-flash', 'llmProvider default');
            assertEqual(
                cfg.llmInstruction,
                'Extract the key facts, claims, and arguments from this page and summarize them concisely.',
                'llmInstruction default',
            );
            assertEqual(
                cfg.llmSchemaJson,
                '{"type":"object","properties":{"title":{"type":"string"},"summary":{"type":"string"},"key_points":{"type":"array","items":{"type":"string"}}},"required":["title","summary"]}',
                'llmSchemaJson default',
            );
            assertEqual(cfg.llmChunkTokenThreshold, 4000, 'chunk threshold default');
            assertEqual(cfg.llmOverlapRate, 0.1, 'overlap rate default');
        },
    ],

    // ── isLLMExtractionMode ──────────────────────────────────────────────

    [
        'isLLMExtractionMode: markdown false, schema/block true',
        () => {
            assertEqual(
                isLLMExtractionMode({ extractionMode: 'markdown' }),
                false,
                'markdown false',
            );
            assertEqual(isLLMExtractionMode({ extractionMode: 'llm-schema' }), true, 'schema true');
            assertEqual(isLLMExtractionMode({ extractionMode: 'llm-block' }), true, 'block true');
            assertEqual(isLLMExtractionMode({}), false, 'missing config false');
        },
    ],

    // ── buildLLMExtractionStrategy ───────────────────────────────────────

    [
        'buildLLMExtractionStrategy: markdown mode returns null',
        () => {
            assertEqual(
                buildLLMExtractionStrategy({ extractionMode: 'markdown' }),
                null,
                'no strategy for markdown',
            );
        },
    ],

    [
        'buildLLMExtractionStrategy: schema mode builds type+params',
        () => {
            const strategy = buildLLMExtractionStrategy({
                extractionMode: 'llm-schema',
                llmProvider: 'openai/gpt-4o',
                llmSchemaJson:
                    '{"type":"object","properties":{"title":{"type":"string"}},"required":["title"]}',
                llmChunkTokenThreshold: 4000,
                llmOverlapRate: 0.1,
            });
            assert(strategy, 'strategy present');
            assertEqual(strategy.type, 'LLMExtractionStrategy', 'type is class name');
            assertEqual(strategy.params.provider, 'openai/gpt-4o', 'provider');
            assertDeepEqual(
                strategy.params.schema,
                {
                    type: 'object',
                    properties: { title: { type: 'string' } },
                    required: ['title'],
                },
                'schema parsed',
            );
            assertEqual(strategy.params.chunk_token_threshold, 4000, 'chunk threshold');
            assertEqual(strategy.params.overlap_rate, 0.1, 'overlap rate');
        },
    ],

    [
        'buildLLMExtractionStrategy: block mode builds instruction',
        () => {
            const strategy = buildLLMExtractionStrategy({
                extractionMode: 'llm-block',
                llmProvider: 'anthropic/claude-3-5-sonnet',
                llmInstruction: 'Summarize this page.',
            });
            assert(strategy, 'strategy present');
            assertEqual(strategy.type, 'LLMExtractionStrategy', 'type');
            assertEqual(strategy.params.instruction, 'Summarize this page.', 'instruction');
        },
    ],

    [
        'buildLLMExtractionStrategy: invalid schema JSON returns null',
        () => {
            const strategy = buildLLMExtractionStrategy({
                extractionMode: 'llm-schema',
                llmSchemaJson: '{ not valid json',
            });
            assertEqual(strategy, null, 'falls back to markdown');
        },
    ],

    [
        'buildLLMExtractionStrategy: empty schema returns null',
        () => {
            assertEqual(
                buildLLMExtractionStrategy({ extractionMode: 'llm-schema', llmSchemaJson: '' }),
                null,
                'no schema',
            );
        },
    ],

    [
        'buildLLMExtractionStrategy: empty instruction returns null',
        () => {
            assertEqual(
                buildLLMExtractionStrategy({ extractionMode: 'llm-block', llmInstruction: '   ' }),
                null,
                'no instruction',
            );
        },
    ],

    // ── buildCrawlPayload ────────────────────────────────────────────────

    [
        'buildCrawlPayload: markdown mode omits extraction_strategy',
        () => {
            const payload = buildCrawlPayload(['https://example.com'], {
                ...baseConfig,
                extractionMode: 'markdown',
            });
            assert(
                payload.crawler_config.extraction_strategy === undefined,
                'no extraction_strategy',
            );
            assert(payload.crawler_config.markdown_generator, 'markdown generator kept');
        },
    ],

    [
        'buildCrawlPayload: schema mode includes extraction_strategy',
        () => {
            const payload = buildCrawlPayload(['https://example.com'], {
                ...baseConfig,
                extractionMode: 'llm-schema',
                llmSchemaJson: '{"type":"object","properties":{"title":{"type":"string"}}}',
            });
            const strat = payload.crawler_config.extraction_strategy;
            assert(strat, 'extraction_strategy present');
            assertEqual(strat.type, 'LLMExtractionStrategy', 'type');
            assert(strat.params.schema, 'schema in params');
        },
    ],

    [
        'buildCrawlPayload: block mode includes instruction',
        () => {
            const payload = buildCrawlPayload(['https://example.com'], {
                ...baseConfig,
                extractionMode: 'llm-block',
                llmInstruction: 'Summarize',
            });
            const strat = payload.crawler_config.extraction_strategy;
            assert(strat, 'extraction_strategy present');
            assertEqual(strat.params.instruction, 'Summarize', 'instruction');
        },
    ],

    [
        'buildCrawlPayload: invalid schema falls back to markdown',
        () => {
            const payload = buildCrawlPayload(['https://example.com'], {
                ...baseConfig,
                extractionMode: 'llm-schema',
                llmSchemaJson: '{ broken',
            });
            assert(
                payload.crawler_config.extraction_strategy === undefined,
                'no extraction_strategy on bad schema',
            );
        },
    ],

    [
        'buildCrawlPayload: preserves existing crawler config',
        () => {
            const payload = buildCrawlPayload(['https://example.com'], {
                ...baseConfig,
                extractionMode: 'llm-schema',
                llmSchemaJson: '{"type":"object"}',
            });
            assertEqual(payload.crawler_config.cache_mode, 'bypass', 'cache mode');
            assertEqual(payload.browser_config.headless, true, 'headless');
            assert(
                payload.crawler_config.markdown_generator.params.content_filter,
                'content filter kept',
            );
        },
    ],

    // ── parseCrawlResults ────────────────────────────────────────────────

    [
        'parseCrawlResults: schema mode captures structuredJson',
        () => {
            const config = { ...baseConfig, extractionMode: 'llm-schema' };
            const results = parseCrawlResults(
                [
                    {
                        success: true,
                        url: 'https://example.com',
                        json: { title: 'Hello' },
                        markdown: { fit_markdown: 'markdown here' },
                    },
                ],
                config,
            );
            assertEqual(results[0].success, true, 'success');
            assertEqual(results[0].llmExtractionUsed, true, 'llm used');
            assertDeepEqual(results[0].structuredJson, { title: 'Hello' }, 'structured json');
            assertEqual(results[0].fitMarkdown, 'markdown here', 'markdown still extracted');
        },
    ],

    [
        'parseCrawlResults: string json parsed to object',
        () => {
            const config = { ...baseConfig, extractionMode: 'llm-schema' };
            const results = parseCrawlResults(
                [
                    {
                        success: true,
                        url: 'https://example.com',
                        json: '{"price": "10"}',
                        markdown: {},
                    },
                ],
                config,
            );
            assertDeepEqual(results[0].structuredJson, { price: '10' }, 'string json parsed');
        },
    ],

    [
        'parseCrawlResults: block mode captures llmResponse',
        () => {
            const config = { ...baseConfig, extractionMode: 'llm-block' };
            const results = parseCrawlResults(
                [
                    {
                        success: true,
                        url: 'https://example.com',
                        llm: 'The main argument is X.',
                        markdown: { fit_markdown: 'raw' },
                    },
                ],
                config,
            );
            assertEqual(results[0].llmResponse, 'The main argument is X.', 'llm response');
            assertEqual(results[0].structuredJson, null, 'no structured json');
        },
    ],

    [
        'parseCrawlResults: markdown mode has no llm fields',
        () => {
            const config = { ...baseConfig, extractionMode: 'markdown' };
            const results = parseCrawlResults(
                [
                    {
                        success: true,
                        url: 'https://example.com',
                        json: { title: 'x' },
                        markdown: { fit_markdown: 'raw' },
                    },
                ],
                config,
            );
            assertEqual(results[0].llmExtractionUsed, false, 'no llm');
            assertEqual(results[0].structuredJson, null, 'no structured json');
            assertEqual(results[0].llmResponse, null, 'no llm response');
        },
    ],

    [
        'parseCrawlResults: failed result keeps llm flags',
        () => {
            const config = { ...baseConfig, extractionMode: 'llm-schema' };
            const results = parseCrawlResults(
                [
                    {
                        success: false,
                        url: 'https://example.com',
                        error_message: 'boom',
                    },
                ],
                config,
            );
            assertEqual(results[0].success, false, 'failed');
            assertEqual(results[0].errorMessage, 'boom', 'error');
            assertEqual(results[0].llmExtractionUsed, true, 'llm flag on failure');
        },
    ],

    // ── buildCrawlResultBlock (LLM modes) ────────────────────────────────

    [
        'buildCrawlResultBlock: schema mode renders JSON code block',
        () => {
            const block = buildCrawlResultBlock({
                success: true,
                url: 'https://example.com',
                fitMarkdown: 'raw markdown',
                llmExtractionUsed: true,
                structuredJson: { title: 'Hello' },
                llmResponse: null,
            });
            assert(block.includes('Structured JSON extracted by LLM'), 'mode line');
            assert(block.includes('```json'), 'json code fence');
            assert(block.includes('"title"'), 'json content');
            assert(block.includes('untrusted'), 'safety guard');
        },
    ],

    [
        'buildCrawlResultBlock: block mode renders freeform answer',
        () => {
            const block = buildCrawlResultBlock({
                success: true,
                url: 'https://example.com',
                fitMarkdown: 'raw markdown',
                llmExtractionUsed: true,
                structuredJson: null,
                llmResponse: 'The main argument is X.',
            });
            assert(block.includes('LLM extraction from'), 'mode line');
            assert(block.includes('The main argument is X.'), 'llm answer');
            assert(block.includes('untrusted'), 'safety guard');
        },
    ],

    [
        'buildCrawlResultBlock: schema mode with empty output falls back to markdown',
        () => {
            const block = buildCrawlResultBlock({
                success: true,
                url: 'https://example.com',
                fitMarkdown: 'fallback markdown',
                llmExtractionUsed: true,
                structuredJson: null,
                llmResponse: null,
            });
            assert(block.includes('fallback markdown'), 'falls back to fit_markdown');
        },
    ],

    [
        'buildCrawlResultBlock: markdown mode unchanged',
        () => {
            const block = buildCrawlResultBlock({
                success: true,
                url: 'https://example.com',
                fitMarkdown: '# Title\n\nContent.',
                truncated: false,
                llmExtractionUsed: false,
                structuredJson: null,
                llmResponse: null,
            });
            assert(block.includes('Full text scraped from'), 'markdown header');
            assert(block.includes('Title'), 'content');
            assert(block.includes('untrusted'), 'safety guard');
        },
    ],

    [
        'buildCrawlResultBlock: server-blocked LLM shows markdown + notice',
        () => {
            const block = buildCrawlResultBlock({
                success: true,
                url: 'https://example.com',
                fitMarkdown: 'markdown content',
                llmExtractionUsed: false,
                llmBlockedByServer: true,
            });
            assert(block.includes('markdown content'), 'markdown shown');
            assert(block.includes('LLM extraction unavailable'), 'blocked notice');
            assert(block.includes('UNTRUSTED_ALLOWED_TYPES'), 'points at the fix');
        },
    ],

    // ── buildLlmJobInstruction / normalizeLlmJobResult (via /llm endpoint) ──

    [
        'buildLlmJobInstruction: uses user instruction',
        () => {
            assertEqual(
                buildLlmJobInstruction({
                    extractionMode: 'llm-block',
                    llmInstruction: 'Summarize',
                }),
                'Summarize',
                'block instruction used',
            );
        },
    ],

    [
        'buildLlmJobInstruction: schema mode falls back to default',
        () => {
            assertEqual(
                buildLlmJobInstruction({ extractionMode: 'llm-schema', llmInstruction: '' }),
                'Extract the requested fields from the page as JSON.',
                'default instruction for schema mode',
            );
        },
    ],

    [
        'normalizeLlmJobResult: object becomes structuredJson',
        () => {
            const r = normalizeLlmJobResult(
                'https://example.com',
                { title: 'Hello' },
                { extractionMode: 'llm-schema' },
            );
            assertEqual(r.success, true, 'success');
            assertEqual(r.llmExtractionUsed, true, 'llm used');
            assertDeepEqual(r.structuredJson, { title: 'Hello' }, 'structured json');
            assertEqual(r.llmResponse, null, 'no freeform');
        },
    ],

    [
        'normalizeLlmJobResult: string becomes llmResponse',
        () => {
            const r = normalizeLlmJobResult('https://example.com', 'Freeform answer', {
                extractionMode: 'llm-block',
            });
            assertEqual(r.llmResponse, 'Freeform answer', 'freeform response');
            assertEqual(r.structuredJson, null, 'no structured json');
        },
    ],

    [
        'normalizeLlmJobResult: empty result is a failure',
        () => {
            const r = normalizeLlmJobResult('https://example.com', null, {
                extractionMode: 'llm-schema',
            });
            assertEqual(r.success, false, 'failed');
            assert(r.errorMessage, 'has error');
        },
    ],

    // ── getCrawlResultText ────────────────────────────────────────────────

    [
        'getCrawlResultText: markdown mode prefers fitMarkdown',
        () => {
            const r = { url: 'https://example.com', success: true, fitMarkdown: '# Title\n\nBody' };
            assertEqual(getCrawlResultText(r), '# Title\n\nBody', 'fitMarkdown returned');
        },
    ],

    [
        'getCrawlResultText: llm-schema result returns structuredJson text',
        () => {
            const r = normalizeLlmJobResult(
                'https://example.com',
                { title: 'Hello', summary: 'World' },
                { extractionMode: 'llm-schema' },
            );
            const text = getCrawlResultText(r);
            assert(text.includes('"title": "Hello"'), 'structured json rendered as text');
            assert(text.includes('"summary": "World"'), 'includes summary field');
        },
    ],

    [
        'getCrawlResultText: llm-block result returns llmResponse',
        () => {
            const r = normalizeLlmJobResult('https://example.com', 'Freeform answer', {
                extractionMode: 'llm-block',
            });
            assertEqual(getCrawlResultText(r), 'Freeform answer', 'llm response returned');
        },
    ],

    [
        'getCrawlResultText: failed result is empty',
        () => {
            const r = normalizeLlmJobResult('https://example.com', null, {
                extractionMode: 'llm-schema',
            });
            assertEqual(getCrawlResultText(r), '', 'no text on failure');
        },
    ],

    [
        'getCrawlResultText: empty schema object is empty',
        () => {
            const r = normalizeLlmJobResult(
                'https://example.com',
                {},
                { extractionMode: 'llm-schema' },
            );
            assertEqual(getCrawlResultText(r), '', 'empty object yields no text');
        },
    ],

    [
        'getCrawlResultText: null result is empty',
        () => {
            assertEqual(getCrawlResultText(null), '', 'null yields no text');
            assertEqual(getCrawlResultText(undefined), '', 'undefined yields no text');
        },
    ],

    // ── isPdfUrl ───────────────────────────────────────────────────────────

    [
        'isPdfUrl: direct .pdf URL',
        () => {
            assert(isPdfUrl('https://example.com/paper/file.pdf'), 'pdf path true');
        },
    ],

    [
        'isPdfUrl: uppercase extension',
        () => {
            assert(isPdfUrl('https://example.com/REPORT.PDF'), 'uppercase .PDF true');
        },
    ],

    [
        'isPdfUrl: query string on pdf',
        () => {
            assert(
                isPdfUrl('https://example.com/doc.pdf?token=abc123'),
                'query ignored, still pdf',
            );
        },
    ],

    [
        'isPdfUrl: html page is false',
        () => {
            assert(!isPdfUrl('https://example.com/article.html'), 'html false');
        },
    ],

    [
        'isPdfUrl: bare domain is false',
        () => {
            assert(!isPdfUrl('https://example.com'), 'no path false');
        },
    ],

    [
        'isPdfUrl: invalid url is false',
        () => {
            assert(!isPdfUrl('not a url'), 'invalid false');
            assert(!isPdfUrl(''), 'empty false');
        },
    ],

    // ── looksLikePdf ───────────────────────────────────────────────────────

    [
        'looksLikePdf: pdf magic bytes',
        () => {
            const bytes = new TextEncoder().encode('%PDF-1.4\n...');
            assert(looksLikePdf(bytes), 'pdf magic true');
        },
    ],

    [
        'looksLikePdf: leading whitespace before magic',
        () => {
            const bytes = new TextEncoder().encode('  \t\n%PDF-1.7');
            assert(looksLikePdf(bytes), 'whitespace tolerated');
        },
    ],

    [
        'looksLikePdf: utf8 bom before magic',
        () => {
            const bytes = new TextEncoder().encode('\uFEFF%PDF-1.7');
            assert(looksLikePdf(bytes), 'utf8 bom tolerated');
        },
    ],

    [
        'looksLikePdf: html is false',
        () => {
            const bytes = new TextEncoder().encode('<!DOCTYPE html><html>');
            assert(!looksLikePdf(bytes), 'html false');
        },
    ],

    [
        'looksLikePdf: short/empty is false',
        () => {
            assert(!looksLikePdf(new Uint8Array(0)), 'empty false');
            assert(!looksLikePdf(new TextEncoder().encode('%PDF')), 'too short false');
        },
    ],

    // ── looksLikePdfFailure ────────────────────────────────────────────────

    [
        'looksLikePdfFailure: navigation error signature',
        () => {
            assert(
                looksLikePdfFailure('Page.goto: net::ERR_FAILED at https://x/a.pdf'),
                'err_failed true',
            );
            assert(
                looksLikePdfFailure('Failed on navigating ACS-GOTO'),
                'failed on navigating true',
            );
        },
    ],

    [
        'looksLikePdfFailure: anti-bot block is not pdf',
        () => {
            assert(
                !looksLikePdfFailure('Blocked by anti-bot protection: Cloudflare JS challenge'),
                'cloudflare false',
            );
            assert(!looksLikePdfFailure(''), 'empty false');
        },
    ],

    // ── extractPageLinks ──────────────────────────────────────────────────

    [
        'extractPageLinks: extracts internal links',
        () => {
            const result = {
                links: {
                    internal: [
                        { href: '/intro.html', text: 'Introduction', title: '' },
                        { href: '/admin/settings.html', text: 'Settings', title: 'Settings' },
                        { href: '', text: 'Empty href', title: '' },
                    ],
                },
            };
            const links = extractPageLinks(result);
            assertEqual(links.length, 2, 'empty href skipped');
            assertEqual(links[0].href, '/intro.html', 'href kept');
            assertEqual(links[1].title, 'Settings', 'title kept');
        },
    ],

    [
        'extractPageLinks: missing links object returns []',
        () => {
            assertDeepEqual(extractPageLinks({}), [], 'no links');
            assertDeepEqual(extractPageLinks(null), [], 'null result');
            assertDeepEqual(extractPageLinks({ links: { internal: null } }), [], 'null internal');
        },
    ],

    // ── normalizeInternalLinks ────────────────────────────────────────────

    [
        'normalizeInternalLinks: resolves relative hrefs to absolute',
        () => {
            const links = [
                { href: '../engine_error_handling.html', text: 'Errors', title: '' },
                { href: 'getting-started.html', text: 'Getting started', title: '' },
                { href: '/intro', text: 'Intro', title: '' },
            ];
            const normalized = normalizeInternalLinks(
                links,
                'https://docs.searxng.org/admin/settings.html',
            );
            assert(
                normalized.some(
                    (l) => l.href === 'https://docs.searxng.org/engine_error_handling.html',
                ),
                'parent dir resolved',
            );
            assert(
                normalized.some(
                    (l) => l.href === 'https://docs.searxng.org/admin/getting-started.html',
                ),
                'sibling resolved',
            );
            assert(
                normalized.some((l) => l.href === 'https://docs.searxng.org/intro'),
                'root-relative resolved',
            );
        },
    ],

    [
        'normalizeInternalLinks: dedupes and strips fragments',
        () => {
            const links = [
                { href: '/page.html', text: 'One', title: '' },
                { href: '/page.html#section', text: 'Two', title: '' },
                { href: '/page.html', text: 'Three', title: '' },
            ];
            const normalized = normalizeInternalLinks(links, 'https://docs.example.org/');
            assertEqual(normalized.length, 1, 'deduped to one');
            assertEqual(
                normalized[0].href,
                'https://docs.example.org/page.html',
                'fragment stripped',
            );
        },
    ],

    [
        'normalizeInternalLinks: filters noise hrefs',
        () => {
            const links = [
                { href: '/print/page.html', text: 'Print', title: '' },
                { href: '/login', text: 'Login', title: '' },
                { href: '/guide.pdf', text: 'PDF', title: '' },
                { href: 'mailto:hi@example.org', text: 'Mail', title: '' },
                { href: '/real/page.html', text: 'Real', title: '' },
            ];
            const normalized = normalizeInternalLinks(links, 'https://docs.example.org/');
            assertEqual(normalized.length, 1, 'only real link kept');
            assertEqual(normalized[0].href, 'https://docs.example.org/real/page.html', 'real kept');
        },
    ],

    // ── getCrawlResultLinks ───────────────────────────────────────────────

    [
        'getCrawlResultLinks: caps output and uses result.url as base',
        () => {
            const result = {
                url: 'https://docs.example.org/',
                links: {
                    internal: Array.from({ length: 120 }, (_, i) => ({
                        href: `/page-${i}.html`,
                        text: `Page ${i}`,
                        title: '',
                    })),
                },
            };
            const links = getCrawlResultLinks(result, '', 100);
            assertEqual(links.length, 100, 'capped at 100');
            assertEqual(
                links[0].href,
                'https://docs.example.org/page-0.html',
                'base from result.url',
            );
        },
    ],

    // ── parseCrawlResults carries links ───────────────────────────────────

    [
        'parseCrawlResults: attaches normalized internal links',
        () => {
            const config = { ...baseConfig, maxChars: 24000 };
            const raw = [
                {
                    url: 'https://docs.example.org/',
                    success: true,
                    markdown: { fit_markdown: '# Docs' },
                    links: {
                        internal: [{ href: '/install.html', text: 'Install', title: '' }],
                    },
                },
            ];
            const parsed = parseCrawlResults(raw, config);
            assert(Array.isArray(parsed[0].links), 'links attached');
            assertEqual(parsed[0].links.length, 1, 'one link');
            assertEqual(
                parsed[0].links[0].href,
                'https://docs.example.org/install.html',
                'resolved href',
            );
        },
    ],

    // ── parseNetworkRequests ───────────────────────────────────────────────

    [
        'parseNetworkRequests: empty and non-array input yield empty output',
        () => {
            assertEqual(parseNetworkRequests(null), '', 'null');
            assertEqual(parseNetworkRequests(undefined), '', 'undefined');
            assertEqual(parseNetworkRequests([]), '', 'empty array');
            assertEqual(parseNetworkRequests('nope'), '', 'non-array');
        },
    ],

    [
        'parseNetworkRequests: keeps JSON/JS responses and skips other content types',
        () => {
            const text = parseNetworkRequests([
                {
                    url: 'https://api.example/data',
                    method: 'GET',
                    content_type: 'application/json',
                    body: '{"a":1}',
                },
                {
                    url: 'https://api.example/script.js',
                    content_type: 'application/javascript',
                    body: 'var a=1',
                },
                {
                    url: 'https://api.example/page',
                    content_type: 'text/html',
                    body: '<html></html>',
                },
                { url: 'https://api.example/image', content_type: 'image/png', body: 'binary' },
            ]);
            assert(text.includes('https://api.example/data'), 'json kept');
            assert(text.includes('https://api.example/script.js'), 'javascript kept');
            assert(!text.includes('api.example/page'), 'html dropped');
            assert(!text.includes('api.example/image'), 'image dropped');
        },
    ],

    [
        'parseNetworkRequests: dedupes the same URL ignoring its query string',
        () => {
            const text = parseNetworkRequests([
                {
                    url: 'https://api.example/items?page=1',
                    content_type: 'application/json',
                    body: '{"page":1}',
                },
                {
                    url: 'https://api.example/items?page=2',
                    content_type: 'application/json',
                    body: '{"page":2}',
                },
            ]);
            assertEqual(
                text.split('https://api.example/items').length - 1,
                1,
                'duplicate path captured once',
            );
            assert(text.includes('{"page":1}'), 'first response kept');
            assert(!text.includes('{"page":2}'), 'later duplicate dropped');
        },
    ],

    [
        'parseNetworkRequests: stringifies object bodies and skips empty ones',
        () => {
            const text = parseNetworkRequests([
                {
                    url: 'https://api.example/a',
                    content_type: 'application/json',
                    body: { ok: true },
                },
                { url: 'https://api.example/b', content_type: 'application/json', body: null },
                { url: 'https://api.example/c', content_type: 'application/json' },
                { content_type: 'application/json', body: '{"no":"url"}' },
            ]);
            assert(text.includes('{"ok":true}'), 'object body serialized');
            assert(!text.includes('https://api.example/b'), 'null body skipped');
            assert(!text.includes('https://api.example/c'), 'missing body skipped');
            assert(!text.includes('no":"url'), 'entry without url skipped');
        },
    ],

    [
        'parseNetworkRequests: labels the method and defaults to GET',
        () => {
            const text = parseNetworkRequests([
                {
                    url: 'https://api.example/a',
                    method: 'POST',
                    content_type: 'application/json',
                    body: '{}',
                },
                { url: 'https://api.example/b', content_type: 'application/json', body: '{}' },
            ]);
            assert(text.includes('// POST https://api.example/a'), 'explicit method');
            assert(text.includes('// GET https://api.example/b'), 'default method');
        },
    ],

    [
        'parseNetworkRequests: truncates a long body and caps total output',
        () => {
            const longBody = 'x'.repeat(5000);
            const text = parseNetworkRequests([
                {
                    url: 'https://api.example/long',
                    content_type: 'application/json',
                    body: longBody,
                },
            ]);
            assert(text.includes('…'), 'truncation marker present');
            assert(!text.includes('x'.repeat(3001)), 'body truncated at 3000 chars');

            const many = Array.from({ length: 20 }, (_unused, index) => ({
                url: `https://api.example/entry-${index}`,
                content_type: 'application/json',
                body: 'y'.repeat(3000),
            }));
            const capped = parseNetworkRequests(many);
            assert(capped.length <= 24_000, `total output capped (${capped.length})`);
            assert(!capped.includes('entry-19'), 'entries past the cap are dropped');
        },
    ],

    // ── HTTP status / rate-limit helpers ───────────────────────────────────

    [
        'httpStatusPhrase: resolves 429/503 and tolerates unknown codes',
        () => {
            assertEqual(httpStatusPhrase(429), 'Too Many Requests', '429 phrase');
            assertEqual(httpStatusPhrase(503), 'Service Unavailable', '503 phrase');
            assertEqual(httpStatusPhrase(401), 'Unauthorized', '401 phrase');
            assertEqual(httpStatusPhrase(599), 'Unknown Error', 'unknown code fallback');
        },
    ],

    [
        'parseRetryAfterMs: seconds, HTTP-date, empty and garbage',
        () => {
            assertEqual(parseRetryAfterMs('2'), 2000, 'delta seconds');
            assertEqual(parseRetryAfterMs('0'), 0, 'zero stays zero');
            assertEqual(parseRetryAfterMs(''), null, 'empty header');
            assertEqual(parseRetryAfterMs(null), null, 'null header');
            assertEqual(parseRetryAfterMs('not-a-date'), null, 'garbage header');

            const now = Date.parse('2026-01-01T00:00:00Z');
            assertEqual(
                parseRetryAfterMs('Thu, 01 Jan 2026 00:00:03 GMT', now),
                3000,
                'HTTP-date header',
            );
            assertEqual(
                parseRetryAfterMs('Thu, 01 Jan 2025 00:00:00 GMT', now),
                0,
                'past HTTP-date clamps to zero',
            );
        },
    ],

    [
        'parseRateLimitResetMs: epoch seconds/ms and delta seconds',
        () => {
            const now = 1_760_000_000_000;
            assertEqual(
                parseRateLimitResetMs(String(1_760_000_005), now),
                5000,
                'epoch seconds -> remaining ms',
            );
            assertEqual(
                parseRateLimitResetMs(String(1_760_000_002_500), now),
                2500,
                'epoch milliseconds',
            );
            assertEqual(parseRateLimitResetMs('7', now), 7000, 'delta seconds');
            assertEqual(parseRateLimitResetMs(String(1_759_999_000), now), 0, 'past epoch clamps');
            assertEqual(parseRateLimitResetMs(''), null, 'empty');
            assertEqual(parseRateLimitResetMs('nope'), null, 'garbage');
        },
    ],

    [
        'isRetryableCrawlError: classifies transient vs permanent failures',
        () => {
            assert(isRetryableCrawlError({ code: 'rate-limited' }), 'rate limit');
            assert(isRetryableCrawlError({ code: 'server-busy' }), 'server busy');
            assert(isRetryableCrawlError({ code: 'network-error' }), 'network');
            assert(isRetryableCrawlError({ code: 'connection-failed' }), 'connection');
            assert(isRetryableCrawlError({ code: 'http-error', statusCode: 503 }), 'http 503');
            assert(isRetryableCrawlError({ code: 'http-error', statusCode: 502 }), 'http 502');
            assert(!isRetryableCrawlError({ code: 'http-error', statusCode: 404 }), 'http 404');
            assert(!isRetryableCrawlError({ code: 'unauthorized' }), 'unauthorized');
            assert(!isRetryableCrawlError({ code: 'blocked-host' }), 'blocked host');
            assert(!isRetryableCrawlError(null), 'null error');
        },
    ],

    [
        'computeCrawlRetryDelayMs: honors Retry-After, backoff ladder and cap',
        () => {
            assertEqual(
                computeCrawlRetryDelayMs({ retryAfterMs: 2500 }, 1, () => 0),
                2500,
                'Retry-After wins',
            );
            assertEqual(
                computeCrawlRetryDelayMs({ retryAfterMs: 0 }, 1, () => 0),
                0,
                'zero Retry-After means retry now',
            );
            assertEqual(
                computeCrawlRetryDelayMs({ retryAfterMs: 120_000 }, 1, () => 0),
                60_000,
                'Retry-After capped',
            );
            assertEqual(
                computeCrawlRetryDelayMs({}, 1, () => 0),
                2000,
                'attempt 1 backoff',
            );
            assertEqual(
                computeCrawlRetryDelayMs({}, 3, () => 0),
                10_000,
                'attempt 3 backoff',
            );
            assertEqual(
                computeCrawlRetryDelayMs({}, 99, () => 0),
                10_000,
                'attempt beyond ladder uses last step',
            );
            assertEqual(
                computeCrawlRetryDelayMs({}, 1, () => 1),
                2500,
                'jitter applied to backoff',
            );
        },
    ],

    [
        'isTransientCrawlResultFailure: retries server-side rate pressure only',
        () => {
            assert(
                isTransientCrawlResultFailure({
                    success: false,
                    errorMessage: 'Rate limit retry count exceeded for domain example.com',
                }),
                'rate limit message',
            );
            assert(
                isTransientCrawlResultFailure({
                    success: false,
                    statusCode: 429,
                    errorMessage: 'Too many requests',
                }),
                '429 status',
            );
            assert(
                isTransientCrawlResultFailure({
                    success: false,
                    errorMessage: 'Requeued due to critical memory pressure',
                }),
                'memory pressure requeue',
            );
            assert(
                !isTransientCrawlResultFailure({
                    success: false,
                    statusCode: 404,
                    errorMessage: 'Not found',
                }),
                '404 is permanent',
            );
            assert(!isTransientCrawlResultFailure({ success: true }), 'success is not retried');
            assert(!isTransientCrawlResultFailure(null), 'null result');
        },
    ],

    [
        'isLlmFallbackWorthyError: only API-shape failures fall back to markdown',
        () => {
            assert(isLlmFallbackWorthyError({ code: 'bad-response' }), 'bad response');
            assert(isLlmFallbackWorthyError({ code: 'no-task-id' }), 'no task id');
            assert(
                isLlmFallbackWorthyError({ code: 'http-error', statusCode: 404 }),
                'endpoint missing',
            );
            assert(isLlmFallbackWorthyError({ code: 'timeout' }), 'job timeout');
            assert(!isLlmFallbackWorthyError({ code: 'rate-limited' }), 'rate limit');
            assert(!isLlmFallbackWorthyError({ code: 'server-busy' }), 'server busy');
            assert(!isLlmFallbackWorthyError({ code: 'unauthorized' }), 'auth');
            assert(!isLlmFallbackWorthyError({ code: 'network-error' }), 'network');
        },
    ],

    [
        'parseCrawlResults: preserves statusCode on failed results',
        () => {
            const parsed = parseCrawlResults(
                [
                    {
                        url: 'https://example.com/limited',
                        success: false,
                        status_code: 429,
                        error_message: 'Rate limit exceeded',
                    },
                ],
                baseConfig,
            );
            assertEqual(parsed[0].success, false, 'failure preserved');
            assertEqual(parsed[0].statusCode, 429, 'status code preserved');
        },
    ],

    // ── Integration: mock Crawl4AI server with rate limiting ───────────────

    [
        'integration: retries HTTP 429 and succeeds',
        async () => {
            const url = 'https://example.com/retry-429';
            let hits = 0;
            const mock = startMockServer((msg) => {
                hits += 1;
                if (hits <= 2) {
                    respondJson(
                        msg,
                        429,
                        { error: 'Rate limit exceeded: 10 per 1 minute' },
                        {
                            'Retry-After': '0',
                        },
                    );
                } else {
                    respondJson(msg, 200, crawlSuccess(url));
                }
            });
            const runtime = new Crawl4AIRuntime();
            try {
                const results = await runtime.crawl(url, mockConfig(mock.port));
                assertEqual(hits, 3, 'two 429s then a success');
                assertEqual(results[0].success, true, 'crawl succeeded');
                assert(results[0].fitMarkdown.includes(url), 'content returned');
            } finally {
                mock.close();
            }
        },
    ],

    [
        'integration: persistent 429 surfaces a rate-limited error, not network-error',
        async () => {
            const url = 'https://example.com/always-429';
            let hits = 0;
            const mock = startMockServer((msg) => {
                hits += 1;
                respondJson(
                    msg,
                    429,
                    { error: 'Too many concurrent jobs for this caller' },
                    {
                        'Retry-After': '0',
                    },
                );
            });
            const runtime = new Crawl4AIRuntime();
            try {
                let caught = null;
                try {
                    await runtime.crawl(url, mockConfig(mock.port));
                } catch (error) {
                    caught = error;
                }
                assert(caught, 'crawl threw');
                assertEqual(caught.code, 'rate-limited', 'classified as rate-limited');
                assertEqual(caught.statusCode, 429, 'status code attached');
                assertEqual(hits, 4, 'all retry attempts used');
                assert(caught.message.includes('still refusing requests'), 'retry hint added');
            } finally {
                mock.close();
            }
        },
    ],

    [
        'integration: retries HTTP 503 (server busy) and honors Retry-After',
        async () => {
            const url = 'https://example.com/retry-503';
            let hits = 0;
            const started = Date.now();
            const mock = startMockServer((msg) => {
                hits += 1;
                if (hits === 1) {
                    respondJson(
                        msg,
                        503,
                        { detail: 'Server busy, retry later' },
                        {
                            'Retry-After': '1',
                        },
                    );
                } else {
                    respondJson(msg, 200, crawlSuccess(url));
                }
            });
            const runtime = new Crawl4AIRuntime();
            try {
                const results = await runtime.crawl(url, mockConfig(mock.port));
                const elapsed = Date.now() - started;
                assertEqual(hits, 2, 'one 503 then a success');
                assertEqual(results[0].success, true, 'crawl succeeded');
                assert(elapsed >= 900, `Retry-After honored (waited ${elapsed}ms)`);
            } finally {
                mock.close();
            }
        },
    ],

    [
        'integration: serializes concurrent crawl requests',
        async () => {
            let inFlight = 0;
            let maxInFlight = 0;
            const mock = startMockServer((msg) => {
                inFlight += 1;
                maxInFlight = Math.max(maxInFlight, inFlight);
                msg.pause();
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 40, () => {
                    inFlight -= 1;
                    respondJson(msg, 200, crawlSuccess('https://example.com/concurrent'));
                    msg.unpause();
                    return GLib.SOURCE_REMOVE;
                });
            });
            const runtime = new Crawl4AIRuntime();
            try {
                const urls = [
                    'https://example.com/concurrent-a',
                    'https://example.com/concurrent-b',
                    'https://example.com/concurrent-c',
                ];
                const results = await Promise.all(
                    urls.map((url) => runtime.crawl(url, mockConfig(mock.port))),
                );
                assertEqual(maxInFlight, 1, 'only one request reached the server at a time');
                assert(
                    results.every((r) => r[0].success),
                    'all concurrent crawls succeeded',
                );
            } finally {
                mock.close();
            }
        },
    ],

    [
        'integration: retries a per-URL rate-limit failure returned inside HTTP 200',
        async () => {
            const url = 'https://example.com/result-level-429';
            let hits = 0;
            const mock = startMockServer((msg) => {
                hits += 1;
                if (hits === 1) {
                    respondJson(msg, 200, {
                        results: [
                            {
                                url,
                                success: false,
                                status_code: 429,
                                error_message:
                                    'Rate limit retry count exceeded for domain example.com',
                            },
                        ],
                    });
                } else {
                    respondJson(msg, 200, crawlSuccess(url));
                }
            });
            const runtime = new Crawl4AIRuntime();
            try {
                const results = await runtime.crawl(url, mockConfig(mock.port));
                assertEqual(hits, 2, 'failed result was retried');
                assertEqual(results[0].success, true, 'retry returned content');
            } finally {
                mock.close();
            }
        },
    ],

    [
        'cleanup: restore the research cache path and remove temp dir',
        () => {
            _setCachePathForTesting(null);
            removeTempDir(TEMP_DIR);
        },
    ],
];

await runTests(tests);
