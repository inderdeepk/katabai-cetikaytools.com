// citationTracker.test.js — Tests for citation binding layer
import {
    createCitationTracker,
    registerFacts,
    registerSource,
    getUniqueSources,
    buildBibliography,
    annotateCitations,
    buildCitationSummary,
} from '../src/research/citationTracker.js';
import { assert, assertEqual, assertDeepEqual, runTests } from './testUtils.js';

const tests = [
    // ── createCitationTracker ───────────────────────────────────────────────

    ['createCitationTracker: fresh state', () => {
        const tracker = createCitationTracker();
        assert(Array.isArray(tracker.entries), 'entries is array');
        assertEqual(tracker.entries.length, 0, 'entries empty');
        assert(tracker.urlToNumber instanceof Map, 'urlToNumber is Map');
        assertEqual(tracker.urlToNumber.size, 0, 'urlToNumber empty');
    }],

    // ── registerFacts ──────────────────────────────────────────────────────

    ['registerFacts: single fact', () => {
        const tracker = createCitationTracker();
        registerFacts(tracker, [{ claim: 'The sky is blue.', url: 'https://example.com' }]);
        assertEqual(tracker.entries.length, 1, 'one entry');
        assertEqual(tracker.entries[0].citationNum, 1, 'citation number 1');
        assertEqual(tracker.urlToNumber.size, 1, 'one URL');
    }],

    ['registerFacts: URL deduplication (same URL → same number)', () => {
        const tracker = createCitationTracker();
        registerFacts(tracker, [
            { claim: 'Claim A', url: 'https://example.com/page' },
            { claim: 'Claim B', url: 'https://example.com/page' },
        ]);
        assertEqual(tracker.entries.length, 2, 'two entries');
        assertEqual(tracker.entries[0].citationNum, 1, 'first num 1');
        assertEqual(tracker.entries[1].citationNum, 1, 'second also num 1');
        assertEqual(tracker.urlToNumber.size, 1, 'one unique URL');
    }],

    ['registerFacts: different URLs get different numbers', () => {
        const tracker = createCitationTracker();
        registerFacts(tracker, [
            { claim: 'Claim A', url: 'https://a.com' },
            { claim: 'Claim B', url: 'https://b.com' },
        ]);
        assertEqual(tracker.entries[0].citationNum, 1, 'first num 1');
        assertEqual(tracker.entries[1].citationNum, 2, 'second num 2');
    }],

    ['registerFacts: URL normalization (trailing slash)', () => {
        const tracker = createCitationTracker();
        registerFacts(tracker, [
            { claim: 'Claim A', url: 'https://example.com/' },
            { claim: 'Claim B', url: 'https://example.com' },
        ]);
        assertEqual(tracker.urlToNumber.size, 1, 'normalized to one URL');
    }],

    ['registerFacts: URL normalization (case insensitivity)', () => {
        const tracker = createCitationTracker();
        registerFacts(tracker, [
            { claim: 'Claim A', url: 'https://EXAMPLE.com/Page' },
            { claim: 'Claim B', url: 'https://example.com/page' },
        ]);
        assertEqual(tracker.urlToNumber.size, 1, 'case normalized');
    }],

    ['registerFacts: invalid inputs', () => {
        const tracker = createCitationTracker();
        registerFacts(tracker, null);
        assertEqual(tracker.entries.length, 0, 'null facts ignored');

        registerFacts(tracker, 'not-an-array');
        assertEqual(tracker.entries.length, 0, 'non-array ignored');

        registerFacts(tracker, [{ claim: '', url: 'https://x.com' }]);
        assertEqual(tracker.entries.length, 0, 'empty claim skipped');

        registerFacts(tracker, [{ claim: 'X', url: '' }]);
        assertEqual(tracker.entries.length, 0, 'empty URL skipped');
    }],

    // ── registerSource ─────────────────────────────────────────────────────

    ['registerSource: new source', () => {
        const tracker = createCitationTracker();
        registerSource(tracker, 'https://newsource.com');
        assertEqual(tracker.urlToNumber.size, 1, 'URL registered');
        assertEqual(tracker.urlToNumber.get('https://newsource.com'), 1, 'number 1');
    }],

    ['registerSource: duplicate source does not increment', () => {
        const tracker = createCitationTracker();
        registerSource(tracker, 'https://example.com');
        registerSource(tracker, 'https://example.com');
        assertEqual(tracker.urlToNumber.size, 1, 'still one URL');
        assertEqual(tracker.entries.length, 0, 'no entries (source only, no facts)');
    }],

    ['registerSource: null tracker ignored', () => {
        registerSource(null, 'https://example.com');
        // Should not throw
    }],

    // ── getUniqueSources ───────────────────────────────────────────────────

    ['getUniqueSources: empty tracker', () => {
        const sources = getUniqueSources(createCitationTracker());
        assertEqual(sources.length, 0, 'no sources');
    }],

    ['getUniqueSources: null tracker', () => {
        const sources = getUniqueSources(null);
        assertEqual(sources.length, 0, 'null returns empty');
    }],

    ['getUniqueSources: single source', () => {
        const tracker = createCitationTracker();
        registerFacts(tracker, [{ claim: 'Test', url: 'https://example.com' }]);
        const sources = getUniqueSources(tracker);
        assertEqual(sources.length, 1, 'one source');
        assertEqual(sources[0].num, 1, 'number 1');
        assertEqual(sources[0].url, 'https://example.com', 'URL preserved');
    }],

    ['getUniqueSources: sorted by number', () => {
        const tracker = createCitationTracker();
        registerFacts(tracker, [
            { claim: 'A', url: 'https://c.com' },
            { claim: 'B', url: 'https://a.com' },
            { claim: 'C', url: 'https://b.com' },
        ]);
        const sources = getUniqueSources(tracker);
        assertEqual(sources.length, 3, 'three sources');
        assertEqual(sources[0].num, 1, 'sorted num 1 first');
        assertEqual(sources[1].num, 2, 'sorted num 2');
        assertEqual(sources[2].num, 3, 'sorted num 3');
    }],

    // ── buildBibliography ──────────────────────────────────────────────────

    ['buildBibliography: empty tracker', () => {
        assertEqual(buildBibliography(createCitationTracker()), '', 'empty string');
    }],

    ['buildBibliography: single source', () => {
        const tracker = createCitationTracker();
        registerFacts(tracker, [{ claim: 'Test', url: 'https://example.com' }]);
        const bib = buildBibliography(tracker);
        assert(bib.includes('Sources & References'), 'has heading');
        assert(bib.includes('[https://example.com]'), 'has URL markdown link');
    }],

    ['buildBibliography: multiple sources', () => {
        const tracker = createCitationTracker();
        registerFacts(tracker, [
            { claim: 'A', url: 'https://a.com' },
            { claim: 'B', url: 'https://b.com' },
        ]);
        const bib = buildBibliography(tracker);
        assert(bib.includes('1.'), 'numbered list');
        assert(bib.includes('2.'), 'second entry');
    }],

    // ── annotateCitations ──────────────────────────────────────────────────

    ['annotateCitations: null/empty returns text unchanged', () => {
        assertEqual(annotateCitations(null, 'hello'), 'hello', 'null tracker');
        assertEqual(annotateCitations(createCitationTracker(), 'hello'), 'hello', 'empty tracker');
    }],

    ['annotateCitations: short claims (<30 chars) are skipped', () => {
        const tracker = createCitationTracker();
        registerFacts(tracker, [{ claim: 'Short claim.', url: 'https://x.com' }]);
        const result = annotateCitations(tracker, 'Short claim.');
        assertEqual(result, 'Short claim.', 'short claim not annotated');
    }],

    ['annotateCitations: matching claim gets citation marker', () => {
        const tracker = createCitationTracker();
        const claim = 'This is a sufficiently long factual claim that exceeds thirty characters.';
        registerFacts(tracker, [{ claim, url: 'https://example.com' }]);
        const result = annotateCitations(tracker, claim);
        assert(result.includes('[1]'), 'citation marker inserted');
        assert(result.startsWith(claim), 'claim preserved');
    }],

    ['annotateCitations: existing markers not doubled', () => {
        const tracker = createCitationTracker();
        const claim = 'This is a long enough claim that has a citation marker already present for testing.';
        registerFacts(tracker, [{ claim, url: 'https://example.com' }]);
        // Text already has a citation marker right after the claim
        const text = claim + '[1]';
        const result = annotateCitations(tracker, text);
        // Should not insert another [1]
        assertEqual(result, text, 'existing marker not doubled');
    }],

    // ── buildCitationSummary ───────────────────────────────────────────────

    ['buildCitationSummary: empty tracker', () => {
        assertEqual(buildCitationSummary(createCitationTracker()), '', 'empty');
        assertEqual(buildCitationSummary(null), '', 'null');
    }],

    ['buildCitationSummary: with entries', () => {
        const tracker = createCitationTracker();
        registerFacts(tracker, [{ claim: 'Test claim that is long enough for the tracker to store.', url: 'https://example.com' }]);
        const summary = buildCitationSummary(tracker);
        assert(summary.includes('SOURCES COLLECTED'), 'has header');
        assert(summary.includes('[1]'), 'has citation number');
        assert(summary.includes('https://example.com'), 'has URL');
    }],
];

runTests(tests);
