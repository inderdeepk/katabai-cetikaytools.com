// Katab AI — chat message bubbles. Builds the per-message frame that every
// user prompt and assistant reply is rendered into: the row + bubble shell,
// sender label, thinking section, tool-call log, content box, footer row
// (copy / regenerate / metrics), cache-savings + knowledge-base pills and
// their drawers, attachment chips, and the diagnostic box. The assistant
// render pipeline itself (markdown segments, citations, sources) stays in
// extension.js and is reached through the host bag.
//
// Extracted from extension.js (analysis item #4). The dialog keeps thin
// wrappers (`_addChatMessage`, `_scrollToBottom`, `_applyAssistantMetrics`,
// `_isDisposedWidgetError`) and a `_buildBubblesHost()` bag for everything
// the builders need back from the dialog.
//
// NOTE (a11y): on GNOME 46 accessibility roles are exposed via `Atk.Role`
// (`Atk.Role.PUSH_BUTTON`). `Clutter.AccessibleRole` is a mutter 47+ API —
// referencing it on 46 throws a TypeError at widget construction and takes
// the whole send flow down with it. Keep the Atk form.
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Atk from 'gi://Atk';

import { createRagGicon } from '../tools/ragTools.js';

/**
 * Builds chat message bubbles and the small widgets inside them.
 *
 * Host bag contract:
 *   isOpen(), getChatScroll(), getMessageContainer(), getChatGeneration(),
 *   getExtensionPath(), hasSessionDocument(path),
 *   getMessageAttachments(messageMeta), getAttachmentKind(attachment),
 *   makeTextSelectable(label), applyAssistantRender(uiElements, text, options),
 *   applyCacheSavings(uiElements, messageMeta),
 *   formatAssistantMetrics(messageMeta), regenerateResponse()
 */
export class MessageBubble {
    constructor(host) {
        this._host = host;
    }

    applyAssistantMetrics(label, messageMeta, footerRow = null) {
        if (!label || !this._host.isOpen()) {
            return;
        }

        let summary = this._host.formatAssistantMetrics(messageMeta);
        label.set_text(summary);
        label.visible = Boolean(summary);

        if (footerRow) {
            footerRow.visible = Boolean(footerRow._katabHasReplyCopy) || label.visible;
        }
    }

    isDisposedWidgetError(e) {
        if (!e) return false;
        return /already disposed/i.test(String(e?.message || e || ''));
    }

    buildMessage(sender, text, type, messageMeta = null) {
        let isUser = type === 'user';

        let rowBox = new St.BoxLayout({
            vertical: false,
            style_class: 'katab-chat-row',
            x_expand: true,
        });

        let bubbleBox = new St.BoxLayout({
            vertical: true,
            style_class: isUser ? 'katab-chat-bubble user' : 'katab-chat-bubble assistant',
        });

        let senderLabel = new St.Label({
            text: sender,
            style_class: 'katab-chat-sender-label',
        });
        bubbleBox.add_child(senderLabel);

        const { thinkWrapper, thinkLabel } = this._buildThinkingSection();
        bubbleBox.add_child(thinkWrapper);

        const { toolLogWrapper, toolCallLogBox, toolLogCountLabel } =
            this._buildToolLogSection(isUser);
        if (toolLogWrapper) bubbleBox.add_child(toolLogWrapper);

        let contentBox = new St.BoxLayout({
            vertical: true,
            style_class: 'katab-chat-content-box',
            x_expand: true,
        });
        bubbleBox.add_child(contentBox);

        let contentLabel = new St.Label({
            text: '',
            style_class: 'katab-chat-content-label',
            x_expand: true,
        });
        contentLabel.clutter_text.line_wrap = true;
        contentLabel.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        contentLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        contentLabel.clutter_text.single_line_mode = false;
        contentLabel.clutter_text.can_focus = false;
        if (isUser) {
            this._host.makeTextSelectable(contentLabel);
            contentBox.add_child(contentLabel);
        }

        let copyBtnRow = new St.BoxLayout({
            vertical: false,
            style_class: 'katab-message-footer-row',
            x_expand: true,
            x_align: isUser ? Clutter.ActorAlign.END : Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER,
            visible: isUser,
        });
        copyBtnRow._katabHasReplyCopy = false;
        copyBtnRow._katabCopyText = String(text ?? '');
        if (isUser) {
            let copyBtn = new St.Button({
                label: 'Copy message',
                style_class: 'katab-copy-btn katab-copy-btn-text',
                y_align: Clutter.ActorAlign.CENTER,
                accessible_name: 'Copy message to clipboard',
            });
            copyBtn.connect('clicked', () => {
                let txt = contentLabel.get_text();
                St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, txt);
            });
            copyBtnRow.add_child(copyBtn);
        } else {
            let replyCopyBtn = new St.Button({
                label: 'Copy message',
                style_class: 'katab-copy-btn katab-copy-btn-text',
                y_align: Clutter.ActorAlign.CENTER,
                accessible_name: 'Copy message to clipboard',
            });
            replyCopyBtn.connect('clicked', () => {
                let txt = copyBtnRow._katabCopyText ?? '';
                St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, txt);
            });
            copyBtnRow._katabHasReplyCopy = true;
            copyBtnRow.visible = true;
            copyBtnRow.add_child(replyCopyBtn);

