// researchPipeline.test.js — Tests for the research pipeline analysis phases.
import {
    GAP_ANALYSIS_MAX_TOKENS,
    CAUSAL_CHAIN_MAX_TOKENS,
    CAUSAL_CHAIN_MAX_QUERIES,
    MID_RESEARCH_CRITIQUE_MAX_TOKENS,
    runGapAnalysis,
    runRePlanningCritique,
    runCausalChainCheck,
} from '../src/research/pipeline.js';
import { assert, assertEqual, runTests } from './testUtils.js';

const BRANCHES = [{ topic: 'Topic A', findings: 'F'.repeat(120) }];

function makeHost(responses, extras = {}) {
    const calls = [];
    const host = {
        requestCompletion: async (messages, opts) => {
            calls.push({ messages, opts });
            const next = responses.shift();
            if (next instanceof Error) throw next;
            return next;
        },
        modelOverride: 'model-x',
        getCancellable: () => 'ct',
        isCancelled: (e) => e && e.isCancel === true,
        ...extras,
    };
    return { calls, host };
}

const tests = [
    ['constants: analysis-phase token budgets', () => {
        assertEqual(GAP_ANALYSIS_MAX_TOKENS, 512, 'gap budget');
        assertEqual(CAUSAL_CHAIN_MAX_TOKENS, 512, 'causal budget');
        assertEqual(CAUSAL_CHAIN_MAX_QUERIES, 3, 'causal query cap');
        assertEqual(MID_RESEARCH_CRITIQUE_MAX_TOKENS, 640, 'critique budget');
    }],

    ['runGapAnalysis: empty or unusable findings short-circuit without an LLM call', async () => {
        const { calls, host } = makeHost([]);
        const empty = await runGapAnalysis(host, [], 'q');
        assertEqual(empty.queries.length, 0, 'no queries');
        assertEqual(empty.rationale, '', 'no rationale');
        const tooShort = await runGapAnalysis(host, [{ topic: 't', findings: 'tiny' }], 'q');
        assertEqual(tooShort.queries.length, 0, 'short findings skipped');
        assertEqual(calls.length, 0, 'no LLM calls');
    }],

    ['runGapAnalysis: caps queries and returns rationales', async () => {
        const plan = JSON.stringify([
            { sub_task: 'A', search_query: 'qa', rationale: 'ra' },
            { sub_task: 'B', search_query: 'qb', rationale: 'rb' },
            { sub_task: 'C', search_query: 'qc', rationale: 'rc' },
        ]);
        const { calls, host } = makeHost([plan], { gapAnalysisMaxQueries: 2, qualityRetryMaxQueries: 2 });
        const result = await runGapAnalysis(host, BRANCHES, 'orig q');
        assertEqual(result.queries.length, 2, 'capped at 2');
        assertEqual(result.queries[1].search_query, 'qb', 'kept first two');
        assertEqual(result.rationale, 'ra → "qa"; rb → "qb"', 'rationale joined');
        assertEqual(calls[0].opts.maxTokens, GAP_ANALYSIS_MAX_TOKENS, 'token budget');
        assertEqual(calls[0].opts.modelOverride, 'model-x', 'model override');
        assert(calls[0].messages[1].content.includes('orig q'), 'query embedded');
        assert(!calls[0].messages[1].content.includes('missing or poorly covered'), 'no missing-aspects block');
    }],

    ['runGapAnalysis: missing-aspects path widens the cap and embeds the aspects', async () => {
        const plan = JSON.stringify([
            { sub_task: 'A', search_query: 'qa', rationale: 'ra' },
            { sub_task: 'B', search_query: 'qb', rationale: 'rb' },
        ]);
        const { calls, host } = makeHost([plan], { gapAnalysisMaxQueries: 1, qualityRetryMaxQueries: 2 });
        const result = await runGapAnalysis(host, BRANCHES, 'q', ['aspect one']);
        assertEqual(result.queries.length, 2, 'cap widened to max(cfg, retry)');
        const content = calls[0].messages[1].content;
        assert(content.includes('missing or poorly covered'), 'missing-aspects framing');
        assert(content.includes('- aspect one'), 'aspect listed');
        assert(content.includes('up to 2 queries'), 'retry cap in message');
    }],

    ['runGapAnalysis: errors return empty, cancellation rethrows', async () => {
        const { host } = makeHost([new Error('boom')]);
        const result = await runGapAnalysis(host, BRANCHES, 'q');
        assertEqual(result.queries.length, 0, 'graceful empty');
        assertEqual(result.rationale, '', 'no rationale');

        const cancelErr = new Error('stop');
        cancelErr.isCancel = true;
        const { calls, host: cancelHost } = makeHost([cancelErr]);
        let threw = false;
        try {
            await runGapAnalysis(cancelHost, BRANCHES, 'q');
        } catch (_e) {
            threw = true;
        }
        assert(threw, 'cancel rethrown');
        assertEqual(calls.length, 1, 'single attempt');
    }],

    ['runCausalChainCheck: caps at CAUSAL_CHAIN_MAX_QUERIES', async () => {
        const plan = JSON.stringify(
            [1, 2, 3, 4, 5].map(i => ({ sub_task: `S${i}`, search_query: `q${i}` }))
        );
        const { calls, host } = makeHost([plan]);
        const queries = await runCausalChainCheck(host, BRANCHES, 'q');
        assertEqual(queries.length, CAUSAL_CHAIN_MAX_QUERIES, 'capped at 3');
        assertEqual(calls[0].opts.maxTokens, CAUSAL_CHAIN_MAX_TOKENS, 'token budget');

        const { calls: emptyCalls, host: emptyHost } = makeHost([]);
        assertEqual((await runCausalChainCheck(emptyHost, [], 'q')).length, 0, 'empty findings');
        assertEqual(emptyCalls.length, 0, 'no call for empty findings');
    }],

    ['runCausalChainCheck: errors return empty, cancellation rethrows', async () => {
        const { host } = makeHost([new Error('x')]);
        assertEqual((await runCausalChainCheck(host, BRANCHES, 'q')).length, 0, 'graceful empty');

        const cancelErr = new Error('stop');
        cancelErr.isCancel = true;
        const { host: cancelHost } = makeHost([cancelErr]);
        let threw = false;
        try {
            await runCausalChainCheck(cancelHost, BRANCHES, 'q');
        } catch (_e) {
            threw = true;
        }
        assert(threw, 'cancel rethrown');
    }],

    ['runRePlanningCritique: guard paths skip the LLM call', async () => {
        const { calls, host } = makeHost([]);
        const noCompleted = await runRePlanningCritique(host, [], [{ sub_task: 'S', search_query: 'q' }], 'q');
        assertEqual(noCompleted.sufficient, false, 'empty completed → not sufficient');
        const noRemaining = await runRePlanningCritique(host, BRANCHES, [], 'q');
        assertEqual(noRemaining.sufficient, true, 'no remaining → sufficient');
        assertEqual(calls.length, 0, 'no LLM calls');
    }],

    ['runRePlanningCritique: parses, filters, and defaults the response fields', async () => {
        const wrapped = '```json\n' + JSON.stringify({
            sufficient: true,
            contradictions: ['c1'],
            adjustments: [{ index: 0, new_query: 'nq' }],
            drop_indices: [1, 'x', 2.5],
            new_branches: [{ sub_task: 'no query' }, { sub_task: 'ok', search_query: 'q' }],
        }) + '\n```';
        const { calls, host } = makeHost([wrapped]);
        const critique = await runRePlanningCritique(host, BRANCHES, [{ sub_task: 'S', search_query: 'q' }], 'main q');
        assertEqual(critique.sufficient, true, 'sufficient');
        assertEqual(critique.contradictions.length, 1, 'contradictions kept');
        assertEqual(critique.adjustments.length, 1, 'adjustments kept');
        assertEqual(critique.drop_indices.join(','), '1', 'non-integer drops filtered');
        assertEqual(critique.new_branches.length, 1, 'branches without query filtered');
        assertEqual(calls[0].opts.maxTokens, MID_RESEARCH_CRITIQUE_MAX_TOKENS, 'token budget');
        assert(calls[0].messages[1].content.includes('main q'), 'question embedded');
    }],

    ['runRePlanningCritique: unparseable response and errors yield the empty shape', async () => {
        const emptyShape = 'sufficient=false contradictions=0 adjustments=0 drops=0';
        const { host } = makeHost(['definitely not json']);
        const critique = await runRePlanningCritique(host, BRANCHES, [{ sub_task: 'S', search_query: 'q' }], 'q');
        assertEqual(`sufficient=${critique.sufficient} contradictions=${critique.contradictions.length} adjustments=${critique.adjustments.length} drops=${critique.drop_indices.length}`, emptyShape, 'empty shape');
    }],

    ['runRePlanningCritique: cancellation rethrows', async () => {
        const cancelErr = new Error('stop');
        cancelErr.isCancel = true;
        const { host } = makeHost([cancelErr]);
        let threw = false;
        try {
            await runRePlanningCritique(host, BRANCHES, [{ sub_task: 'S', search_query: 'q' }], 'q');
        } catch (_e) {
            threw = true;
        }
        assert(threw, 'cancel rethrown');
    }],
];

await runTests(tests);
