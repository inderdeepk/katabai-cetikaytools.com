// researchCache.test.js — Tests for persistent research result cache
//
// Exercises the public API against an isolated on-disk cache path (the
// _setCachePathForTesting seam) plus the crash-recovery checkpoint API.

import GLib from 'gi://GLib';
import {
    cacheSearchResults,
    getCachedSearchResults,
    cacheCrawlResult,
    getCachedCrawlResult,
    cacheLLMExtractionResult,
    getCachedLLMExtractionResult,
    cacheFetchResult,
    getCachedFetchResult,
    getRecommendedTtlForUrl,
    getCacheStats,
    clearCache,
    invalidateCacheEntry,
    getAllCacheEntries,
    flushCacheSync,
    saveResearchCheckpoint,
    loadResearchCheckpoint,
    clearResearchCheckpoint,
    _setCachePathForTesting,
    _setCheckpointPathForTesting,
} from '../src/research/researchCache.js';
import {
    assert,
    assertEqual,
    assertDeepEqual,
    runTests,
    makeTempDir,
    removeTempDir,
    readTextFile,
} from './testUtils.js';

// Redirect both persistent stores into a throwaway directory so the suite
// never touches the real ~/.local/share/katabai files.
const TEMP_DIR = makeTempDir('katabai-research-cache-XXXXXX');
const CACHE_PATH = GLib.build_filenamev([TEMP_DIR, 'research-cache.json']);
const CHECKPOINT_PATH = GLib.build_filenamev([TEMP_DIR, 'research-checkpoint.json']);
_setCachePathForTesting(CACHE_PATH);
_setCheckpointPathForTesting(CHECKPOINT_PATH);

function writeCheckpointFile(contents) {
    GLib.mkdir_with_parents(GLib.path_get_dirname(CHECKPOINT_PATH), 0o755);
    GLib.file_set_contents(CHECKPOINT_PATH, contents);
}

// ── In-memory store for test isolation ───────────────────────────────────────
// We monkey-patch the internal module state between tests.
// The researchCache module uses module-scoped `_cache`, `_dirty`, `_flushTimerId`.
// We can't access those directly, but we CAN use clearCache() between tests
// and the public API will work with the in-memory state.

function resetForTest() {
    clearCache();
}

// Shared Crawl4AI config used by the LLM extraction cache tests.
const llmConfig = {
    extractionMode: 'llm-schema',
    llmProvider: 'openai/gpt-4o-mini',
    llmInstruction: '',
    llmSchemaJson: '{"type":"object"}',
};

