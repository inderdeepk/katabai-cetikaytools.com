// researchPrompts.test.js — Tests for the research prompt module.
import {
    DEEP_RESEARCH_SYSTEM_INSTRUCTION,
    DEEP_RESEARCH_PLANNER_SYSTEM_PROMPT,
    DEEP_RESEARCH_PLANNER_REVISION_SYSTEM_PROMPT,
    CAUSAL_CHAIN_SYSTEM_PROMPT,
    GAP_ANALYSIS_SYSTEM_PROMPT,
    SYNTHESIS_OUTLINE_SYSTEM_PROMPT,
    SYNTHESIS_OUTLINE_CRITIQUE_PROMPT,
    MID_RESEARCH_CRITIQUE_SYSTEM_PROMPT,
    FORCE_SYNTHESIS_SYSTEM_INSTRUCTION,
    REGULAR_SYNTHESIS_SYSTEM_INSTRUCTION,
    NO_RESULTS_SYNTHESIS_SYSTEM_INSTRUCTION,
    TOOL_CALL_HEALING_INSTRUCTION,
    RESEARCH_QUALITY_CHECK_SYSTEM_PROMPT,
    parsePlannerResponse,
    buildResearchPlanPrompt,
    isSynthesisRegurgitation,
} from '../src/research/prompts.js';
import { assert, assertEqual, runTests } from './testUtils.js';

