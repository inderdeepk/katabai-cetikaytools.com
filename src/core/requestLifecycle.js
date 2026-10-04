// requestLifecycle.js — Request lifecycle state machine (bookkeeping only).
//
// Phase 6 of the hardening program. The module owns STATE BOOKKEEPING ONLY —
// Gio.Cancellable creation/cancellation, HTTP, and UI stay in KatabDialog;
// the stop flow is: lifecycle.stop() then cancel the cancellable.
//
// States: idle → enriching → awaiting-model ⇄ tool-loop → synthesis →
// stopping → done/error → idle.
//
// The module runs in DUAL-RUN mode during the migration: KatabDialog records
// every transition here while the legacy booleans (_isStreaming /
// _activeResponseState) remain authoritative. `begin()` / `stop()` /
// `finish()` return { ok, previous, reason } so callers can log
// `[Katab:lifecycle] state mismatch …` when the recorded reality diverges —
// the observable window before reads are flipped over in a later phase.

export const REQUEST_STATES = Object.freeze({
    IDLE: 'idle',
    ENRICHING: 'enriching',           // KB/RAG enrichment + pre-send work
    AWAITING_MODEL: 'awaiting-model', // request sent, awaiting stream chunks
    TOOL_LOOP: 'tool-loop',           // executing local tools / research branches
    SYNTHESIS: 'synthesis',           // final answer synthesis after tools
    STOPPING: 'stopping',             // user pressed stop; finalisation in progress
    DONE: 'done',                     // completed (settled; next begin starts fresh)
    ERROR: 'error',                   // failed (settled)
});

const ACTIVE_STATES = new Set([
    REQUEST_STATES.ENRICHING,
    REQUEST_STATES.AWAITING_MODEL,
    REQUEST_STATES.TOOL_LOOP,
    REQUEST_STATES.SYNTHESIS,
    REQUEST_STATES.STOPPING,
]);

const PHASE_STATES = new Set([
    REQUEST_STATES.ENRICHING,
    REQUEST_STATES.AWAITING_MODEL,
    REQUEST_STATES.TOOL_LOOP,
    REQUEST_STATES.SYNTHESIS,
]);

const STOPPABLE_STATES = new Set([
    REQUEST_STATES.ENRICHING,
    REQUEST_STATES.AWAITING_MODEL,
    REQUEST_STATES.TOOL_LOOP,
    REQUEST_STATES.SYNTHESIS,
]);

const SETTLED_STATES = new Set([
    REQUEST_STATES.IDLE,
    REQUEST_STATES.DONE,
    REQUEST_STATES.ERROR,
]);

/**
 * Create a request lifecycle recorder.
 *
 * begin(phase, key):
 *   - phase ∈ {enriching, awaiting-model, tool-loop, synthesis}
 *   - key: stable per-RESPONSE identity (distinct from per-iteration ids).
 *     May be null for anonymous work (e.g. the research run, which is later
 *     named by its synthesis stream).
 *   - From a settled state → new request (generation++). From an active state
 *     with the same key → re-arm within the response (tool iterations) — no
 *     generation bump. With a different non-null key while active → flagged
 *     'response-overlap' (bookkeeping still follows reality). While stopping
 *     → flagged 'illegal-transition'.
 *
 * markPhase(phase): active → active phase move (awaiting-model ⇄ tool-loop →
 *   synthesis). Strict: only legal while active; never from settled/stopping.
 *
 * stop(): active (non-stopping) → stopping.
 *
 * finish(outcome='done'): active (incl. stopping) → done/error. Settled → ok
 *   false, no change (idempotent clear).
 *
 * Predicates: isActive() (includes stopping), canSend() (settled), canStop().
 */
export function createRequestLifecycle() {
    let state = REQUEST_STATES.IDLE;
    let responseKey = null;
    let generation = 0;

    const settle = (outcome) => {
        const previous = state;
        if (!ACTIVE_STATES.has(previous)) {
            return { ok: false, previous, reason: 'not-active' };
        }
        state = outcome;
        return { ok: true, previous, reason: null };
    };

    return {
        get state() {
            return state;
        },
        get responseKey() {
            return responseKey;
        },
        get generation() {
            return generation;
        },

        isActive() {
            return ACTIVE_STATES.has(state);
        },

        canSend() {
            return SETTLED_STATES.has(state);
        },

        canStop() {
            return STOPPABLE_STATES.has(state);
        },

        begin(phase, key = null) {
            const previous = state;
            if (!PHASE_STATES.has(phase)) {
                return { ok: false, previous, reason: 'invalid-phase' };
            }

            const settled = SETTLED_STATES.has(previous);
            const stopping = previous === REQUEST_STATES.STOPPING;
            const sameResponse = key !== null && responseKey !== null && key === responseKey;

            // Bookkeeping follows reality in all cases — the flags below only
            // describe whether the transition was expected.
            state = phase;
            let reason = null;
            if (stopping) {
                reason = 'illegal-transition';
            } else if (settled) {
                generation += 1;
                if (key !== null) responseKey = key;
            } else if (key !== null && !sameResponse) {
                // Active with a different response identity: overlapping request.
                if (responseKey === null) {
                    // First naming of an anonymous run (research → synthesis).
                    responseKey = key;
                } else {
                    reason = 'response-overlap';
                    responseKey = key;
                    generation += 1;
                }
            } else if (key !== null && sameResponse) {
                // Re-arm within the same response (tool iterations) — normal.
            }
            return { ok: reason === null, previous, reason };
        },

        markPhase(phase) {
            const previous = state;
            if (!PHASE_STATES.has(phase) || !ACTIVE_STATES.has(previous) || previous === REQUEST_STATES.STOPPING) {
                return { ok: false, previous, reason: 'illegal-transition' };
            }
            state = phase;
            return { ok: true, previous, reason: null };
        },

        stop() {
            const previous = state;
            if (previous === REQUEST_STATES.STOPPING) {
                return { ok: false, previous, reason: 'already-stopping' };
            }
            if (!STOPPABLE_STATES.has(previous)) {
                return { ok: false, previous, reason: 'not-stoppable' };
            }
            state = REQUEST_STATES.STOPPING;
            return { ok: true, previous, reason: null };
        },

        finish(outcome = REQUEST_STATES.DONE) {
            const target = outcome === REQUEST_STATES.ERROR ? REQUEST_STATES.ERROR : REQUEST_STATES.DONE;
            return settle(target);
        },
    };
}