const tests = [
    // ── cacheSearchResults / getCachedSearchResults ────────────────────────

    [
        'cacheSearchResults: store and retrieve',
        () => {
            resetForTest();
            const results = [{ title: 'Result 1', url: 'https://a.com' }];
            cacheSearchResults('what is gnome shell', results);

            const cached = getCachedSearchResults('what is gnome shell');
            assert(cached !== null, 'cached result found');
            assertEqual(cached.length, 1, 'one result');
            assertEqual(cached[0].title, 'Result 1', 'content preserved');
        },
    ],

    [
        'cacheSearchResults: case and whitespace insensitivity',
        () => {
            resetForTest();
            cacheSearchResults('  GNOME Shell  ', [{ title: 'Test' }]);

            const cached = getCachedSearchResults('gnome shell');
            assert(cached !== null, 'trimmed + lowercased match');
            assertEqual(cached.length, 1, 'result found');
        },
    ],

    [
        'getCachedSearchResults: TTL expiration',
        () => {
            resetForTest();
            cacheSearchResults('test query', [{ title: 'Old' }]);

            // Use maxAgeMs=-1 to force expiration (any non-negative age > -1)
            const cached = getCachedSearchResults('test query', -1);
            assertEqual(cached, null, 'expired with maxAgeMs=-1');

            // Should also be gone on subsequent lookups
            const cached2 = getCachedSearchResults('test query');
            assertEqual(cached2, null, 'expired entry removed');
        },
    ],

    [
        'getCachedSearchResults: not found',
        () => {
            resetForTest();
            const cached = getCachedSearchResults('nonexistent query');
            assertEqual(cached, null, 'not found');
        },
    ],

    [
        'cacheSearchResults: re-caching moves to front (renews)',
        () => {
            resetForTest();
            cacheSearchResults('first', [{ id: 1 }]);
            cacheSearchResults('second', [{ id: 2 }]);
            cacheSearchResults('first', [{ id: 1, updated: true }]);

            // first should now be the most recent
            const cached = getCachedSearchResults('first');
            assert(cached[0].updated, 're-cached entry preserved with updates');
        },
    ],

    // ── cacheCrawlResult / getCachedCrawlResult ────────────────────────────

    [
        'cacheCrawlResult: store and retrieve',
        () => {
            resetForTest();
            cacheCrawlResult('https://example.com/page', { markdown: '# Title\n\nContent.' });

            const cached = getCachedCrawlResult('https://example.com/page');
            assert(cached !== null, 'crawl result found');
            assertEqual(cached.markdown, '# Title\n\nContent.', 'content preserved');
        },
    ],

    [
        'getCachedCrawlResult: TTL expiration',
        () => {
            resetForTest();
            cacheCrawlResult('https://example.com', { data: 'test' });
            const cached = getCachedCrawlResult('https://example.com', -1);
            assertEqual(cached, null, 'expired with maxAgeMs=-1');
        },
    ],

    [
        'getCachedCrawlResult: not found',
        () => {
            resetForTest();
            const cached = getCachedCrawlResult('https://never-cached.com');
            assertEqual(cached, null, 'not found');
        },
    ],

    // ── cacheLLMExtractionResult / getCachedLLMExtractionResult ──────────

    [
        'cacheLLMExtractionResult: store and retrieve',
        () => {
            resetForTest();
            cacheLLMExtractionResult(
                'https://example.com',
                [{ structuredJson: { title: 'Hello' } }],
                llmConfig,
            );

            const cached = getCachedLLMExtractionResult('https://example.com', llmConfig);
            assert(cached !== null, 'llm extraction found');
            assertDeepEqual(cached[0].structuredJson, { title: 'Hello' }, 'content preserved');
        },
    ],

    [
        'getCachedLLMExtractionResult: parameter-aware key (different schema misses)',
        () => {
            resetForTest();
            cacheLLMExtractionResult(
                'https://example.com',
                { structuredJson: { title: 'A' } },
                llmConfig,
            );

            const otherSchema = {
                ...llmConfig,
                llmSchemaJson: '{"type":"object","properties":{"price":{"type":"string"}}}',
            };
            const cached = getCachedLLMExtractionResult('https://example.com', otherSchema);
            assertEqual(cached, null, 'different schema key misses');

            const original = getCachedLLMExtractionResult('https://example.com', llmConfig);
            assert(cached === null && original !== null, 'original schema still hits');
        },
    ],

    [
        'getCachedLLMExtractionResult: TTL expiration',
        () => {
            resetForTest();
            cacheLLMExtractionResult('https://example.com', { structuredJson: {} }, llmConfig);
            const cached = getCachedLLMExtractionResult('https://example.com', llmConfig, -1);
            assertEqual(cached, null, 'expired with maxAgeMs=-1');
        },
    ],

    [
        'getCachedLLMExtractionResult: not found',
        () => {
            resetForTest();
            assertEqual(
                getCachedLLMExtractionResult('https://never.com', llmConfig),
                null,
                'not found',
            );
        },
    ],

    [
        'getCacheStats: counts llm-extraction entries',
        () => {
            resetForTest();
            cacheLLMExtractionResult('https://example.com', { structuredJson: {} }, llmConfig);
            const stats = getCacheStats();
            assertEqual(stats.llmExtractionCount, 1, 'one llm extraction');
            assertEqual(stats.entryCount, 1, 'one total');
        },
    ],

    // ── cacheFetchResult / getCachedFetchResult ────────────────────────────

    [
        'cacheFetchResult: store and retrieve with TTL category',
        () => {
            resetForTest();
            cacheFetchResult(
                'https://news.example.com/article',
                { content: 'Breaking news!' },
                'news',
            );

            // With no explicit maxAgeMs, uses category-derived TTL
            const cached = getCachedFetchResult('https://news.example.com/article');
            assert(cached !== null, 'fetch result found');
            assertEqual(cached.content, 'Breaking news!', 'content preserved');
        },
    ],

    [
        'getCachedFetchResult: custom maxAgeMs overrides category',
        () => {
            resetForTest();
            cacheFetchResult('https://example.com/static', { content: 'Static page' }, 'static');

            const cached = getCachedFetchResult('https://example.com/static', -1);
            assertEqual(cached, null, 'explicit maxAgeMs=-1 forces expiration');
        },
    ],

    [
        'getCachedFetchResult: not found',
        () => {
            resetForTest();
            const cached = getCachedFetchResult('https://never-fetched.com');
            assertEqual(cached, null, 'not found');
        },
    ],

    // ── getRecommendedTtlForUrl ────────────────────────────────────────────

    [
        'getRecommendedTtlForUrl: explicit news category',
        () => {
            const ttl = getRecommendedTtlForUrl('https://example.com', 'news');
            assertEqual(ttl, 6 * 60 * 60 * 1000, '6 hours for news');
        },
    ],

    [
        'getRecommendedTtlForUrl: date-pattern URL → short TTL',
        () => {
            const ttl = getRecommendedTtlForUrl('https://example.com/2025/07/28/article-title');
            assertEqual(ttl, 6 * 60 * 60 * 1000, 'date pattern → 6h');
        },
    ],

    [
        'getRecommendedTtlForUrl: /news/ path → short TTL',
        () => {
            const ttl = getRecommendedTtlForUrl('https://example.com/news/breaking-story');
            assertEqual(ttl, 6 * 60 * 60 * 1000, '/news/ path → 6h');
        },
    ],

    [
        'getRecommendedTtlForUrl: /blog/ path → short TTL',
        () => {
            const ttl = getRecommendedTtlForUrl('https://example.com/blog/my-post');
            assertEqual(ttl, 6 * 60 * 60 * 1000, '/blog/ path → 6h');
        },
    ],

    [
        'getRecommendedTtlForUrl: static content → 7 days',
        () => {
            const ttl = getRecommendedTtlForUrl('https://docs.example.com/reference/api');
            assertEqual(ttl, 7 * 24 * 60 * 60 * 1000, 'static → 7d');
        },
    ],

    [
        'getRecommendedTtlForUrl: empty URL → 7 days',
        () => {
            const ttl = getRecommendedTtlForUrl('');
            assertEqual(ttl, 7 * 24 * 60 * 60 * 1000, 'empty → default 7d');
        },
    ],

    // ── getCacheStats ──────────────────────────────────────────────────────

    [
        'getCacheStats: empty cache',
        () => {
            resetForTest();
            const stats = getCacheStats();
            assertEqual(stats.entryCount, 0, 'zero entries');
            assertEqual(stats.searchCount, 0, 'zero searches');
            assertEqual(stats.crawlCount, 0, 'zero crawls');
            assertEqual(stats.fetchCount, 0, 'zero fetches');
        },
    ],

    [
        'getCacheStats: mixed entries',
        () => {
            resetForTest();
            cacheSearchResults('q1', [{}]);
            cacheSearchResults('q2', [{}]);
            cacheCrawlResult('https://a.com', {});
            cacheFetchResult('https://b.com', {});

            const stats = getCacheStats();
            assertEqual(stats.entryCount, 4, 'four total');
            assertEqual(stats.searchCount, 2, 'two searches');
            assertEqual(stats.crawlCount, 1, 'one crawl');
            assertEqual(stats.fetchCount, 1, 'one fetch');
        },
    ],

    // ── clearCache ─────────────────────────────────────────────────────────

    [
        'clearCache: empties all entries',
        () => {
            resetForTest();
            cacheSearchResults('q', [{}]);
            cacheCrawlResult('https://x.com', {});
            assert(getCacheStats().entryCount > 0, 'entries exist before clear');

            clearCache();
            const stats = getCacheStats();
            assertEqual(stats.entryCount, 0, 'all entries removed');
        },
    ],

    // ── invalidateCacheEntry ───────────────────────────────────────────────

    [
        'invalidateCacheEntry: removes specific search entry',
        () => {
            resetForTest();
            cacheSearchResults('keep', [{ id: 'keep' }]);
            cacheSearchResults('remove', [{ id: 'remove' }]);
            assertEqual(getCacheStats().entryCount, 2, 'two entries');

            invalidateCacheEntry('search', 'remove');
            const stats = getCacheStats();
            assertEqual(stats.entryCount, 1, 'one remaining');
            assertEqual(getCachedSearchResults('remove'), null, 'removed entry gone');
            assert(getCachedSearchResults('keep') !== null, 'kept entry still there');
        },
    ],

    [
        'invalidateCacheEntry: removes specific crawl entry',
        () => {
            resetForTest();
            cacheCrawlResult('https://keep.com', {});
            cacheCrawlResult('https://remove.com', {});
            assertEqual(getCacheStats().entryCount, 2, 'two entries');

            invalidateCacheEntry('crawl', 'https://remove.com');
            assertEqual(getCacheStats().entryCount, 1, 'one remaining');
            assertEqual(getCachedCrawlResult('https://remove.com'), null, 'removed');
            assert(getCachedCrawlResult('https://keep.com') !== null, 'kept');
        },
    ],

    [
        'invalidateCacheEntry: nonexistent key does nothing',
        () => {
            resetForTest();
            cacheSearchResults('real', [{}]);
            invalidateCacheEntry('search', 'nonexistent');
            assertEqual(getCacheStats().entryCount, 1, 'still one entry');
        },
    ],

    // ── LRU eviction ───────────────────────────────────────────────────────
    // The cache prunes to DEFAULT_MAX_ENTRIES=500 on every write.
    // We test with a smaller effective limit by filling beyond it.

    [
        'cache eviction: old entries removed when over limit',
        () => {
            resetForTest();
            // Fill with many entries — the limit is 500, so we add 510
            for (let i = 0; i < 510; i++) {
                cacheSearchResults(`query-${i}`, [{ id: i }]);
            }
            const stats = getCacheStats();
            assert(stats.entryCount <= 500, 'pruned to max entries');
            // The oldest (query-0...query-9) should be evicted
            assertEqual(getCachedSearchResults('query-0'), null, 'oldest evicted');
            assertEqual(getCachedSearchResults('query-1'), null, 'second oldest evicted');
            // Recent ones should survive
            assert(getCachedSearchResults('query-509') !== null, 'most recent survives');
        },
    ],

    [
        'getAllCacheEntries: newest first + key included',
        () => {
            resetForTest();
            cacheSearchResults('first query', [{ title: 'a' }]);
            cacheSearchResults('second query', [{ title: 'b' }]);
            const entries = getAllCacheEntries();
            assertEqual(entries.length, 2, 'two entries');
            assertEqual(entries[0].query, 'second query', 'newest entry first');
            assert(entries[0].key, 'entry includes its cache key');
            assertEqual(entries[0].type, 'search', 'type preserved');
        },
    ],
    // ── Persistence ────────────────────────────────────────────────────────

    [
        'flushCacheSync: pending writes reach disk and reload from it',
        () => {
            resetForTest();
            cacheSearchResults('persisted query', [{ title: 'kept' }]);
            assert(
                !readTextFile(CACHE_PATH).includes('persisted query'),
                'write is debounced until flush',
            );

            flushCacheSync();
            assert(
                readTextFile(CACHE_PATH).includes('persisted query'),
                'flushCacheSync wrote the entry to disk',
            );

            _setCachePathForTesting(CACHE_PATH); // force a reload from disk
            const cached = getCachedSearchResults('persisted query');
            assert(cached !== null, 'entry survives a reload');
            assertEqual(cached[0].title, 'kept', 'payload intact');
        },
    ],

    [
        'cleanup checkpoint file for the checkpoint tests',
        () => {
            clearResearchCheckpoint();
            assertEqual(loadResearchCheckpoint(), null, 'starts with no checkpoint');
        },
    ],

    // ── Research checkpoints (crash recovery) ──────────────────────────────

    [
        'checkpoint: save → load round-trips and trims oversized findings',
        () => {
            clearResearchCheckpoint();
            saveResearchCheckpoint({
                plan: [{ id: 'branch-1', topic: 'Alpha' }],
                originalQuery: 'What is X?',
                branchResults: [
                    {
                        topic: 'Alpha',
                        findings: 'a'.repeat(9000),
                        facts: ['fact one'],
                        sources: ['https://example.com/a'],
                        pageCount: 3,
                    },
                ],
                refinementResults: [],
                gapRationale: 'gap',
                synthesisOutline: 'outline',
                citationEntries: [1, 2, 3],
                urlToNumber: [['https://example.com/a', 1]],
                globalContext: {
                    summaries: [{ topic: 'Alpha', gist: 'short gist', sourceCount: 2 }],
                },
                messageHistoryLength: 7,
                conversationId: 'conv_1',
            });

            const loaded = loadResearchCheckpoint();
            assert(loaded, 'checkpoint loaded');
            assertEqual(loaded.version, 2, 'version stamped');
            assertEqual(loaded.originalQuery, 'What is X?', 'query preserved');
            assertEqual(loaded.plan.length, 1, 'plan preserved');
            assertEqual(loaded.conversationId, 'conv_1', 'conversation id preserved');
            assertEqual(loaded.messageHistoryLength, 7, 'history length preserved');
            assertEqual(loaded.branchResults[0].topic, 'Alpha', 'branch topic preserved');
            assertEqual(loaded.branchResults[0].pageCount, 3, 'page count preserved');
            assertDeepEqual(loaded.branchResults[0].facts, ['fact one'], 'facts preserved');
            assert(
                loaded.branchResults[0].findings.length < 9000,
                'oversized findings were trimmed',
            );
            assert(
                loaded.branchResults[0].findings.includes('[...checkpoint truncated...]'),
                'trim marker present',
            );
        },
    ],

    [
        'checkpoint: an outdated version is discarded',
        () => {
            writeCheckpointFile(JSON.stringify({ version: 1, plan: [] }));
            assertEqual(loadResearchCheckpoint(), null, 'v1 payload rejected');
            assert(
                !GLib.file_test(CHECKPOINT_PATH, GLib.FileTest.EXISTS),
                'outdated checkpoint deleted',
            );
        },
    ],

    [
        'checkpoint: corrupt JSON is discarded without throwing',
        () => {
            writeCheckpointFile('{not valid json');
            assertEqual(loadResearchCheckpoint(), null, 'corrupt payload → null');
        },
    ],

    [
        'checkpoint: a plan-less payload is rejected',
        () => {
            writeCheckpointFile(JSON.stringify({ version: 2, plan: 'nope' }));
            assertEqual(loadResearchCheckpoint(), null, 'missing plan array → null');
        },
    ],

    [
        'checkpoint: clearResearchCheckpoint deletes the file',
        () => {
            saveResearchCheckpoint({ plan: [{ id: 'x' }], originalQuery: 'q' });
            assert(GLib.file_test(CHECKPOINT_PATH, GLib.FileTest.EXISTS), 'checkpoint written');
            clearResearchCheckpoint();
            assert(
                !GLib.file_test(CHECKPOINT_PATH, GLib.FileTest.EXISTS),
                'checkpoint file deleted',
            );
            assertEqual(loadResearchCheckpoint(), null, 'nothing to load after clear');
        },
    ],

    [
        'cleanup: restore the real paths and remove the temp dir',
        () => {
            _setCachePathForTesting(null);
            _setCheckpointPathForTesting(null);
            clearResearchCheckpoint();
            removeTempDir(TEMP_DIR);
            assert(!GLib.file_test(CACHE_PATH, GLib.FileTest.EXISTS), 'temp cache removed');
        },
    ],
];

await runTests(tests);
