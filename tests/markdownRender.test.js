// markdownRender.test.js — Tests for the extracted markdown parse pipeline.
import {
    MARKDOWN_SEGMENT_MAX_CHARS,
    splitTextIntoBoundedChunks,
    normalizeUrl,
    formatInlineMarkdown,
    buildAssistantRenderModel,
} from '../src/ui/markdownRender.js';
import { assert, assertEqual, runTests } from './testUtils.js';

const textsOf = (model) => model.segments.filter((s) => s.type === 'text');
const firstText = (model) => textsOf(model)[0];

const tests = [
    // ── splitTextIntoBoundedChunks ─────────────────────────────────────────

    [
        'chunks: short text is a single chunk',
        () => {
            const chunks = splitTextIntoBoundedChunks('line one\nline two', 100);
            assertEqual(chunks.length, 1, 'one chunk');
        },
    ],

    [
        'chunks: splits at line boundaries within the cap',
        () => {
            const lines = Array.from({ length: 12 }, (_, i) => `line-${i}-${'x'.repeat(20)}`);
            const chunks = splitTextIntoBoundedChunks(lines.join('\n'), 50);
            assert(chunks.length > 1, 'split into multiple chunks');
            for (const chunk of chunks) {
                assert(chunk.length <= 50, `chunk within cap (${chunk.length})`);
            }
            assertEqual(chunks.join('\n'), lines.join('\n'), 'content preserved');
        },
    ],

    [
        'chunks: empty input yields one empty chunk; over-long single line kept whole',
        () => {
            assertEqual(JSON.stringify(splitTextIntoBoundedChunks('', 50)), '[""]', 'empty → [""]');
            const longLine = 'y'.repeat(120);
            const chunks = splitTextIntoBoundedChunks(longLine, 50);
            assertEqual(chunks.length, 1, 'single over-long line stays one chunk');
            assertEqual(chunks[0], longLine, 'content preserved');
        },
    ],

    // ── normalizeUrl ──────────────────────────────────────────────────────

    [
        'normalizeUrl: strips trailing punctuation, rejects non-http',
        () => {
            assertEqual(
                normalizeUrl(' https://example.com/page. '),
                'https://example.com/page',
                'trailing dot stripped',
            );
            assertEqual(normalizeUrl('not a url'), null, 'non-url rejected');
            assertEqual(normalizeUrl(''), null, 'empty rejected');
        },
    ],

    // ── formatInlineMarkdown ──────────────────────────────────────────────

    [
        'inline: bold, italic, and code spans',
        () => {
            assert(formatInlineMarkdown('**bold**').includes('<b>bold</b>'), 'bold');
            assert(formatInlineMarkdown('*italic*').includes('<i>italic</i>'), 'italic');
            assert(formatInlineMarkdown('`code`').includes('font_family="monospace"'), 'code span');
        },
    ],

    [
        'inline: HTML tags are stripped and special chars escaped',
        () => {
            const markup = formatInlineMarkdown('<b>not html</b> & "quotes"');
            assert(!markup.includes('<b>'), 'raw tags removed');
            assert(markup.includes('not html'), 'inner text kept');
            assert(markup.includes('&amp;'), 'ampersand escaped');
            assert(
                formatInlineMarkdown('a < b').includes('a &lt; b'),
                'lone angle bracket escaped',
            );
        },
    ],

    // ── buildAssistantRenderModel ─────────────────────────────────────────

    [
        'model: plain mode renders chunks without markdown parsing or link extraction',
        () => {
            const model = buildAssistantRenderModel('**not bold** <tag>', { plain: true });
            assertEqual(model.links.length, 0, 'no links in plain mode');
            const text = firstText(model);
            assert(!text.markup.includes('<b>'), 'no bold parsing');
            assert(text.markup.includes('**not bold**'), 'asterisks preserved');
            assert(!text.markup.includes('<tag>'), 'html tag stripped');
        },
    ],

    [
        'model: headings, bullets, and ordered lists produce markup',
        () => {
            const model = buildAssistantRenderModel('# Title\n- item\n1. first');
            const markup = firstText(model).markup;
            assert(markup.includes('size="x-large"'), 'heading size');
            assert(markup.includes('• item'), 'bullet');
            assert(markup.includes('1. first'), 'ordered item');
        },
    ],

    [
        'model: code fences become code segments with language',
        () => {
            const model = buildAssistantRenderModel('Before\n```js\nconst a = 1;\n```\nAfter');
            const code = model.segments.find((s) => s.type === 'code');
            assert(code, 'code segment present');
            assertEqual(code.language, 'js', 'language');
            assertEqual(code.code, 'const a = 1;', 'code body');
            assertEqual(textsOf(model).length, 2, 'text before + after');
        },
    ],

    [
        'model: odd trailing fence during streaming renders as plain text',
        () => {
            const streaming = buildAssistantRenderModel('Answer so far\n```py\nx = 1', {
                final: false,
            });
            assert(!streaming.segments.some((s) => s.type === 'code'), 'no complete code segment');
            const trailing = textsOf(streaming).find((s) => s.fallbackText.includes('```py'));
            assert(trailing, 'trailing fence rendered as text');
            assert(trailing.markup.includes('```py'), 'fence visible in markup');

            const finale = buildAssistantRenderModel('Answer so far\n```py\nx = 1', {
                final: true,
            });
            assert(
                !finale.segments.some((s) => s.type === 'code'),
                'final: still no code segment for unclosed fence',
            );
            assert(
                textsOf(finale).some((s) => s.fallbackText.includes('x = 1')),
                'final: content preserved as text',
            );
        },
    ],

    [
        'model: markdown tables become table segments',
        () => {
            const model = buildAssistantRenderModel('| A | B |\n| --- | --- |\n| 1 | 2 |');
            const table = model.segments.find((s) => s.type === 'table');
            assert(table, 'table segment present');
            assertEqual(table.headers.join(','), 'A,B', 'headers');
            assertEqual(table.rows.length, 1, 'one row');
            assertEqual(table.rows[0].join(','), '1,2', 'row cells');
        },
    ],

    [
        'model: divider lines become rule segments',
        () => {
            const model = buildAssistantRenderModel('Above\n---\nBelow');
            assert(
                model.segments.some((s) => s.type === 'rule'),
                'rule segment',
            );
        },
    ],

    [
        'model: blockquotes nest parsed content',
        () => {
            const model = buildAssistantRenderModel('> quoted **bold**\n> second line');
            const quote = model.segments.find((s) => s.type === 'blockquote');
            assert(quote, 'blockquote segment');
            const inner = quote.segments.find((s) => s.type === 'text');
            assert(inner.markup.includes('<b>bold</b>'), 'nested formatting');
        },
    ],

    [
        'model: links are extracted, deduped, and left as label text',
        () => {
            const model = buildAssistantRenderModel(
                'See [docs](https://example.com/a) and https://example.com/a plus https://example.com/b.',
            );
            assertEqual(model.links.length, 2, 'two unique links');
            assertEqual(model.links[0].label, 'docs', 'markdown label kept');
            assert(
                model.links.some((l) => l.url === 'https://example.com/b'),
                'bare url collected',
            );
            assert(
                firstText(model).fallbackText.includes('See docs and'),
                'link label replaces markdown syntax',
            );
        },
    ],

    [
        'model: empty input yields no segments',
        () => {
            const model = buildAssistantRenderModel('');
            assertEqual(model.segments.length, 0, 'no segments');
            assertEqual(model.links.length, 0, 'no links');
        },
    ],

    [
        'model: MARKDOWN_SEGMENT_MAX_CHARS is respected for long text blocks',
        () => {
            const longText = Array.from(
                { length: 400 },
                (_, i) => `paragraph line ${i} ${'z'.repeat(30)}`,
            ).join('\n');
            const model = buildAssistantRenderModel(longText);
            for (const segment of textsOf(model)) {
                assert(
                    segment.fallbackText.length <= MARKDOWN_SEGMENT_MAX_CHARS,
                    `segment within cap (${segment.fallbackText.length})`,
                );
            }
        },
    ],
];

await runTests(tests);
