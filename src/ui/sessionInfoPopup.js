// sessionInfoPopup.js — floating "Session Info" panel anchored to the token
// box in the footer.  Shows the context-window breakdown (system, user
// context, session memory, research) and hosts the Summarize/Compact actions.
//
// Self-contained component: owns the popup actor (built lazily on first
// show), the hover/leave/click-lock lifecycle timers, the deferred-reposition
// idle source, and all `_si*` widget refs.  The dialog keeps the
// `_sessionInfoPopup` actor field for its visibility checks plus thin
// wrappers; the rest flows through the host bag.
//
// Shell-only module: imports gi://St + Clutter (excluded from the plain-gjs
// import smoke test, like src/pets/petSpriteActor.js).
import { gettext as _ } from '../shared/i18n.js';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';

export class SessionInfoPopup {
    /**
     * @param {Object} host — dialog surface:
     *   addToOverlay(actor), getSessionInfo(),
     *   getAnchor(), stageToOverlayCoords(x, y), overlaySize(),
     *   summarizeNow(), compactConversation()
     */
    constructor(host) {
        this._host = host;

        this._popup = null;
        this._clickLocked = false;
        this._hoverTimeout = 0;
        this._leaveTimeout = 0;
        this._repositionId = 0;
    }

    get popup() {
        return this._popup;
    }

