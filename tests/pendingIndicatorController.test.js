// pendingIndicatorController.test.js — Tests for the warm-up row state machine.
//
// The controller owns the "never flash, never cover an answer, never look
// frozen" rules for the indicator shown between sending a prompt and the first
// streamed token.  Timers and actors are injected, so the whole lifecycle is
// driven synchronously here.
import {
    PENDING_INDICATOR_ELAPSED_AFTER_MS,
    PENDING_INDICATOR_GRACE_MS,
    PENDING_INDICATOR_TICK_MS,
    PendingIndicatorController,
} from '../src/ui/pendingIndicatorController.js';
import { assert, assertEqual, runTests } from './testUtils.js';

function makeContainer() {
    return {
        childCount: 0,
        children: [],
        get_n_children() {
            return this.childCount;
        },
        add_child(actor) {
            this.children.push(actor);
            actor.mounted = true;
            this.childCount += 1;
        },
    };
}

function makeIndicator(text) {
    return {
        text,
        actor: { mounted: false },
        started: false,
        destroyed: false,
        start() {
            this.started = true;
        },
        isDestroyed() {
            return this.destroyed;
        },
        setText(value) {
            this.text = value;
        },
        destroy() {
            this.destroyed = true;
            this.actor = null;
        },
    };
}

function makeEnv(overrides = {}) {
    const timers = new Map();
    let nextId = 1;

    const env = {
        scheduled: [],
        removed: [],
        created: [],
        scrolls: 0,
        logs: [],
        chatCurrent: true,
        disposed: false,
        canRecover: true,
        container: makeContainer(),
        ...overrides,
    };

    env.pendingTimers = () => timers.size;
    env.fireTimers = () => {
        for (const [id, entry] of [...timers]) {
            timers.delete(id);
            entry.callback();
        }
    };
    // Advance the visible row's one-second ticker by `count` ticks.
    env.advance = (count = 1) => {
        for (let i = 0; i < count; i++) {
            env.fireTimers();
        }
    };

    env.host = {
        getContainer: () => env.container,
        isChatCurrent: () => env.chatCurrent,
        isDisposed: () => env.disposed,
        createIndicator: (text) => {
            const indicator = makeIndicator(text);
            env.created.push(indicator);
            return indicator;
        },
        canRecover: () => env.canRecover,
        scrollToBottom: () => {
            env.scrolls += 1;
        },
        log: (message) => env.logs.push(message),
    };

    env.controller = new PendingIndicatorController(env.host, {
        timeoutAdd: (ms, callback) => {
            const id = nextId++;
            timers.set(id, { ms, callback });
            env.scheduled.push({ id, ms });
            return id;
        },
        timeoutRemove: (id) => {
            timers.delete(id);
            env.removed.push(id);
        },
    });

    return env;
}

