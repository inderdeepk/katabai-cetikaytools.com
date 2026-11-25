// askUserTools.test.js — Unit tests for ask_user config, /guide parser,
// argument normalization, result formatting, summary cards, and instructions.
import {
    ASK_USER_TOOL_NAME,
    ASK_USER_TOOL_COMMAND,
    ASK_USER_DEFAULT_ENABLED,
    ASK_USER_DEFAULT_MAX_PER_TURN,
    ASK_USER_MIN_MAX_PER_TURN,
    ASK_USER_MAX_MAX_PER_TURN,
    ASK_USER_MAX_QUESTIONS,
    ASK_USER_MAX_OPTIONS,
    readAskUserConfig,
    parseGuideCommand,
    normalizeAskUserArgs,
    formatAskUserResult,
    buildAskUserSummary,
    buildInteractiveSystemInstruction,
} from '../src/tools/askUserTools.js';
import { assert, assertEqual, assertDeepEqual, runTests, createMockSettings } from './testUtils.js';

const tests = [
    // ── readAskUserConfig ──────────────────────────────────────────────────

    [
        'readAskUserConfig: returns defaults when settings throw or omit keys',
        () => {
            const throwing = {
                get_boolean: () => {
                    throw new Error('missing');
                },
                get_int: () => {
                    throw new Error('missing');
                },
            };
            assertDeepEqual(readAskUserConfig(throwing), {
                enabled: ASK_USER_DEFAULT_ENABLED,
                maxPerTurn: ASK_USER_DEFAULT_MAX_PER_TURN,
            });
        },
    ],

    [
        'readAskUserConfig: clamps maxPerTurn to [1, 10] and reads enabled',
        () => {
            const low = createMockSettings({
                'ask-user-enabled': false,
                'ask-user-max-per-turn': -5,
            });
            assertDeepEqual(readAskUserConfig(low), {
                enabled: false,
                maxPerTurn: ASK_USER_MIN_MAX_PER_TURN,
            });

            const high = createMockSettings({
                'ask-user-enabled': true,
                'ask-user-max-per-turn': 99,
            });
            assertDeepEqual(readAskUserConfig(high), {
                enabled: true,
                maxPerTurn: ASK_USER_MAX_MAX_PER_TURN,
            });

            const mid = createMockSettings({
                'ask-user-enabled': true,
                'ask-user-max-per-turn': 5,
            });
            assertDeepEqual(readAskUserConfig(mid), {
                enabled: true,
                maxPerTurn: 5,
            });
        },
    ],

    // ── parseGuideCommand ──────────────────────────────────────────────────

    [
        'parseGuideCommand: handles bare, prefix, suffix, case-insensitivity, and non-matches',
        () => {
            assertDeepEqual(parseGuideCommand('/guide'), { isCommand: true, prompt: '' });
            assertDeepEqual(parseGuideCommand('  /GUIDE  '), { isCommand: true, prompt: '' });
            assertDeepEqual(parseGuideCommand('/guide Walk me through this takeover'), {
                isCommand: true,
                prompt: 'Walk me through this takeover',
            });
            assertDeepEqual(parseGuideCommand('Help me finish the checklist /guide'), {
                isCommand: true,
                prompt: 'Help me finish the checklist',
            });
            assertEqual(parseGuideCommand('/guidance something'), null, 'must not match /guidance');
            assertEqual(
                parseGuideCommand('complete the /guide step'),
                null,
                'mid-sentence ignored',
            );
            assertEqual(parseGuideCommand(''), null, 'empty returns null');
        },
    ],

    // ── normalizeAskUserArgs ───────────────────────────────────────────────

    [
        'normalizeAskUserArgs: normalizes canonical payload with snake_case and camelCase',
        () => {
            const res = normalizeAskUserArgs({
                title: '  Takeover setup  ',
                questions: [
                    {
                        id: 'phase',
                        question: ' Which phases are already done? ',
                        options: ['Phase 1', 'phase 1', { label: 'Phase 2' }, '  '],
                        multi_select: true,
                        allow_custom: false,
                        placeholder: 'Add details',
                    },
                    {
                        question: 'Preferred pace?',
                        options: ['Step-by-step', 'Full draft'],
                        multiSelect: false,
                    },
                ],
            });
            assertEqual(res.ok, true, 'valid payload');
            assertEqual(res.title, 'Takeover setup', 'trimmed title');
            assertEqual(res.questions.length, 2, 'two questions');
            assertDeepEqual(res.questions[0], {
                id: 'phase',
                question: 'Which phases are already done?',
                options: ['Phase 1', 'Phase 2'],
                multiSelect: true,
                allowCustom: false,
                placeholder: 'Add details',
            });
            assertDeepEqual(res.questions[1], {
                id: 'q2',
                question: 'Preferred pace?',
                options: ['Step-by-step', 'Full draft'],
                multiSelect: false,
                allowCustom: true,
                placeholder: '',
            });
        },
    ],

    [
        'normalizeAskUserArgs: repairs top-level question shorthand and string arrays',
        () => {
            const single = normalizeAskUserArgs({
                question: 'Which domain should we start with?',
                options: ['EasyDNS', 'HostGator'],
            });
            assertEqual(single.ok, true, 'top-level shorthand accepted');
            assertEqual(single.questions.length, 1, 'wrapped into 1 question');
            assertEqual(single.questions[0].options.length, 2, 'options preserved');

            const strArr = normalizeAskUserArgs({
                questions: ['What OS?', 'Which browser?'],
            });
            assertEqual(strArr.ok, true, 'string array accepted');
            assertEqual(strArr.questions[0].allowCustom, true, 'freeform allowed');
            assertEqual(strArr.questions[1].id, 'q2', 'generated id');
        },
    ],

    [
        'normalizeAskUserArgs: enforces question/option caps, dedups IDs, and rejects empty',
        () => {
            const tooManyQuestions = Array.from({ length: 12 }, (_, i) => ({
                id: 'dup',
                question: `Q${i + 1}`,
                options: Array.from({ length: 15 }, (_v, j) => `Opt ${j + 1}`),
            }));
            const res = normalizeAskUserArgs({ questions: tooManyQuestions });
            assertEqual(res.ok, true, 'capped payload valid');
            assertEqual(res.questions.length, ASK_USER_MAX_QUESTIONS, 'questions capped');
            assertEqual(res.questions[0].options.length, ASK_USER_MAX_OPTIONS, 'options capped');
            assertEqual(res.questions[0].id, 'dup', 'first id kept');
            assertEqual(res.questions[1].id, 'dup_2', 'duplicate id disambiguated');

            assertEqual(normalizeAskUserArgs(null).ok, false, 'null rejected');
            assertEqual(normalizeAskUserArgs([]).ok, false, 'array rejected');
            assertEqual(normalizeAskUserArgs({ questions: [] }).ok, false, 'empty rejected');
            assertEqual(
                normalizeAskUserArgs({ questions: [{ question: '   ' }] }).ok,
                false,
                'whitespace-only question rejected',
            );
        },
    ],

    // ── formatAskUserResult & buildAskUserSummary ──────────────────────────

    [
        'formatAskUserResult & buildAskUserSummary: formats answers, combined custom notes, and skips',
        () => {
            const questions = [
                { id: 'q1', question: 'Which phases are done?' },
                { id: 'q2', question: 'Any blockers?' },
                { id: 'q3', question: 'Anything else?' },
            ];
            const answers = new Map([
                ['q1', { selected: ['Phase 1', 'Phase 2'], customText: 'DNS verified' }],
                ['q2', { selected: [], customText: 'Waiting on 2FA code' }],
            ]);

            const formatted = formatAskUserResult({
                title: 'IT Takeover Check-in',
                questions,
                answers,
            });
            assert(formatted.includes('[User answered "IT Takeover Check-in"]'), 'header present');
            assert(
                formatted.includes('Answer: Phase 1, Phase 2 — Note: DNS verified'),
                'selected + custom combined',
            );
            assert(formatted.includes('Answer: Waiting on 2FA code'), 'custom only');
            assert(formatted.includes('Answer: (no answer provided)'), 'blank handled');

            const summary = buildAskUserSummary({
                title: 'IT Takeover Check-in',
                questions,
                answers,
            });
            assertEqual(summary.skipped, false, 'not skipped');
            assertEqual(summary.pairs.length, 3, '3 summary pairs');
            assertEqual(
                summary.pairs[0].answer,
                'Phase 1, Phase 2 — Note: DNS verified',
                'summary pair answer',
            );

            const skippedText = formatAskUserResult({ questions, skipped: true });
            assert(skippedText.includes('User skipped'), 'skip message');
            const skippedSummary = buildAskUserSummary({
                title: 'Check-in',
                questions,
                skipped: true,
            });
            assertEqual(skippedSummary.skipped, true, 'summary skipped');
            assertEqual(skippedSummary.pairs.length, 0, 'skipped has empty pairs');
        },
    ],

    // ── buildInteractiveSystemInstruction ──────────────────────────────────

    [
        'buildInteractiveSystemInstruction: matches Auto, Guided+tools, Guided-no-tools, and Off',
        () => {
            const auto = buildInteractiveSystemInstruction({
                guided: false,
                canCallAskUser: true,
            });
            assert(auto.includes(ASK_USER_TOOL_NAME), 'Auto mentions ask_user');

            const guidedTools = buildInteractiveSystemInstruction({
                guided: true,
                canCallAskUser: true,
            });
            assert(guidedTools.includes('Guided Walkthrough Mode'), 'Guided header');
            assert(guidedTools.includes(ASK_USER_TOOL_NAME), 'Guided+tools mentions ask_user');
            assert(guidedTools.includes('ONE concrete step at a time'), 'one step at a time');

            const guidedNoTools = buildInteractiveSystemInstruction({
                guided: true,
                canCallAskUser: false,
            });
            assert(guidedNoTools.includes('Guided Walkthrough Mode'), 'Guided fallback header');
            assert(!guidedNoTools.includes(ASK_USER_TOOL_NAME), 'no-tools omits ask_user');

            const off = buildInteractiveSystemInstruction({
                guided: false,
                canCallAskUser: false,
            });
            assertEqual(off, '', 'Off returns empty instruction');
            assertEqual(ASK_USER_TOOL_COMMAND, '/guide', 'command constant');
        },
    ],
];

await runTests(tests);
