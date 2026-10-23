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
//
// All timers and actors are injected so the rules are unit-testable outside
// GNOME Shell.

export const PENDING_INDICATOR_GRACE_MS = 300;

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
     */
    constructor(host, options = {}) {
        this._host = host;
        this._timeoutAdd = options.timeoutAdd;
        this._timeoutRemove = options.timeoutRemove;
        this._graceMs = options.graceMs ?? PENDING_INDICATOR_GRACE_MS;

        this._text = '';
        this._timerId = 0;
        this._indicator = null;
        this._dismissed = false;
        this._recovered = false;
        this._allowExistingChildren = false;
    }

    /** Arm the grace timer once and remember the phase text. */
    arm(text, { allowExistingChildren = false } = {}) {
        const container = this._host.getContainer();
        if (!container || this._host.isDisposed(container)) return;
        if (this._dismissed) return;

        this._text = String(text ?? '');
        this._allowExistingChildren = allowExistingChildren;
        if (this._indicator) {
            this._applyText();
            return;
        }
        if (this._timerId) return;
        this._timerId = this._timeoutAdd(this._graceMs, () => this._onGraceElapsed());
    }

    /** Update the phase label without restarting the grace period. */
    setText(text) {
        this._text = String(text ?? '');
        if (this._dismissed || !this._indicator) return;
        this._applyText();
    }

    /** True while the wait is covered (timer pending or row visible). */
    hasArmed() {
        if (this._dismissed) return false;
        if (this._indicator) {
            if (!this._indicator.actor) {
                this._indicator = null;
                this._dismissed = true;
                return false;
            }
            return true;
        }
        return Boolean(this._timerId);
    }

    /**
     * Re-arm the row once, for the first model wait after a status render.
     * @returns {boolean} true when the row is armed again
     */
    recover(text) {
        if (!this._dismissed || this._recovered) return false;
        if (this._host.canRecover && !this._host.canRecover()) return false;
        this._recovered = true;
        this._dismissed = false;
        this.arm(text, { allowExistingChildren: true });
        return this.hasArmed();
    }

    /** Cancel the timer and destroy the row. */
    dismiss() {
        if (this._dismissed) return;
        this._dismissed = true;
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

    _applyText() {
        try {
            this._indicator.setText(this._text);
        } catch (_e) {
            /* bubble already disposed */
        }
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
            const indicator = this._host.createIndicator(this._text);
            if (!indicator) return;
            this._indicator = indicator;
            container.add_child(indicator.actor);
            indicator.start();
            this._host.scrollToBottom?.();
        } catch (e) {
            this._host.log?.(
                `[Katab:title] Failed to show the warm-up indicator: ${e.message || e}`,
            );
        }
    }
}