const tests = [
    [
        'default grace period is a short 300 ms',
        () => {
            assertEqual(PENDING_INDICATOR_GRACE_MS, 300, 'grace');
            const env = makeEnv();
            env.controller.arm('Preparing context…');
            assertEqual(env.scheduled.length, 1, 'one timer');
            assertEqual(env.scheduled[0].ms, 300, 'grace applied');
        },
    ],

    [
        'nothing is shown during the grace period, then the row appears',
        () => {
            const env = makeEnv();
            env.controller.arm('Preparing context…');
            assertEqual(env.created.length, 0, 'no indicator before grace');
            assert(env.controller.hasArmed(), 'armed while timer pending');

            env.fireTimers();
            assertEqual(env.created.length, 1, 'indicator created after grace');
            const indicator = env.created[0];
            assertEqual(indicator.text, 'Preparing context…', 'phase text');
            assert(indicator.started, 'animation started');
            assert(indicator.actor.mounted, 'mounted into the bubble');
            assertEqual(env.container.childCount, 1, 'one child');
            assertEqual(env.scrolls, 1, 'scrolled to the row');
            assert(env.controller.hasArmed(), 'armed while visible');
        },
    ],

    [
        'fast reply: dismissing before the grace period never flashes a row',
        () => {
            const env = makeEnv();
            env.controller.arm('Thinking…');
            env.controller.dismiss();

            assertEqual(env.removed.length, 1, 'grace timer cancelled');
            assertEqual(env.pendingTimers(), 0, 'no timer left');
            env.fireTimers();
            assertEqual(env.created.length, 0, 'no indicator ever created');
            assert(!env.controller.hasArmed(), 'not armed');
        },
    ],

    [
        'phase updates keep one timer and never restart the grace period',
        () => {
            const env = makeEnv();
            env.controller.arm('Preparing context…');
            env.controller.setText('Searching your knowledge base…');
            env.controller.arm('Searching your knowledge base…');
            assertEqual(env.scheduled.length, 1, 'single grace timer');

            env.fireTimers();
            assertEqual(
                env.created[0].text,
                'Searching your knowledge base…',
                'latest phase shown',
            );

            env.controller.setText('Thinking…');
            assertEqual(env.created[0].text, 'Thinking…', 'live phase update');
            assertEqual(
                env.scheduled.filter((entry) => entry.ms === PENDING_INDICATOR_GRACE_MS).length,
                1,
                'grace period never restarted',
            );
        },
    ],

    [
        'content that wins the race is never covered by a late row',
        () => {
            const env = makeEnv();
            env.controller.arm('Thinking…');
            env.container.childCount = 1; // answer/status rendered first

            env.fireTimers();
            assertEqual(env.created.length, 0, 'no loader over content');
            assert(!env.controller.hasArmed(), 'dropped');

            env.controller.arm('Thinking…'); // further arming stays ignored
            assertEqual(env.scheduled.length, 1, 'no new timer');
        },
    ],

    [
        'stale chat UI: the grace callback does nothing',
        () => {
            const env = makeEnv();
            env.controller.arm('Thinking…');
            env.chatCurrent = false;
            env.fireTimers();
            assertEqual(env.created.length, 0, 'no row for an old chat');
        },
    ],

    [
        'disposed bubble: arming is a no-op',
        () => {
            const env = makeEnv();
            env.disposed = true;
            env.controller.arm('Thinking…');
            assertEqual(env.scheduled.length, 0, 'no timer');
            assert(!env.controller.hasArmed(), 'not armed');
        },
    ],

    [
        'status render then model wait: one recovery keeps the row animating',
        () => {
            const env = makeEnv();
            env.controller.arm('Preparing context…');
            env.controller.dismiss(); // status line rendered
            assert(!env.controller.hasArmed(), 'dismissed by status');

            env.container.childCount = 1; // the status line stays visible
            assert(env.controller.recover('Thinking…'), 'recovered');
            assert(env.controller.hasArmed(), 'armed again');

            env.fireTimers();
            assertEqual(env.created.length, 1, 'row shown under the status');
            assertEqual(env.created[0].text, 'Thinking…', 'model wait text');
            assertEqual(env.container.childCount, 2, 'appended to the status');
        },
    ],

    [
        'recovery happens at most once per response',
        () => {
            const env = makeEnv();
            env.controller.arm('Preparing context…');
            env.controller.dismiss();
            assert(env.controller.recover('Thinking…'), 'first recovery');
            env.controller.dismiss(); // first streamed token / tool call
            assert(!env.controller.recover('Thinking…'), 'no second recovery');
            assert(!env.controller.hasArmed(), 'stays dismissed');
        },
    ],

    [
        'recovery is refused once the answer has started',
        () => {
            const env = makeEnv();
            env.controller.arm('Preparing context…');
            env.controller.dismiss();
            env.canRecover = false;
            assert(!env.controller.recover('Thinking…'), 'refused');
            assertEqual(env.scheduled.length, 1, 'nothing re-armed');
        },
    ],

    [
        'an externally destroyed row stops the elapsed ticker',
        () => {
            const env = makeEnv();
            env.controller.arm('Thinking…');
            env.fireTimers();
            const indicator = env.created[0];
            assertEqual(env.pendingTimers(), 1, 'ticker running');

            indicator.destroyed = true; // content render replaced the row
            env.advance(1);

            assertEqual(env.pendingTimers(), 0, 'ticker stopped');
            assert(!env.controller.hasArmed(), 'treated as dismissed');
        },
    ],

    [
        'a contentBox rebuild that removed the actor counts as dismissed',
        () => {
            const env = makeEnv();
            env.controller.arm('Thinking…');
            env.fireTimers();
            assert(env.controller.hasArmed(), 'visible');

            env.created[0].actor = null; // external destroy_all_children()
            assert(!env.controller.hasArmed(), 'detected removal');
            env.canRecover = false; // the rebuild was the answer itself
            assert(!env.controller.recover('Thinking…'), 'no recovery after content');
        },
    ],

    [
        'dismiss destroys a visible row and is idempotent',
        () => {
            const env = makeEnv();
            env.controller.arm('Thinking…');
            env.fireTimers();
            const indicator = env.created[0];

            env.controller.dismiss();
            env.controller.dismiss();
            assert(indicator.destroyed, 'row destroyed once');
            assert(!env.controller.hasArmed(), 'not armed');
            assertEqual(env.removed.length, 1, 'elapsed ticker cancelled');
            assertEqual(env.pendingTimers(), 0, 'nothing left ticking');
        },
    ],

    [
        'elapsed seconds appear once the wait stops feeling instant',
        () => {
            const env = makeEnv();
            env.controller.arm('Thinking…');
            env.fireTimers();
            const indicator = env.created[0];
            assertEqual(indicator.text, 'Thinking…', 'quiet at first');

            const ticks = Math.ceil(PENDING_INDICATOR_ELAPSED_AFTER_MS / PENDING_INDICATOR_TICK_MS);
            env.advance(ticks - 1);
            assertEqual(indicator.text, 'Thinking…', 'still quiet just before the threshold');

            env.advance(1);
            assertEqual(indicator.text, `Thinking… · ${ticks}s`, 'elapsed counter shown');

            env.advance(1);
            assertEqual(indicator.text, `Thinking… · ${ticks + 1}s`, 'counter advances');
        },
    ],

    [
        'slow hint replaces the phase for a long cold-model wait',
        () => {
            const env = makeEnv();
            env.controller.arm('Thinking…', {
                slowHint: 'Loading the model into memory…',
                slowHintAfterMs: 2000,
            });
            env.fireTimers();
            const indicator = env.created[0];
            assertEqual(indicator.text, 'Thinking…', 'phase first');

            env.advance(2);
            assertEqual(indicator.text, 'Loading the model into memory…', 'slow hint takes over');

            env.advance(2);
            assertEqual(
                indicator.text,
                'Loading the model into memory… · 4s',
                'elapsed time still counts during the slow hint',
            );
        },
    ],

    [
        'a new phase restarts the elapsed counter',
        () => {
            const env = makeEnv();
            env.controller.arm('Preparing context…');
            env.fireTimers();
            const indicator = env.created[0];

            env.advance(6);
            assert(indicator.text.includes('6s'), 'counter running');

            env.controller.setText('Thinking…');
            assertEqual(indicator.text, 'Thinking…', 'counter cleared for the new phase');
            assertEqual(env.pendingTimers(), 1, 'ticker keeps running');
        },
    ],

    [
        'a phase set before the row appears is used without a loader flash',
        () => {
            const env = makeEnv();
            env.controller.arm('Preparing context…');
            env.controller.setText('Searching your knowledge base…', {
                slowHint: 'Still searching…',
                slowHintAfterMs: 3000,
            });
            assertEqual(env.created.length, 0, 'grace period still pending');

            env.fireTimers();
            assertEqual(env.created[0].text, 'Searching your knowledge base…', 'latest phase');
        },
    ],

    [
        'indicator failures are logged and never throw',
        () => {
            const env = makeEnv();
            env.host.createIndicator = () => {
                throw new Error('boom');
            };
            env.controller.arm('Thinking…');
            env.fireTimers();
            assertEqual(env.logs.length, 1, 'logged');
            assert(env.logs[0].includes('boom'), 'error message kept');
            assert(!env.controller.hasArmed(), 'not armed');
        },
    ],
];

runTests(tests);
