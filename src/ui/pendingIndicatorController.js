// pendingIndicatorController.js — warm-up row state machine (no UI imports).
//
// The send path never shows a spinner immediately: it *arms* a short grace
// timer so a fast reply renders straight into the bubble with no loader
// flash.  Once the grace period elapses the animated row appears, and it stays
// up through enrichment, title generation, and the first model wait.
//
// Rules:
//   • arm() is idempotent — phase text updates never restart the grace timer.
//   • If real content already exists when the timer fires, the row is dropped
//     (content always wins; it is never drawn over an answer).
//   • dismiss() cancels the timer and destroys the row.  It may be followed by
//     exactly one recover(), which is how the first model wait after a status
//     line (search started, retrying, …) keeps showing activity instead of a
//     frozen label.
//   • A row whose actor was removed by an external contentBox rebuild is
//     treated as dismissed.
//   • Once visible, the row ticks every second.  After a few seconds the phase
//     label gains an elapsed counter, and a caller-supplied slow hint replaces
//     it when the wait is long (cold model load, slow KB service) — the
//     message never looks frozen just because no tokens are arriving.
//
// All timers and actors are injected so the rules are unit-testable outside
// GNOME Shell.

import { gettext as _, format } from '../shared/i18n.js';

export const PENDING_INDICATOR_GRACE_MS = 300;
// Waits beyond this show elapsed seconds next to the phase ("Thinking… · 12s").
// Shorter waits stay quiet so a normal reply never flashes a counter.
export const PENDING_INDICATOR_ELAPSED_AFTER_MS = 4000;
export const PENDING_INDICATOR_TICK_MS = 1000;

export class PendingIndicatorController {
    /**
     * @param {object} host
     * @param {() => object|null} host.getContainer bubble contentBox actor
     * @param {() => boolean} host.isChatCurrent false when the chat UI was replaced
     * @param {(actor: object) => boolean} host.isDisposed
     * @param {(text: string) => object} host.createIndicator {actor,start,setText,destroy}
     * @param {() => boolean} [host.canRecover]
     * @param {() => void} [host.scrollToBottom]
     * @param {(message: string) => void} [host.log]
     * @param {object} [options]
     * @param {(ms: number, cb: () => void) => number} options.timeoutAdd
     * @param {(id: number) => void} options.timeoutRemove
     * @param {number} [options.graceMs]
     * @param {number} [options.tickMs]
     * @param {number} [options.elapsedAfterMs]
     */
    constructor(host, options = {}) {
        this._host = host;
        this._timeoutAdd = options.timeoutAdd;
        this._timeoutRemove = options.timeoutRemove;
        this._graceMs = options.graceMs ?? PENDING_INDICATOR_GRACE_MS;
        this._tickMs = options.tickMs ?? PENDING_INDICATOR_TICK_MS;
        this._elapsedAfterMs = options.elapsedAfterMs ?? PENDING_INDICATOR_ELAPSED_AFTER_MS;

        this._phaseText = '';
        this._slowHint = '';
        this._slowHintAfterMs = 0;
        this._elapsedMs = 0;
        this._tickerId = 0;
        this._timerId = 0;
        this._indicator = null;
        this._dismissed = false;
        this._recovered = false;
        this._allowExistingChildren = false;
    }

    /**
     * Arm the grace timer once and remember the phase text.
     *
     * @param {string} text phase label
     * @param {object} [options]
     * @param {boolean} [options.allowExistingChildren] draw below existing content
     * @param {string} [options.slowHint] label used once slowHintAfterMs elapses
     * @param {number} [options.slowHintAfterMs]
     */
    arm(text, { allowExistingChildren = false, slowHint = '', slowHintAfterMs = 0 } = {}) {
        const container = this._host.getContainer();
        if (!container || this._host.isDisposed(container)) return;
        if (this._dismissed) return;

        this._setPhase(text, slowHint, slowHintAfterMs);
        this._allowExistingChildren = allowExistingChildren;
        if (this._indicator) {
            this._applyText();
            this._ensureTicker();
            return;
        }
        if (this._timerId) return;
        this._timerId = this._timeoutAdd(this._graceMs, () => this._onGraceElapsed());
    }

    /**
     * Update the phase label without restarting the grace period.  A new phase
     * restarts the elapsed counter so descriptions stay truthful.
     */
    setText(text, { slowHint = '', slowHintAfterMs = 0 } = {}) {
        if (this._dismissed) return;
        this._setPhase(text, slowHint, slowHintAfterMs);
        if (!this._indicator) return;
        this._applyText();
        this._ensureTicker();
    }

