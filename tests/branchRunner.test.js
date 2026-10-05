// branchRunner.test.js — Tests for the research branch runner module
// (single-branch execution, sequential orchestration, refinement mini-branches).
import {
    MID_RESEARCH_CRITIQUE_INTERVAL,
    MAX_TOTAL_SPAWNED_BRANCHES,
    REFINEMENT_CRAWL_COUNT,
    RESEARCH_BRANCH_BACKOFF_MS,
    RESEARCH_BRANCH_MAX_RETRIES,
    RESEARCH_PROGRESS_COMPRESSING,
    RESEARCH_PROGRESS_DONE,
    RESEARCH_PROGRESS_ERROR,
    RESEARCH_PROGRESS_REFINING,
    RESEARCH_PROGRESS_SCRAPING,
    RESEARCH_PROGRESS_SEARCHING,
    executeResearchBranch,
    runRefinementResearch,
    runResearchBranches,
    selectFollowLinks,
    serviceDownError,
} from '../src/research/branchRunner.js';
import { createCitationTracker } from '../src/research/citationTracker.js';
import { assert, assertEqual, runTests } from './testUtils.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

async function expectReject(promise, check, label) {
    let err = null;
    try {
        await promise;
    } catch (e) {
        err = e;
    }
    if (!err) throw new Error(`${label}: expected rejection`);
    if (check && !check(err)) {
        throw new Error(`${label}: rejection did not match (code=${err.code}: ${err.message})`);
    }
}

function searchResult(url, title = 'T', snippet = 'S') {
    return { url, title, snippet };
}

/**
 * Build a host bag + call recorder for the branch runner module.
 */
function makeHost(overrides = {}) {
    const calls = {
        progress: [],
        search: [],
        crawl: [],
        checkpoints: [],
        timeline: [],
        pageReads: [],
        searchCards: [],
        sleeps: [],
        llm: [],
    };
    const tracker = createCitationTracker();
    let globalContext = null;

    const host = {
        webSearch: async (query, cfg, c) => {
            calls.search.push({ query, cfg, c });
            return {
                results: [
                    searchResult(`https://${query}.example`, `Title ${query}`, 'A'.repeat(80)),
                ],
            };
        },
        crawl: async (url, cfg, c) => {
            calls.crawl.push({ url, cfg, c });
            return [];
        },
        requestCompletion: async (messages, opts) => {
            calls.llm.push({ messages, opts });
            return JSON.stringify([
                { claim: 'Fact one', anchor: 'anchor text', url: 'https://one.example' },
            ]);
        },
        modelOverride: 'comp-x',
        getCancellable: () => 'ct',
        isCancelled: (e) => e?.code === 'cancelled',
        isTransient: (e) =>
            ['connection-failed', 'timeout', 'rate-limited', 'network-error'].includes(e?.code),
        sleep: async (ms) => {
            calls.sleeps.push(ms);
        },
        getConfig: () => ({ webSearchConfig: { ws: true }, crawl4aiConfig: { c4: true } }),
        getOriginalQuery: () => 'orig query',
        getCitationTracker: () => tracker,
        getGlobalContext: () => globalContext,
        setGlobalContext: (ctx) => {
            globalContext = ctx;
        },
        getActivePlanLength: () => 3,
        getPipelineHost: () => ({
            requestCompletion: async () => '{}',
            modelOverride: null,
            getCancellable: () => null,
            isCancelled: () => false,
        }),
        updateProgress: (index, status, detail) => calls.progress.push({ index, status, detail }),
        addTimelineEntry: (phase, iconName, title, desc) => {
            const ref = { phase, iconName, title, desc };
            calls.timeline.push(ref);
            return ref;
        },
        addSearchResultCards: (ref, results) => calls.searchCards.push({ ref, results }),
        addPageReadProgress: (ref, url, status, detail) =>
            calls.pageReads.push({ url, status, detail }),
        formatBytes: (n) => `${n}B`,
        extendProgressCardForRefinement: (queries) => {
            calls.refineExtend = queries.length;
        },
        saveCheckpoint: (label) => calls.checkpoints.push(label),
        ...overrides,
    };
    return { calls, host, tracker, getGlobalContext: () => globalContext };
}

