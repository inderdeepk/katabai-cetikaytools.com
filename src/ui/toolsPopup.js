// toolsPopup.js — floating "Tools" panel anchored to the footer gear button.
// Lists every available tool with its mode control (Auto/On/Off for the
// mode-controlled tools) and inserts slash commands when clicked.
//
// Self-contained component: owns the popup actor (built lazily on first
// show), the tool-row container and per-tool mode-label refs, the
// hover/leave/click-lock lifecycle timers, and the deferred-reposition idle.
// The dialog keeps the `_toolsPopup` actor field for its visibility checks
// plus thin wrappers; dialog state (tool list, modes, prompt entry) flows
// through the host bag.  Pattern mirrors src/ui/sessionInfoPopup.js.
//
// Shell-only module: imports gi://St + Clutter (excluded from the plain-gjs
// import smoke test, like src/pets/petSpriteActor.js).
import GLib from 'gi://GLib';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import { RAG_TOOL_NAME } from '../tools/ragTools.js';
import { DOCUMENT_TOOL_NAME } from '../tools/documentTools.js';
import { DEEP_RESEARCH_TOOL_NAME } from '../tools/toolDefinitions.js';
import {
    DEEP_RESEARCH_MODE_LABELS,
    TOOL_MODE_AUTO,
    TOOL_MODE_OFF,
    TOOL_MODE_ON,
    TOOL_MODE_LABELS,
} from '../shared/toolModes.js';

export class ToolsPopup {
    /**
     * @param {Object} host — dialog surface:
     *   addToOverlay(actor), getAnchor(), stageToOverlayCoords(x, y),
     *   overlaySize(), getDialogRect(),
     *   getAvailableTools(), isModeControlledTool(name), getToolMode(name),
     *   isDocumentToolEnabled(), toolModeAvailable(tool, mode),
     *   getToolButtonLabel(tool), cycleToolMode(name), updateToolsBadge(),
     *   addSystemMessage(text), pickDocumentForAttachment(),
     *   getEntryText(), setEntryText(text), focusPrompt(), placeCursorAtEnd()
     */
    constructor(host) {
        this._host = host;

        this._popup = null;
        this._clickLocked = false;
        this._hoverTimeout = 0;
        this._leaveTimeout = 0;
        this._repositionId = 0;
        this._rows = null;
        this._modeLabels = {};
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
        // Diagnostics for the floating-popup geometry (overlay-local units) —
        // popups are children of the overlay, not the dialog container, so
        // placement bugs are invisible without this trace.  One line per open.
        try {
            const [opW, opH] = this._host.overlaySize();
            const [dx, dy, dw, dh] = this._host.getDialogRect();
            log(
                `[Katab:tools] Popup placed at ${Math.round(this._popup.x)},${Math.round(this._popup.y)} · overlay ${Math.round(opW)}×${Math.round(opH)} · dialog ${dx},${dy} ${dw}×${dh}`,
            );
        } catch (_e) {
            /* diagnostics only */
        }
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

        // A visible popup always closes on a trigger click (same rationale
        // as the Session Info toggle) — a hover-opened popup used to swallow
        // the first click as a silent "pin" no-op.
        if (this._popup?.visible) {
            this.hide();
            return;
        }

        this._clickLocked = true;
        this.show();
    }

    // Pointer entered the gear-button trigger.
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

    // Pointer left the gear-button trigger.
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

    position() {
        if (!this._popup || !this._host.getAnchor()) return;

        let [, popupWidth] = this._popup.get_preferred_width(-1);
        let [, popupHeight] = this._popup.get_preferred_height(popupWidth);

        // Gear anchor, converted from stage space into the overlay's local
        // space (the overlay is pinned to the primary monitor origin, which
        // is not necessarily the stage origin — see _stageToOverlayCoords).
        // Skipping this conversion used to push the lower tool rows outside
        // the dialog rectangle, where clicks closed the chat window instead
        // of toggling the tool (e.g. the Deep Research row).
        let [gbX, gbY] = this._host.stageToOverlayCoords(
            ...this._host.getAnchor().get_transformed_position(),
        );
        let [gbW, gbH] = this._host.getAnchor().get_transformed_size();

        const [overlayWidth, overlayHeight] = this._host.overlaySize();
        const margin = 12;

        // Position above the gear button, right-aligned
        let popupX = gbX + gbW - popupWidth;
        let popupY = gbY - popupHeight - 8;

        if (popupX + popupWidth > overlayWidth - margin) {
            popupX = overlayWidth - popupWidth - margin;
        }
        if (popupX < margin) {
            popupX = margin;
        }
        if (popupY < margin) {
            // Not enough room above — place below the gear button instead
            popupY = gbY + gbH + 8;
            if (popupY + popupHeight > overlayHeight - margin) {
                popupY = overlayHeight - popupHeight - margin;
            }
        }
        if (popupY < margin) {
            popupY = margin;
        }

        this._popup.set_position(Math.round(popupX), Math.round(popupY));
    }