    // Show the popup (click or hover).  Builds it on first call.
    show() {
        if (!this._popup) {
            this._popup = this._build();
            this._host.addToOverlay(this._popup);
        }
        this._popup.visible = true;
        const parent = this._popup.get_parent();
        if (parent) parent.set_child_above_sibling(this._popup, null);
        this.refresh();
        this.position();
        // Deferred reposition: after this frame paints, the actual
        // allocation is available — re-anchor for pixel-perfect placement.
        if (this._repositionId) GLib.source_remove(this._repositionId);
        this._repositionId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._repositionId = 0;
            this.position();
            return GLib.SOURCE_REMOVE;
        });
    }

    // Hide the popup (hover leave, close button, Escape, outside click).
    hide() {
        if (this._popup) {
            this._popup.visible = false;
        }
        this._clickLocked = false;
        this._clearTimeouts();
    }

    // Toggle open/close on click.
    toggle() {
        this._clearTimeouts();

        // A visible popup always closes on a trigger click — whether it was
        // opened by hover or by click.  The old "click while hover-shown
        // pins it open" branch turned the click into a silent no-op, which
        // read as a stuck button (users clicked again and again).
        if (this._popup?.visible) {
            this.hide();
            return;
        }

        // Click while closed → show; the click lock keeps it open while the
        // pointer moves onto it (hover-opened previews still auto-hide).
        this._clickLocked = true;
        this.show();
    }

    // Pointer entered the token-box trigger.
    noteTriggerEnter() {
        if (this._leaveTimeout) {
            GLib.source_remove(this._leaveTimeout);
            this._leaveTimeout = 0;
        }
        if (!this._clickLocked && !this._popup?.visible) {
            this._hoverTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
                this._hoverTimeout = 0;
                this.show();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    // Pointer left the token-box trigger.
    noteTriggerLeave() {
        if (this._hoverTimeout) {
            GLib.source_remove(this._hoverTimeout);
            this._hoverTimeout = 0;
        }
        if (!this._clickLocked) {
            this._leaveTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
                this._leaveTimeout = 0;
                this.hide();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    // Clear any pending hover/leave timeouts.
    _clearTimeouts() {
        if (this._hoverTimeout) {
            GLib.source_remove(this._hoverTimeout);
            this._hoverTimeout = 0;
        }
        if (this._leaveTimeout) {
            GLib.source_remove(this._leaveTimeout);
            this._leaveTimeout = 0;
        }
        if (this._repositionId) {
            GLib.source_remove(this._repositionId);
            this._repositionId = 0;
        }
    }

    /** Remove pending timers so nothing fires post-destroy. */
    destroy() {
        this._clearTimeouts();
    }

    // Position the popup above the token box, clamped to overlay bounds.
    position() {
        if (!this._popup) return;

        // Use preferred size — works on first paint, no layout pass needed
        let [, popupWidth] = this._popup.get_preferred_width(-1);
        let [, popupHeight] = this._popup.get_preferred_height(popupWidth);

        // Token box anchor, converted from stage space into the overlay's
        // local space (the overlay is pinned to the primary monitor origin,
        // which is not necessarily the stage origin — see
        // _stageToOverlayCoords).
        let [tbX, tbY] = this._host.stageToOverlayCoords(
            ...this._host.getAnchor().get_transformed_position(),
        );
        let [tbW, tbH] = this._host.getAnchor().get_transformed_size();

        const [overlayWidth, overlayHeight] = this._host.overlaySize();
        const margin = 12;

        // Position above the token box, right-aligned
        let popupX = tbX + tbW - popupWidth;
        let popupY = tbY - popupHeight - 8;

        if (popupX + popupWidth > overlayWidth - margin) {
            popupX = overlayWidth - popupWidth - margin;
        }
        if (popupX < margin) {
            popupX = margin;
        }
        if (popupY < margin) {
            // Not enough room above — position below instead
            popupY = tbY + tbH + 8;
            if (popupY + popupHeight > overlayHeight - margin) {
                popupY = overlayHeight - popupHeight - margin;
            }
        }
        if (popupY < margin) {
            popupY = margin;
        }

        this._popup.set_position(Math.round(popupX), Math.round(popupY));
    }

    // Refresh the popup contents with current data.  Only updates UI
    // labels — does not rebuild the widget tree.
    refresh() {
        // Only recompute/redraw while visible — hidden-widget updates on every
        // keystroke would repeatedly serialize + truncate the whole history.
        if (!this._popup || !this._popup.visible) return;

        const info = this._host.getSessionInfo();

        // ── Context Window ────────────────────────────────────────────
        const { contextWindow: cw } = info;
        this._siCwLabel.set_text(`${cw.fmtUsed} / ${cw.fmtMax} tokens`);
        this._siCwPct.set_text(`${cw.pct}%`);

        // Progress bar: filled portion + hatched reserved-for-response segment
        const trackWidth = this._siProgress.width;
        const effectiveWidth = trackWidth > 0 ? trackWidth : 300;
        const fillWidth = Math.max(
            cw.used > 0 ? (cw.pct / 100) * effectiveWidth : 0,
            cw.used > 0 ? 4 : 0,
        );
        const reservedWidth = Math.max(0, effectiveWidth - fillWidth);
        this._siProgressFill.set_width(Math.min(fillWidth, effectiveWidth));
        this._siReservedFill.set_width(reservedWidth);

        // Color the fill based on ratio
        ['medium', 'warn', 'high', 'danger'].forEach((c) =>
            this._siProgressFill.remove_style_class_name(c),
        );
        if (cw.pct >= 95) this._siProgressFill.add_style_class_name('danger');
        else if (cw.pct >= 75) this._siProgressFill.add_style_class_name('high');
        else if (cw.pct >= 50) this._siProgressFill.add_style_class_name('warn');
        else if (cw.pct > 0) this._siProgressFill.add_style_class_name('medium');

        // ── System ────────────────────────────────────────────────────
        const { system: sys } = info;
        this._siSysInstr.set_text(`${sys.instructionTokens} · ${sys.instructionPct}%`);
        if (sys.hasToolDefs) {
            this._siSysTools.set_text(`${sys.toolDefTokens} · ${sys.toolDefPct}%`);
        } else {
            this._siSysTools.set_text('None');
        }

        // ── User Context ──────────────────────────────────────────────
        const { userContext: uc } = info;
        this._siUcMsgs.set_text(`${uc.messageTokens} · ${uc.messagePct}%`);
        this._siUcTools.set_text(`${uc.toolResultTokens} · ${uc.toolResultPct}%`);

        // ── Session Memory ────────────────────────────────────────────
        const { sessionMemory: mem } = info;
        if (mem.status === 'active') {
            this._siMemValue.set_text(`${mem.tokens} · ${mem.pct}%`);
            this._siMemStatus.set_text(
                'Session memory active — older turns are summarized automatically so the model keeps full context.',
            );
        } else if (mem.status === 'compacting') {
            this._siMemValue.set_text('…');
            this._siMemStatus.set_text('Summarizing earlier turns…');
        } else {
            this._siMemValue.set_text('None');
            this._siMemStatus.set_text(
                'No session memory yet — it grows automatically as the chat gets long.',
            );
        }

        // ── Research ──────────────────────────────────────────────────
        const { research: res } = info;
        if (res) {
            this._siResearchSection.visible = true;
            this._siResCumulative.set_text(`${res.cumulative} (Σ)`);
            this._siResIter.set_text(String(res.toolIterations));
            this._siResSynth.set_text(res.synthesisActive ? 'Yes (tools suppressed)' : 'No');
            this._siResCtx.set_text(res.contextTokens);
        } else {
            this._siResearchSection.visible = false;
        }
    }

    // Create the Session Info floating popup.  Built once, updated in-place
    // via refresh().  Floats on the dialog's overlay actor so it can overflow
    // the dialog bounds freely.
    _build() {
        const popup = new St.BoxLayout({
            vertical: true,
            style_class: 'katab-session-info-popup',
            visible: false,
            reactive: true,
            can_focus: true,
        });

        // ── Header ────────────────────────────────────────────────────
        const header = new St.BoxLayout({
            vertical: false,
            style_class: 'katab-session-info-header',
        });
        const title = new St.Label({
            text: _('Session Info'),
            style_class: 'katab-session-info-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        header.add_child(title);
        const closeBtn = new St.Button({
            child: new St.Icon({
                icon_name: 'window-close-symbolic',
                style_class: 'katab-session-info-close-icon',
            }),
            style_class: 'katab-session-info-close-btn',
            can_focus: true,
            accessible_name: 'Close session info',
        });
        closeBtn.connect('clicked', () => this.hide());
        header.add_child(closeBtn);
        popup.add_child(header);

        // ── Context Window section ────────────────────────────────────
        const cwSection = new St.BoxLayout({
            vertical: true,
            style_class: 'katab-session-info-section',
        });
        const cwTitle = new St.Label({
            text: 'CONTEXT WINDOW',
            style_class: 'katab-session-info-section-title',
        });
        cwSection.add_child(cwTitle);

        const cwRow = new St.BoxLayout({ vertical: false, style_class: 'katab-session-info-row' });
        this._siCwLabel = new St.Label({
            text: '—',
            style_class: 'katab-session-info-row-label',
            x_expand: true,
        });
        cwRow.add_child(this._siCwLabel);
        this._siCwPct = new St.Label({ text: '—', style_class: 'katab-session-info-row-value' });
        cwRow.add_child(this._siCwPct);
        cwSection.add_child(cwRow);

        // Progress bar: filled + reserved sections
        this._siProgress = new St.Widget({
            style_class: 'katab-session-info-progress',
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            height: 6,
        });
        const progressTrack = new St.BoxLayout({
            style_class: 'katab-session-info-progress-track',
            x_expand: true,
            height: 6,
        });
        this._siProgressFill = new St.Widget({
            style_class: 'katab-session-info-progress-fill',
            width: 0,
            height: 6,
        });
        // Hatched "reserved for response" segment — mirrors the bottom gauge.
        this._siReservedFill = new St.Widget({
            style_class: 'katab-session-info-progress-reserved',
            width: 0,
            height: 6,
        });
        progressTrack.add_child(this._siProgressFill);
        progressTrack.add_child(this._siReservedFill);
        this._siProgress.add_child(progressTrack);
        cwSection.add_child(this._siProgress);

        const reservedLabel = new St.Label({
            text: 'Reserved for response',
            style_class: 'katab-session-info-reserved-label',
        });
        cwSection.add_child(reservedLabel);

        popup.add_child(cwSection);

        // ── System section ────────────────────────────────────────────
        const sysSection = new St.BoxLayout({
            vertical: true,
            style_class: 'katab-session-info-section',
        });
        const sysTitle = new St.Label({
            text: 'SYSTEM',
            style_class: 'katab-session-info-section-title',
        });
        sysSection.add_child(sysTitle);
        this._siSysSection = sysSection;

        const sysInstrRow = new St.BoxLayout({
            vertical: false,
            style_class: 'katab-session-info-row',
        });
        sysInstrRow.add_child(
            new St.Label({
                text: 'System Instructions',
                style_class: 'katab-session-info-row-label',
                x_expand: true,
            }),
        );
        this._siSysInstr = new St.Label({ text: '—', style_class: 'katab-session-info-row-value' });
        sysInstrRow.add_child(this._siSysInstr);
        sysSection.add_child(sysInstrRow);

        const sysToolRow = new St.BoxLayout({
            vertical: false,
            style_class: 'katab-session-info-row',
        });
        sysToolRow.add_child(
            new St.Label({
                text: 'Tool Definitions',
                style_class: 'katab-session-info-row-label',
                x_expand: true,
            }),
        );
        this._siSysTools = new St.Label({ text: '—', style_class: 'katab-session-info-row-value' });
        sysToolRow.add_child(this._siSysTools);
        sysSection.add_child(sysToolRow);

        popup.add_child(sysSection);

        // ── User Context section ──────────────────────────────────────
        const ucSection = new St.BoxLayout({
            vertical: true,
            style_class: 'katab-session-info-section',
        });
        const ucTitle = new St.Label({
            text: 'USER CONTEXT',
            style_class: 'katab-session-info-section-title',
        });
        ucSection.add_child(ucTitle);

        const msgRow = new St.BoxLayout({ vertical: false, style_class: 'katab-session-info-row' });
        msgRow.add_child(
            new St.Label({
                text: 'Messages',
                style_class: 'katab-session-info-row-label',
                x_expand: true,
            }),
        );
        this._siUcMsgs = new St.Label({ text: '—', style_class: 'katab-session-info-row-value' });
        msgRow.add_child(this._siUcMsgs);
        ucSection.add_child(msgRow);

        const toolRow = new St.BoxLayout({
            vertical: false,
            style_class: 'katab-session-info-row',
        });
        toolRow.add_child(
            new St.Label({
                text: 'Tool Results',
                style_class: 'katab-session-info-row-label',
                x_expand: true,
            }),
        );
        this._siUcTools = new St.Label({ text: '—', style_class: 'katab-session-info-row-value' });
        toolRow.add_child(this._siUcTools);
        ucSection.add_child(toolRow);

        popup.add_child(ucSection);

        // ── Session Memory section ──────────────────────────────────
        const memSection = new St.BoxLayout({
            vertical: true,
            style_class: 'katab-session-info-section',
        });
        const memTitle = new St.Label({
            text: 'SESSION MEMORY',
            style_class: 'katab-session-info-section-title',
        });
        memSection.add_child(memTitle);

        const memRow = new St.BoxLayout({ vertical: false, style_class: 'katab-session-info-row' });
        memRow.add_child(
            new St.Label({
                text: 'Folded summary',
                style_class: 'katab-session-info-row-label',
                x_expand: true,
            }),
        );
        this._siMemValue = new St.Label({ text: '—', style_class: 'katab-session-info-row-value' });
        memRow.add_child(this._siMemValue);
        memSection.add_child(memRow);

        this._siMemStatus = new St.Label({
            text: 'No session memory yet — grows automatically as the chat gets long.',
            style_class: 'katab-session-info-mem-status',
        });
        this._siMemStatus.clutter_text.line_wrap = true;
        this._siMemStatus.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        memSection.add_child(this._siMemStatus);

        popup.add_child(memSection);

        // ── Research section (built lazily, shown only when active) ──
        this._siResearchSection = new St.BoxLayout({
            vertical: true,
            style_class: 'katab-session-info-section',
            visible: false,
        });
        const rsTitle = new St.Label({
            text: 'RESEARCH',
            style_class: 'katab-session-info-section-title',
        });
        this._siResearchSection.add_child(rsTitle);

        const resCumRow = new St.BoxLayout({
            vertical: false,
            style_class: 'katab-session-info-row',
        });
        resCumRow.add_child(
            new St.Label({
                text: 'Pipeline (cumulative)',
                style_class: 'katab-session-info-row-label',
                x_expand: true,
            }),
        );
        this._siResCumulative = new St.Label({
            text: '—',
            style_class: 'katab-session-info-row-value',
        });
        resCumRow.add_child(this._siResCumulative);
        this._siResearchSection.add_child(resCumRow);

        const resIterRow = new St.BoxLayout({
            vertical: false,
            style_class: 'katab-session-info-row',
        });
        resIterRow.add_child(
            new St.Label({
                text: 'Tool Iterations this turn',
                style_class: 'katab-session-info-row-label',
                x_expand: true,
            }),
        );
        this._siResIter = new St.Label({ text: '—', style_class: 'katab-session-info-row-value' });
        resIterRow.add_child(this._siResIter);
        this._siResearchSection.add_child(resIterRow);

        const resSynthRow = new St.BoxLayout({
            vertical: false,
            style_class: 'katab-session-info-row',
        });
        resSynthRow.add_child(
            new St.Label({
                text: 'Synthesis Active',
                style_class: 'katab-session-info-row-label',
                x_expand: true,
            }),
        );
        this._siResSynth = new St.Label({ text: '—', style_class: 'katab-session-info-row-value' });
        resSynthRow.add_child(this._siResSynth);
        this._siResearchSection.add_child(resSynthRow);

        const resCtxRow = new St.BoxLayout({
            vertical: false,
            style_class: 'katab-session-info-row',
        });
        resCtxRow.add_child(
            new St.Label({
                text: 'Context Payload Size',
                style_class: 'katab-session-info-row-label',
                x_expand: true,
            }),
        );
        this._siResCtx = new St.Label({ text: '—', style_class: 'katab-session-info-row-value' });
        resCtxRow.add_child(this._siResCtx);
        this._siResearchSection.add_child(resCtxRow);

        popup.add_child(this._siResearchSection);

        // ── Summarize now + Compact Conversation buttons ─────────────
        // NOTE: St.BoxLayout has no 'spacing' GObject property — passing it
        // here throws "No property spacing on StBoxLayout" at construction
        // time, which aborted the whole popup build and made the token-box
        // hover/click look broken.  Spacing is set via the CSS class.
        const actionRow = new St.BoxLayout({
            vertical: false,
            style_class: 'katab-session-info-action-row',
            x_expand: true,
        });
        const summarizeBtn = new St.Button({
            label: 'Summarize Now',
            style_class: 'katab-session-info-action-btn',
            can_focus: true,
            reactive: true,
            x_expand: true,
        });
        summarizeBtn.connect('clicked', () => this._host.summarizeNow());
        actionRow.add_child(summarizeBtn);

        const compactBtn = new St.Button({
            label: 'Compact Conversation',
            style_class: 'katab-session-info-action-btn',
            can_focus: true,
            reactive: true,
            x_expand: true,
        });
        compactBtn.connect('clicked', () => this._host.compactConversation());
        actionRow.add_child(compactBtn);
        popup.add_child(actionRow);

        // Hover on the popup itself cancels any pending leave timeout so
        // the user can move the mouse from the token box onto the popup.
        popup.connect('enter-event', () => {
            if (this._leaveTimeout) {
                GLib.source_remove(this._leaveTimeout);
                this._leaveTimeout = 0;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        popup.connect('leave-event', () => {
            if (!this._clickLocked) {
                this._leaveTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
                    this._leaveTimeout = 0;
                    this.hide();
                    return GLib.SOURCE_REMOVE;
                });
            }
            return Clutter.EVENT_PROPAGATE;
        });

        return popup;
    }
}
