// titleGenerator.test.js — Tests for the pure conversation title/description
// generator helpers (transcript excerpt, prompt shape, response parsing).
import {
    TITLE_GEN_DESCRIPTION_MAX_CHARS,
    TITLE_GEN_TITLE_MAX_CHARS,
    TITLE_GEN_TRANSCRIPT_MAX_CHARS,
    buildTitleGenerationMessages,
    buildTranscriptExcerpt,
    messageText,
    parseTitleDescriptionResponse,
} from '../src/core/titleGenerator.js';
import { assert, assertEqual, runTests } from './testUtils.js';

const tests = [
    [
        'messageText: string, block arrays, tool results, and junk',
        () => {
            assertEqual(messageText({ content: 'hello' }), 'hello', 'string content');
            assertEqual(
                messageText({ content: [{ type: 'text', text: 'a' }, { text: 'b' }] }),
                'a b',
                'text blocks',
            );
            assertEqual(
                messageText({ content: [{ type: 'tool_result', content: 'result' }] }),
                'result',
                'tool result block',
            );
            assertEqual(messageText({}), '', 'missing content');
            assertEqual(messageText(null), '', 'null message');
        },
    ],

    [
        'excerpt: formats user/assistant and skips tool/system/injected messages',
        () => {
            const excerpt = buildTranscriptExcerpt([
                { role: 'system', content: 'system prompt' },
                { role: 'user', content: 'How do I configure Ollama?' },
                { role: 'assistant', content: 'Set the context size.' },
                { role: 'tool', name: 'web_search', content: 'tool output' },
                { role: 'user', content: 'ignored retry', _healingInjection: true },
                { role: 'user', content: 'ignored summary', _researchSummary: true },
                { role: 'user', content: 'ignored plan', _planInjection: true },
                { role: 'user', content: 'ignored synth', _synthesisRetry: true },
                { role: 'user', content: 'ignored memory', _sessionMemory: true },
            ]);
            assertEqual(
                excerpt,
                'User: How do I configure Ollama?\nAssistant: Set the context size.',
                'only displayable conversation turns',
            );
        },
    ],

    [
        'excerpt: empty when nothing displayable',
        () => {
            assertEqual(buildTranscriptExcerpt([]), '', 'empty array');
            assertEqual(buildTranscriptExcerpt(null), '', 'null');
            assertEqual(
                buildTranscriptExcerpt([
                    { role: 'tool', content: 'x' },
                    { role: 'user', content: '   ' },
                ]),
                '',
                'no displayable text',
            );
        },
    ],

    [
        'excerpt: per-message cap and total budget with truncation marker',
        () => {
            const long = 'w'.repeat(1000);
            const excerpt = buildTranscriptExcerpt(
                [
                    { role: 'user', content: long },
                    { role: 'assistant', content: 'reply' },
                    { role: 'user', content: 'third' },
                ],
                { maxMessageChars: 50, maxChars: 80 },
            );
            const lines = excerpt.split('\n');
            assert(lines[0].startsWith('User: ' + 'w'.repeat(50)), 'message capped at 50 chars');
            assert(lines[0].endsWith('\u2026'), 'ellipsis on capped message');
            assert(excerpt.includes('continues beyond this excerpt'), 'budget marker present');
            assert(!excerpt.includes('User: third'), 'over-budget message omitted');
        },
    ],

    [
        'excerpt: a single oversized first message still yields a bounded fragment',
        () => {
            const excerpt = buildTranscriptExcerpt([{ role: 'user', content: 'x'.repeat(5000) }], {
                maxMessageChars: 4000,
                maxChars: 100,
            });
            assert(excerpt.length > 0, 'non-empty');
            const [firstLine] = excerpt.split('\n');
            assert(firstLine.length <= 100, 'first line bounded by maxChars');
            assert(excerpt.startsWith('User: '), 'keeps speaker prefix');
        },
    ],

    [
        'buildTitleGenerationMessages: one user message, instruction + transcript',
        () => {
            const messages = buildTitleGenerationMessages([
                { role: 'user', content: 'Plan my trip to Kyoto' },
                { role: 'assistant', content: 'Sure — when are you going?' },
            ]);
            assertEqual(messages.length, 1, 'single message (anthropic-safe)');
            assertEqual(messages[0].role, 'user', 'user role');
            assert(messages[0].content.includes('STRICT JSON'), 'instruction present');
            assert(
                messages[0].content.includes('User: Plan my trip to Kyoto'),
                'transcript present',
            );
        },
    ],

    [
        'buildTitleGenerationMessages: null when there is nothing to summarize',
        () => {
            assertEqual(buildTitleGenerationMessages([]), null, 'empty messages');
            assertEqual(
                buildTitleGenerationMessages([{ role: 'system', content: 'only system' }]),
                null,
                'no user/assistant content',
            );
        },
    ],

    [
        'parse: clean JSON response',
        () => {
            const parsed = parseTitleDescriptionResponse(
                '{"title": "Ollama context setup", "description": "How to configure Ollama context size."}',
            );
            assert(parsed, 'parsed');
            assertEqual(parsed.title, 'Ollama context setup', 'title');
            assertEqual(parsed.description, 'How to configure Ollama context size.', 'description');
        },
    ],

    [
        'parse: fenced and prose-wrapped JSON',
        () => {
            const fenced = parseTitleDescriptionResponse(
                '```json\n{"title": "Kyoto Trip", "description": "Planning a Kyoto itinerary."}\n```',
            );
            assertEqual(fenced.title, 'Kyoto Trip', 'fence title');
            const embedded = parseTitleDescriptionResponse(
                'Here you go:\n{"title": "Kyoto Trip", "description": "Planning a Kyoto itinerary."}\nHope that helps!',
            );
            assertEqual(
                embedded.description,
                'Planning a Kyoto itinerary.',
                'embedded description',
            );
        },
    ],

    [
        'parse: labeled-line fallback when JSON is absent',
        () => {
            const parsed = parseTitleDescriptionResponse(
                '**Title**: Debugging read_url\n**Description**: Why page reads silently fail.',
            );
            assert(parsed, 'parsed');
            assertEqual(parsed.title, 'Debugging read_url', 'labeled title');
            assertEqual(parsed.description, 'Why page reads silently fail.', 'labeled description');
        },
    ],

    [
        'parse: title-only JSON yields an empty description',
        () => {
            const parsed = parseTitleDescriptionResponse('{"title": "Only a title"}');
            assertEqual(parsed.title, 'Only a title', 'title');
            assertEqual(parsed.description, '', 'no description');
        },
    ],

    [
        'parse: whitespace, quotes, and caps are normalized',
        () => {
            const parsed = parseTitleDescriptionResponse(
                JSON.stringify({
                    title: `"${'T'.repeat(TITLE_GEN_TITLE_MAX_CHARS + 50)}"`,
                    description: `  multi\nline   description ${'d'.repeat(TITLE_GEN_DESCRIPTION_MAX_CHARS)}`,
                }),
            );
            assert(!parsed.title.startsWith('"') && !parsed.title.endsWith('"'), 'quotes stripped');
            assertEqual(parsed.title.length, TITLE_GEN_TITLE_MAX_CHARS, 'title capped');
            assert(!parsed.description.includes('\n'), 'description single line');
            assertEqual(
                parsed.description.length,
                TITLE_GEN_DESCRIPTION_MAX_CHARS,
                'description capped',
            );
        },
    ],

    [
        'parse: unusable responses return null',
        () => {
            assertEqual(parseTitleDescriptionResponse(''), null, 'empty string');
            assertEqual(parseTitleDescriptionResponse(null), null, 'null');
            assertEqual(parseTitleDescriptionResponse('I cannot help with that.'), null, 'prose');
            assertEqual(parseTitleDescriptionResponse('[1, 2, 3]'), null, 'array JSON');
            assertEqual(
                parseTitleDescriptionResponse('{"other": "field"}'),
                null,
                'no title field',
            );
            assertEqual(parseTitleDescriptionResponse('{broken json'), null, 'malformed');
        },
    ],

    [
        'constants: sane ordering of generator vs transcript caps',
        () => {
            assert(
                TITLE_GEN_TITLE_MAX_CHARS < TITLE_GEN_TRANSCRIPT_MAX_CHARS,
                'title < transcript',
            );
            assert(TITLE_GEN_TRANSCRIPT_MAX_CHARS >= 1000, 'transcript budget usable');
        },
    ],
];

await runTests(tests);