    /** True while the wait is covered (timer pending or row visible). */
    hasArmed() {
        if (this._dismissed) return false;
        if (this._indicator) {
            if (this._rowGone()) {
                this._forgetRow();
                return false;
            }
            return true;
        }
        return Boolean(this._timerId);
    }

    /** The row actor was removed or destroyed by an external content rebuild. */
    _rowGone() {
        return (
            !this._indicator ||
            !this._indicator.actor ||
            (typeof this._indicator.isDestroyed === 'function' && this._indicator.isDestroyed())
        );
    }

    /** Treat an externally removed row exactly like a dismissal. */
    _forgetRow() {
        this._indicator = null;
        this._dismissed = true;
        this._stopTicker();
    }

    /**
     * Re-arm the row once, for the first model wait after a status render.
     * @param {string} text phase label
     * @param {object} [options] same slow-hint options as arm()
     * @returns {boolean} true when the row is armed again
     */
    recover(text, options = {}) {
        if (!this._dismissed || this._recovered) return false;
        if (this._host.canRecover && !this._host.canRecover()) return false;
        this._recovered = true;
        this._dismissed = false;
        this.arm(text, { allowExistingChildren: true, ...options });
        return this.hasArmed();
    }

    /** Cancel the timer and destroy the row. */
    dismiss() {
        if (this._dismissed) return;
        this._dismissed = true;
        this._stopTicker();
        if (this._timerId) {
            this._timeoutRemove(this._timerId);
            this._timerId = 0;
        }
        const indicator = this._indicator;
        this._indicator = null;
        if (!indicator) return;
        try {
            indicator.destroy();
        } catch (_e) {
            /* bubble already disposed */
        }
    }

    _setPhase(text, slowHint = '', slowHintAfterMs = 0) {
        this._phaseText = String(text ?? '');
        this._slowHint = String(slowHint ?? '');
        this._slowHintAfterMs =
            Number.isFinite(slowHintAfterMs) && slowHintAfterMs > 0
                ? Math.floor(slowHintAfterMs)
                : 0;
        this._elapsedMs = 0;
    }

    /** The phase text plus elapsed/slow-wait hints, ready for the label. */
    _labelText() {
        let text = this._phaseText;
        if (this._slowHint && this._slowHintAfterMs && this._elapsedMs >= this._slowHintAfterMs) {
            text = this._slowHint;
        }
        if (this._elapsedMs >= this._elapsedAfterMs) {
            const seconds = Math.max(1, Math.floor(this._elapsedMs / 1000));
            text = format(_('{phase} · {seconds}s'), { phase: text, seconds });
        }
        return text;
    }

    _applyText() {
        if (!this._indicator) return;
        if (this._rowGone()) {
            this._forgetRow();
            return;
        }
        try {
            this._indicator.setText(this._labelText());
        } catch (_e) {
            /* bubble already disposed */
        }
    }

    // Ticks once a second while the row is visible so the label can show
    // elapsed time and escalate to the caller's slow-wait hint.  Re-arms
    // itself; stops on dismiss and never runs before the row exists.
    _ensureTicker() {
        if (this._tickerId || this._dismissed || !this._indicator) return;
        this._tickerId = this._timeoutAdd(this._tickMs, () => {
            this._tickerId = 0;
            if (this._dismissed) return;
            if (this._rowGone()) {
                this._forgetRow();
                return;
            }
            this._elapsedMs += this._tickMs;
            this._applyText();
            this._ensureTicker();
        });
    }

    _stopTicker() {
        if (!this._tickerId) return;
        this._timeoutRemove(this._tickerId);
        this._tickerId = 0;
    }

    _onGraceElapsed() {
        this._timerId = 0;
        if (this._dismissed) return;
        if (!this._host.isChatCurrent()) return;

        const container = this._host.getContainer();
        if (!container || this._host.isDisposed(container)) return;

        if (!this._allowExistingChildren) {
            let childCount = 0;
            try {
                childCount = container.get_n_children();
            } catch (_e) {
                return;
            }
            if (childCount > 0) {
                this._dismissed = true;
                return;
            }
        }

        try {
            const indicator = this._host.createIndicator(this._labelText());
            if (!indicator) return;
            this._indicator = indicator;
            container.add_child(indicator.actor);
            indicator.start();
            this._host.scrollToBottom?.();
            this._elapsedMs = 0;
            this._ensureTicker();
        } catch (e) {
            this._host.log?.(`[Katab:ui] Failed to show the warm-up indicator: ${e.message || e}`);
        }
    }
}
