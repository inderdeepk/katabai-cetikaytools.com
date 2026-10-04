// researchPipeline.test.js — Tests for the research pipeline analysis phases.
import {
    GAP_ANALYSIS_MAX_TOKENS,
    CAUSAL_CHAIN_MAX_TOKENS,
    CAUSAL_CHAIN_MAX_QUERIES,
    MID_RESEARCH_CRITIQUE_MAX_TOKENS,
    SYNTHESIS_OUTLINE_MAX_TOKENS,
    RESEARCH_QUALITY_CHECK_MAX_TOKENS,
    runGapAnalysis,
    runRePlanningCritique,
    runCausalChainCheck,
    buildSynthesisOutline,
    runQualityCheck,
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

    ['buildSynthesisOutline: empty or unusable findings skip the LLM call', async () => {
        const { calls, host } = makeHost([]);
        assertEqual(await buildSynthesisOutline(host, [], 'q'), null, 'empty findings');
        assertEqual(await buildSynthesisOutline(host, [{ topic: 't', findings: 'tiny' }], 'q'), null, 'short findings');
        assertEqual(calls.length, 0, 'no LLM calls');
    }],

    ['buildSynthesisOutline: direct JSON parse and prompt contents', async () => {
        const outlineJson = JSON.stringify({ sections: [{ title: 'A', key_claims: ['x [1]'] }] });
        const { calls, host } = makeHost([outlineJson]);
        const outline = await buildSynthesisOutline(host, BRANCHES, 'how do widgets work');
        assertEqual(outline.sections.length, 1, 'one section');
        assertEqual(calls[0].opts.maxTokens, SYNTHESIS_OUTLINE_MAX_TOKENS, 'token budget');
        const content = calls[0].messages[1].content;
        assert(content.includes('how do widgets work'), 'query embedded');
        assert(content.includes('Topic A'), 'topic embedded');
    }],

    ['buildSynthesisOutline: extracts sections from wrapped prose; bad shapes yield null', async () => {
        const wrapped = 'Here is the outline:\n{"sections": [{"title": "B"}]}\nDone.';
        const { host } = makeHost([wrapped]);
        const outline = await buildSynthesisOutline(host, BRANCHES, 'q');
        assertEqual(outline.sections[0].title, 'B', 'extracted from prose');

        const { host: badHost } = makeHost(['{"notSections": []}', '{"sections": "nope"}']);
        assertEqual(await buildSynthesisOutline(badHost, BRANCHES, 'q'), null, 'missing sections');
        assertEqual(await buildSynthesisOutline(badHost, BRANCHES, 'q'), null, 'non-array sections');
    }],

    ['buildSynthesisOutline: errors yield null, cancellation rethrows', async () => {
        const { host } = makeHost([new Error('x')]);
        assertEqual(await buildSynthesisOutline(host, BRANCHES, 'q'), null, 'graceful null');

        const cancelErr = new Error('stop');
        cancelErr.isCancel = true;
        const { host: cancelHost } = makeHost([cancelErr]);
        let threw = false;
        try {
            await buildSynthesisOutline(cancelHost, BRANCHES, 'q');
        } catch (_e) {
            threw = true;
        }
        assert(threw, 'cancel rethrown');
    }],

    ['runQualityCheck: parses the two-axis shape and embeds facts', async () => {
        const payload = JSON.stringify({
            coverage_score: 2,
            groundedness_score: 1,
            missing_aspects: ['aspect one'],
            unsupported_claims: ['claim x', ''],
            unverified_citations: ['[3]'],
        });
        const facts = [{ claim: 'claim one', url: 'https://a.example' }, { claim: 'claim two' }];
        const { calls, host } = makeHost([payload]);
        const result = await runQualityCheck(host, 'The report text is long enough.', 'orig q', facts);
        assertEqual(result.coverage, 2, 'coverage');
        assertEqual(result.groundedness, 1, 'groundedness');
        assertEqual(result.missingAspects.length, 1, 'missing aspects');
        assertEqual(result.unsupportedClaims.join(','), 'claim x', 'empty strings filtered');
        assertEqual(result.unverifiedCitations.join(','), '[3]', 'citations kept');
        assertEqual(calls[0].opts.maxTokens, RESEARCH_QUALITY_CHECK_MAX_TOKENS, 'token budget');
        const content = calls[0].messages[1].content;
        assert(content.includes('- claim one [https://a.example]'), 'fact with url');
        assert(content.includes('- claim two'), 'fact without url');
    }],

    ['runQualityCheck: legacy score fallback, no-facts block, report truncation', async () => {
        const legacy = JSON.stringify({ score: 4, groundedness_score: 3, missing_aspects: [] });
        const { calls, host } = makeHost([legacy]);
        const report = 'R'.repeat(6500) + 'TAILMARKER';
        const result = await runQualityCheck(host, report, 'q', []);
        assertEqual(result.coverage, 4, 'legacy score used');
        const content = calls[0].messages[1].content;
        assert(content.includes('(none provided)'), 'no-facts block');
        assert(!content.includes('TAILMARKER'), 'report truncated at 6000');
    }],

    ['runQualityCheck: unusable responses and errors yield null (errors are swallowed)', async () => {
        const { host } = makeHost(['no json here']);
        assertEqual(await runQualityCheck(host, 'report', 'q', []), null, 'no score → null');

        const { host: emptyHost } = makeHost(['{"groundedness_score": 5}']);
        assertEqual(await runQualityCheck(emptyHost, 'report', 'q', []), null, 'coverage missing → null');

        // Fire-and-forget caller: even a cancel-like error must NOT rethrow.
        const cancelErr = new Error('stop');
        cancelErr.isCancel = true;
        const { host: errHost } = makeHost([cancelErr]);
        const result = await runQualityCheck(errHost, 'report', 'q', []);
        assertEqual(result, null, 'swallowed, no rethrow');
    }],

    ['runQualityCheck: non-array fields default to empty', async () => {
        const payload = JSON.stringify({ coverage_score: 5, groundedness_score: 5, missing_aspects: 'x', unsupported_claims: {}, unverified_citations: null });
        const { host } = makeHost([payload]);
        const result = await runQualityCheck(host, 'report', 'q', []);
        assertEqual(result.missingAspects.length, 0, 'missing aspects default');
        assertEqual(result.unsupportedClaims.length, 0, 'claims default');
        assertEqual(result.unverifiedCitations.length, 0, 'citations default');
    }],
];

await runTests(tests);