// ── Tests ───────────────────────────────────────────────────────────────────

const tests = [
    // ── Constants / factory ─────────────────────────────────────────────
    [
        'constants: retry + critique budgets',
        () => {
            assertEqual(RESEARCH_BRANCH_MAX_RETRIES, 2, 'max retries');
            assertEqual(RESEARCH_BRANCH_BACKOFF_MS[0], 2000, 'first backoff');
            assertEqual(RESEARCH_BRANCH_BACKOFF_MS[1], 5000, 'second backoff');
            assertEqual(REFINEMENT_CRAWL_COUNT, 2, 'refinement crawl count');
            assertEqual(MID_RESEARCH_CRITIQUE_INTERVAL, 2, 'critique interval');
            assertEqual(MAX_TOTAL_SPAWNED_BRANCHES, 3, 'spawn budget');
        },
    ],

    [
        'serviceDownError: carries the actionable guidance + error code',
        () => {
            const err = serviceDownError(new Error('connect refused'));
            assertEqual(err.code, 'research-service-down', 'code');
            assert(err.message.includes('SearxNG'), 'mentions SearxNG');
            assert(err.message.includes('connect refused'), 'includes cause');
            const bare = serviceDownError(null);
            assert(bare.message.includes('Connection failed.'), 'null cause fallback');
        },
    ],

    // ── executeResearchBranch ───────────────────────────────────────────
    [
        'executeResearchBranch: non-transient search failure returns empty result + error progress',
        async () => {
            const { calls, host } = makeHost({
                webSearch: async () => {
                    throw Object.assign(new Error('blocked'), { code: 'blocked-host' });
                },
            });
            const res = await executeResearchBranch(
                host,
                { sub_task: 'T', search_query: 'q', index: 0 },
                { webSearchConfig: {}, crawl4aiConfig: {} },
                'ct',
            );
            assertEqual(res.findings, '', 'no findings');
            assertEqual(res.pageCount, 0, 'no pages');
            assertEqual(calls.progress[0].status, RESEARCH_PROGRESS_SEARCHING, 'searching first');
            assert(
                calls.progress.some(
                    (p) => p.status === RESEARCH_PROGRESS_ERROR && p.detail === 'Search failed',
                ),
                'error progress',
            );
        },
    ],

    [
        'executeResearchBranch: no search results short-circuits with DONE',
        async () => {
            const { calls, host } = makeHost({ webSearch: async () => ({ results: [] }) });
            const res = await executeResearchBranch(
                host,
                { sub_task: 'T', search_query: 'q', index: 1 },
                { webSearchConfig: {}, crawl4aiConfig: {} },
                'ct',
            );
            assertEqual(res.findings, '', 'no findings');
            assert(
                calls.progress.some(
                    (p) => p.status === RESEARCH_PROGRESS_DONE && p.detail === 'No results found',
                ),
                'done progress',
            );
            assertEqual(calls.crawl.length, 0, 'no crawls');
        },
    ],

    [
        'executeResearchBranch: transient search error re-throws for the retry loop',
        async () => {
            const err = Object.assign(new Error('timeout'), { code: 'timeout' });
            const { host } = makeHost({
                webSearch: async () => {
                    throw err;
                },
            });
            await expectReject(
                executeResearchBranch(
                    host,
                    { sub_task: 'T', search_query: 'q', index: 0 },
                    { webSearchConfig: {}, crawl4aiConfig: {} },
                    'ct',
                ),
                (e) => e === err,
                'transient rethrow',
            );
        },
    ],

    [
        'executeResearchBranch: cancellation re-throws before transient handling',
        async () => {
            const err = Object.assign(new Error('cancelled'), { code: 'cancelled' });
            const { host } = makeHost({
                webSearch: async () => {
                    throw err;
                },
            });
            await expectReject(
                executeResearchBranch(
                    host,
                    { sub_task: 'T', search_query: 'q', index: 0 },
                    { webSearchConfig: {}, crawl4aiConfig: {} },
                    'ct',
                ),
                (e) => e === err,
                'cancel rethrow',
            );
        },
    ],

    [
        'executeResearchBranch: covered URLs are skipped when novel alternatives exist',
        async () => {
            const ctx = {
                summaries: [],
                coveredUrls: new Set(['https://a.example']),
                keyFacts: [],
            };
            const { calls, host } = makeHost({
                webSearch: async () => ({
                    results: [
                        searchResult('https://a.example'),
                        searchResult('https://b.example'),
                        searchResult('https://c.example'),
                    ],
                }),
            });
            // global context override
            const hostWithCtx = { ...host, getGlobalContext: () => ctx };
            const res = await executeResearchBranch(
                hostWithCtx,
                { sub_task: 'T', search_query: 'my query', index: 0 },
                { webSearchConfig: {}, crawl4aiConfig: {} },
                'ct',
            );
            assertEqual(calls.crawl.length, 2, 'crawled only the novel URLs');
            assertEqual(calls.crawl[0].url, 'https://b.example', 'first novel URL');
            assertEqual(calls.crawl[1].url, 'https://c.example', 'second novel URL');
            assertEqual(calls.crawl[0].cfg.query, 'my query', 'query injected into crawl config');
            assert(
                res.findings.includes('Search results for "my query"'),
                'snippet fallback findings',
            );
        },
    ],

    [
        'executeResearchBranch: snippet fallback registers sources in the citation tracker',
        async () => {
            const { host, tracker } = makeHost({
                webSearch: async () => ({
                    results: [
                        searchResult('https://a.example'),
                        searchResult('https://b.example'),
                        searchResult('https://c.example'),
                    ],
                }),
            });
            const res = await executeResearchBranch(
                host,
                { sub_task: 'T', search_query: 'q', index: 0 },
                { webSearchConfig: {}, crawl4aiConfig: {} },
                'ct',
            );
            assertEqual(tracker.urlToNumber.size, 3, 'three source URLs numbered');
            assertEqual(res.sources.length, 3, 'three sources in result');
        },
    ],

    [
        'executeResearchBranch: successful crawl + compression registers facts and findings',
        async () => {
            const { calls, host, tracker } = makeHost({
                crawl: async (url) => [{ success: true, fitMarkdown: 'Page body about widgets.' }],
            });
            const res = await executeResearchBranch(
                host,
                { sub_task: 'T', search_query: 'q', index: 0 },
                { webSearchConfig: {}, crawl4aiConfig: {} },
                'ct',
            );
            assertEqual(res.pageCount, 1, 'one page');
            assertEqual(res.facts.length, 1, 'one fact');
            assert(res.findings.includes('Fact one'), 'merged findings include the fact');
            assertEqual(tracker.entries.length, 1, 'fact registered');
            assertEqual(calls.llm[0].opts.modelOverride, 'comp-x', 'compression model override');
            assert(
                calls.progress.some((p) => p.status === RESEARCH_PROGRESS_COMPRESSING),
                'compressing progress',
            );
            assert(
                calls.progress.some(
                    (p) => p.status === RESEARCH_PROGRESS_DONE && p.detail === '1 pages, 1 facts',
                ),
                'done progress',
            );
        },
    ],

    [
        'executeResearchBranch: a throw inside the compression block falls back to raw pages',
        async () => {
            const { host } = makeHost({
                crawl: async (url) => [{ success: true, fitMarkdown: 'Page body about widgets.' }],
                getCitationTracker: () => {
                    throw new Error('tracker boom');
                },
            });
            const res = await executeResearchBranch(
                host,
                { sub_task: 'T', search_query: 'q', index: 0 },
                { webSearchConfig: {}, crawl4aiConfig: {} },
                'ct',
            );
            assert(res.findings.startsWith('### Page: https://q.example'), 'raw-page fallback');
            assert(res.findings.includes('Page body about widgets.'), 'raw page text included');
        },
    ],

    // ── runResearchBranches ─────────────────────────────────────────────
    [
        'runResearchBranches: two branches run sequentially with checkpoints + context sharing',
        async () => {
            const plan = [
                { sub_task: 'Angle A', search_query: 'q1' },
                { sub_task: 'Angle B', search_query: 'q2' },
            ];
            const { calls, host, getGlobalContext } = makeHost();
            const results = await runResearchBranches(host, plan);
            assertEqual(results.length, 2, 'two results');
            assertEqual(calls.search.length, 2, 'two searches');
            assertEqual(calls.checkpoints.length, 2, 'checkpoint per branch');
            assertEqual(calls.checkpoints[0], 'branch 1/2', 'first checkpoint label');
            assertEqual(calls.checkpoints[1], 'branch 2/2', 'second checkpoint label');
            const ctx = getGlobalContext();
            assertEqual(ctx.summaries.length, 2, 'summaries pushed');
            assertEqual(ctx.coveredUrls.size, 2, 'covered urls tracked');
            // The cross-branch mechanism is the covered-URL filter (asserted above);
            // no per-task context note is attached (dead wiring removed).
            assertEqual(plan[1]._contextAware, undefined, 'no dead context note attached');
            // Timeline entries were created per branch and search cards were attached.
            assertEqual(calls.timeline.length, 2, 'timeline entries');
            assertEqual(calls.searchCards.length, 2, 'search result cards attached');
            // No critique with a 2-branch plan.
            assertEqual(calls.llm.length, 0, 'no LLM calls (snippet path only)');
        },
    ],

    [
        'runResearchBranches: transient branch failure retries with backoff then succeeds',
        async () => {
            let attempts = 0;
            const { calls, host } = makeHost({
                webSearch: async (query) => {
                    attempts += 1;
                    if (attempts === 1)
                        throw Object.assign(new Error('timeout'), { code: 'timeout' });
                    return { results: [searchResult(`https://${query}.example`)] };
                },
            });
            const plan = [{ sub_task: 'A', search_query: 'q1' }];
            const results = await runResearchBranches(host, plan);
            assertEqual(results[0].pageCount, 0, 'snippet result after retry');
            assert(results[0].findings.length > 0, 'findings present');
            assertEqual(calls.sleeps.length, 1, 'one backoff sleep');
            assertEqual(calls.sleeps[0], 2000, 'first backoff delay');
            assert(
                calls.progress.some(
                    (p) => p.detail === `Retry 1/${RESEARCH_BRANCH_MAX_RETRIES}...`,
                ),
                'retry progress',
            );
        },
    ],

    [
        'runResearchBranches: service-down aborts the whole run with research-service-down',
        async () => {
            const { calls, host } = makeHost({
                webSearch: async () => {
                    throw Object.assign(new Error('refused'), { code: 'connection-failed' });
                },
            });
            const plan = [
                { sub_task: 'A', search_query: 'q1' },
                { sub_task: 'B', search_query: 'q2' },
            ];
            await expectReject(
                runResearchBranches(host, plan),
                (e) => e.code === 'research-service-down',
                'service down',
            );
            assertEqual(calls.checkpoints.length, 0, 'no checkpoints saved');
            assert(
                calls.progress.some((p) => p.detail === 'Aborted — service unreachable'),
                'abort progress',
            );
            // Both branches marked aborted (current + remaining).
            assertEqual(
                calls.progress.filter((p) => p.detail === 'Aborted — service unreachable').length,
                2,
                'all branches marked',
            );
        },
    ],

    [
        'runResearchBranches: mid-research critique stops the loop when findings are sufficient',
        async () => {
            const { calls, host } = makeHost({
                getPipelineHost: () => ({
                    requestCompletion: async () => '{"sufficient":true}',
                    modelOverride: null,
                    getCancellable: () => null,
                    isCancelled: () => false,
                }),
            });
            const plan = [
                { sub_task: 'A', search_query: 'q1' },
                { sub_task: 'B', search_query: 'q2' },
                { sub_task: 'C', search_query: 'q3' },
                { sub_task: 'D', search_query: 'q4' },
            ];
            const results = await runResearchBranches(host, plan);
            assertEqual(results.length, 2, 'stopped after 2 branches');
            assertEqual(calls.search.length, 2, 'only two searches ran');
            assertEqual(
                calls.progress.filter((p) => p.detail === 'Skipped (sufficient)').length,
                2,
                'remaining marked skipped',
            );
        },
    ],

    [
        'runResearchBranches: critique drops and spawns angles (bounded)',
        async () => {
            const { calls, host } = makeHost({
                getPipelineHost: () => ({
                    requestCompletion: async () =>
                        JSON.stringify({
                            sufficient: false,
                            drop_indices: [0],
                            new_branches: [{ sub_task: 'Spawned', search_query: 'qs' }],
                        }),
                    modelOverride: null,
                    getCancellable: () => null,
                    isCancelled: () => false,
                }),
            });
            const plan = [
                { sub_task: 'A', search_query: 'q1' },
                { sub_task: 'B', search_query: 'q2' },
                { sub_task: 'C', search_query: 'q3' },
            ];
            const results = await runResearchBranches(host, plan);
            assertEqual(results.length, 4, 'dropped slot + spawned branch included');
            assertEqual(results[2].findings, '', 'dropped branch produced empty result');
            assertEqual(results[3].topic, 'Spawned', 'spawned branch executed');
            assert(
                calls.search.some((s) => s.query === 'qs'),
                'spawned query searched',
            );
            assert(!calls.search.some((s) => s.query === 'q3'), 'dropped branch never searched');
            assertEqual(plan.length, 4, 'spawned branch appended to plan');
            assert(
                calls.progress.some((p) => p.detail === 'Skipped (redundant)'),
                'drop progress',
            );
        },
    ],

    // ── runRefinementResearch ───────────────────────────────────────────
    [
        'runRefinementResearch: empty gap queries short-circuit',
        async () => {
            const { host } = makeHost();
            const res = await runRefinementResearch(host, []);
            assertEqual(res.length, 0, 'no results');
        },
    ],

    [
        'runRefinementResearch: crawls only the top 2 results and uses plan-offset indices',
        async () => {
            const { calls, host } = makeHost({
                webSearch: async () => ({
                    results: [
                        searchResult('https://r1.example'),
                        searchResult('https://r2.example'),
                        searchResult('https://r3.example'),
                    ],
                }),
            });
            const res = await runRefinementResearch(host, [
                { rationale: 'Gap R', search_query: 'gq' },
            ]);
            assertEqual(res.length, 1, 'one refinement result');
            assertEqual(calls.crawl.length, REFINEMENT_CRAWL_COUNT, 'only 2 crawls');
            assertEqual(calls.progress[0].index, 3, 'refIndex offset by active plan length');
            assertEqual(calls.progress[0].status, RESEARCH_PROGRESS_REFINING, 'refining progress');
            assertEqual(calls.progress[1].status, RESEARCH_PROGRESS_SCRAPING, 'scraping progress');
            assertEqual(calls.refineExtend, 1, 'progress card extended');
            assert(res[0].findings.includes('Refinement search for "gq"'), 'snippet fallback');
            assertEqual(res[0].sources.length, 3, 'sources from search results');
        },
    ],

    [
        'runRefinementResearch: service-down aborts with research-service-down',
        async () => {
            const { host } = makeHost({
                webSearch: async () => {
                    throw Object.assign(new Error('refused'), { code: 'connection-failed' });
                },
            });
            await expectReject(
                runRefinementResearch(host, [{ rationale: 'Gap R', search_query: 'gq' }]),
                (e) => e.code === 'research-service-down',
                'refinement service down',
            );
        },
    ],

    [
        'runRefinementResearch: search failure yields an empty result and keeps going',
        async () => {
            const { calls, host } = makeHost({
                webSearch: async () => {
                    throw Object.assign(new Error('nope'), { code: 'bad-request' });
                },
            });
            const res = await runRefinementResearch(host, [
                { rationale: 'Gap R', search_query: 'gq' },
            ]);
            assertEqual(res.length, 1, 'one result entry');
            assertEqual(res[0].findings, '', 'empty findings');
            assert(
                calls.progress.some((p) => p.status === RESEARCH_PROGRESS_ERROR),
                'error progress',
            );
        },
    ],

    // ── selectFollowLinks + progressive browsing ─────────────────────────

    [
        'selectFollowLinks: scores, caps, excludes, and prefers internal links',
        () => {
            const pages = [
                {
                    url: 'https://site.example/start',
                    links: [
                        {
                            href: 'https://site.example/engine-error-handling',
                            text: 'Engine error handling',
                        },
                        {
                            href: 'https://other.example/engine-errors',
                            text: 'Engine errors guide',
                            external: true,
                        },
                        { href: 'https://site.example/unrelated', text: 'Unrelated topic' },
                        {
                            href: 'https://site.example/engine-error-handling#top',
                            text: 'Engine error handling',
                        },
                    ],
                },
            ];
            const selected = selectFollowLinks(pages, 'engine error', {
                exclude: new Set(['https://site.example/unrelated']),
                max: 2,
            });
            assertEqual(selected.length, 2, 'capped at max');
            assertEqual(
                selected[0].href,
                'https://site.example/engine-error-handling',
                'internal link first',
            );
            assert(
                selected.every((l) => l.score > 0),
                'only links with a keyword match are selected',
            );
        },
    ],

    [
        'selectFollowLinks: safe on empty input and stopword-only queries',
        () => {
            assertEqual(selectFollowLinks([], 'q', {}).length, 0, 'no pages');
            const selected = selectFollowLinks(
                [
                    {
                        url: 'https://a.example',
                        links: [{ href: 'https://a.example/x', text: 'X' }],
                    },
                ],
                'the docs page',
                {},
            );
            assertEqual(selected.length, 0, 'stopword-only query selects nothing');
            assertEqual(
                selectFollowLinks(
                    [
                        {
                            url: 'https://a.example',
                            links: [{ href: 'https://a.example/engine', text: 'Engine' }],
                        },
                    ],
                    'engine',
                    { max: 0 },
                ).length,
                0,
                'max 0 disables following',
            );
        },
    ],

    [
        'executeResearchBranch: follows scored subpage links in raw markdown mode',
        async () => {
            const { calls, host } = makeHost({
                webSearch: async () => ({
                    results: [searchResult('https://start.example/page', 'Start', 'S'.repeat(80))],
                }),
                crawl: async (url, cfg, c) => {
                    calls.crawl.push({ url, cfg, c });
                    if (url === 'https://start.example/page') {
                        return [
                            {
                                success: true,
                                fitMarkdown: 'Overview page about engine error handling.',
                                links: [
                                    {
                                        href: 'https://start.example/engine-errors',
                                        text: 'Engine error handling',
                                    },
                                    { href: 'https://start.example/other', text: 'Other topic' },
                                ],
                            },
                        ];
                    }
                    return [{ success: true, fitMarkdown: `Detail page for ${url}` }];
                },
            });
            const result = await executeResearchBranch(
                host,
                { sub_task: 'Engine errors', search_query: 'engine error handling', index: 0 },
                {
                    webSearchConfig: { ws: true },
                    crawl4aiConfig: {
                        c4: true,
                        extractionMode: 'llm-schema',
                        followLinksEnabled: true,
                        maxFollowLinks: 2,
                    },
                },
                'ct',
            );
            const urls = calls.crawl.map((entry) => entry.url);
            assert(
                urls.includes('https://start.example/engine-errors'),
                'followed the relevant subpage',
            );
            assert(!urls.includes('https://start.example/other'), 'unrelated link not followed');
            assertEqual(calls.crawl[0].cfg.extractionMode, 'markdown', 'raw markdown crawl');
            assertEqual(result.pageCount, 2, 'followed page counted');
        },
    ],

    [
        'executeResearchBranch: follow pass can be disabled',
        async () => {
            const { calls, host } = makeHost({
                webSearch: async () => ({ results: [searchResult('https://start.example/page')] }),
                crawl: async (url, cfg, c) => {
                    calls.crawl.push({ url, cfg, c });
                    return [
                        {
                            success: true,
                            fitMarkdown: 'Page about engines.',
                            links: [{ href: 'https://start.example/engine', text: 'Engine' }],
                        },
                    ];
                },
            });
            await executeResearchBranch(
                host,
                { sub_task: 'S', search_query: 'engine', index: 0 },
                {
                    webSearchConfig: {},
                    crawl4aiConfig: { followLinksEnabled: false, maxFollowLinks: 3 },
                },
                null,
            );
            assertEqual(calls.crawl.length, 1, 'no follow crawls when disabled');
        },
    ],
];

await runTests(tests);