    refresh() {
        if (!this._rows) return;

        const tools = this._host.getAvailableTools();
        const primaryTools = tools.filter((t) => t.toolName !== RAG_TOOL_NAME);
        const moreTools = tools.filter((t) => t.toolName === RAG_TOOL_NAME);
        const hasSeparator = moreTools.length > 0;
        const totalRows = primaryTools.length + (hasSeparator ? 1 : 0) + moreTools.length;

        const existingChildren = this._rows.get_n_children();

        // Full rebuild only when the tool list changes (row count differs)
        // or on first render.  Otherwise patch mode labels in-place.
        if (existingChildren !== totalRows) {
            this._rows.destroy_all_children();
            this._modeLabels = {};

            // ── Build a single tool row ──────────────────────────────
            const buildRow = (tool) => {
                const isModeControlled = this._host.isModeControlledTool(tool.toolName);
                const mode = this._host.getToolMode(tool.toolName);
                const documentToolDisabled =
                    tool.toolName === DOCUMENT_TOOL_NAME && !this._host.isDocumentToolEnabled();
                const isDeepResearch = tool.toolName === DEEP_RESEARCH_TOOL_NAME;
                const modeLabels = isDeepResearch ? DEEP_RESEARCH_MODE_LABELS : TOOL_MODE_LABELS;
                const defaultModeLabel = isDeepResearch
                    ? DEEP_RESEARCH_MODE_LABELS[TOOL_MODE_OFF]
                    : TOOL_MODE_LABELS[TOOL_MODE_AUTO];
                const modeToolDisabled =
                    isModeControlled &&
                    mode === (isDeepResearch ? TOOL_MODE_OFF : TOOL_MODE_AUTO) &&
                    !this._host.toolModeAvailable(tool, mode);

                const row = new St.Button({
                    style_class: 'katab-tools-popup-row',
                    can_focus: true,
                    x_expand: true,
                });

                const iconProps = {};
                if (tool.gicon) {
                    iconProps.gicon = tool.gicon;
                } else {
                    iconProps.icon_name = tool.icon;
                }
                const icon = new St.Icon({
                    ...iconProps,
                    style_class: 'katab-tools-popup-row-icon',
                    x_align: Clutter.ActorAlign.CENTER,
                    y_align: Clutter.ActorAlign.CENTER,
                });

                const nameLabel = new St.Label({
                    text: this._host.getToolButtonLabel(tool),
                    style_class: 'katab-tools-popup-row-label',
                    x_expand: true,
                    y_align: Clutter.ActorAlign.CENTER,
                });

                const modeWrap = new St.Widget({
                    style_class: isModeControlled
                        ? `katab-tools-popup-row-mode katab-tools-mode-${mode}`
                        : 'katab-tools-popup-row-mode',
                    layout_manager: new Clutter.BinLayout(),
                });
                const modeLabel = new St.Label({
                    text: isModeControlled ? modeLabels[mode] || defaultModeLabel : '',
                    style_class: 'katab-tools-popup-row-mode-label',
                });
                modeWrap.add_child(modeLabel);

                // Store references for in-place updates
                if (isModeControlled) {
                    this._modeLabels[tool.toolName] = {
                        wrap: modeWrap,
                        label: modeLabel,
                    };
                }

                const rowContent = new St.BoxLayout({
                    vertical: false,
                    style_class: 'katab-tools-popup-row-content',
                    x_expand: true,
                    y_align: Clutter.ActorAlign.CENTER,
                });
                rowContent.add_child(icon);
                rowContent.add_child(nameLabel);
                rowContent.add_child(modeWrap);

                if (documentToolDisabled || modeToolDisabled) {
                    row.add_style_class_name('katab-tools-popup-row-disabled');
                }

                row.set_child(rowContent);

                row.connect('clicked', async () => {
                    if (isModeControlled) {
                        // Deep Research needs at least one research-capable
                        // tool underneath.  When neither Web Search nor Web
                        // Scraper is available the row renders disabled and
                        // must not silently flip a mode that cannot run —
                        // explain how to make it usable instead.
                        if (isDeepResearch && !this._host.toolModeAvailable(tool, TOOL_MODE_ON)) {
                            this._host.addSystemMessage(
                                'Deep Research needs Web Search or Web Scraper. Enable one in Settings → Tools, or switch its mode to On from this popup.',
                            );
                            return;
                        }
                        this._host.cycleToolMode(tool.toolName);
                        this._patchMode(tool.toolName);
                        this._host.updateToolsBadge();
                        return;
                    }

                    if (tool.toolName === DOCUMENT_TOOL_NAME) {
                        if (!this._host.isDocumentToolEnabled()) {
                            this._host.addSystemMessage(
                                'Document tool is available, but it is currently off. Enable it in Settings > Tools to use the /doc command.',
                            );
                            return;
                        }
                        this.hide();
                        await this._host.pickDocumentForAttachment();
                        return;
                    }

                    let currentText = this._host.getEntryText();
                    if (!currentText) {
                        this._host.setEntryText(`${tool.command} `);
                    } else if (
                        currentText === tool.command ||
                        currentText.startsWith(`${tool.command} `) ||
                        currentText.endsWith(` ${tool.command}`)
                    ) {
                        this._host.setEntryText(currentText);
                    } else {
                        this._host.setEntryText(`${tool.command} ${currentText}`);
                    }
                    this.hide();
                    this._host.focusPrompt();
                    this._host.placeCursorAtEnd();
                });

                return row;
            };

            // ── Primary tools ────────────────────────────────────────
            for (const tool of primaryTools) {
                this._rows.add_child(buildRow(tool));
            }

            // ── "More Tools:" section ────────────────────────────────
            if (hasSeparator) {
                const moreHeader = new St.Label({
                    text: 'More Tools:',
                    style_class: 'katab-tools-popup-section-header',
                    x_expand: true,
                });
                this._rows.add_child(moreHeader);

                for (const tool of moreTools) {
                    this._rows.add_child(buildRow(tool));
                }
            }

            // Full rebuild may change popup dimensions — reposition.
            if (this._popup?.visible) {
                if (this._repositionId) GLib.source_remove(this._repositionId);
                this._repositionId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                    this._repositionId = 0;
                    this.position();
                    return GLib.SOURCE_REMOVE;
                });
            }
        } else {
            // In-place patch: update mode labels without destroying rows
            for (const tool of tools) {
                if (this._host.isModeControlledTool(tool.toolName)) {
                    this._patchMode(tool.toolName);
                }
            }
        }
    }

    // Update a single tool's mode label and styling in-place.
    _patchMode(toolName) {
        const refs = this._modeLabels?.[toolName];
        if (!refs) return;

        const mode = this._host.getToolMode(toolName);
        const isDeepResearch = toolName === DEEP_RESEARCH_TOOL_NAME;
        const labels = isDeepResearch ? DEEP_RESEARCH_MODE_LABELS : TOOL_MODE_LABELS;
        const defaultLabel = isDeepResearch
            ? DEEP_RESEARCH_MODE_LABELS[TOOL_MODE_OFF]
            : TOOL_MODE_LABELS[TOOL_MODE_AUTO];
        const text = labels[mode] || defaultLabel;

        refs.label.set_text(text);

        // Swap style classes on the wrapper
        ['katab-tools-mode-auto', 'katab-tools-mode-on', 'katab-tools-mode-off'].forEach((c) => {
            refs.wrap.remove_style_class_name(c);
        });
        refs.wrap.add_style_class_name(`katab-tools-mode-${mode}`);
    }

    _build() {
        const popup = new St.BoxLayout({
            vertical: true,
            style_class: 'katab-tools-popup',
            visible: false,
            reactive: true,
            can_focus: true,
        });

        // Header
        const header = new St.BoxLayout({
            vertical: false,
            style_class: 'katab-tools-popup-header',
        });
        const title = new St.Label({
            text: 'Tools',
            style_class: 'katab-tools-popup-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        header.add_child(title);
        const closeBtn = new St.Button({
            child: new St.Icon({
                icon_name: 'window-close-symbolic',
                style_class: 'katab-tools-popup-close-icon',
            }),
            style_class: 'katab-tools-popup-close-btn',
            can_focus: true,
        });
        closeBtn.connect('clicked', () => this.hide());
        header.add_child(closeBtn);
        popup.add_child(header);

        // Tool rows container — rebuilt by refresh()
        this._rows = new St.BoxLayout({
            vertical: true,
            style_class: 'katab-tools-popup-rows',
        });
        popup.add_child(this._rows);

        // Hover on the popup cancels pending leave timeout
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
