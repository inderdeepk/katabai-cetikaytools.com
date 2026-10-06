// historyPayload.test.js — Tests for provider payload shaping (estimates,
// truncators, attachment payloads, provider-dialect sanitization).
import {
    DEEPSEEK_INPUT_TOKEN_BUDGET,
    estimateTextTokens,
    estimateContentTokens,
    estimateDeepSeekMessageTokens,
    truncateOllamaMessages,
    truncateDeepSeekMessages,
    truncateToolResultForIteration,
    getMessageAttachments,
    getAttachmentKind,
    messageHasImageAttachments,
    extractMessageText,
    buildApiAttachmentPayload,
    sanitizeHistoryMessage,
} from '../src/providers/historyPayload.js';
import { IMAGE_TOKEN_ESTIMATE } from '../src/core/sessionMemory.js';
import { formatLinksSection } from '../src/shared/pageLinks.js';
import { assert, assertEqual, assertDeepEqual, runTests } from './testUtils.js';

const SANDBOX_B64 = 'A'.repeat(30000);
const imageMeta = (path = '/tmp/x.png') => ({ path, kind: 'image', displayName: 'x.png' });
const cachedImage = (base64Data = 'QQ==') => ({ kind: 'image', base64Data, mimeType: 'image/png' });

const tests = [
    // ── estimateTextTokens / estimateContentTokens ─────────────────────────

    [
        'tokens: null/empty/undefined are 0',
        () => {
            assertEqual(estimateTextTokens(null), 0, 'null');
            assertEqual(estimateTextTokens(undefined), 0, 'undefined');
            assertEqual(estimateTextTokens(''), 0, 'empty');
        },
    ],
    [
        'tokens: string is ceil(len/4)',
        () => {
            assertEqual(estimateTextTokens('abcd'), 1, '4 chars → 1');
            assertEqual(estimateTextTokens('x'.repeat(400)), 100, '400 chars → 100');
        },
    ],
    [
        'tokens: non-string is JSON-stringified (never [object Object])',
        () => {
            assertEqual(estimateTextTokens(1234), 1, 'number');
            assertEqual(estimateTextTokens({ a: 1 }), 2, 'object → JSON len 7');
        },
    ],
    [
        'content: string + plain object',
        () => {
            assertEqual(estimateContentTokens('abcd'), 1, 'string');
            assertEqual(estimateContentTokens({ a: 1 }), 2, 'object JSON');
        },
    ],
    [
        'content: image blocks are charged a fixed cost, not base64 length',
        () => {
            const blocks = [
                { type: 'image_url', image_url: { url: `data:image/png;base64,${SANDBOX_B64}` } },
            ];
            assertEqual(estimateContentTokens(blocks), IMAGE_TOKEN_ESTIMATE, 'openai image_url');
            const anthropic = [
                {
                    type: 'image',
                    source: { type: 'base64', media_type: 'image/png', data: SANDBOX_B64 },
                },
            ];
            assertEqual(estimateContentTokens(anthropic), IMAGE_TOKEN_ESTIMATE, 'anthropic base64');
        },
    ],
    [
        'content: text blocks are JSON-counted',
        () => {
            const tokens = estimateContentTokens([{ type: 'text', text: 'abcd' }]);
            // '{"type":"text","text":"abcd"}' = 29 chars → 8
            assertEqual(tokens, 8, 'JSON length / 4');
        },
    ],

    // ── estimateDeepSeekMessageTokens ──────────────────────────────────────

    [
        'deepseek tokens: base overhead + role + content',
        () => {
            assertEqual(
                estimateDeepSeekMessageTokens({ role: 'user', content: 'aaaa' }),
                8,
                '6+1+1',
            );
            assertEqual(estimateDeepSeekMessageTokens(null), 0, 'null message');
        },
    ],
    [
        'deepseek tokens: reasoning + tool_calls + images',
        () => {
            const msg = {
                role: 'assistant',
                content: '',
                reasoning_content: 'r'.repeat(400),
                tool_calls: [
                    { id: 't', type: 'function', function: { name: 'x', arguments: '{}' } },
                ],
                images: ['a', 'b'],
            };
            const tokens = estimateDeepSeekMessageTokens(msg);
            assert(tokens >= 2 * IMAGE_TOKEN_ESTIMATE + 100, 'images (fixed) + reasoning counted');
        },
    ],

    // ── truncateOllamaMessages ─────────────────────────────────────────────

    [
        'ollama: ≤4 messages untouched',
        () => {
            const messages = [
                { role: 'system', content: 'S' },
                { role: 'user', content: 'x'.repeat(5000) },
            ];
            assertEqual(truncateOllamaMessages(messages), messages, 'same reference');
        },
    ],
    [
        'ollama: under budget untouched',
        () => {
            const messages = [
                { role: 'system', content: 'S' },
                ...Array.from({ length: 6 }, () => ({ role: 'user', content: 'short' })),
            ];
            assertEqual(
                truncateOllamaMessages(messages, { maxBodyChars: 100000 }),
                messages,
                'same ref',
            );
        },
    ],
    [
        'ollama: drops middles, keeps system + newest',
        () => {
            const system = { role: 'system', content: 'S' };
            const middles = Array.from({ length: 8 }, (_, i) => ({
                role: 'user',
                content: `m${i}`.padEnd(1000, 'x'),
            }));
            const messages = [system, ...middles];
            const result = truncateOllamaMessages(messages, { maxBodyChars: 4000 });
            assert(result.length < messages.length, 'truncated');
            assertEqual(result[0], system, 'system kept');
            assertEqual(result[result.length - 1], middles[middles.length - 1], 'newest kept');
        },
    ],
    [
        'ollama: image payloads do not count as base64 text',
        () => {
            const messages = [
                { role: 'system', content: 'S' },
                ...Array.from({ length: 6 }, () => ({
                    role: 'user',
                    content: [
                        {
                            type: 'image_url',
                            image_url: { url: `data:image/png;base64,${SANDBOX_B64}` },
                        },
                    ],
                })),
            ];
            assertEqual(
                truncateOllamaMessages(messages, { maxBodyChars: 50000 }),
                messages,
                'collapsed image cost stays under budget',
            );
        },
    ],
    [
        'ollama: heavy fallback keeps system + last message',
        () => {
            const system = { role: 'system', content: 'S' };
            const messages = [
                system,
                ...Array.from({ length: 4 }, () => ({ role: 'user', content: 'x'.repeat(100000) })),
            ];
            const result = truncateOllamaMessages(messages, { maxBodyChars: 1000 });
            assertEqual(result.length, 2, 'minimal fallback');
            assertEqual(result[0], system, 'system');
            assertEqual(result[1], messages[4], 'last');
        },
    ],

    // ── truncateDeepSeekMessages ───────────────────────────────────────────

    [
        'deepseek: ≤2 messages untouched',
        () => {
            const messages = [
                { role: 'system', content: 'S' },
                { role: 'user', content: 'x'.repeat(99999) },
            ];
            assertEqual(truncateDeepSeekMessages(messages), messages, 'same ref');
        },
    ],
    [
        'deepseek: under budget untouched',
        () => {
            const messages = [
                { role: 'system', content: 'S' },
                { role: 'user', content: 'hello' },
                { role: 'assistant', content: 'hi' },
            ];
            assertEqual(
                truncateDeepSeekMessages(messages, { tokenBudget: 1000000 }),
                messages,
                'same ref',
            );
        },
    ],
    [
        'deepseek: drops middles, keeps prefix + newest',
        () => {
            const sys = { role: 'system', content: 'SYS' };
            const user1 = { role: 'user', content: 'FIRST' };
            const middles = Array.from({ length: 4 }, () => ({
                role: 'assistant',
                content: 'M'.repeat(20000),
            }));
            const last = { role: 'user', content: 'LAST' };
            const messages = [sys, user1, ...middles, last];
            const budget =
                estimateDeepSeekMessageTokens(sys) +
                estimateDeepSeekMessageTokens(user1) +
                estimateDeepSeekMessageTokens(last) +
                20;
            const result = truncateDeepSeekMessages(messages, { tokenBudget: budget });
            assertEqual(result[0], sys, 'system kept');
            assertEqual(result[1], user1, 'first user kept');
            assertEqual(result[result.length - 1], last, 'newest kept');
            assert(result.length < messages.length, 'middles dropped');
            assert(!result.includes(middles[0]), 'middle dropped');
        },
    ],
    [
        'deepseek: trailing tool span stays with its assistant turn',
        () => {
            const sys = { role: 'system', content: 'SYS' };
            const user1 = { role: 'user', content: 'FIRST' };
            const midA = { role: 'assistant', content: 'M'.repeat(20000) };
            const midB = { role: 'user', content: 'N'.repeat(20000) };
            const asstTool = {
                role: 'assistant',
                content: '',
                tool_calls: [
                    { id: 't', type: 'function', function: { name: 'read_url', arguments: '{}' } },
                ],
            };
            const tool1 = { role: 'tool', tool_call_id: 't', content: 'R1'.repeat(100) };
            const tool2 = { role: 'tool', tool_call_id: 't', content: 'R2'.repeat(100) };
            const messages = [sys, user1, midA, midB, asstTool, tool1, tool2];
            const budget =
                [sys, user1, asstTool, tool1, tool2].reduce(
                    (sum, m) => sum + estimateDeepSeekMessageTokens(m),
                    0,
                ) + 10;
            const result = truncateDeepSeekMessages(messages, { tokenBudget: budget });
            assertDeepEqual(result, [sys, user1, asstTool, tool1, tool2], 'tool span grouped');
        },
    ],
    [
        'deepseek: exported input budget matches 1M context minus 384K output',
        () => {
            assertEqual(DEEPSEEK_INPUT_TOKEN_BUDGET, 616000, 'budget constant');
        },
    ],

    // ── truncateToolResultForIteration ─────────────────────────────────────

    [
        'toolresult: guards — non-string and missing tiers',
        () => {
            assertEqual(
                truncateToolResultForIteration(null, { toolName: 'read_url' }),
                null,
                'null',
            );
            assertEqual(
                truncateToolResultForIteration('text', { toolName: 'read_url' }),
                'text',
                'no tiers → unchanged',
            );
        },
    ],
    [
        'toolresult: tier selection by iteration',
        () => {
            const tiers = [
                {
                    maxIteration: 2,
                    readUrlChars: 4000,
                    crawlChars: 4000,
                    searchResults: 5,
                    searchSnippetChars: 200,
                },
                {
                    maxIteration: 99,
                    readUrlChars: 500,
                    crawlChars: 500,
                    searchResults: 2,
                    searchSnippetChars: 50,
                },
            ];
            const text = 'A'.repeat(5000);
            const early = truncateToolResultForIteration(text, {
                toolName: 'read_url',
                iteration: 1,
                tiers,
            });
            const late = truncateToolResultForIteration(text, {
                toolName: 'read_url',
                iteration: 5,
                tiers,
            });
            assert(early.length > 3500, 'early tier keeps most of the body');
            assert(late.length < 1500, 'late tier trims hard');
        },
    ],
    [
        'toolresult: read keeps the links tail when trimming',
        () => {
            const links = formatLinksSection([{ href: 'https://ex.example/x', text: 'Page X' }]);
            const text = `${'B'.repeat(5000)}\n\n${links}`;
            const tiers = [
                {
                    maxIteration: 99,
                    readUrlChars: 1000,
                    crawlChars: 1000,
                    searchResults: 5,
                    searchSnippetChars: 200,
                },
            ];
            const result = truncateToolResultForIteration(text, {
                toolName: 'read_url',
                iteration: 0,
                tiers,
            });
            assert(result.includes('https://ex.example/x'), 'links tail preserved');
            assert(result.includes('Content trimmed'), 'trim note present');
            assert(result.startsWith('B'), 'head preserved');
        },
    ],
    [
        'toolresult: crawl + knowledge caps use their tier fields',
        () => {
            const tiers = [
                {
                    maxIteration: 99,
                    readUrlChars: 1000,
                    crawlChars: 800,
                    knowledgeChars: 300,
                    searchResults: 5,
                    searchSnippetChars: 200,
                },
            ];
            const crawl = truncateToolResultForIteration('C'.repeat(5000), {
                toolName: 'crawl_url',
                iteration: 0,
                tiers,
            });
            assert(crawl.length < 1000 && crawl.includes('Content trimmed'), 'crawl cap 800');
            const knowledge = truncateToolResultForIteration('K'.repeat(5000), {
                toolName: 'knowledge_search',
                iteration: 0,
                tiers,
            });
            assert(knowledge.length < 500, 'knowledge cap 300');
        },
    ],
    [
        'toolresult: search trims result count and snippet length',
        () => {
            const snippet = 's'.repeat(200);
            const text = Array.from(
                { length: 4 },
                (_, i) =>
                    `${i + 1}. Result ${i + 1}\n   URL: https://${i + 1}.example\n   ${snippet}`,
            ).join('\n');
            const tiers = [
                {
                    maxIteration: 99,
                    readUrlChars: 1000,
                    crawlChars: 1000,
                    searchResults: 2,
                    searchSnippetChars: 50,
                },
            ];
            const result = truncateToolResultForIteration(text, {
                toolName: 'web_search',
                iteration: 0,
                tiers,
            });
            assert(!result.includes('Result 3'), 'third result dropped');
            assert(result.includes('more results trimmed'), 'trim notice');
            // The snippet line keeps its 3-space indent: slice(0,50) = 3 spaces + 47 s.
            assert(result.includes('s'.repeat(47) + '…'), 'snippet truncated with ellipsis');
        },
    ],
    [
        'toolresult: under-cap text unchanged',
        () => {
            const tiers = [
                {
                    maxIteration: 99,
                    readUrlChars: 1000,
                    crawlChars: 1000,
                    searchResults: 5,
                    searchSnippetChars: 200,
                },
            ];
            assertEqual(
                truncateToolResultForIteration('short', {
                    toolName: 'read_url',
                    iteration: 0,
                    tiers,
                }),
                'short',
                'unchanged',
            );
        },
    ],

    // ── attachment helpers ─────────────────────────────────────────────────

    [
        'attachments: metadata helpers',
        () => {
            assertDeepEqual(
                getMessageAttachments({ documents: [{ path: 'a' }] }),
                [{ path: 'a' }],
                'array',
            );
            assertDeepEqual(getMessageAttachments({}), [], 'missing → []');
            assertEqual(getAttachmentKind({ kind: 'image' }), 'image', 'explicit kind');
            assertEqual(getAttachmentKind({ kind: 'document' }), 'document', 'explicit document');
            assertEqual(getAttachmentKind(imageMeta()), 'image', 'png path → image');
            assert(
                messageHasImageAttachments({ documents: [imageMeta()] }),
                'image attachment detected',
            );
            assert(
                !messageHasImageAttachments({ documents: [{ kind: 'document' }] }),
                'document only',
            );
        },
    ],
    [
        'attachments: extractMessageText handles strings, blocks and tool results',
        () => {
            assertEqual(extractMessageText({ content: 'plain' }), 'plain', 'string');
            assertEqual(
                extractMessageText({
                    content: [
                        { type: 'text', text: 'a' },
                        'b',
                        { type: 'tool_result', content: 'c' },
                    ],
                }),
                'a b c',
                'blocks',
            );
            assertEqual(extractMessageText({ content: 42 }), '', 'unsearchable');
        },
    ],

    // ── buildApiAttachmentPayload ──────────────────────────────────────────

    [
        'payload: no attachments passthrough',
        () => {
            assertDeepEqual(
                buildApiAttachmentPayload({ role: 'user', content: 'hi' }),
                { content: 'hi', images: [] },
                'plain',
            );
        },
    ],
    [
        'payload: array content passed through verbatim',
        () => {
            const content = [{ type: 'tool_result', tool_use_id: 'x', content: 'r' }];
            const payload = buildApiAttachmentPayload({ role: 'user', content });
            assertEqual(payload.content, content, 'same reference');
        },
    ],
    [
        'payload: cached ollama image becomes base64 images entry',
        () => {
            const payload = buildApiAttachmentPayload(
                { role: 'user', content: '', documents: [imageMeta()] },
                { provider: 'ollama', getSessionAttachment: () => cachedImage('BB==') },
            );
            assertDeepEqual(payload.images, ['BB=='], 'base64 data');
        },
    ],
    [
        'payload: missing image yields reattach notice for text providers',
        () => {
            const payload = buildApiAttachmentPayload(
                { role: 'user', content: 'q', documents: [imageMeta()] },
                { provider: 'openai', getSessionAttachment: () => null },
            );
            assert(String(payload.content).includes('Previously attached image:'), 'notice');
        },
    ],
    [
        'payload: vision analysis block added once for multiple images',
        () => {
            const payload = buildApiAttachmentPayload(
                {
                    role: 'user',
                    content: 'q',
                    documents: [imageMeta('/tmp/a.png'), imageMeta('/tmp/b.png')],
                },
                {
                    provider: 'deepseek',
                    visionAnalysis: 'ANALYSIS',
                    visionModelName: 'llava',
                    getSessionAttachment: () => cachedImage(),
                },
            );
            const occurrences =
                String(payload.content).split('[Vision analysis of the attached image').length - 1;
            assertEqual(occurrences, 1, 'single deduped vision block');
            assert(String(payload.content).includes('llava'), 'model named');
        },
    ],

    // ── sanitizeHistoryMessage ─────────────────────────────────────────────

    [
        'sanitize: strips UI-only keys for OpenAI-compatible providers',
        () => {
            const out = sanitizeHistoryMessage(
                {
                    role: 'user',
                    content: 'hi',
                    documents: [],
                    metrics: { eval_count: 1 },
                    provider: 'ollama',
                    index: 3,
                },
                { provider: 'openai' },
            );
            assertDeepEqual(out, { role: 'user', content: 'hi' }, 'only API keys survive');
        },
    ],
    [
        'sanitize: anthropic array content passes through untouched',
        () => {
            const content = [
                { type: 'tool_use', id: 't', name: 'x', input: {} },
                { type: 'tool_result', tool_use_id: 't', content: 'r' },
            ];
            const out = sanitizeHistoryMessage(
                { role: 'user', content },
                { provider: 'anthropic' },
            );
            assertEqual(out.content, content, 'same reference');
            assertEqual(out.role, 'user', 'role');
        },
    ],
    [
        'sanitize: assistant tool_use blocks convert to tool_calls for OpenAI',
        () => {
            const out = sanitizeHistoryMessage(
                {
                    role: 'assistant',
                    content: [
                        { type: 'tool_use', id: 't1', name: 'web_search', input: { q: 'x' } },
                    ],
                },
                { provider: 'openai' },
            );
            assertEqual(out.content, undefined, 'content removed');
            assertDeepEqual(
                out.tool_calls,
                [
                    {
                        id: 't1',
                        type: 'function',
                        function: { name: 'web_search', arguments: '{"q":"x"}' },
                    },
                ],
                'tool_calls shape',
            );
        },
    ],
    [
        'sanitize: tool_result blocks flatten to plain text',
        () => {
            const out = sanitizeHistoryMessage(
                { role: 'user', content: [{ type: 'tool_result', content: 'RESULT' }] },
                { provider: 'openai' },
            );
            assertEqual(out.content, 'RESULT', 'flattened');
        },
    ],
    [
        'sanitize: context injections append to content',
        () => {
            const out = sanitizeHistoryMessage(
                { role: 'user', content: 'q', webSearchContext: 'CTX' },
                { provider: 'openai' },
            );
            assertEqual(out.content, 'q\n\nCTX', 'appended');
            const empty = sanitizeHistoryMessage(
                { role: 'user', content: '', webSearchContext: 'CTX' },
                { provider: 'openai' },
            );
            assertEqual(empty.content, 'CTX', 'empty content replaced');
        },
    ],
    [
        'sanitize: deepseek adds type + reasoning echo rules',
        () => {
            const withReasoning = sanitizeHistoryMessage(
                {
                    role: 'assistant',
                    content: 'a',
                    reasoning_content: 'R',
                    tool_calls: [
                        { id: '1', type: 'function', function: { name: 'x', arguments: '{}' } },
                    ],
                },
                { provider: 'deepseek', thinkingEnabled: true },
            );
            assertEqual(withReasoning.type, 'assistant', 'type mirrors role');
            assertEqual(withReasoning.reasoning_content, 'R', 'reasoning echoed');

            const thinkingOnNoReasoning = sanitizeHistoryMessage(
                { role: 'assistant', content: 'a' },
                { provider: 'deepseek', thinkingEnabled: true },
            );
            assertEqual(
                thinkingOnNoReasoning.reasoning_content,
                '',
                'empty string when thinking on',
            );

            const thinkingOff = sanitizeHistoryMessage(
                {
                    role: 'assistant',
                    content: '',
                    reasoning_content: 'R',
                    tool_calls: [
                        { id: '1', type: 'function', function: { name: 'x', arguments: '{}' } },
                    ],
                },
                { provider: 'deepseek', thinkingEnabled: false },
            );
            assertEqual(
                thinkingOff.reasoning_content,
                'R',
                'tool-call turn echo when thinking off',
            );

            const plainOff = sanitizeHistoryMessage(
                { role: 'assistant', content: 'a' },
                { provider: 'deepseek', thinkingEnabled: false },
            );
            assertEqual(plainOff.reasoning_content, undefined, 'no echo without tool calls');
        },
    ],
    [
        'sanitize: deepseek type is stripped for other openai-compatible providers',
        () => {
            const out = sanitizeHistoryMessage(
                { role: 'user', content: 'x' },
                { provider: 'openai' },
            );
            assertEqual(out.type, undefined, 'no deepseek type leak');
        },
    ],
    [
        'sanitize: ollama merges message.images with cached attachment images',
        () => {
            const out = sanitizeHistoryMessage(
                { role: 'user', content: '', images: ['A'], documents: [imageMeta()] },
                { provider: 'ollama', getSessionAttachment: () => cachedImage('B') },
            );
            assertDeepEqual(out.images, ['A', 'B'], 'merged');
        },
    ],
    [
        'sanitize: native deepseek vision keeps array content blocks',
        () => {
            const out = sanitizeHistoryMessage(
                { role: 'user', content: 'hi', documents: [imageMeta()] },
                {
                    provider: 'deepseek',
                    isDeepSeekNativeVisionModel: () => true,
                    getSessionAttachment: () => cachedImage('QQ=='),
                },
            );
            assert(Array.isArray(out.content), 'content stays array');
            assertEqual(out.content[1].type, 'image_url', 'image_url block');
            assertEqual(
                out.content[1].image_url.url,
                'data:image/png;base64,QQ==',
                'data URI built',
            );
            assertEqual(out.type, 'user', 'deepseek type set');
        },
    ],
    [
        'sanitize: text-only deepseek uses the vision analysis block',
        () => {
            const out = sanitizeHistoryMessage(
                {
                    role: 'user',
                    content: 'What is this?',
                    documents: [imageMeta()],
                    visionAnalysis: 'ANALYSIS',
                },
                {
                    provider: 'deepseek',
                    getVisionModelConfig: () => ({ model: 'llava' }),
                    getSessionAttachment: () => cachedImage(),
                },
            );
            assert(String(out.content).includes('ANALYSIS'), 'analysis text');
            assert(String(out.content).includes('llava'), 'model named');
        },
    ],
    [
        'sanitize: failed vision sentinel renders unavailable notice',
        () => {
            const out = sanitizeHistoryMessage(
                { role: 'user', content: 'q', documents: [imageMeta()], visionAnalysis: '' },
                {
                    provider: 'deepseek',
                    getVisionModelConfig: () => ({ model: 'llava' }),
                    getSessionAttachment: () => cachedImage(),
                },
            );
            assert(String(out.content).includes('Vision analysis unavailable'), 'sentinel notice');
        },
    ],
    [
        'sanitize: unknown document attachment yields reattach notice',
        () => {
            const out = sanitizeHistoryMessage(
                {
                    role: 'user',
                    content: '',
                    documents: [{ displayName: 'doc.pdf', path: '/tmp/doc.pdf' }],
                },
                { provider: 'openai', getSessionAttachment: () => null },
            );
            assert(String(out.content).includes('Previously attached document: doc.pdf'), 'notice');
        },
    ],
];

await runTests(tests);
