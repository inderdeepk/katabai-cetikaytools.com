// pendingIndicator.js — the small "warm-up" row shown inside an assistant
// bubble from the moment a prompt is sent until the first real content is
// rendered (title generation → main request handoff).
//
// Three staggered dots pulse while a phase label explains what is happening
// ("Naming this chat…" → "Thinking…").  The row lives in the bubble's
// contentBox, so the first markdown render replaces (and destroys) it
// automatically; the destroy signal stops every timer.
//
// Shell-only module: imports gi://St + Clutter (excluded from the plain-gjs
// import smoke test, like src/ui/welcomePanel.js).
import GLib from 'gi://GLib';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';

const DOT_COUNT = 3;
const DOT_SIZE = 7;
const PULSE_INTERVAL_MS = 1100;
const DOT_UP_DURATION_MS = 340;
const DOT_DOWN_DELAY_MS = 380;
const DOT_STAGGER_MS = 100;
const DOT_DOWN_DURATION_MS = 360;
const DOT_IDLE_OPACITY = 80;
const DOT_IDLE_SCALE = 0.7;

export class PendingIndicator {
    /**
     * @param {Object} [options]
     * @param {string} [options.text] phase label shown next to the dots
     */
    constructor({ text = '' } = {}) {
        this._destroyed = false;
        this._loopId = 0;
        this._sourceIds = [];
        this._dots = [];

        this.actor = new St.BoxLayout({
            vertical: false,
            style_class: 'katab-pending-row',
            x_expand: true,
        });

        const dotsBox = new St.BoxLayout({
            vertical: false,
            style_class: 'katab-pending-dots',
            y_align: Clutter.ActorAlign.CENTER,
        });
        for (let index = 0; index < DOT_COUNT; index++) {
            const dot = new St.Widget({
                style_class: 'katab-pending-dot',
                y_align: Clutter.ActorAlign.CENTER,
            });
            dot.set_size(DOT_SIZE, DOT_SIZE);
            dot.set_pivot_point(0.5, 0.5);
            dot.opacity = 255;
            dotsBox.add_child(dot);
            this._dots.push(dot);
        }
        this.actor.add_child(dotsBox);

        this._label = new St.Label({
            text: String(text ?? ''),
            style_class: 'katab-pending-label',
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        this._label.clutter_text.line_wrap = true;
        this._label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        this._label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this._label.clutter_text.single_line_mode = false;
        this._label.clutter_text.can_focus = false;
        this.actor.add_child(this._label);

        this.actor.connect('destroy', () => {
            this._destroyed = true;
            this.stop();
            this.actor = null;
            this._label = null;
            this._dots = [];
        });
    }

    setText(text) {
        if (this._destroyed || !this._label) return;
        this._label.set_text(String(text ?? ''));
    }

    start() {
        if (this._destroyed || this._loopId) return;

        if (!animationsEnabled()) {
            this._setDotsIdle();
            return;
        }

        this._runPulse();
        this._loopId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PULSE_INTERVAL_MS, () => {
            this._runPulse();
            return GLib.SOURCE_CONTINUE;
        });
    }

    stop() {
        if (this._loopId) {
            GLib.source_remove(this._loopId);
            this._loopId = 0;
        }
        for (const sourceId of this._sourceIds) {
            GLib.source_remove(sourceId);
        }
        this._sourceIds = [];
        if (!this._destroyed) {
            this._setDotsIdle();
        }
    }

    destroy() {
        if (this._destroyed) return;
        this.stop();
        this._destroyed = true;
        const actor = this.actor;
        this.actor = null;
        this._label = null;
        this._dots = [];
        if (actor) {
            actor.destroy();
        }
    }

    _schedule(delayMs, callback) {
        let sourceId = 0;
        sourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delayMs, () => {
            this._sourceIds = this._sourceIds.filter((id) => id !== sourceId);
            if (!this._destroyed) {
                callback();
            }
            return GLib.SOURCE_REMOVE;
        });
        this._sourceIds.push(sourceId);
    }

    _setDotsIdle() {
        for (const dot of this._dots) {
            if (!dot) continue;
            dot.remove_all_transitions();
            dot.opacity = 255;
            dot.scale_x = 1;
            dot.scale_y = 1;
        }
    }

    _runPulse() {
        if (this._destroyed) return;

        for (let index = 0; index < this._dots.length; index++) {
            const dot = this._dots[index];
            if (!dot) continue;

            dot.remove_all_transitions();
            dot.opacity = DOT_IDLE_OPACITY;
            dot.scale_x = DOT_IDLE_SCALE;
            dot.scale_y = DOT_IDLE_SCALE;
            dot.ease({
                opacity: 255,
                scale_x: 1,
                scale_y: 1,
                duration: DOT_UP_DURATION_MS,
                delay: index * DOT_STAGGER_MS,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });

            this._schedule(DOT_DOWN_DELAY_MS + index * DOT_STAGGER_MS, () => {
                if (!dot) return;
                dot.ease({
                    opacity: DOT_IDLE_OPACITY,
                    scale_x: DOT_IDLE_SCALE,
                    scale_y: DOT_IDLE_SCALE,
                    duration: DOT_DOWN_DURATION_MS,
                    mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
                });
            });
        }
    }
}

function animationsEnabled() {
    try {
        return St.Settings.get().enable_animations;
    } catch (_e) {
        return true;
    }
}
