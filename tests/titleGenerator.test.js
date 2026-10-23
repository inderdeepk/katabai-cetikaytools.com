// titleGenerator.test.js — Tests for the pure conversation title/description
// generator helpers (transcript excerpt, prompt shape, response parsing).
import {
    AUTO_TITLE_MAX_CHARS,
    AUTO_TITLE_PROMPT_MAX_CHARS,
    TITLE_GEN_DESCRIPTION_MAX_CHARS,
    TITLE_GEN_TITLE_MAX_CHARS,
    TITLE_GEN_TRANSCRIPT_MAX_CHARS,
    buildAutoTitleMessages,
    buildTitleGenerationMessages,
    buildTranscriptExcerpt,
    messageText,
    parseAutoTitleResponse,
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
        'auto title: bounded single-user-message request',
        () => {
            const messages = buildAutoTitleMessages('How do I configure Ollama context?');
            assertEqual(messages.length, 1, 'single message (anthropic-safe)');
            assertEqual(messages[0].role, 'user', 'user role');
            assert(messages[0].content.includes('ONLY a short title'), 'instruction present');
            assert(
                messages[0].content.includes('How do I configure Ollama context?'),
                'prompt present',
            );

            const long = 'w'.repeat(AUTO_TITLE_PROMPT_MAX_CHARS + 200);
            const capped = buildAutoTitleMessages(`  ${long}  `);
            assert(capped[0].content.endsWith('\u2026\n"""'), 'prompt excerpt capped');
            assert(
                capped[0].content.includes('w'.repeat(AUTO_TITLE_PROMPT_MAX_CHARS)),
                'keeps the budgeted prefix',
            );

            assertEqual(buildAutoTitleMessages(''), null, 'empty prompt');
            assertEqual(buildAutoTitleMessages('   \n '), null, 'whitespace prompt');
            assertEqual(buildAutoTitleMessages(null), null, 'null prompt');
        },
    ],

    [
        'auto title: tolerant parsing of plain, fenced, JSON, and labeled replies',
        () => {
            assertEqual(
                parseAutoTitleResponse('  Debugging Ollama context limits.  '),
                'Debugging Ollama context limits',
                'plain text + trailing punctuation',
            );
            assertEqual(
                parseAutoTitleResponse('```\nGNOME Shell Wayland crash\n```'),
                'GNOME Shell Wayland crash',
                'fenced',
            );
            assertEqual(
                parseAutoTitleResponse('{"title": "Ollama context setup"}'),
                'Ollama context setup',
                'JSON title',
            );
            assertEqual(
                parseAutoTitleResponse('**Title**: "Kyoto in November"'),
                'Kyoto in November',
                'labeled + quoted',
            );
            assertEqual(
                parseAutoTitleResponse('Sure — here is your title: Wayland crash'),
                'Wayland crash',
                'prose lead-in',
            );
            assertEqual(
                parseAutoTitleResponse('- Slow RAG indexing\n\nExtra explanation'),
                'Slow RAG indexing',
                'bullet + first line',
            );
            assertEqual(
                parseAutoTitleResponse('1. Ollama context setup\u2026'),
                'Ollama context setup',
                'numbered list + ellipsis',
            );
            assertEqual(
                parseAutoTitleResponse('[GNOME] Wayland crash'),
                '[GNOME] Wayland crash',
                'bracketed title is not mistaken for JSON',
            );
            assertEqual(parseAutoTitleResponse('## Heading ##'), 'Heading', 'heading markers');
            assertEqual(parseAutoTitleResponse('C#'), 'C#', 'trailing hash is not markdown');
            assertEqual(parseAutoTitleResponse('Title - Foo'), 'Foo', 'spaced label dash');
            assertEqual(
                parseAutoTitleResponse('Title-bar behavior'),
                'Title-bar behavior',
                'hyphenated word is not a label',
            );
        },
    ],

    [
        'auto title: unusable replies are rejected',
        () => {
            assertEqual(parseAutoTitleResponse(''), '', 'empty');
            assertEqual(parseAutoTitleResponse('   '), '', 'whitespace');
            assertEqual(parseAutoTitleResponse(null), '', 'null');
            assertEqual(parseAutoTitleResponse('42'), '', 'bare number');
            assertEqual(parseAutoTitleResponse('{broken json'), '', 'broken syntax only');
            assertEqual(parseAutoTitleResponse('[1, 2, 3]'), '', 'JSON array');
            assertEqual(parseAutoTitleResponse('Title:'), '', 'empty labeled title');
            assertEqual(parseAutoTitleResponse('Untitled'), '', 'placeholder title');
            assertEqual(
                parseAutoTitleResponse('Chat UX improvements'),
                'Chat UX improvements',
                'real title containing Chat',
            );
            assertEqual(parseAutoTitleResponse('I cannot help with that.'), '', 'refusal');
            assertEqual(
                parseAutoTitleResponse("Sorry, I can't help with that."),
                '',
                'apologetic refusal',
            );
            assertEqual(
                parseAutoTitleResponse('Sorry State of Error Handling'),
                'Sorry State of Error Handling',
                'legitimate title beginning with Sorry',
            );
        },
    ],

    [
        'auto title: cap is honored on a word boundary',
        () => {
            const title = parseAutoTitleResponse(
                'one two three four five six seven eight nine ten',
            );
            assert(title.length <= AUTO_TITLE_MAX_CHARS, 'capped');
            assert(!title.endsWith(' '), 'no dangling space');
            const custom = parseAutoTitleResponse('one two three four five', { maxChars: 12 });
            assertEqual(custom, 'one two', 'cuts at a word boundary');

            const emoji = parseAutoTitleResponse('\u{1F600}'.repeat(10), { maxChars: 4 });
            assertEqual(
                Array.from(emoji).length,
                4,
                'code-point cap does not split surrogate pairs',
            );
            assertEqual(emoji, '\u{1F600}'.repeat(4), 'whole emoji kept');
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
            assert(AUTO_TITLE_MAX_CHARS < TITLE_GEN_TITLE_MAX_CHARS, 'auto title stays short');
        },
    ],
];

await runTests(tests);
