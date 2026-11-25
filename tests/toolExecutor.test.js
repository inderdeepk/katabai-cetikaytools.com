// toolExecutor.test.js — Unit tests for the tool execution engine:
// argument repair, ID sanitization & deduplication, turn-scoped caching,
// bounded concurrent read-only batching, in-flight deduplication, serial
// unsafe execution with KB cache invalidation, and linked timeout cancellation.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import {
    DEFAULT_TOOL_TIMEOUT_MS,
    TOOL_TIMEOUTS_MS,
    getToolTimeoutMs,
    createLinkedTimeoutCancellable,
    parseToolCallArguments,
    sanitizeToolCallId,
    normalizeToolCalls,
    canonicalizeValue,
    buildToolCacheKey,
    ToolExecutionSession,
    formatElapsedMs,
    executeToolBatch,
} from '../src/tools/toolExecutor.js';
import { DANGER_POTENTIALLY_UNSAFE, DANGER_READ_ONLY } from '../src/tools/toolRegistry.js';
import { assert, assertEqual, assertDeepEqual, runTests } from './testUtils.js';

function delayMs(ms) {
    return new Promise((resolve) => {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        });
    });
}

const tests = [
    // ── getToolTimeoutMs / formatElapsedMs ─────────────────────────────────

    [
        'getToolTimeoutMs: returns tool-specific timeout or default fallback',
        () => {
            assertEqual(getToolTimeoutMs('web_search'), TOOL_TIMEOUTS_MS.web_search, 'web_search');
            assertEqual(getToolTimeoutMs('crawl_url'), TOOL_TIMEOUTS_MS.crawl_url, 'crawl_url');
            assertEqual(getToolTimeoutMs('ask_user'), 0, 'ask_user disables timeout');
            assertEqual(
                getToolTimeoutMs('unknown_custom_tool'),
                DEFAULT_TOOL_TIMEOUT_MS,
                'fallback',
            );
        },
    ],

    [
        'formatElapsedMs: formats ms, tenths of a second, and whole seconds',
        () => {
            assertEqual(formatElapsedMs(0), '0ms', 'zero');
            assertEqual(formatElapsedMs(42), '42ms', 'sub-100ms');
            assertEqual(formatElapsedMs(450), '0.5s', 'sub-10s');
            assertEqual(formatElapsedMs(12400), '12s', '10s+');
            assertEqual(formatElapsedMs(-5), '', 'negative');
            assertEqual(formatElapsedMs(NaN), '', 'NaN');
        },
    ],

    // ── parseToolCallArguments ─────────────────────────────────────────────

    [
        'parseToolCallArguments: handles null, undefined, empty string, objects, and valid JSON',
        () => {
            assertDeepEqual(parseToolCallArguments(null), {
                ok: true,
                args: {},
                repaired: false,
                error: null,
            });
            assertDeepEqual(parseToolCallArguments(undefined), {
                ok: true,
                args: {},
                repaired: false,
                error: null,
            });
            assertDeepEqual(parseToolCallArguments('   '), {
                ok: true,
                args: {},
                repaired: false,
                error: null,
            });
            assertDeepEqual(parseToolCallArguments({ query: 'rust' }), {
                ok: true,
                args: { query: 'rust' },
                repaired: false,
                error: null,
            });
            assertDeepEqual(parseToolCallArguments('{"query":"rust","limit":5}'), {
                ok: true,
                args: { query: 'rust', limit: 5 },
                repaired: false,
                error: null,
            });
        },
    ],

    [
        'parseToolCallArguments: rejects arrays and primitive values with structured error',
        () => {
            const arrObj = parseToolCallArguments([1, 2]);
            assertEqual(arrObj.ok, false, 'array object rejected');
            assert(arrObj.error.includes('array'), 'mentions array');

            const arrStr = parseToolCallArguments('[1, 2]');
            assertEqual(arrStr.ok, false, 'array JSON rejected');

            const num = parseToolCallArguments(42);
            assertEqual(num.ok, false, 'number rejected');
        },
    ],

    [
        'parseToolCallArguments: repairs fenced JSON, trailing commas, and wrapper text',
        () => {
            const fenced = parseToolCallArguments('```json\n{"query": "gnome 46",}\n```');
            assertEqual(fenced.ok, true, 'fenced repaired');
            assertEqual(fenced.repaired, true, 'marked repaired');
            assertDeepEqual(fenced.args, { query: 'gnome 46' }, 'fenced value');

            const wrapped = parseToolCallArguments(
                'Sure! Here are the arguments: {"url": "https://a.example/{id}", "tags": ["a",],} thanks!',
            );
            assertEqual(wrapped.ok, true, 'wrapped repaired with braces inside string');
            assertEqual(wrapped.repaired, true, 'marked repaired');
            assertDeepEqual(
                wrapped.args,
                { url: 'https://a.example/{id}', tags: ['a'] },
                'extracted object preserves braces in string literals',
            );
        },
    ],

    [
        'parseToolCallArguments: returns actionable error on unrecoverable JSON',
        () => {
            const bad = parseToolCallArguments('{query: missing quotes');
            assertEqual(bad.ok, false, 'invalid rejected');
            assert(bad.error.includes('Invalid JSON'), 'error explains invalid JSON');
            assert(bad.error.includes('{query: missing quotes'), 'includes preview');
        },
    ],

    // ── sanitizeToolCallId / normalizeToolCalls ────────────────────────────

    [
        'sanitizeToolCallId: normalizes non-API-safe characters and falls back when empty',
        () => {
            assertEqual(sanitizeToolCallId('call:abc.123/x', 'fb'), 'call_abc_123_x', 'sanitized');
            assertEqual(sanitizeToolCallId('   ', 'fb_0'), 'fb_0', 'whitespace -> fallback');
            assertEqual(sanitizeToolCallId(null, 'fb_1'), 'fb_1', 'null -> fallback');
        },
    ],

    [
        'normalizeToolCalls: assigns unique IDs, skips empty names, and attaches non-enumerable _parsedArgs',
        () => {
            const normalized = normalizeToolCalls(
                [
                    null,
                    { id: 'dup', function: { name: 'web_search', arguments: '{"query":"a"}' } },
                    { id: 'dup', function: { name: 'web_search', arguments: '{"query":"b"}' } },
                    { id: '', function: { name: 'read_url', arguments: '{bad json' } },
                    {
                        id: 'anth_1',
                        _invalidJson: true,
                        _rawArguments: '{"url": broken',
                        function: { name: 'crawl_url', arguments: '{}' },
                    },
                    { id: 'empty_name', function: { name: '   ', arguments: '{}' } },
                ],
                { turnPrefix: 'turn1', iteration: 2 },
            );

            assertEqual(normalized.length, 4, '4 valid calls');
            assertEqual(normalized[0].id, 'dup', 'first dup keeps ID');
            assertEqual(normalized[1].id, 'dup_1', 'second dup gets unique suffix');
            assertEqual(normalized[2].id, 'turn1_2_3', 'missing ID gets deterministic fallback');
            assertEqual(normalized[2]._parsedArgs.ok, false, 'invalid JSON captured');
            assertEqual(
                normalized[2].function.arguments,
                '{bad json',
                'raw invalid JSON preserved',
            );
            assertEqual(
                normalized[3]._parsedArgs.ok,
                false,
                '_invalidJson/_rawArguments flagged as parse error',
            );
            assert(
                !Object.keys(normalized[0]).includes('_parsedArgs'),
                '_parsedArgs is non-enumerable',
            );
            assert(
                !JSON.stringify(normalized[0]).includes('_parsedArgs'),
                '_parsedArgs excluded from JSON.stringify',
            );
        },
    ],

    // ── canonicalizeValue / buildToolCacheKey / ToolExecutionSession ───────

    [
        'canonicalizeValue & buildToolCacheKey: key-order invariant and query/url normalized',
        () => {
            assertEqual(
                canonicalizeValue({ b: 2, a: 1, c: undefined }),
                canonicalizeValue({ a: 1, b: 2 }),
                'key order & undefined stripped',
            );
            assertEqual(
                buildToolCacheKey('web_search', { limit: 5, query: '  GNOME   Shell  ' }),
                buildToolCacheKey('web_search', { query: 'gnome shell', limit: 5 }),
                'query trimmed, collapsed, lowercased',
            );
            assertEqual(
                buildToolCacheKey('read_url', { url: '  https://example.com/Docs  ' }),
                buildToolCacheKey('read_url', { url: 'https://example.com/Docs' }),
                'url trimmed without altering path case',
            );
        },
    ],

    [
        'ToolExecutionSession: caches, formats large duplicate excerpts, and invalidates by tool',
        () => {
            const session = new ToolExecutionSession();
            const small = 'Short result';
            const large = 'L'.repeat(2000);

            session.setCached('knowledge_search', { query: 'auth' }, small, 0, '1 hit');
            session.setCached('read_url', { url: 'https://ex.com' }, large, 0, '2KB');

            const kbHit = session.getCached('knowledge_search', { query: '  AUTH ' });
            assert(kbHit, 'canonical cache hit');
            assertEqual(
                session.formatCachedResult('knowledge_search', kbHit, 2),
                small,
                'small cached output returned verbatim',
            );

            const urlHit = session.getCached('read_url', { url: 'https://ex.com' });
            assertEqual(
                session.formatCachedResult('read_url', urlHit, 0),
                large,
                'same-iteration large output returned verbatim',
            );
            const excerpt = session.formatCachedResult('read_url', urlHit, 1);
            assert(
                excerpt.includes('Duplicate call skipped'),
                'later-iteration large call trimmed',
            );
            assert(excerpt.length < large.length, 'excerpt is shorter than original');

            session.invalidateTool('knowledge_search');
            assertEqual(
                session.getCached('knowledge_search', { query: 'auth' }),
                null,
                'knowledge_search invalidated',
            );
            assert(
                session.getCached('read_url', { url: 'https://ex.com' }) !== null,
                'other tools kept intact',
            );
        },
    ],

    // ── createLinkedTimeoutCancellable ─────────────────────────────────────

    [
        'createLinkedTimeoutCancellable: propagates parent cancel and fires timeout',
        async () => {
            // Already-cancelled parent
            const preCancelled = new Gio.Cancellable();
            preCancelled.cancel();
            const linkedPre = createLinkedTimeoutCancellable(preCancelled, 5000);
            assert(linkedPre.cancellable.is_cancelled(), 'pre-cancelled child cancelled');
            assert(linkedPre.isParentCancelled(), 'parent cancelled flag');
            assertEqual(linkedPre.isTimedOut(), false, 'not timed out');
            linkedPre.cleanup();

            // Parent cancelled mid-flight
            const parent = new Gio.Cancellable();
            const linkedParent = createLinkedTimeoutCancellable(parent, 5000);
            assert(!linkedParent.cancellable.is_cancelled(), 'starts uncancelled');
            parent.cancel();
            assert(linkedParent.cancellable.is_cancelled(), 'parent cancel propagated');
            assert(linkedParent.isParentCancelled(), 'parent flag true');
            assertEqual(linkedParent.isTimedOut(), false, 'timeout flag false');
            linkedParent.cleanup();

            // Timeout triggers child cancel
            const liveParent = new Gio.Cancellable();
            const linkedTimeout = createLinkedTimeoutCancellable(liveParent, 25);
            await delayMs(60);
            assert(linkedTimeout.cancellable.is_cancelled(), 'timeout cancelled child');
            assertEqual(linkedTimeout.isTimedOut(), true, 'timedOut flag true');
            assertEqual(linkedTimeout.isParentCancelled(), false, 'parent still live');
            linkedTimeout.cleanup();

            // Cleanup cancels timeout before it fires
            const linkedClean = createLinkedTimeoutCancellable(liveParent, 25);
            linkedClean.cleanup();
            await delayMs(50);
            assert(!linkedClean.cancellable.is_cancelled(), 'cleaned up timeout never fires');
        },
    ],

    // ── executeToolBatch ───────────────────────────────────────────────────

    [
        'executeToolBatch: bounds read-only concurrency, deduplicates in-flight, and preserves order',
        async () => {
            const session = new ToolExecutionSession();
            const calls = normalizeToolCalls([
                { id: 'c0', function: { name: 'web_search', arguments: '{"query":"alpha"}' } },
                { id: 'c1', function: { name: 'update_knowledge', arguments: '{"content":"x"}' } },
                { id: 'c2', function: { name: 'web_search', arguments: '{"query":"  ALPHA  "}' } },
                { id: 'c3', function: { name: 'web_search', arguments: '{"query":"beta"}' } },
                { id: 'c4', function: { name: 'web_search', arguments: '{"query":"gamma"}' } },
            ]);

            let activeReadOnly = 0;
            let peakReadOnly = 0;
            const execOrder = [];
            const progressEvents = [];

            const results = await executeToolBatch({
                toolCalls: calls,
                session,
                iteration: 0,
                maxConcurrency: 2,
                classifyDanger: (name) =>
                    name === 'web_search' ? DANGER_READ_ONLY : DANGER_POTENTIALLY_UNSAFE,
                onProgress: (info) => {
                    progressEvents.push({ ...info });
                },
                executeOne: async (tc, meta) => {
                    if (meta.fromCache) {
                        return {
                            result: `REUSED:${meta.cachedEntry.result}`,
                            meta: { reused: true },
                        };
                    }
                    const name = tc.function.name;
                    execOrder.push(`${name}:${tc.id}`);
                    if (name === 'web_search') {
                        activeReadOnly++;
                        peakReadOnly = Math.max(peakReadOnly, activeReadOnly);
                        await delayMs(25);
                        activeReadOnly--;
                        return {
                            result: `RES:${meta.parsedArgs.args.query}`,
                            meta: { id: tc.id },
                        };
                    }
                    return { result: 'UPDATED', meta: { id: tc.id } };
                },
            });

            assertEqual(results.length, 5, '5 ordered results');
            assertEqual(peakReadOnly, 2, 'peak concurrency bounded to 2');
            // c0 and c2 are duplicates of "alpha" — only c0 executes, c2 is deduped follower
            assertEqual(session.stats.dedupedInFlight, 1, '1 in-flight dedup');
            assertEqual(results[0].toolCall.id, 'c0', 'order[0] preserved');
            assertEqual(results[1].toolCall.id, 'c1', 'order[1] preserved');
            assertEqual(results[2].toolCall.id, 'c2', 'order[2] preserved');
            assertEqual(results[2].deduped, true, 'c2 marked deduped');
            assertEqual(results[2].fromCache, true, 'c2 marked fromCache');
            assertEqual(results[2].result, 'REUSED:RES:alpha', 'c2 reused c0 result');
            assertDeepEqual(results[0].meta, { id: 'c0' }, 'meta passed through');
            assertDeepEqual(results[2].meta, { reused: true }, 'follower meta passed through');
            // Read-only calls run before unsafe update_knowledge
            assertEqual(
                execOrder[execOrder.length - 1],
                'update_knowledge:c1',
                'unsafe ran after read-only batch',
            );
            assert(progressEvents.length > 0, 'progress events emitted');
            assertEqual(
                progressEvents[progressEvents.length - 1].completed,
                5,
                'final progress completed === total',
            );
        },
    ],

    [
        'executeToolBatch: reuses turn cache across iterations and invalidates KB cache on mutation',
        async () => {
            const session = new ToolExecutionSession();
            let networkCalls = 0;

            const runIter = (rawCalls, iteration) =>
                executeToolBatch({
                    toolCalls: normalizeToolCalls(rawCalls, { iteration }),
                    session,
                    iteration,
                    classifyDanger: (name) =>
                        name === 'knowledge_search' ? DANGER_READ_ONLY : DANGER_POTENTIALLY_UNSAFE,
                    executeOne: async (tc, meta) => {
                        if (meta.fromCache) {
                            return { result: meta.cachedEntry.result };
                        }
                        networkCalls++;
                        if (tc.function.name === 'update_knowledge') {
                            return {
                                result: meta.parsedArgs.args.fail ? 'failed' : 'saved',
                                error: Boolean(meta.parsedArgs.args.fail),
                            };
                        }
                        return { result: `KB_HIT_${networkCalls}` };
                    },
                });

            // Iteration 0: populates cache
            const r0 = await runIter(
                [
                    {
                        id: 'k1',
                        function: { name: 'knowledge_search', arguments: '{"query":"api"}' },
                    },
                ],
                0,
            );
            assertEqual(r0[0].fromCache, false, 'iter 0 executes');
            assertEqual(r0[0].result, 'KB_HIT_1', 'iter 0 value');

            // Iteration 1: cache hit
            const r1 = await runIter(
                [
                    {
                        id: 'k2',
                        function: { name: 'knowledge_search', arguments: '{"query":"API"}' },
                    },
                ],
                1,
            );
            assertEqual(r1[0].fromCache, true, 'iter 1 hits turn cache');
            assertEqual(r1[0].result, 'KB_HIT_1', 'iter 1 returns cached result');
            assertEqual(networkCalls, 1, 'no extra execution on cache hit');
            assertEqual(session.stats.cacheHits, 1, 'cache hit recorded');

            // Iteration 2: failed update_knowledge does NOT invalidate cache
            await runIter(
                [
                    {
                        id: 'u_fail',
                        function: { name: 'update_knowledge', arguments: '{"fail":true}' },
                    },
                ],
                2,
            );
            assert(
                session.getCached('knowledge_search', { query: 'api' }) !== null,
                'failed update_knowledge keeps cache',
            );

            // Iteration 3: successful update_knowledge invalidates knowledge_search cache
            await runIter(
                [{ id: 'u_ok', function: { name: 'update_knowledge', arguments: '{}' } }],
                3,
            );
            assertEqual(
                session.getCached('knowledge_search', { query: 'api' }),
                null,
                'successful update_knowledge invalidates KB cache',
            );

            // Iteration 4: re-executes fresh search
            const r4 = await runIter(
                [
                    {
                        id: 'k3',
                        function: { name: 'knowledge_search', arguments: '{"query":"api"}' },
                    },
                ],
                4,
            );
            assertEqual(r4[0].fromCache, false, 'iter 4 executes fresh after invalidation');
            assertEqual(r4[0].result, 'KB_HIT_4', 'fresh result returned');
        },
    ],

    [
        'executeToolBatch: handles cancellation mid-batch and thrown tool errors gracefully',
        async () => {
            const cancellable = new Gio.Cancellable();
            const calls = normalizeToolCalls([
                { id: 'e1', function: { name: 'read_url', arguments: '{"url":"https://a.ex"}' } },
                { id: 'u1', function: { name: 'crawl_url', arguments: '{"url":"https://b.ex"}' } },
                { id: 'u2', function: { name: 'crawl_url', arguments: '{"url":"https://c.ex"}' } },
            ]);

            const results = await executeToolBatch({
                toolCalls: calls,
                cancellable,
                serialDelayMs: 40,
                classifyDanger: (name) =>
                    name === 'read_url' ? DANGER_READ_ONLY : DANGER_POTENTIALLY_UNSAFE,
                executeOne: async (tc) => {
                    if (tc.id === 'e1') {
                        throw new Error('network boom');
                    }
                    if (tc.id === 'u1') {
                        // Cancel before u2 runs
                        cancellable.cancel();
                        return { result: 'u1 done' };
                    }
                    return { result: 'u2 should not run' };
                },
            });

            assertEqual(results[0].error, true, 'thrown read-only marked error');
            assertEqual(results[0].cancelled, false, 'thrown error not marked cancelled');
            assert(results[0].result.includes('network boom'), 'error message preserved');
            assertEqual(results[1].result, 'u1 done', 'u1 completed');
            assertEqual(results[2].cancelled, true, 'u2 cancelled before starting');
            assertEqual(results[2].error, true, 'cancelled u2 flagged as error');
        },
    ],

    [
        'executeToolBatch: ask_user runs serially without artificial delay and zero-timeout cancellable does not auto-expire',
        async () => {
            const parent = new Gio.Cancellable();
            const guard = createLinkedTimeoutCancellable(parent, getToolTimeoutMs('ask_user'));
            await delayMs(20);
            assertEqual(guard.isTimedOut(), false, '0ms timeout never auto-fires');
            assertEqual(guard.cancellable.is_cancelled(), false, 'child stays active');
            guard.cleanup();

            const order = [];
            const calls = normalizeToolCalls([
                { id: 'u1', function: { name: 'update_knowledge', arguments: '{}' } },
                {
                    id: 'a1',
                    function: { name: 'ask_user', arguments: '{"question":"Continue?"}' },
                },
            ]);
            const startMs = Date.now();
            const results = await executeToolBatch({
                toolCalls: calls,
                serialDelayMs: 500,
                classifyDanger: () => DANGER_POTENTIALLY_UNSAFE,
                executeOne: async (tc) => {
                    order.push(tc.function.name);
                    return { result: `done:${tc.function.name}` };
                },
            });
            const elapsed = Date.now() - startMs;
            assertDeepEqual(order, ['update_knowledge', 'ask_user'], 'serial order preserved');
            assertEqual(results[1].result, 'done:ask_user', 'ask_user result preserved');
            assert(elapsed < 250, `expected no serialDelayMs before ask_user (took ${elapsed}ms)`);
        },
    ],
];

await runTests(tests);
