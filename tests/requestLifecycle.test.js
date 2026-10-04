// requestLifecycle.test.js — Tests for the request lifecycle state machine.
import {
    REQUEST_STATES,
    createRequestLifecycle,
} from '../src/core/requestLifecycle.js';
import { assert, assertEqual, runTests } from './testUtils.js';

const S = REQUEST_STATES;

function fresh() {
    return createRequestLifecycle();
}

const tests = [
    ['fresh instance is idle and settled', () => {
        const lc = fresh();
        assertEqual(lc.state, S.IDLE, 'idle');
        assertEqual(lc.generation, 0, 'generation 0');
        assertEqual(lc.responseKey, null, 'no key');
        assert(lc.canSend(), 'can send');
        assert(!lc.canStop(), 'cannot stop');
        assert(!lc.isActive(), 'not active');
        assert(!lc.isResponding(), 'not responding');
    }],

    ['isResponding: false during enrichment, true from awaiting-model onward', () => {
        const lc = fresh();
        lc.begin(S.ENRICHING, 'k1');
        assert(lc.isActive(), 'enriching is active');
        assert(!lc.isResponding(), 'enriching is not responding');
        assert(!lc.canSend(), 'cannot send during enrichment');

        lc.begin(S.AWAITING_MODEL, 'k1');
        assert(lc.isResponding(), 'awaiting-model responds');
        lc.markPhase(S.TOOL_LOOP);
        assert(lc.isResponding(), 'tool-loop responds');
        lc.markPhase(S.SYNTHESIS);
        assert(lc.isResponding(), 'synthesis responds');
        lc.stop();
        assert(lc.isResponding(), 'stopping still responds');
        lc.finish();
        assert(!lc.isResponding(), 'done does not respond');
        assert(lc.canSend(), 'can send after done');
    }],

    ['begin from idle starts a new request (generation bump)', () => {
        const lc = fresh();
        const res = lc.begin(S.AWAITING_MODEL, 'k1');
        assert(res.ok && res.previous === S.IDLE, 'ok from idle');
        assertEqual(lc.state, S.AWAITING_MODEL, 'state applied');
        assertEqual(lc.generation, 1, 'generation 1');
        assertEqual(lc.responseKey, 'k1', 'key stored');
        assert(lc.isActive(), 'active');
        assert(!lc.canSend(), 'cannot send while active');
        assert(lc.canStop(), 'can stop');
    }],

    ['same-key re-arm (tool iterations) does not bump generation', () => {
        const lc = fresh();
        lc.begin(S.AWAITING_MODEL, 'k1');
        const again = lc.begin(S.TOOL_LOOP, 'k1');
        assert(again.ok, 're-arm ok');
        assertEqual(lc.state, S.TOOL_LOOP, 'phase moved');
        assertEqual(lc.generation, 1, 'generation unchanged');
    }],

    ['different key while active is a flagged response-overlap (reality still recorded)', () => {
        const lc = fresh();
        lc.begin(S.AWAITING_MODEL, 'k1');
        const overlap = lc.begin(S.AWAITING_MODEL, 'k2');
        assert(!overlap.ok, 'flagged');
        assertEqual(overlap.reason, 'response-overlap', 'reason');
        assertEqual(lc.responseKey, 'k2', 'new identity recorded');
        assertEqual(lc.generation, 2, 'generation bumped for the new response');
        assertEqual(lc.state, S.AWAITING_MODEL, 'state applied');
    }],

    ['anonymous begin (research run) can be named later without a generation bump', () => {
        const lc = fresh();
        const anon = lc.begin(S.TOOL_LOOP);
        assert(anon.ok, 'anonymous ok');
        assertEqual(lc.responseKey, null, 'no key yet');
        assertEqual(lc.generation, 1, 'generation 1');

        const named = lc.begin(S.AWAITING_MODEL, 'synth-1');
        assert(named.ok, 'naming ok');
        assertEqual(lc.responseKey, 'synth-1', 'key set');
        assertEqual(lc.generation, 1, 'same request — no generation bump');
        assertEqual(lc.state, S.AWAITING_MODEL, 'state moved');
    }],

    ['invalid phase is rejected without state change', () => {
        const lc = fresh();
        const res = lc.begin('bogus');
        assert(!res.ok, 'rejected');
        assertEqual(res.reason, 'invalid-phase', 'reason');
        assertEqual(lc.state, S.IDLE, 'state unchanged');
        assertEqual(lc.generation, 0, 'generation unchanged');
    }],

    ['begin while stopping is flagged illegal-transition', () => {
        const lc = fresh();
        lc.begin(S.AWAITING_MODEL, 'k1');
        lc.stop();
        const res = lc.begin(S.AWAITING_MODEL, 'k2');
        assert(!res.ok, 'flagged');
        assertEqual(res.reason, 'illegal-transition', 'reason');
        assertEqual(res.previous, S.STOPPING, 'previous stopping');
        assertEqual(lc.state, S.AWAITING_MODEL, 'reality recorded');
    }],

    ['markPhase moves between active phases only', () => {
        const lc = fresh();
        assert(!lc.markPhase(S.TOOL_LOOP).ok, 'rejected from idle');

        lc.begin(S.ENRICHING, 'k1');
        assert(lc.markPhase(S.AWAITING_MODEL).ok, 'enriching → awaiting');
        assert(lc.markPhase(S.TOOL_LOOP).ok, 'awaiting → tool-loop');
        assert(lc.markPhase(S.SYNTHESIS).ok, 'tool-loop → synthesis');
        assertEqual(lc.state, S.SYNTHESIS, 'final phase');

        lc.stop();
        assert(!lc.markPhase(S.TOOL_LOOP).ok, 'rejected while stopping');
        assertEqual(lc.state, S.STOPPING, 'state unchanged');
    }],

    ['stop is legal from every working state, flagged elsewhere', () => {
        for (const phase of [S.ENRICHING, S.AWAITING_MODEL, S.TOOL_LOOP, S.SYNTHESIS]) {
            const lc = fresh();
            lc.begin(phase, 'k1');
            const res = lc.stop();
            assert(res.ok, `stop ok from ${phase}`);
            assertEqual(lc.state, S.STOPPING, `stopping from ${phase}`);
            assert(lc.isActive(), 'stopping still active');
            assert(!lc.canSend(), 'cannot send while stopping');
            assert(!lc.canStop(), 'cannot stop again');
            assert(!lc.stop().ok, 'second stop flagged');
            assertEqual(lc.stop().reason, 'already-stopping', 'reason');
        }
        for (const setup of [() => fresh(), (lc) => lc.finish(), (lc) => lc.finish(S.ERROR)]) {
            const lc = fresh();
            setup(lc);
            const res = lc.stop();
            assert(!res.ok, 'not stoppable from settled');
            assertEqual(res.reason, 'not-stoppable', 'reason');
        }
    }],

    ['finish settles from active/stopping; idempotent from settled', () => {
        const lc = fresh();
        lc.begin(S.AWAITING_MODEL, 'k1');
        const done = lc.finish();
        assert(done.ok && done.previous === S.AWAITING_MODEL, 'finish ok');
        assertEqual(lc.state, S.DONE, 'done');
        assert(lc.canSend(), 'can send after done');
        assert(!lc.isActive(), 'not active after done');

        const idem = lc.finish();
        assert(!idem.ok, 'second finish flagged');
        assertEqual(idem.reason, 'not-active', 'reason');
        assertEqual(lc.state, S.DONE, 'state unchanged');

        const lc2 = fresh();
        lc2.begin(S.TOOL_LOOP, 'k1');
        lc2.finish(S.ERROR);
        assertEqual(lc2.state, S.ERROR, 'error outcome');

        const lc3 = fresh();
        lc3.begin(S.SYNTHESIS, 'k1');
        lc3.stop();
        assert(lc3.finish().ok, 'finish from stopping');
        assertEqual(lc3.state, S.DONE, 'stopped request settles as done');
    }],

    ['full request sequence: enrichment → model → tools → synthesis → done', () => {
        const lc = fresh();
        assert(lc.begin(S.ENRICHING, 'r1').ok, 'begin');
        assert(lc.markPhase(S.AWAITING_MODEL).ok, 'awaiting');
        assert(lc.markPhase(S.TOOL_LOOP).ok, 'tools');
        assert(lc.begin(S.AWAITING_MODEL, 'r1').ok, 're-arm after tools');
        assert(lc.markPhase(S.SYNTHESIS).ok, 'synthesis');
        assert(lc.finish().ok, 'finish');
        assertEqual(lc.state, S.DONE, 'done');

        assert(lc.begin(S.ENRICHING, 'r2').ok, 'next request ok');
        assertEqual(lc.generation, 2, 'second generation');
        assertEqual(lc.responseKey, 'r2', 'new key');
    }],
];

await runTests(tests);
