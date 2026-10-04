// synthesisPrompt.test.js — Tests for the synthesis-prompt builder and its
// helper functions (contradiction detection, token estimation, source hints).
import {
    CONTRADICTION_NUMERIC_TOLERANCE,
    CONTRADICTION_TOPIC_SIMILARITY_THRESHOLD,
    buildSynthesisPrompt,
    detectContradictions,
    estimateTokens,
    sourceRecencyHint,
    sourceReliabilityHint,
} from '../src/research/synthesisPrompt.js';
import {
    createCitationTracker,
    registerFacts,
    registerSource,
} from '../src/research/citationTracker.js';
import { assert, assertEqual, runTests } from './testUtils.js';

function branch(topic, findings, facts = [], sources = []) {
    return { topic, findings, facts, sources, pageCount: 1 };
}

const tests = [
    [
        'constants: contradiction thresholds',
        () => {
            assertEqual(CONTRADICTION_TOPIC_SIMILARITY_THRESHOLD, 3, 'similarity threshold');
            assertEqual(CONTRADICTION_NUMERIC_TOLERANCE, 0.15, 'numeric tolerance');
        },
    ],

    [
        'estimateTokens: prose vs code-like heuristic',
        () => {
            assertEqual(estimateTokens(''), 0, 'empty');
            assertEqual(estimateTokens(null), 0, 'null');
            assertEqual(estimateTokens('a'.repeat(40)), 10, 'prose 4 chars/token');
            assertEqual(estimateTokens('{{{{{{{{{{;'), 5, 'code-like 2.5 chars/token');
        },
    ],

    [
        'sourceRecencyHint: extracts years from URL paths',
        () => {
            assertEqual(
                sourceRecencyHint('https://news.example.com/2025/03/story'),
                '2025',
                'year found',
            );
            assertEqual(sourceRecencyHint('https://example.com/about'), '', 'no year');
            assertEqual(sourceRecencyHint(null), '', 'null safe');
        },
    ],

    [
        'sourceReliabilityHint: high/low/medium tiers',
        () => {
            assertEqual(
                sourceReliabilityHint('https://www.nature.com/articles/x'),
                'high',
                'nature high',
            );
            assertEqual(sourceReliabilityHint('https://mit.edu/paper'), 'high', 'edu high');
            assertEqual(
                sourceReliabilityHint('https://en.wikipedia.org/wiki/X'),
                'low',
                'wikipedia low',
            );
            assertEqual(
                sourceReliabilityHint('https://medium.com/@author/post'),
                'low',
                'medium.com low',
            );
            assertEqual(
                sourceReliabilityHint('https://example.com/page'),
                'medium',
                'default medium',
            );
            assertEqual(sourceReliabilityHint(null), 'medium', 'null medium');
        },
    ],

    [
        'detectContradictions: needs 2+ facts and divergent numbers across different sources',
        () => {
            assertEqual(detectContradictions([]).length, 0, 'empty');
            assertEqual(
                detectContradictions([
                    branch('t', 'f', [{ claim: 'only one', url: 'https://a.example' }]),
                ]).length,
                0,
                'single fact',
            );

            const divergent = detectContradictions([
                branch('t', 'f', [
                    {
                        claim: 'widget market adoption reached 20 percent',
                        url: 'https://a.example',
                    },
                    {
                        claim: 'widget market adoption reached 80 percent',
                        url: 'https://b.example',
                    },
                ]),
            ]);
            assert(divergent.length >= 1, 'divergent numbers flagged');
            assert(
                typeof divergent[0].topic === 'string' && divergent[0].topic.length > 0,
                'topic label set',
            );
            assertEqual(divergent[0].claims.length, 2, 'two claims per contradiction');

            // Same source URL — not a contradiction.
            assertEqual(
                detectContradictions([
                    branch('t', 'f', [
                        {
                            claim: 'server latency measured 100 milliseconds',
                            url: 'https://same.example',
                        },
                        {
                            claim: 'server latency measured 300 milliseconds',
                            url: 'https://same.example',
                        },
                    ]),
                ]).length,
                0,
                'same URL skipped',
            );

            // Within tolerance (20 vs 21 = ~4.8%).
            assertEqual(
                detectContradictions([
                    branch('t', 'f', [
                        { claim: 'router throughput reached 20 units', url: 'https://a.example' },
                        { claim: 'router throughput reached 21 units', url: 'https://b.example' },
                    ]),
                ]).length,
                0,
                'within tolerance',
            );
        },
    ],

    [
        'buildSynthesisPrompt: question-less fallback header and query header with gap rationale',
        () => {
            const noQuery = buildSynthesisPrompt({ branchResults: [] });
            assert(noQuery.startsWith('[SYNTHESIS TASK'), 'fallback header');
            assert(!noQuery.includes("USER'S QUESTION"), 'no question block');

            const out = buildSynthesisPrompt({
                branchResults: [],
                originalQuery: 'how do widgets work',
                gapRationale: 'Gap R',
            });
            assert(out.includes(`USER'S QUESTION:\n"how do widgets work"`), 'question embedded');
            assert(
                out.includes('gap analysis identified and filled the following gaps: Gap R'),
                'gap rationale line',
            );

            const noGap = buildSynthesisPrompt({ branchResults: [], originalQuery: 'q' });
            assert(!noGap.includes('gap analysis identified'), 'no rationale when empty');
        },
    ],

    [
        'buildSynthesisPrompt: filters findings shorter than 100 chars',
        () => {
            const out = buildSynthesisPrompt({
                branchResults: [branch('Big', 'B'.repeat(150)), branch('Small', 'tiny')],
                originalQuery: 'q',
            });
            assert(out.includes('### Research Context: Big'), 'big included');
            assert(!out.includes('### Research Context: Small'), 'short excluded');
        },
    ],

    [
        'buildSynthesisPrompt: truncates oversized findings and caps facts',
        () => {
            const facts = Array.from({ length: 40 }, (_, i) => ({
                claim: `C${i}` + 'x'.repeat(48),
                url: 'https://f.example',
            }));
            const out = buildSynthesisPrompt({
                branchResults: [branch('Huge', 'X'.repeat(6000), facts)],
                originalQuery: 'q',
                contextBudgetChars: 3000,
            });
            assert(out.includes('[...summary trimmed...]'), 'summary trimmed');
            assert(out.includes('more facts available]'), 'fact overflow marker');

            const full = buildSynthesisPrompt({
                branchResults: [branch('Huge', 'X'.repeat(6000), facts)],
                originalQuery: 'q',
                contextBudgetChars: 100000,
            });
            assert(!full.includes('[...summary trimmed...]'), 'no trimming within budget');
        },
    ],

    [
        'buildSynthesisPrompt: relevance-sandwich puts top match first and least-relevant in the middle',
        () => {
            const out = buildSynthesisPrompt({
                branchResults: [
                    branch('A', 'alpha '.repeat(40)),
                    branch('B', 'plain '.repeat(30)),
                    branch('C', 'beta in the alpha story '.repeat(8)),
                ],
                originalQuery: 'alpha beta',
            });
            const ai = out.indexOf('### Research Context: A');
            const bi = out.indexOf('### Research Context: B');
            const ci = out.indexOf('### Research Context: C');
            assert(ai >= 0 && bi >= 0 && ci >= 0, 'all branches rendered');
            assert(ai < bi && bi < ci, `sandwich order A<B<C (got ${ai}, ${bi}, ${ci})`);
        },
    ],

    [
        'buildSynthesisPrompt: document context, citation summary, and source numbering',
        () => {
            const tracker = createCitationTracker();
            registerFacts(tracker, [{ claim: 'fact one', url: 'https://tracked.example' }]);
            registerSource(tracker, 'https://src.example');

            const out = buildSynthesisPrompt({
                branchResults: [
                    branch('A', 'A'.repeat(150), [], ['https://tracked.example']),
                    branch('B', 'B'.repeat(150), [], ['https://untracked.example']),
                ],
                citationTracker: tracker,
                originalQuery: 'q',
                documentContext: 'D'.repeat(7000),
            });
            assert(out.includes('─── ATTACHED DOCUMENT CONTEXT ───'), 'document block header');
            assert(out.includes('[...document truncated for synthesis'), 'document truncated');
            assert(out.includes('SOURCES COLLECTED'), 'citation summary included');
            assert(out.includes('[1](https://tracked.example)'), 'tracked source numbered');
            assert(out.includes('[?](https://untracked.example)'), 'untracked source marked ?');
            assert(out.includes('─── REPORT GUIDELINES ───'), 'guidelines present');
            assert(out.includes('CRITICAL RULES:'), 'critical rules present');

            const noDocs = buildSynthesisPrompt({ branchResults: [], originalQuery: 'q' });
            assert(!noDocs.includes('ATTACHED DOCUMENT CONTEXT'), 'no document block when absent');
        },
    ],

    [
        'buildSynthesisPrompt: renders the outline scaffold with key claims (max 2 per section)',
        () => {
            const out = buildSynthesisPrompt({
                branchResults: [],
                originalQuery: 'q',
                synthesisOutline: {
                    sections: [
                        { title: 'First', key_claims: ['c1', 'c2', 'c3'] },
                        { title: 'Second', key_claims: [] },
                    ],
                },
            });
            assert(out.includes('─── SUGGESTED OUTLINE'), 'outline header');
            assert(out.includes('1. First'), 'first section');
            assert(out.includes('   - c1') && out.includes('   - c2'), 'two claims');
            assert(!out.includes('   - c3'), 'third claim dropped');
            assert(out.includes('2. Second'), 'second section');
            assert(out.includes('─── END OUTLINE ───'), 'outline footer');
        },
    ],
];

await runTests(tests);
