// compressionTools.test.js — Tests for LLM-based hierarchical compression pipeline
import {
    _slidingWindowChunk,
    compressPage,
    mergePageSummaries,
    clusterThemes,
    buildSectionDraft,
    compressResearchBranch,
} from '../src/research/compressionTools.js';
import { assert, assertEqual, assertDeepEqual, runTests, createMockLlmCall } from './testUtils.js';

const tests = [
    // ── _slidingWindowChunk ─────────────────────────────────────────────────

    ['_slidingWindowChunk: text shorter than window → single chunk', () => {
        const text = 'Short text.';
        const chunks = _slidingWindowChunk(text, 2000, 500);
        assertEqual(chunks.length, 1, 'single chunk');
        assertEqual(chunks[0], text, 'content preserved');
    }],

    ['_slidingWindowChunk: empty text', () => {
        const chunks = _slidingWindowChunk('', 2000, 500);
        assertEqual(chunks.length, 1, 'single empty chunk');
        assertEqual(chunks[0], '', 'empty chunk');
    }],

    ['_slidingWindowChunk: null/undefined', () => {
        const chunks = _slidingWindowChunk(null, 2000, 500);
        assertEqual(chunks.length, 1, 'null → one chunk');
        assertEqual(chunks[0], '', 'null → empty string');
    }],

    ['_slidingWindowChunk: overlap >= window auto-corrected', () => {
        // overlap >= window would degrade to 1-char steps — should be corrected
        const text = 'A'.repeat(100) + '. B'.repeat(100) + '.';
        const chunks = _slidingWindowChunk(text, 50, 100); // overlap > window
        // Should not produce hundreds of chunks
        assert(chunks.length < 20, 'auto-corrected overlap prevents explosion');
    }],

    ['_slidingWindowChunk: long text produces multiple overlapping chunks', () => {
        const sentences = [];
        for (let i = 0; i < 20; i++) {
            sentences.push(`This is sentence number ${i} with some extra content to make it longer.`);
        }
        const text = sentences.join(' ');
        const chunks = _slidingWindowChunk(text, 200, 50);
        assert(chunks.length > 1, 'multiple chunks produced');
        // Check overlap: first chunk's end should appear in second chunk's start
        const firstEnd = chunks[0].split(' ').slice(-3).join(' ');
        assert(chunks[1].includes(firstEnd), 'chunks overlap');
    }],

    // ── compressPage ────────────────────────────────────────────────────────

    ['compressPage: with valid LLM response', async () => {
        const llmCall = createMockLlmCall([
            JSON.stringify([
                { claim: 'The sky is blue.', url: 'https://example.com' },
                { claim: 'Water is wet.', url: 'https://example.com' },
            ]),
        ]);
        const facts = await compressPage({
            rawText: 'The sky is blue. Water is wet. This is a test page.',
            sourceUrl: 'https://example.com',
            llmCall,
        });
        assertEqual(facts.length, 2, 'two facts extracted');
        assertEqual(facts[0].claim, 'The sky is blue.', 'first claim');
        assertEqual(facts[1].url, 'https://example.com', 'URL preserved');
    }],

    ['compressPage: with LLM wrapped in markdown fence', async () => {
        const llmCall = createMockLlmCall([
            '```json\n[{"claim":"Fact A","url":"https://a.com"}]\n```',
        ]);
        const facts = await compressPage({
            rawText: 'Fact A is important.',
            sourceUrl: 'https://a.com',
            llmCall,
        });
        assertEqual(facts.length, 1, 'markdown-fenced JSON parsed');
        assertEqual(facts[0].claim, 'Fact A', 'claim extracted');
    }],

    ['compressPage: missing required params returns empty', async () => {
        const llmCall = createMockLlmCall(['[]']);
        const facts1 = await compressPage({ llmCall });
        assertEqual(facts1.length, 0, 'no rawText');

        const facts2 = await compressPage({ rawText: 'text', llmCall });
        assertEqual(facts2.length, 0, 'no sourceUrl');

        const facts3 = await compressPage({ rawText: 'text', sourceUrl: 'url' });
        assertEqual(facts3.length, 0, 'no llmCall');
    }],

    ['compressPage: LLM error returns empty', async () => {
        const llmCall = async () => { throw new Error('LLM failed'); };
        const facts = await compressPage({
            rawText: 'Test content.', sourceUrl: 'https://x.com', llmCall,
        });
        assertEqual(facts.length, 0, 'error handled gracefully');
    }],

    ['compressPage: bullet list fallback', async () => {
        const llmCall = createMockLlmCall([
            '- First bullet point about something\n- Second bullet point here\n- Third one',
        ]);
        const facts = await compressPage({
            rawText: 'A'.repeat(100), sourceUrl: 'https://x.com', llmCall,
        });
        assertEqual(facts.length, 3, 'bullets extracted as facts');
        assert(facts[0].url === 'https://x.com', 'source URL applied to all');
    }],

    // ── mergePageSummaries ──────────────────────────────────────────────────

    ['mergePageSummaries: single summary returned directly', async () => {
        const llmCall = createMockLlmCall([]);
        const result = await mergePageSummaries({
            summaries: ['- Bullet 1\n- Bullet 2'],
            topic: 'Test Topic',
            llmCall,
        });
        assertEqual(result, '- Bullet 1\n- Bullet 2', 'single summary unchanged');
    }],

    ['mergePageSummaries: multiple summaries merged', async () => {
        const llmCall = createMockLlmCall(['- Merged bullet 1\n- Merged bullet 2']);
        const result = await mergePageSummaries({
            summaries: ['- A', '- B', '- C'],
            topic: 'Merging Test',
            llmCall,
        });
        assert(result.includes('Merged'), 'LLM response used');
    }],

    ['mergePageSummaries: empty summaries returns empty', async () => {
        const llmCall = createMockLlmCall([]);
        const result = await mergePageSummaries({
            summaries: [],
            topic: 'Empty',
            llmCall,
        });
        assertEqual(result, '', 'empty input → empty output');
    }],

    ['mergePageSummaries: LLM error falls back to concatenation', async () => {
        const llmCall = async () => { throw new Error('fail'); };
        const result = await mergePageSummaries({
            summaries: ['- A', '- B'],
            topic: 'Test',
            llmCall,
        });
        assert(result.includes('- A'), 'fallback includes first');
        assert(result.includes('- B'), 'fallback includes second');
    }],

    // ── clusterThemes ──────────────────────────────────────────────────────

    ['clusterThemes: valid input', async () => {
        const llmCall = createMockLlmCall(['**Theme 1**\nParagraph about theme 1.\n\n**Theme 2**\nParagraph about theme 2.']);
        const result = await clusterThemes({
            topicSummaries: [
                { topic: 'Topic A', findings: '- Finding 1\n- Finding 2' },
                { topic: 'Topic B', findings: '- Finding 3\n- Finding 4' },
            ],
            llmCall,
        });
        assert(result.includes('Theme 1'), 'LLM output used');
    }],

    ['clusterThemes: empty input', async () => {
        const llmCall = createMockLlmCall([]);
        const result = await clusterThemes({
            topicSummaries: [],
            llmCall,
        });
        assertEqual(result, '', 'empty → empty');
    }],

    // ── buildSectionDraft ──────────────────────────────────────────────────

    ['buildSectionDraft: valid input', async () => {
        const llmCall = createMockLlmCall(['This is a drafted section with proper prose.']);
        const result = await buildSectionDraft({
            themedParagraphs: '**Theme 1**\nContent.',
            sectionTitle: 'Introduction',
            llmCall,
        });
        assert(result.includes('drafted'), 'LLM output used');
    }],

    ['buildSectionDraft: missing sectionTitle returns paragraphs', async () => {
        const llmCall = createMockLlmCall([]);
        const result = await buildSectionDraft({
            themedParagraphs: 'Some content.',
            llmCall,
        });
        assertEqual(result, 'Some content.', 'returned unchanged without title');
    }],

    // ── compressResearchBranch ─────────────────────────────────────────────

    ['compressResearchBranch: full pipeline with mock LLM', async () => {
        const llmCall = createMockLlmCall([
            // Page 1 compression
            JSON.stringify([
                { claim: 'Python 3.13 released October 2024.', url: 'https://python.org' },
                { claim: 'New JIT compiler included.', url: 'https://python.org' },
            ]),
            // Page 2 compression
            JSON.stringify([
                { claim: 'Performance improved 10-60%.', url: 'https://benchmarks.org' },
            ]),
            // Merge result (not called in branch with <2 pages with facts)
        ]);

        const result = await compressResearchBranch({
            pages: [
                { url: 'https://python.org', text: 'Python 3.13 was released in October 2024. It includes a new JIT compiler.' },
                { url: 'https://benchmarks.org', text: 'Performance improved 10-60% according to benchmarks.' },
            ],
            topic: 'Python 3.13 Release',
            llmCall,
        });

        assert(result.facts.length === 3, '3 facts extracted');
        assert(result.sources.length === 2, '2 sources tracked');
        assert(result.findings.length > 0, 'findings compiled');
    }],

    ['compressResearchBranch: empty pages returns empty', async () => {
        const llmCall = createMockLlmCall([]);
        const result = await compressResearchBranch({
            pages: [],
            topic: 'Nothing',
            llmCall,
        });
        assertEqual(result.facts.length, 0, 'empty facts');
        assertEqual(result.findings, '', 'empty findings');
        assertEqual(result.sources.length, 0, 'empty sources');
    }],
];

// Run async tests
(async () => {
    let passed = 0;
    let failed = 0;
    for (const [name, run] of tests) {
        try {
            await run();
            console.log(`PASS ${name}`);
            passed++;
        } catch (e) {
            console.log(`FAIL ${name}: ${e.message}`);
            failed++;
        }
    }
    console.log(`${passed} passed, ${failed} failed, ${tests.length} total`);
    if (failed > 0) throw new Error(`${failed} test(s) failed`);
})();
