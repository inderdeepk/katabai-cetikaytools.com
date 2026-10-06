// welcomePanel.js — Animated empty-state "open book" scene for the chat view.
//
// Self-contained component: owns its actor tree (book, flipping pages, glowing
// aura, drifting dust) and the looping animation timeline.  The dialog keeps
// only the root actor (`this._welcomePanel`) for visibility checks; animation
// scheduling and reset logic live here.
//
// Shell-only module: imports gi://St + Clutter (excluded from the plain-gjs
// import smoke test, like src/pets/petSpriteActor.js).
import GLib from 'gi://GLib';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';

export class WelcomePanel {
    /** @param {Object} dialog — owning KatabDialog (reads `isOpen` and `_chatScroll`). */
    constructor(dialog) {
        this._dialog = dialog;
        this.panel = null;
        this._stage = null;
        this._aura = null;
        this._pageActors = [];
        this._dustActors = [];
        this._animationLoopId = 0;
        this._animationSourceIds = [];

        this.panel = this._build();
    }

    _build() {
        let panel = new St.BoxLayout({
            vertical: true,
            style_class: 'katab-welcome-panel',
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._stage = new St.Widget({
            style_class: 'katab-welcome-stage',
            layout_manager: new Clutter.BinLayout(),
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._stage.set_size(280, 200);
        panel.add_child(this._stage);

        let scene = new St.Widget({
            style_class: 'katab-welcome-scene',
            layout_manager: new Clutter.FixedLayout(),
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        scene.set_size(280, 200);
        this._stage.add_child(scene);

        this._aura = new St.Widget({
            style_class: 'katab-welcome-aura',
            opacity: 120,
        });
        this._aura.set_size(184, 86);
        this._aura.set_position(48, 92);
        scene.add_child(this._aura);

        let shadow = new St.Widget({
            style_class: 'katab-welcome-book-shadow',
        });
        shadow.set_size(172, 18);
        shadow.set_position(54, 146);
        scene.add_child(shadow);

        let book = new St.Widget({
            style_class: 'katab-welcome-book',
            layout_manager: new Clutter.FixedLayout(),
        });
        book.set_size(172, 110);
        book.set_position(54, 52);
        scene.add_child(book);

        let leftCover = new St.Widget({
            style_class: 'katab-welcome-cover katab-welcome-cover-left',
        });
        leftCover.set_size(79, 96);
        leftCover.set_position(8, 8);
        book.add_child(leftCover);

        let rightCover = new St.Widget({
            style_class: 'katab-welcome-cover katab-welcome-cover-right',
        });
        rightCover.set_size(79, 96);
        rightCover.set_position(86, 8);
        book.add_child(rightCover);

        let leftPaper = new St.Widget({
            style_class: 'katab-welcome-paper katab-welcome-paper-left',
        });
        leftPaper.set_size(64, 82);
        leftPaper.set_position(16, 15);
        book.add_child(leftPaper);

        let rightPaper = new St.Widget({
            style_class: 'katab-welcome-paper katab-welcome-paper-right',
        });
        rightPaper.set_size(62, 80);
        rightPaper.set_position(96, 16);
        book.add_child(rightPaper);

        let spine = new St.Widget({
            style_class: 'katab-welcome-spine',
        });
        spine.set_size(8, 96);
        spine.set_position(82, 8);
        book.add_child(spine);

        let backPage = new St.Widget({
            style_class: 'katab-welcome-flip-page katab-welcome-flip-page-secondary',
            opacity: 170,
        });
        backPage.set_size(68, 84);
        backPage.set_position(90, 13);
        backPage.set_pivot_point(0.04, 0.5);
        book.add_child(backPage);

        let frontPage = new St.Widget({
            style_class: 'katab-welcome-flip-page katab-welcome-flip-page-primary',
            opacity: 235,
        });
        frontPage.set_size(72, 88);
        frontPage.set_position(88, 11);
        frontPage.set_pivot_point(0.04, 0.5);
        book.add_child(frontPage);

        this._pageActors = [backPage, frontPage];

        let dustLayer = new St.Widget({
            style_class: 'katab-welcome-dust-layer',
            layout_manager: new Clutter.FixedLayout(),
        });
        dustLayer.set_size(280, 200);
        scene.add_child(dustLayer);

        const dustSpecs = [
            {
                x: 94,
                y: 122,
                size: 8,
                driftX: -18,
                driftY: -74,
                delay: 40,
                duration: 1120,
                peakOpacity: 180,
                scale: 1.22,
            },
            {
                x: 112,
                y: 128,
                size: 5,
                driftX: -8,
                driftY: -92,
                delay: 180,
                duration: 1260,
                peakOpacity: 150,
                scale: 1.28,
            },
            {
                x: 126,
                y: 124,
                size: 7,
                driftX: 6,
                driftY: -86,
                delay: 320,
                duration: 1180,
                peakOpacity: 168,
                scale: 1.24,
            },
            {
                x: 138,
                y: 130,
                size: 5,
                driftX: 14,
                driftY: -96,
                delay: 460,
                duration: 1320,
                peakOpacity: 142,
                scale: 1.3,
            },
            {
                x: 152,
                y: 126,
                size: 6,
                driftX: 22,
                driftY: -76,
                delay: 620,
                duration: 1080,
                peakOpacity: 154,
                scale: 1.18,
            },
            {
                x: 118,
                y: 138,
                size: 4,
                driftX: -24,
                driftY: -66,
                delay: 780,
                duration: 980,
                peakOpacity: 132,
                scale: 1.16,
            },
            {
                x: 142,
                y: 140,
                size: 4,
                driftX: 20,
                driftY: -70,
                delay: 930,
                duration: 1020,
                peakOpacity: 128,
                scale: 1.18,
            },
            {
                x: 130,
                y: 118,
                size: 9,
                driftX: 0,
                driftY: -98,
                delay: 1080,
                duration: 1380,
                peakOpacity: 176,
                scale: 1.34,
            },
        ];

        this._dustActors = dustSpecs.map((spec) => {
            let dust = new St.Widget({
                style_class: 'katab-welcome-dust',
                opacity: 0,
            });
            dust.set_size(spec.size, spec.size);
            dust.set_position(spec.x, spec.y);
            dustLayer.add_child(dust);
            return { actor: dust, ...spec };
        });

        let caption = new St.Label({
            text: 'Open a page. Ask anything.',
            style_class: 'katab-welcome-caption',
            x_align: Clutter.ActorAlign.CENTER,
        });
        caption.clutter_text.line_wrap = true;
        caption.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        caption.clutter_text.single_line_mode = false;
        caption.clutter_text.can_focus = false;
        panel.add_child(caption);

        return panel;
    }

    setVisible(visible) {
        if (!this.panel) {
            return;
        }

        this.panel.visible = visible;

        if (visible && this._dialog.isOpen && this._dialog._chatScroll?.visible) {
            this.startAnimation();
        } else {
            this.stopAnimation();
        }
    }

    _scheduleCallback(delayMs, callback) {
        let sourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delayMs, () => {
            this._animationSourceIds = this._animationSourceIds.filter((id) => id !== sourceId);

            if (this.panel?.visible && this._dialog.isOpen && this._dialog._chatScroll?.visible) {
                callback();
            }

            return GLib.SOURCE_REMOVE;
        });

        this._animationSourceIds.push(sourceId);
    }

    _reset() {
        if (this._aura) {
            this._aura.remove_all_transitions();
            this._aura.opacity = 120;
            this._aura.scale_x = 0.9;
            this._aura.scale_y = 0.9;
        }

        for (let [index, actor] of this._pageActors.entries()) {
            actor.remove_all_transitions();
            actor.rotation_angle_y = 0;
            actor.translation_x = 0;
            actor.translation_y = 0;
            actor.scale_x = 1;
            actor.scale_y = 1;
            actor.opacity = index === 0 ? 170 : 235;
        }

        for (let dust of this._dustActors) {
            dust.actor.remove_all_transitions();
            dust.actor.translation_x = 0;
            dust.actor.translation_y = 0;
            dust.actor.scale_x = 0.72;
            dust.actor.scale_y = 0.72;
            dust.actor.opacity = 0;
        }
    }

    _runCycle() {
        if (!this.panel?.visible || !this._dialog.isOpen || !this._dialog._chatScroll?.visible) {
            return;
        }

        this._reset();

        if (this._aura) {
            this._aura.ease({
                duration: 920,
                opacity: 210,
                scale_x: 1.08,
                scale_y: 1.08,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });

            this._scheduleCallback(980, () => {
                if (!this._aura) {
                    return;
                }

                this._aura.ease({
                    duration: 1220,
                    opacity: 120,
                    scale_x: 0.9,
                    scale_y: 0.9,
                    mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
                });
            });
        }

        const pageAnimations = [
            {
                actor: this._pageActors[0],
                delay: 180,
                duration: 840,
                translationX: -10,
                rotation: -156,
                opacity: 68,
                scaleY: 1.03,
            },
            {
                actor: this._pageActors[1],
                delay: 560,
                duration: 980,
                translationX: -14,
                rotation: -176,
                opacity: 0,
                scaleY: 1.05,
            },
        ];

        for (let animation of pageAnimations) {
            this._scheduleCallback(animation.delay, () => {
                animation.actor.ease({
                    duration: animation.duration,
                    translation_x: animation.translationX,
                    rotation_angle_y: animation.rotation,
                    opacity: animation.opacity,
                    scale_y: animation.scaleY,
                    mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
                });
            });
        }

        for (let dust of this._dustActors) {
            this._scheduleCallback(dust.delay, () => {
                dust.actor.opacity = dust.peakOpacity;
                dust.actor.ease({
                    duration: dust.duration,
                    translation_x: dust.driftX,
                    translation_y: dust.driftY,
                    opacity: 0,
                    scale_x: dust.scale,
                    scale_y: dust.scale,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                });
            });
        }
    }

    startAnimation() {
        if (!this.panel?.visible || !this._dialog.isOpen || !this._dialog._chatScroll?.visible) {
            return;
        }

        if (this._animationLoopId) {
            return;
        }

        this._runCycle();
        this._animationLoopId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2600, () => {
            this._runCycle();
            return GLib.SOURCE_CONTINUE;
        });
    }

    stopAnimation() {
        if (this._animationLoopId) {
            GLib.source_remove(this._animationLoopId);
            this._animationLoopId = 0;
        }

        for (let sourceId of this._animationSourceIds) {
            GLib.source_remove(sourceId);
        }
        this._animationSourceIds = [];

        this._reset();
    }
}
