// recentChatsPopup.js — "Recent Conversations" hover preview anchored to the
// header history button.  Lists up to 5 recent conversations; clicking a row
// loads that conversation (clicking the button itself opens the full history
// view — handled by the dialog).
//
// Self-contained component: owns the popup actor (built lazily on first
// show), the row labels, the hover/leave lifecycle timers, the deferred
// reposition idle, and the stage-wide click-outside close handler.  The
// dialog keeps the `_recentChatsPopup` actor field for its visibility checks
// plus thin wrappers; dialog state flows through the host bag.
// Pattern mirrors src/ui/sessionInfoPopup.js / toolsPopup.js.
//
// Shell-only module: imports gi://St + Clutter (excluded from the plain-gjs
// import smoke test, like src/pets/petSpriteActor.js).
import GLib from 'gi://GLib';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import { HistoryManager } from '../core/historyManager.js';

export class RecentChatsPopup {
    /**
     * @param {Object} host — dialog surface:
     *   addToOverlay(actor), getHistoryButton(), isChatViewVisible(),
     *   getCurrentConversationId(), loadConversation(entry),
     *   stageToOverlayCoords(x, y), overlaySize()
     */
    constructor(host) {
        this._host = host;

        this._popup = null;
        this._clickLocked = false;
        this._hoverTimeout = 0;
        this._leaveTimeout = 0;
        this._repositionId = 0;
        this._closeHandler = null;
    }

    get popup() {
        return this._popup;
    }

    // Show the preview (hover).  Builds it on first call.
    show() {
        if (!this._host.getHistoryButton()) return;
        // Only preview from the chat view — never over the history list or
        // another auxiliary panel (the popup would cover the panel's first
        // rows and intercept clicks meant for them).
        if (!this._host.isChatViewVisible()) return;
        let history = HistoryManager.getCached();
        let recentEntries = history
            .filter((e) => e.id !== this._host.getCurrentConversationId() && !e.archived)
            .slice(0, 5);
        if (recentEntries.length === 0) return;

        // Build once, reuse thereafter
        if (!this._popup) {
            this._popup = this._build();
            this._host.addToOverlay(this._popup);
        }

        // Refresh row labels (titles / timestamps may have changed)
        this._refreshRows(recentEntries);

        this._popup.visible = true;
        const parent = this._popup.get_parent();
        if (parent) parent.set_child_above_sibling(this._popup, null);
        this.position();

        // Deferred reposition — after the frame paints the allocation is available
        if (this._repositionId) GLib.source_remove(this._repositionId);
        this._repositionId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._repositionId = 0;
            this.position();
            return GLib.SOURCE_REMOVE;
        });

        // Auto-close when clicking elsewhere on the stage
        if (!this._closeHandler) {
            this._closeHandler = global.stage.connect('button-press-event', (actor, _event) => {
                if (
                    this._popup?.visible &&
                    !this._popup.contains(actor) &&
                    actor !== this._host.getHistoryButton() &&
                    !this._host.getHistoryButton().contains(actor)
                ) {
                    this.hide();
                }
            });
        }
    }

    // Hide the preview (hover leave, outside click, history-view open).
    hide() {
        if (this._popup) {
            this._popup.visible = false;
        }
        this._clickLocked = false;
        this._clearTimeouts();
    }

    // Pointer entered the history-button trigger.
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

    // Pointer left the history-button trigger.
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

    // Clear any pending hover/leave/reposition timeouts.
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

    /** Disconnect the stage close handler + pending timers on dialog destroy. */
    destroy() {
        this._clearTimeouts();
        if (this._closeHandler) {
            global.stage.disconnect(this._closeHandler);
            this._closeHandler = null;
        }
    }

    // Position the popup below the history button, clamped to overlay bounds.
    position() {
        if (!this._popup || !this._host.getHistoryButton()) return;

        let [, popupWidth] = this._popup.get_preferred_width(-1);
        let [, popupHeight] = this._popup.get_preferred_height(popupWidth);

        // History button anchor, converted from stage space into the
        // overlay's local space (see _stageToOverlayCoords).
        let [btnX, btnY] = this._host.stageToOverlayCoords(
            ...this._host.getHistoryButton().get_transformed_position(),
        );
        let [btnW, btnH] = this._host.getHistoryButton().get_transformed_size();

        const [overlayWidth, overlayHeight] = this._host.overlaySize();
        const margin = 12;

        // Position below the button, left-aligned
        let popupX = btnX;
        let popupY = btnY + btnH + 6;

        if (popupX + popupWidth > overlayWidth - margin) {
            popupX = btnX + btnW - popupWidth;
        }
        if (popupX < margin) {
            popupX = margin;
        }
        if (popupY + popupHeight > overlayHeight - margin) {
            // Not enough room below — position above instead
            popupY = btnY - popupHeight - 6;
            if (popupY < margin) {
                popupY = overlayHeight - popupHeight - margin;
            }
        }
        if (popupY < margin) {
            popupY = margin;
        }

        this._popup.set_position(Math.round(popupX), Math.round(popupY));
    }

    _build() {
        const popup = new St.BoxLayout({
            vertical: true,
            style_class: 'katab-recent-chats-popup',
            visible: false,
            reactive: true,
            can_focus: true,
        });

        // 5 placeholder rows — titles/dates refreshed by _refreshRows
        for (let i = 0; i < 5; i++) {
            let row = new St.BoxLayout({
                vertical: true,
                style_class: 'katab-recent-chats-row',
                reactive: true,
                can_focus: true,
                track_hover: true,
            });

            let titleLabel = new St.Label({
                text: '',
                style_class: 'katab-recent-chats-row-title',
                x_expand: true,
            });
            titleLabel.clutter_text.line_wrap = false;
            titleLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            row.add_child(titleLabel);

            let dateLabel = new St.Label({
                text: '',
                style_class: 'katab-recent-chats-row-date',
            });
            row.add_child(dateLabel);

            // Store refs for later refresh via _refreshRows
            row._katabTitleLabel = titleLabel;
            row._katabDateLabel = dateLabel;
            row._katabEntry = null;

            row.connect('button-press-event', () => {
                if (row._katabEntry) {
                    this.hide();
                    this._host.loadConversation(row._katabEntry);
                }
                return Clutter.EVENT_STOP;
            });

            popup.add_child(row);
        }

        // Hover on the popup itself cancels the leave timeout so the user
        // can move the mouse from the button onto the dropdown.
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

    _refreshRows(entries) {
        if (!this._popup) return;
        let children = this._popup.get_children();
        for (let i = 0; i < children.length; i++) {
            let row = children[i];
            let entry = entries[i];
            if (entry) {
                let title = String(entry.title || 'Untitled').trim();
                if (title.length > 48) title = title.slice(0, 45) + '…';
                row._katabTitleLabel.set_text(title);
                row._katabDateLabel.set_text(this._formatRelativeTime(entry.timestamp));
                row._katabEntry = entry;
                row.visible = true;
            } else {
                row.visible = false;
            }
        }
    }

    _formatRelativeTime(timestamp) {
        let now = Date.now() / 1000;
        let diff = Math.max(0, now - timestamp);
        if (diff < 60) return 'Just now';
        if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
        if (diff < 86400) return `${Math.floor(diff / 3600)} hr ago`;
        if (diff < 604800) return `${Math.floor(diff / 86400)} days ago`;
        return new Date(timestamp * 1000).toLocaleDateString();
    }
}