            let regenerateBtn = new St.Button({
                label: 'Regenerate',
                style_class: 'katab-copy-btn katab-copy-btn-text',
                y_align: Clutter.ActorAlign.CENTER,
                accessible_name: 'Regenerate response',
            });
            regenerateBtn.connect('clicked', () => {
                this._host.regenerateResponse();
            });
            copyBtnRow.add_child(regenerateBtn);
        }

        let metricsLabel = new St.Label({
            text: '',
            style_class: 'katab-message-token-label',
            visible: false,
            y_align: Clutter.ActorAlign.CENTER,
        });
        copyBtnRow.add_child(metricsLabel);

        const pills = this._buildAssistantPills(isUser, copyBtnRow);
        const {
            cacheSavingsPill,
            cacheSavingsPillLabel,
            cacheSavingsChevron,
            kbPill,
            kbPillIcon,
            kbPillLabel,
            kbChevron,
            kbDrawer,
            kbDrawerBody,
        } = pills;

        if (!isUser) {
            this.applyAssistantMetrics(metricsLabel, messageMeta, copyBtnRow);
        }

        // Push copy btn to right if user, otherwise keep it left and tokens right
        if (isUser) {
            copyBtnRow.set_pack_start(true);
        }

        const { cacheSavingsDrawer, cacheSavingsDrawerBody } = this._buildCacheSavingsDrawer(
            isUser,
            messageMeta,
            pills,
        );

        let linkBox = null;
        let sourcesBox = null;
        let diagnosticBox = null;
        let diagnosticLabel = null;
        if (!isUser) {
            linkBox = new St.BoxLayout({
                vertical: true,
                style_class: 'katab-chat-link-list',
                x_expand: true,
                visible: false,
            });
            bubbleBox.add_child(linkBox);

            sourcesBox = new St.BoxLayout({
                vertical: true,
                style_class: 'katab-chat-sources-box',
                x_expand: true,
                visible: false,
            });
            bubbleBox.add_child(sourcesBox);

            diagnosticBox = new St.BoxLayout({
                vertical: true,
                style_class: 'katab-error-box',
                x_expand: true,
                visible: false,
            });

            let diagnosticTitle = new St.Label({
                text: 'Diagnostic Details',
                style_class: 'katab-error-title',
                x_expand: true,
            });
            diagnosticBox.add_child(diagnosticTitle);

            diagnosticLabel = new St.Label({
                text: '',
                style_class: 'katab-error-details-label',
                x_expand: true,
            });
            diagnosticLabel.clutter_text.line_wrap = true;
            diagnosticLabel.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
            diagnosticLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            diagnosticLabel.clutter_text.single_line_mode = false;
            diagnosticLabel.clutter_text.can_focus = false;
            this._host.makeTextSelectable(diagnosticLabel);
            diagnosticBox.add_child(diagnosticLabel);

            bubbleBox.add_child(diagnosticBox);

            // Footer row + cache drawer — added last so link chips and
            // sources sit between the message body and the action bar.
            bubbleBox.add_child(copyBtnRow);
            bubbleBox.add_child(cacheSavingsDrawer);
            if (kbDrawer) {
                bubbleBox.add_child(kbDrawer);
            }
        }

        // User messages: attach the footer row (containing the copy button)
        // so it renders for user prompts as well as assistant replies.
        if (isUser) {
            bubbleBox.add_child(copyBtnRow);
        }

        let spacer = new St.Widget({ x_expand: true });
        if (isUser) {
            rowBox.add_child(spacer);
            rowBox.add_child(bubbleBox);
        } else {
            rowBox.add_child(bubbleBox);
            rowBox.add_child(spacer);
        }

        try {
            this._host.getMessageContainer().add_child(rowBox);
        } catch (_e) {
            if (!this.isDisposedWidgetError(_e)) throw _e;
            // The chat was torn down while this message was being built — the
            // bubble simply won't be displayed. Its widgets are still alive, so
            // later renders into them are harmless.
        }

        if (isUser) {
            contentLabel.set_text(text);
            const msgAttachments = this._host.getMessageAttachments(messageMeta);
            if (msgAttachments.length > 0) {
                const showMissingNotice = Boolean(messageMeta?._showMissingAttachmentNotice);
                const fileRow = new St.BoxLayout({
                    vertical: true,
                    style_class: 'katab-msg-file-row',
                });
                for (const attachment of msgAttachments) {
                    const isMissing =
                        showMissingNotice && attachment?.path
                            ? !this._host.hasSessionDocument(attachment.path)
                            : false;
                    const attachmentKind = this._host.getAttachmentKind(attachment);
                    const isImage = attachmentKind === 'image';
                    let chipClass = 'katab-msg-file-chip';
                    if (isImage) chipClass += ' image';
                    if (isMissing) chipClass += ' missing';
                    const chip = new St.BoxLayout({
                        style_class: chipClass,
                        y_align: Clutter.ActorAlign.CENTER,
                    });
                    let iconClass = 'katab-msg-file-chip-icon';
                    if (isImage) iconClass += ' image';
                    if (isMissing) iconClass += ' missing';
                    const chipIcon = new St.Icon({
                        icon_name: isImage ? 'image-x-generic-symbolic' : 'text-x-generic-symbolic',
                        style_class: iconClass,
                    });
                    chip.add_child(chipIcon);
                    let labelClass = 'katab-msg-file-chip-label';
                    if (isMissing) labelClass += ' missing';
                    const chipLabel = new St.Label({
                        text: attachment.displayName || '',
                        style_class: labelClass,
                        y_align: Clutter.ActorAlign.CENTER,
                    });
                    chipLabel.clutter_text.ellipsize = Pango.EllipsizeMode.MIDDLE;
                    chipLabel.clutter_text.single_line_mode = true;
                    chip.add_child(chipLabel);
                    fileRow.add_child(chip);
                    if (isMissing) {
                        const warnLabel = new St.Label({
                            text: isImage
                                ? 'Reattach this image to include it in a new request.'
                                : 'Reattach this file to include it in a new request.',
                            style_class: 'katab-reattach-warning',
                            x_expand: true,
                        });
                        warnLabel.clutter_text.line_wrap = true;
                        warnLabel.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
                        warnLabel.clutter_text.single_line_mode = false;
                        fileRow.add_child(warnLabel);
                    }
                }
                contentBox.add_child(fileRow);
            }
        } else {
            this._host.applyAssistantRender(
                {
                    contentBox,
                    linkBox,
                    sourcesBox,
                    diagnosticBox,
                    diagnosticLabel,
                    footerRow: copyBtnRow,
                },
                text,
                { final: true },
            );
        }

        this.scrollToBottom();

        const uiElements = {
            contentBox,
            contentLabel,
            thinkLabel,
            thinkWrapper,
            toolCallLogBox,
            toolLogWrapper,
            toolLogCountLabel,
            linkBox,
            sourcesBox,
            diagnosticBox,
            diagnosticLabel,
            metricsLabel,
            cacheSavingsPill,
            cacheSavingsPillLabel,
            cacheSavingsChevron,
            cacheSavingsDrawer,
            cacheSavingsDrawerBody,
            kbPill,
            kbPillIcon,
            kbPillLabel,
            kbChevron,
            kbDrawer,
            kbDrawerBody,
            footerRow: copyBtnRow,
        };
        // Tag the bubble with the chat generation it was created in, so
        // in-flight async renders can detect when the chat was rebuilt and
        // skip touching the disposed widgets.
        uiElements._katabChatGen = this._host.getChatGeneration();
        return uiElements;
    }

    _buildAssistantPills(isUser, copyBtnRow) {
        // ── DeepSeek prompt-cache savings pill (assistant only) ──────────────
        // Sits quietly at the end of the footer row and only appears when a reply
        // actually reused cached tokens. Clicking it reveals the explanation
        // drawer built just below the footer row (see further down).
        let cacheSavingsPill = null;
        let cacheSavingsPillLabel = null;
        let cacheSavingsChevron = null;
        if (!isUser) {
            cacheSavingsPill = new St.BoxLayout({
                style_class: 'katab-cache-pill',
                y_align: Clutter.ActorAlign.CENTER,
                reactive: true,
                can_focus: true,
                track_hover: true,
                visible: false,
                accessible_name: 'Cache savings details',
                accessible_role: Atk.Role.PUSH_BUTTON,
            });
            cacheSavingsPill.add_child(
                new St.Icon({
                    icon_name: 'emblem-ok-symbolic',
                    style_class: 'katab-cache-pill-icon',
                    y_align: Clutter.ActorAlign.CENTER,
                }),
            );
            cacheSavingsPillLabel = new St.Label({
                text: '',
                style_class: 'katab-cache-pill-label',
                y_align: Clutter.ActorAlign.CENTER,
            });
            cacheSavingsPill.add_child(cacheSavingsPillLabel);
            cacheSavingsChevron = new St.Icon({
                icon_name: 'pan-end-symbolic',
                style_class: 'katab-cache-pill-chevron',
                y_align: Clutter.ActorAlign.CENTER,
            });
            cacheSavingsPill.add_child(cacheSavingsChevron);
            copyBtnRow.add_child(cacheSavingsPill);
        }

        // ── Knowledge Base usage pill (assistant only) ───────────────────
        // Small glowing teal pill that replaces the KB rows in the tool-call
        // log. Clicking it reveals the KB drawer built below the footer row.
        let kbPill = null;
        let kbPillIcon = null;
        let kbPillLabel = null;
        let kbChevron = null;
        let kbDrawer = null;
        let kbDrawerBody = null;
        if (!isUser) {
            kbPill = new St.BoxLayout({
                style_class: 'katab-kb-pill',
                y_align: Clutter.ActorAlign.CENTER,
                reactive: true,
                can_focus: true,
                track_hover: true,
                visible: false,
                accessible_name: 'Knowledge base usage',
                accessible_role: Atk.Role.PUSH_BUTTON,
            });
            kbPillIcon = new St.Icon({
                gicon: createRagGicon(this._host.getExtensionPath()),
                style_class: 'katab-kb-pill-icon',
                y_align: Clutter.ActorAlign.CENTER,
            });
            kbPill.add_child(kbPillIcon);
            kbPillLabel = new St.Label({
                text: 'KB',
                style_class: 'katab-kb-pill-label',
                y_align: Clutter.ActorAlign.CENTER,
            });
            kbPill.add_child(kbPillLabel);
            kbChevron = new St.Icon({
                icon_name: 'pan-end-symbolic',
                style_class: 'katab-kb-pill-chevron',
                y_align: Clutter.ActorAlign.CENTER,
            });
            kbPill.add_child(kbChevron);
            copyBtnRow.add_child(kbPill);

            kbDrawer = new St.BoxLayout({
                vertical: true,
                style_class: 'katab-kb-drawer',
                x_expand: true,
                visible: false,
            });
            kbDrawerBody = new St.BoxLayout({
                vertical: true,
                style_class: 'katab-kb-drawer-body',
                x_expand: true,
            });
            kbDrawer.add_child(kbDrawerBody);

            kbPill.connect('button-press-event', () => {
                const show = !kbDrawer.visible;
                kbDrawer.visible = show;
                kbChevron.icon_name = show ? 'pan-down-symbolic' : 'pan-end-symbolic';
                if (show) {
                    kbPill.add_style_class_name('katab-kb-pill-expanded');
                } else {
                    kbPill.remove_style_class_name('katab-kb-pill-expanded');
                }
                this.scrollToBottom();
                return Clutter.EVENT_STOP;
            });
        }

        return {
            cacheSavingsPill,
            cacheSavingsPillLabel,
            cacheSavingsChevron,
            kbPill,
            kbPillIcon,
            kbPillLabel,
            kbChevron,
            kbDrawer,
            kbDrawerBody,
        };
    }

    _buildCacheSavingsDrawer(
        isUser,
        messageMeta,
        { cacheSavingsPill, cacheSavingsPillLabel, cacheSavingsChevron },
    ) {
        // Explanation drawer for the cache-savings pill (assistant only). Hidden
        // until the pill is clicked; contents are (re)built by _applyCacheSavings.
        let cacheSavingsDrawer = null;
        let cacheSavingsDrawerBody = null;
        if (!isUser) {
            cacheSavingsDrawer = new St.BoxLayout({
                vertical: true,
                style_class: 'katab-cache-drawer',
                x_expand: true,
                visible: false,
            });
            cacheSavingsDrawerBody = new St.BoxLayout({
                vertical: true,
                style_class: 'katab-cache-drawer-body',
                x_expand: true,
            });
            cacheSavingsDrawer.add_child(cacheSavingsDrawerBody);

            cacheSavingsPill.connect('button-press-event', () => {
                let show = !cacheSavingsDrawer.visible;
                cacheSavingsDrawer.visible = show;
                cacheSavingsChevron.icon_name = show ? 'pan-down-symbolic' : 'pan-end-symbolic';
                if (show) {
                    cacheSavingsPill.add_style_class_name('katab-cache-pill-expanded');
                } else {
                    cacheSavingsPill.remove_style_class_name('katab-cache-pill-expanded');
                }
                this.scrollToBottom();
                return Clutter.EVENT_STOP;
            });

            // Populate immediately for messages restored from history (metrics
            // are present up front); live replies fill this in during streaming.
            this._host.applyCacheSavings(
                {
                    cacheSavingsPill,
                    cacheSavingsPillLabel,
                    cacheSavingsChevron,
                    cacheSavingsDrawer,
                    cacheSavingsDrawerBody,
                },
                messageMeta,
            );
        }

        return { cacheSavingsDrawer, cacheSavingsDrawerBody };
    }

    _buildToolLogSection(isUser) {
        let toolCallLogBox = null;
        let toolLogWrapper = null;
        let toolLogCountLabel = null;
        if (!isUser) {
            toolLogWrapper = new St.BoxLayout({
                vertical: true,
                style_class: 'katab-tool-call-log',
                visible: false,
                x_expand: true,
            });

            // Summary header — always visible when tool log is shown, click to expand/collapse
            let toolLogHeader = new St.BoxLayout({
                style_class: 'katab-tool-call-group-header',
                reactive: true,
                can_focus: true,
                track_hover: true,
                x_expand: true,
                accessible_name: 'Show tool details',
            });
            toolLogHeader.add_child(
                new St.Icon({
                    icon_name: 'applications-utilities-symbolic',
                    style_class: 'katab-tool-call-name',
                    icon_size: 14,
                    y_align: Clutter.ActorAlign.CENTER,
                }),
            );
            toolLogCountLabel = new St.Label({
                text: 'Ran 0 tools',
                style_class: 'katab-tool-call-group-label',
                y_align: Clutter.ActorAlign.CENTER,
            });
            toolLogHeader.add_child(toolLogCountLabel);
            let toolLogChevron = new St.Icon({
                icon_name: 'pan-end-symbolic',
                style_class: 'katab-tool-call-group-chevron',
                y_align: Clutter.ActorAlign.CENTER,
            });
            toolLogHeader.add_child(toolLogChevron);
            toolLogWrapper.add_child(toolLogHeader);

            // Body — collapsed by default, holds the individual tool-call entry widgets
            toolCallLogBox = new St.BoxLayout({
                vertical: true,
                style_class: 'katab-tool-call-group-body',
                visible: false,
                x_expand: true,
            });
            toolLogWrapper.add_child(toolCallLogBox);

            toolLogHeader.connect('button-press-event', () => {
                let expanded = toolCallLogBox.visible;
                toolCallLogBox.visible = !expanded;
                toolLogChevron.icon_name = expanded ? 'pan-end-symbolic' : 'pan-down-symbolic';
                toolLogHeader.accessible_name = expanded
                    ? 'Show tool details'
                    : 'Hide tool details';
                if (expanded) {
                    toolLogWrapper.add_style_class_name('katab-tool-call-group-collapsed');
                } else {
                    toolLogWrapper.remove_style_class_name('katab-tool-call-group-collapsed');
                }
                return Clutter.EVENT_STOP;
            });
        }
        return { toolLogWrapper, toolCallLogBox, toolLogCountLabel };
    }

    _buildThinkingSection() {
        let thinkWrapper = new St.BoxLayout({
            vertical: true,
            style_class: 'katab-think-wrapper',
            visible: false,
            x_expand: true,
        });

        // ── Thinking header bar ─────────────────────────────────────────
        let thinkHeader = new St.BoxLayout({
            vertical: false,
            style_class: 'katab-think-header',
            x_expand: true,
        });

        let thinkIcon = new St.Icon({
            gicon: Gio.icon_new_for_string(
                `${this._host.getExtensionPath()}/icons/katab-lightbulb-symbolic.svg`,
            ),
            style_class: 'katab-think-icon',
        });
        thinkHeader.add_child(thinkIcon);

        let thinkTitle = new St.Label({
            text: 'Thinking',
            style_class: 'katab-think-title',
        });
        thinkHeader.add_child(thinkTitle);

        let thinkButton = new St.Button({
            label: 'Show',
            style_class: 'katab-think-toggle-btn',
            toggle_mode: true,
            can_focus: true,
            accessible_name: 'Show reasoning',
        });
        thinkHeader.add_child(thinkButton);

        thinkWrapper.add_child(thinkHeader);

        // ── Thinking content body ───────────────────────────────────────
        let thinkBody = new St.BoxLayout({
            vertical: true,
            style_class: 'katab-think-body',
            visible: false,
            x_expand: true,
        });

        let thinkLabel = new St.Label({
            text: '',
            style_class: 'katab-think-label',
            visible: true,
            x_expand: true,
        });
        thinkLabel.clutter_text.line_wrap = true;
        thinkLabel.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        thinkLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        thinkLabel.clutter_text.single_line_mode = false;
        thinkLabel.clutter_text.can_focus = false;
        this._host.makeTextSelectable(thinkLabel);
        thinkBody.add_child(thinkLabel);

        thinkWrapper.add_child(thinkBody);

        thinkButton.connect('notify::checked', () => {
            thinkBody.visible = thinkButton.checked;
            thinkButton.label = thinkButton.checked ? 'Hide' : 'Show';
            thinkButton.accessible_name = thinkButton.checked ? 'Hide reasoning' : 'Show reasoning';
            if (thinkButton.checked) {
                thinkWrapper.add_style_class_name('katab-think-wrapper-expanded');
            } else {
                thinkWrapper.remove_style_class_name('katab-think-wrapper-expanded');
            }
        });

        return { thinkWrapper, thinkLabel };
    }

    scrollToBottom() {
        GLib.idle_add(GLib.PRIORITY_LOW, () => {
            if (!this._host.isOpen() || !this._host.getChatScroll()) {
                return GLib.SOURCE_REMOVE;
            }
            let adj = this._host.getChatScroll().get_vscroll_bar().get_adjustment();
            adj.value = adj.upper - adj.page_size;
            return GLib.SOURCE_REMOVE;
        });
    }
}
