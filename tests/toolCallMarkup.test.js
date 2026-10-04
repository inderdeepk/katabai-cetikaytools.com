// toolCallMarkup.test.js — Tests for the extracted tool-call markup helpers.
import {
    normalizeToolCallMarkup,
    parseTextToolCalls,
    contentLooksLikeToolCalls,
    stillLooksLikeToolMarkup,
    stripTruncatedToolCallMarkup,
} from '../src/core/toolCallMarkup.js';
import { assert, assertEqual, runTests } from './testUtils.js';

// Real-world obfuscation pattern: U+FF5C fullwidth pipes around a fake
// "DSML" namespace prefix inserted between "<" and the tag name.
const DSML = '\uFF5C\uFF5CDSML\uFF5C\uFF5C';
const dsmlGarbage = `<${DSML}tool_calls>\n<${DSML}invoke name="read_url">\n<${DSML}parameter name="url">https://example.com</parameter>\n</invoke>\n</tool_calls>`;

const tests = [
    // ── normalizeToolCallMarkup ────────────────────────────────────────────

    ['normalize: DSML pipe obfuscation collapses to clean tags', () => {
        assertEqual(
            normalizeToolCallMarkup(`<${DSML}tool_calls>`),
            '<tool_calls>',
            'DSML namespace removed');
        assertEqual(
            normalizeToolCallMarkup(`<${DSML}invoke name="read_url">`),
            '<invoke name="read_url">',
            'invoke tag recovered');
    }],

    ['normalize: zero-width chars and fullwidth brackets/quotes', () => {
        assertEqual(
            normalizeToolCallMarkup('<tool\u200B_calls>'),
            '<tool_calls>',
            'zero-width space removed');
        assertEqual(
            normalizeToolCallMarkup('\uFF1Cinvoke name=\u201Dread_url\u201D\uFF1E'),
            '<invoke name="read_url">',
            'fullwidth brackets + smart quotes normalized');
    }],

    ['normalize: space-mangled tags are repaired', () => {
        assertEqual(normalizeToolCallMarkup('< invoke name="read_url">'), '<invoke name="read_url">', '< invoke');
        assertEqual(normalizeToolCallMarkup('</ parameter>'), '</parameter>', '</ parameter>');
        assertEqual(normalizeToolCallMarkup('< calls>'), '<calls>', '< calls>');
    }],

    ['normalize: light mode skips bracket/quote/unicode-tag conversion', () => {
        assertEqual(
            normalizeToolCallMarkup('\uFF1Cinvoke>', { light: true }),
            '\uFF1Cinvoke>',
            'fullwidth bracket preserved in light mode');
        assertEqual(
            normalizeToolCallMarkup('< invoke>', { light: true }),
            '<invoke>',
            'spacing still repaired in light mode');
    }],

    ['normalize: ordinary prose is untouched', () => {
        const prose = 'If a < b then the result is fine. Use "quotes" normally.';
        assertEqual(normalizeToolCallMarkup(prose), prose, 'prose unchanged');
    }],

    // ── parseTextToolCalls ─────────────────────────────────────────────────

    ['parse: JSON object format', () => {
        const text = '{"name":"read_url","arguments":{"url":"https://example.com"}}';
        const calls = parseTextToolCalls(text, ['read_url']);
        assert(calls !== null && calls.length === 1, 'one call extracted');
        assertEqual(calls[0].function.name, 'read_url', 'tool name');
        assert(JSON.parse(calls[0].function.arguments).url === 'https://example.com', 'arguments round-trip');
    }],

    ['parse: function-call syntax', () => {
        const calls = parseTextToolCalls('web_search({"query":"gnome shell"})', ['web_search']);
        assert(calls !== null && calls.length === 1, 'one call extracted');
        assertEqual(calls[0].function.name, 'web_search', 'tool name');
    }],

    ['parse: XML invoke with named parameters', () => {
        const text = '<invoke name="read_url">\n<parameter name="url">https://example.com/page</parameter>\n</invoke>';
        const calls = parseTextToolCalls(text, ['read_url']);
        assert(calls !== null && calls.length === 1, 'one call extracted');
        assertEqual(JSON.parse(calls[0].function.arguments).url, 'https://example.com/page', 'url parameter');
    }],

    ['parse: DSML-obfuscated invoke is recovered', () => {
        const calls = parseTextToolCalls(dsmlGarbage, ['read_url']);
        assert(calls !== null && calls.length === 1, 'one call extracted');
        assertEqual(calls[0].function.name, 'read_url', 'tool name');
    }],

    ['parse: returns null for empty input or unknown tools', () => {
        assertEqual(parseTextToolCalls('', ['read_url']), null, 'empty text');
        assertEqual(parseTextToolCalls('{"name":"nope","arguments":{}}', ['read_url']), null, 'unknown tool');
        assertEqual(parseTextToolCalls('hello', []), null, 'no known tools');
    }],

    // ── contentLooksLikeToolCalls ──────────────────────────────────────────

    ['detect: wrapper tag and invoke patterns', () => {
        assertEqual(contentLooksLikeToolCalls('<tool_calls>'), true, 'wrapper tag');
        assertEqual(contentLooksLikeToolCalls('<invoke name="web_search">'), true, 'invoke tag');
        assertEqual(contentLooksLikeToolCalls('read_url({"url":"x"})'), true, 'raw function call at start');
    }],

    ['detect: large prose that merely mentions tools is not flagged', () => {
        const prose = ('The web_search architecture is interesting. ' +
            'It combines several sources.\n\n' +
            'In this section we discuss read_url and crawl_url.\n\n' +
            'Finally, remember that tool names are just strings. ').repeat(30);
        assertEqual(contentLooksLikeToolCalls(prose), false, 'prose not flagged');
    }],

    ['detect: DSML-obfuscated wrapper is still detected', () => {
        assertEqual(contentLooksLikeToolCalls(dsmlGarbage), true, 'obfuscated wrapper');
    }],

    // ── stillLooksLikeToolMarkup ───────────────────────────────────────────

    ['residue: obfuscated markup detected, prose not', () => {
        assertEqual(stillLooksLikeToolMarkup(dsmlGarbage), true, 'DSML residue detected');
        assertEqual(stillLooksLikeToolMarkup('a < b and c > d'), false, 'prose with comparisons');
        assertEqual(stillLooksLikeToolMarkup(''), false, 'empty string');
    }],

    // ── stripTruncatedToolCallMarkup ───────────────────────────────────────

    ['strip: fully-XML garbage strips to empty', () => {
        assertEqual(stripTruncatedToolCallMarkup(dsmlGarbage), '', 'garbage removed entirely');
    }],

    ['strip: prose around balanced tags survives', () => {
        const text = 'Here is the answer.\n<tool_calls>\n<invoke name="read_url">\n<parameter name="url">https://x.example</parameter>\n</invoke>\n</tool_calls>\nDone.';
        const cleaned = stripTruncatedToolCallMarkup(text);
        assert(cleaned.includes('Here is the answer.'), 'leading prose kept');
        assert(cleaned.includes('Done.'), 'trailing prose kept');
        assert(!cleaned.includes('invoke'), 'tags removed');
    }],

    ['strip: truncated (unclosed) invoke fragments removed', () => {
        const text = 'Prose before.\n<invoke name="crawl_url">\n<parameter name="url">https://x.example';
        const cleaned = stripTruncatedToolCallMarkup(text);
        assert(cleaned.includes('Prose before.'), 'prose kept');
        assert(!cleaned.includes('<invoke'), 'truncated invoke removed');
        assert(!cleaned.includes('<parameter'), 'truncated parameter removed');
    }],
];

await runTests(tests);