const tests = [
    [
        'constants: all prompt texts are non-empty and distinctive',
        () => {
            const constants = [
                DEEP_RESEARCH_SYSTEM_INSTRUCTION,
                DEEP_RESEARCH_PLANNER_SYSTEM_PROMPT,
                DEEP_RESEARCH_PLANNER_REVISION_SYSTEM_PROMPT,
                CAUSAL_CHAIN_SYSTEM_PROMPT,
                GAP_ANALYSIS_SYSTEM_PROMPT,
                SYNTHESIS_OUTLINE_SYSTEM_PROMPT,
                SYNTHESIS_OUTLINE_CRITIQUE_PROMPT,
                MID_RESEARCH_CRITIQUE_SYSTEM_PROMPT,
                FORCE_SYNTHESIS_SYSTEM_INSTRUCTION,
                REGULAR_SYNTHESIS_SYSTEM_INSTRUCTION,
                NO_RESULTS_SYNTHESIS_SYSTEM_INSTRUCTION,
                TOOL_CALL_HEALING_INSTRUCTION,
                RESEARCH_QUALITY_CHECK_SYSTEM_PROMPT,
            ];
            for (const text of constants) {
                assert(typeof text === 'string' && text.length > 40, 'non-empty prompt string');
            }
            assert(
                DEEP_RESEARCH_PLANNER_SYSTEM_PROMPT.includes('JSON array'),
                'planner demands JSON',
            );
            assert(
                DEEP_RESEARCH_PLANNER_REVISION_SYSTEM_PROMPT.includes('revis'),
                'revision variant',
            );
            assert(
                FORCE_SYNTHESIS_SYSTEM_INSTRUCTION.includes('FORBIDDEN'),
                'force synthesis bans tools',
            );
            assert(
                TOOL_CALL_HEALING_INSTRUCTION.includes('<tool_call>'),
                'healing gives the exact format',
            );
            assert(
                RESEARCH_QUALITY_CHECK_SYSTEM_PROMPT.includes('coverage_score'),
                'quality axes present',
            );
            assert(GAP_ANALYSIS_SYSTEM_PROMPT.includes('rationale'), 'gap analysis schema present');
            assert(
                SYNTHESIS_OUTLINE_CRITIQUE_PROMPT.includes('IMPROVED'),
                'critique asks for improvement',
            );
        },
    ],

    [
        'parsePlannerResponse: direct JSON array',
        () => {
            const parsed = parsePlannerResponse(
                JSON.stringify([
                    { sub_task: 'Background', search_query: 'topic background 2025' },
                    { sub_task: 'Details', search_query: 'topic deep details' },
                ]),
            );
            assertEqual(parsed.length, 2, 'two entries');
            assertEqual(parsed[0].sub_task, 'Background', 'label');
            assertEqual(parsed[1].search_query, 'topic deep details', 'query');
        },
    ],

    [
        'parsePlannerResponse: JSON inside a fenced code block',
        () => {
            const parsed = parsePlannerResponse(
                'Here is the plan:\n```json\n[{"sub_task": "A", "search_query": "q a"}]\n```\nDone.',
            );
            assertEqual(parsed.length, 1, 'one entry');
            assertEqual(parsed[0].search_query, 'q a', 'query');
        },
    ],

    [
        'parsePlannerResponse: embedded array plus field aliases',
        () => {
            const parsed = parsePlannerResponse(
                'blah [{"subTask": "Alias", "searchQuery": "alias query", "reason": "why"}] blah',
            );
            assertEqual(parsed.length, 1, 'one entry');
            assertEqual(parsed[0].sub_task, 'Alias', 'subTask alias mapped');
            assertEqual(parsed[0].rationale, 'why', 'reason alias mapped');
        },
    ],

    [
        'parsePlannerResponse: entries without a search query are filtered out',
        () => {
            const parsed = parsePlannerResponse(
                JSON.stringify([
                    { sub_task: 'No query' },
                    { sub_task: 'Has query', search_query: 'q' },
                ]),
            );
            assertEqual(parsed.length, 1, 'filtered');
            assertEqual(parsed[0].sub_task, 'Has query', 'kept');
        },
    ],

    [
        'parsePlannerResponse: numbered list fallback needs at least two entries',
        () => {
            const parsed = parsePlannerResponse(
                '1. Background → background keywords\n2. Details -> detail keywords',
            );
            assertEqual(parsed.length, 2, 'two entries');
            assertEqual(parsed[0].sub_task, 'Background', 'first label');
            assertEqual(parsed[1].search_query, 'detail keywords', 'second query');

            assertEqual(
                parsePlannerResponse('1. Only one → single'),
                null,
                'single entry rejected',
            );
            assertEqual(parsePlannerResponse('no plan here'), null, 'garbage rejected');
            assertEqual(parsePlannerResponse(null), null, 'null rejected');
            assertEqual(parsePlannerResponse(42), null, 'non-string rejected');
        },
    ],

    [
        'buildResearchPlanPrompt: numbered steps with search queries',
        () => {
            const prompt = buildResearchPlanPrompt([
                { sub_task: 'One', search_query: 'first query' },
                { sub_task: 'Two', search_query: 'second query' },
            ]);
            assert(prompt.includes('1. One'), 'first step');
            assert(prompt.includes('Search: "first query"'), 'first query');
            assert(prompt.includes('2. Two'), 'second step');
            assert(prompt.includes('Search: "second query"'), 'second query');
            assert(
                prompt.includes('synthesize a comprehensive research report'),
                'closing guidance',
            );
        },
    ],

    [
        'isSynthesisRegurgitation: non-deepseek providers are never flagged',
        () => {
            assertEqual(
                isSynthesisRegurgitation('1\nGemini deep research\ncontext management', 'ollama'),
                false,
                'ollama ignored',
            );
            assertEqual(isSynthesisRegurgitation('', 'deepseek'), false, 'empty ignored');
            assertEqual(isSynthesisRegurgitation(null, 'deepseek'), false, 'null ignored');
        },
    ],

    [
        'isSynthesisRegurgitation: query-echo garbage is detected',
        () => {
            const garbage =
                '1\nGemini deep research\ncontext management\ncrawl4ai searxng\nRL training\n';
            assertEqual(isSynthesisRegurgitation(garbage, 'deepseek'), true, 'flagged');
        },
    ],

    [
        'isSynthesisRegurgitation: substantial sourced prose is not flagged',
        () => {
            const prose =
                'The extension implements a multi-phase research pipeline that begins with a planning ' +
                'stage, where the model decomposes the query into focused angles before any searching begins. ' +
                'Each angle is executed as an isolated branch that searches, crawls the most promising pages, ' +
                'and compresses the extracted text into a compact findings block. According to ' +
                'https://example.com/report, this staged approach materially improves answer accuracy.\n\n' +
                'A second paragraph covers the trade-offs in detail: latency grows with each added phase, ' +
                'token costs accumulate across compression and synthesis calls, and the overall context ' +
                'budget constrains how many branches can contribute to the final report. The design ' +
                'therefore blends quality gates with hard budgets so the pipeline degrades gracefully.';
            assertEqual(isSynthesisRegurgitation(prose, 'deepseek'), false, 'not flagged');
        },
    ],
];

await runTests(tests);
