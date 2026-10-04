// researchPlanner.test.js — Tests for the research planner agent module.
import {
    PLANNER_MAX_ATTEMPTS,
    buildPlanSnapshot,
    runPlannerAgent,
    reviseResearchPlan,
} from '../src/research/planner.js';
import { assert, assertEqual, runTests } from './testUtils.js';

const VALID_PLAN = '[{"sub_task":"Background","search_query":"background keywords"}]';

function makeHost(responses) {
    const calls = [];
    const host = {
        requestCompletion: async (messages, opts) => {
            calls.push({ messages, opts });
            const next = responses.shift();
            if (next instanceof Error) throw next;
            return next;
        },
        modelOverride: 'model-x',
        getCancellable: () => 'cancellable-token',
        isCancelled: (e) => e && e.isCancel === true,
    };
    return { calls, host };
}

const tests = [
    [
        'PLANNER_MAX_ATTEMPTS is 2',
        () => {
            assertEqual(PLANNER_MAX_ATTEMPTS, 2, 'attempt budget');
        },
    ],

    [
        'buildPlanSnapshot: strips UI refs and keeps optional fields only when present',
        () => {
            const snapshot = buildPlanSnapshot([
                {
                    sub_task: 'A',
                    search_query: 'q a',
                    status: 'pending',
                    _progressRow: {},
                    _planTaskLabel: {},
                },
                {
                    sub_task: 'B',
                    search_query: 'q b',
                    hypothesis: 'h',
                    evidence_needed: 'e',
                    status: 'done',
                },
            ]);
            assertEqual(snapshot.length, 2, 'two entries');
            assertEqual(
                Object.keys(snapshot[0]).join(','),
                'sub_task,search_query',
                'UI refs stripped',
            );
            assertEqual(
                Object.keys(snapshot[1]).join(','),
                'sub_task,search_query,hypothesis,evidence_needed',
                'optional fields kept',
            );
            assertEqual(buildPlanSnapshot(null).length, 0, 'null → empty');
        },
    ],

    [
        'runPlannerAgent: first-attempt success',
        async () => {
            const { calls, host } = makeHost([VALID_PLAN]);
            const plan = await runPlannerAgent(host, 'how do widgets work');
            assertEqual(plan.length, 1, 'plan parsed');
            assertEqual(plan[0].search_query, 'background keywords', 'query');
            assertEqual(calls.length, 1, 'one call');
            assertEqual(calls[0].messages.length, 2, 'system + user only');
            assert(calls[0].messages[1].content.includes('how do widgets work'), 'query embedded');
            assertEqual(calls[0].opts.maxTokens, 1024, 'token budget');
            assertEqual(calls[0].opts.modelOverride, 'model-x', 'model override forwarded');
            assertEqual(calls[0].opts.cancellable, 'cancellable-token', 'cancellable from getter');
        },
    ],

    [
        'runPlannerAgent: unparseable response triggers a format-nudge retry',
        async () => {
            const { calls, host } = makeHost(['not a json plan', VALID_PLAN]);
            const plan = await runPlannerAgent(host, 'q');
            assertEqual(plan.length, 1, 'second attempt parsed');
            assertEqual(calls.length, 2, 'two attempts');
            assertEqual(calls[1].messages.length, 3, 'nudge appended on retry');
            assert(calls[1].messages[2].content.includes('not a valid JSON array'), 'nudge text');
        },
    ],

    [
        'runPlannerAgent: transient errors retry, exhaustion returns null',
        async () => {
            const { calls, host } = makeHost([new Error('boom'), new Error('boom again')]);
            const plan = await runPlannerAgent(host, 'q');
            assertEqual(plan, null, 'no plan after exhaustion');
            assertEqual(calls.length, PLANNER_MAX_ATTEMPTS, 'attempt budget used');
        },
    ],

    [
        'runPlannerAgent: cancellation rethrows immediately',
        async () => {
            const cancelErr = new Error('cancelled');
            cancelErr.isCancel = true;
            const { calls, host } = makeHost([cancelErr, VALID_PLAN]);
            let threw = false;
            try {
                await runPlannerAgent(host, 'q');
            } catch (e) {
                threw = true;
                assertEqual(e.message, 'cancelled', 'same error');
            }
            assert(threw, 'rethrown');
            assertEqual(calls.length, 1, 'no retry after cancel');
        },
    ],

    [
        'runPlannerAgent: getCancellable is read per attempt',
        async () => {
            let cancellableReads = 0;
            const { host } = makeHost(['bad', VALID_PLAN]);
            host.getCancellable = () => {
                cancellableReads++;
                return 'token';
            };
            await runPlannerAgent(host, 'q');
            assertEqual(cancellableReads, 2, 'fresh cancellable per attempt');
        },
    ],

    [
        'reviseResearchPlan: embeds the stripped snapshot and returns the revised plan',
        async () => {
            const revised = '[{"sub_task":"Topic v2","search_query":"topic 2026"}]';
            const { calls, host } = makeHost([revised]);
            const plan = await reviseResearchPlan(
                host,
                'original q',
                [
                    {
                        sub_task: 'Topic',
                        search_query: 'topic 2025',
                        status: 'pending',
                        _progressRow: {},
                    },
                ],
                'please use 2026',
            );
            assertEqual(plan[0].sub_task, 'Topic v2', 'plan returned');
            const userMsg = calls[0].messages[1].content;
            assert(userMsg.includes('original q'), 'original query embedded');
            assert(userMsg.includes('"sub_task": "Topic"'), 'snapshot content embedded');
            assert(userMsg.includes('please use 2026'), 'feedback embedded');
            assert(!userMsg.includes('_progressRow'), 'UI refs not serialized');
            assert(!userMsg.includes('"status"'), 'status not serialized');
        },
    ],

    [
        'reviseResearchPlan: retry nudge and cancellation',
        async () => {
            const { calls, host } = makeHost(['garbage', VALID_PLAN]);
            const plan = await reviseResearchPlan(host, 'q', [], 'feedback');
            assertEqual(plan.length, 1, 'retry parsed');
            assertEqual(calls.length, 2, 'two attempts');
            assert(calls[1].messages[2].content.includes('updated plan'), 'revision nudge text');

            const cancelErr = new Error('stop');
            cancelErr.isCancel = true;
            const { calls: cancelCalls, host: cancelHost } = makeHost([cancelErr, VALID_PLAN]);
            let threw = false;
            try {
                await reviseResearchPlan(cancelHost, 'q', [], 'feedback');
            } catch (_e) {
                threw = true;
            }
            assert(threw, 'cancel rethrown');
            assertEqual(cancelCalls.length, 1, 'no retry after cancel');
        },
    ],
];

await runTests(tests);
