// contentKind.test.js — Tests for code-heaviness analysis + raw code excerpting
import {
    analyzeCodeHeaviness,
    buildRawCodeExcerpt,
    RAW_CODE_EXCERPT_MAX_CHARS,
} from '../src/shared/contentKind.js';
import { assert, assertEqual, runTests } from './testUtils.js';

const CODE_PAGE = [
    '# API Reference',
    '',
    'Install the client:',
    '',
    '```bash',
    'npm install example-client',
    '```',
    '',
    'Then use it:',
    '',
    '```js',
    'const client = new Client();',
    "await client.fetch('https://api.example.org/v1/items');",
    'console.log(client.lastResult);',
    '```',
    '',
].join('\n');

const PROSE_PAGE = [
    'The quick brown fox jumps over the lazy dog. This page describes the history',
    'of the company and its founders, written as flowing prose with no code at all.',
    'It mentions that the company was founded in 1998 and later expanded abroad.',
].join('\n');

const tests = [
    [
        'analyzeCodeHeaviness: fenced code pages are code-heavy',
        () => {
            const info = analyzeCodeHeaviness(CODE_PAGE);
            assert(info.codeHeavy, 'code page detected');
            assertEqual(info.fenceBlocks, 2, 'two fenced blocks');
            assert(info.fencedLineRatio > 0, 'fenced line ratio positive');
        },
    ],

    [
        'analyzeCodeHeaviness: prose pages are not code-heavy',
        () => {
            const info = analyzeCodeHeaviness(PROSE_PAGE);
            assert(!info.codeHeavy, 'prose not code-heavy');
            assertEqual(info.fenceBlocks, 0, 'no fences');
        },
    ],

    [
        'analyzeCodeHeaviness: empty input is safe',
        () => {
            const info = analyzeCodeHeaviness('');
            assert(!info.codeHeavy, 'empty not code-heavy');
            assertEqual(info.fenceBlocks, 0, 'no fences');
        },
    ],

    [
        'buildRawCodeExcerpt: keeps headings + fenced code, drops prose',
        () => {
            const excerpt = buildRawCodeExcerpt(CODE_PAGE);
            assert(excerpt.includes('# API Reference'), 'heading kept');
            assert(excerpt.includes('npm install example-client'), 'bash code kept');
            assert(
                excerpt.includes("await client.fetch('https://api.example.org/v1/items');"),
                'js code kept',
            );
            assert(!excerpt.includes('Install the client:'), 'prose dropped');
            assert(!excerpt.includes('Then use it:'), 'prose dropped');
        },
    ],

    [
        'buildRawCodeExcerpt: respects maxChars and marks trimming',
        () => {
            const longCode = ['```js', 'x'.repeat(500), '```'].join('\n');
            const excerpt = buildRawCodeExcerpt(longCode, { maxChars: 120 });
            assert(excerpt.length <= 120 + 30, 'bounded (plus trim marker)');
            assert(excerpt.includes('[...raw excerpt trimmed]'), 'trim marker present');
        },
    ],

    [
        'buildRawCodeExcerpt: falls back to a bounded slice without code structure',
        () => {
            const inline = `Run ${'x'.repeat(50)} then continue with the next steps.`;
            const excerpt = buildRawCodeExcerpt(inline, { maxChars: 30 });
            assert(excerpt.length > 0, 'non-empty fallback');
            assert(excerpt.length <= 30 + 30, 'bounded');
            assertEqual(buildRawCodeExcerpt('', {}), '', 'empty input → empty excerpt');
            assertEqual(RAW_CODE_EXCERPT_MAX_CHARS, 6000, 'default cap exported');
        },
    ],
];

await runTests(tests);
