/* extension.js
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 2 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const PROVIDER_TOOLS = {
    'unsloth': [
        { label: 'Web Search', command: '/search', icon: 'system-search-symbolic', toolName: 'web_search' },
        { label: 'Python', command: '/python', icon: 'applications-development-symbolic', toolName: 'python' },
        { label: 'Terminal', command: '/terminal', icon: 'utilities-terminal-symbolic', toolName: 'terminal' }
    ],
    'ollama': [
        { label: 'Calculator', command: '/calc', icon: 'accessories-calculator-symbolic', toolName: 'dummy_calculator' }
    ],
    'openai': [],
    'anthropic': []
};

class HistoryManager {
    static get filePath() {
        return GLib.build_filenamev([
            GLib.get_user_data_dir(), 'katabai', 'history.json'
        ]);
    }

    static ensureDir() {
        let dir = Gio.File.new_for_path(
            GLib.build_filenamev([GLib.get_user_data_dir(), 'katabai'])
        );
        try {
            dir.make_directory_with_parents(null);
        } catch (_e) {
            // already exists
        }
    }

    static load() {
        try {
            let file = Gio.File.new_for_path(this.filePath);
            let [, bytes] = file.load_contents(null);
            return JSON.parse(new TextDecoder('utf-8').decode(bytes));
        } catch (_e) {
            return [];
        }
    }

    static save(arr) {
        try {
            this.ensureDir();
            let file = Gio.File.new_for_path(this.filePath);
            let data = new TextEncoder().encode(JSON.stringify(arr, null, 2));
            file.replace_contents(data, null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        } catch (e) {
            log(`Katab: failed to save history: ${e.message}`);
        }
    }

    static saveConversation(messageHistory, existingId = null) {
        let userMsgs = messageHistory.filter(m => m.role === 'user');
        if (userMsgs.length === 0) return null;

        let title = userMsgs[0].content.slice(0, 60);
        if (userMsgs[0].content.length > 60) title += '…';

        let id = existingId || `conv_${Date.now()}`;
        let entry = {
            id: id,
            title: title,
            timestamp: Math.floor(Date.now() / 1000),
            messages: [...messageHistory],
        };

        let arr = this.load();
        if (existingId) {
            arr = arr.filter(e => e.id !== existingId);
        }
        arr.unshift(entry);
        if (arr.length > 50) arr.length = 50;
        this.save(arr);
        return id;
    }

    static deleteConversation(id) {
        let arr = this.load().filter(e => e.id !== id);
        this.save(arr);
    }
}

class KatabDialog {
    constructor(extension) {
        this._extension = extension;
        this._settings = extension.getSettings('org.gnome.shell.extensions.katabai');
        this._currentProvider = this._settings.get_string('provider');
        this._currentConversationId = null;

        this._settings.connect('changed::provider', () => {
            this._currentProvider = this._settings.get_string('provider');
            this._addSystemMessage(`Switched engine to ${this._currentProvider === 'ollama' ? 'Ollama (Local)' : this._currentProvider === 'unsloth' ? 'Unsloth Studio' : this._currentProvider}.`);
            if (this._toolsBox) this._updateToolButtons();

            // Re-fetch context size when switching providers
            this._maxContextSize = 0;
            this._fetchMaxContext();
        });

        this._monitorChangedId = 0;
        this.isOpen = false;
        this._messageHistory = [];
        this._soupSession = new Soup.Session();
        this._soupSession.timeout = 30; // 30 seconds
        this._cancellable = null;

        this._maxContextSize = 0;
        this._currentUsage = 0;
        this._draftUsage = 0;
        this._tokenUpdateTimeout = 0;

        this.actor = new St.Widget({
            style_class: 'katab-shell-overlay',
            reactive: true,
            can_focus: true,
            visible: false,
            x_expand: true,
            y_expand: true,
            layout_manager: new Clutter.BinLayout(),
        });

        this.dialogLayout = new St.BoxLayout({
            vertical: true,
            style_class: 'katab-dialog-container',
            reactive: true,
            can_focus: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.actor.add_child(this.dialogLayout);

        this.contentLayout = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_expand: true,
        });
        this.dialogLayout.add_child(this.contentLayout);

        this.actor.connect('button-press-event', (_actor, event) => {
            if (event.get_source() === this.actor) {
                this.close();
                return Clutter.EVENT_STOP;
            }

            return Clutter.EVENT_PROPAGATE;
        });
        this.actor.connect('key-press-event', (_actor, event) => this._handleKeyPress(event));

        this._monitorChangedId = Main.layoutManager.connect('monitors-changed', () => {
            if (this.isOpen) {
                this._syncGeometry();
            }
        });
        this._syncGeometry();

        this._buildUI();
    }

    _syncGeometry() {
        let monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;

        this.actor.set_position(monitor.x, monitor.y);
        this.actor.set_size(monitor.width, monitor.height);
    }

    _handleKeyPress(event) {
        let symbol = event.get_key_symbol();
        if (symbol === Clutter.KEY_Escape) {
            this.close();
            return Clutter.EVENT_STOP;
        }

        return Clutter.EVENT_PROPAGATE;
    }

    _releasePromptFocus() {
        if (!this._entry || !this._entry.clutter_text) {
            return;
        }

        let keyFocus = global.stage.get_key_focus();
        if (keyFocus !== this._entry && keyFocus !== this._entry.clutter_text) {
            return;
        }

        if (this.dialogLayout && this.dialogLayout.can_focus) {
            this.dialogLayout.grab_key_focus();
        }
    }

    _updateToolButtons() {
        if (!this._toolsBox) return;
        this._toolsBox.destroy_all_children();

        const tools = PROVIDER_TOOLS[this._currentProvider] || [];
        for (const tool of tools) {
            let btn = new St.Button({
                child: new St.Icon({
                    icon_name: tool.icon,
                    style_class: 'katab-tool-icon',
                }),
                style_class: 'katab-tool-btn',
                can_focus: true,
                x_expand: false,
                y_expand: false,
                y_align: Clutter.ActorAlign.CENTER,
            });
            btn.connect('clicked', () => {
                let currentText = this._entry.get_text().trim();
                // Add the slash command, appending to existing text if any, or just starting it
                if (currentText && !currentText.includes(tool.command)) {
                    this._entry.set_text(currentText + ' ' + tool.command + ' ');
                } else {
                    this._entry.set_text(tool.command + ' ');
                }
                this._entry.grab_key_focus();
                // move cursor to end
                this._entry.clutter_text.set_cursor_position(-1);
            });
            this._toolsBox.add_child(btn);
        }
    }

    _buildUI() {

        let headerBox = new St.BoxLayout({
            vertical: false,
            style_class: 'katab-header-box',
        });
        this.contentLayout.add_child(headerBox);

        let titleWrapper = new St.BoxLayout({
            style_class: 'katab-title-wrapper',
            y_align: Clutter.ActorAlign.CENTER,
        });
        headerBox.add_child(titleWrapper);

        let logoGicon = Gio.icon_new_for_string(`${this._extension.path}/icons/katab-logo.svg`);
        let logoIcon = new St.Icon({
            gicon: logoGicon,
            style_class: 'katab-logo-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        titleWrapper.add_child(logoIcon);

        let titleLabel = new St.Label({
            text: 'Katab AI',
            style_class: 'katab-title-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        titleWrapper.add_child(titleLabel);

        let headerSpacer = new St.Widget({
            x_expand: true,
            y_expand: true,
        });
        headerBox.add_child(headerSpacer);

        let historyBtn = new St.Button({
            child: new St.Icon({
                icon_name: 'document-open-recent-symbolic',
                style_class: 'katab-history-icon',
            }),
            style_class: 'katab-history-btn',
            can_focus: true,
            reactive: true,
        });
        historyBtn.connect('clicked', () => this._toggleHistoryView());
        headerBox.add_child(historyBtn);

        let newChatBtn = new St.Button({
            child: new St.Icon({
                icon_name: 'document-new-symbolic',
                style_class: 'katab-new-chat-icon',
            }),
            style_class: 'katab-new-chat-btn',
            can_focus: true,
        });
        newChatBtn.connect('clicked', () => this._newChat());
        headerBox.add_child(newChatBtn);

        let settingsBtn = new St.Button({
            child: new St.Icon({
                icon_name: 'emblem-system-symbolic',
                style_class: 'katab-settings-icon',
            }),
            style_class: 'katab-settings-btn',
            can_focus: true,
        });
        headerBox.add_child(settingsBtn);

        settingsBtn.connect('clicked', () => {
            this._extension.openPreferences();
            this.close();
        });

        let closeBtn = new St.Button({
            child: new St.Icon({
                icon_name: 'window-close-symbolic',
                style_class: 'katab-close-icon',
            }),
            style_class: 'katab-close-btn',
            can_focus: true,
        });
        closeBtn.connect('clicked', () => this.close());
        headerBox.add_child(closeBtn);

        this._chatScroll = new St.ScrollView({
            style_class: 'katab-chat-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            x_expand: true,
            y_expand: true,
        });
        this.contentLayout.add_child(this._chatScroll);

        this._chatContainer = new St.BoxLayout({
            vertical: true,
            style_class: 'katab-chat-container',
        });
        this._chatScroll.add_child(this._chatContainer);

        // History view (hidden by default)
        this._historyView = new St.ScrollView({
            style_class: 'katab-history-view',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            x_expand: true,
            y_expand: true,
            visible: false,
        });
        this.contentLayout.add_child(this._historyView);

        this._historyContainer = new St.BoxLayout({
            vertical: true,
            style_class: 'katab-history-container',
        });
        this._historyView.add_child(this._historyContainer);

        this._footerBox = new St.BoxLayout({
            style_class: 'katab-footer-box',
            vertical: false,
        });
        this.contentLayout.add_child(this._footerBox);
        let footerBox = this._footerBox;

        // Add the token indicator to the footer Box
        this._tokenBox = new St.BoxLayout({
            vertical: true,
            style_class: 'katab-token-box',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false // hide by default until context limit is known
        });

        this._tokenLabel = new St.Label({
            text: '0 / 0',
            style_class: 'katab-token-label',
            x_align: Clutter.ActorAlign.CENTER
        });
        this._tokenBox.add_child(this._tokenLabel);

        this._tokenProgressWrap = new St.Widget({
            style_class: 'katab-token-progress',
            layout_manager: new Clutter.BinLayout(),
        });
        this._tokenProgressFill = new St.Widget({
            style_class: 'katab-token-progress-fill',
            x_align: Clutter.ActorAlign.START,
            width: 0,
        });
        this._tokenProgressWrap.add_child(this._tokenProgressFill);
        this._tokenBox.add_child(this._tokenProgressWrap);

        footerBox.add_child(this._tokenBox);

        this._entry = new St.Entry({
            hint_text: 'Ask Katab (Punjabi book of knowledge)...',
            style_class: 'katab-prompt-entry',
            can_focus: true,
            x_expand: true,
        });
        footerBox.add_child(this._entry);

        this._toolsBox = new St.BoxLayout({
            style_class: 'katab-tools-box',
            vertical: false,
        });
        footerBox.add_child(this._toolsBox);

        this._entry.clutter_text.connect('text-changed', () => {
            if (this._tokenUpdateTimeout) {
                GLib.source_remove(this._tokenUpdateTimeout);
            }
            this._tokenUpdateTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
                this._updateDraftTokenCount();
                this._tokenUpdateTimeout = 0;
                return GLib.SOURCE_REMOVE;
            });
        });

        this._entry.clutter_text.connect('key-press-event', (_actor, event) => {
            let symbol = event.get_key_symbol();
            if (symbol === Clutter.KEY_Escape) {
                this.close();
                return Clutter.EVENT_STOP;
            }

            if (symbol === Clutter.KEY_Return || symbol === Clutter.KEY_KP_Enter) {
                this._sendMessage();
                return Clutter.EVENT_STOP;
            }

            return Clutter.EVENT_PROPAGATE;
        });

        let sendBtn = new St.Button({
            child: new St.Icon({
                icon_name: 'mail-send-symbolic',
                style_class: 'katab-send-icon',
            }),
            style_class: 'katab-send-btn',
            can_focus: true,
        });
        sendBtn.connect('clicked', () => this._sendMessage());
        footerBox.add_child(sendBtn);

        this._addWelcomeMessage();
        this._updateToolButtons();
    }

    open() {
        if (this.isOpen) return true;

        if (!this.actor.get_parent()) {
            Main.layoutManager.addTopChrome(this.actor, { trackFullscreen: true });
        }
        this._syncGeometry();
        this.actor.show();

        this.isOpen = true;

        this._fetchMaxContext();

        // A slight timeout is often needed in GNOME Shell to reliably grab focus
        // after opening a window/overlay.
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            if (this.isOpen && this._entry) {
                this._entry.grab_key_focus();
            }
            return GLib.SOURCE_REMOVE;
        });

        return true;
    }

    close() {
        if (!this.isOpen) return;

        this._cancelStream();
        this._saveCurrentConversation();
        this.isOpen = false;
        this.actor.hide();
        if (this.actor.get_parent()) {
            Main.layoutManager.removeChrome(this.actor);
        }
    }

    destroy() {
        this._cancelStream();

        if (this._monitorChangedId) {
            Main.layoutManager.disconnect(this._monitorChangedId);
            this._monitorChangedId = 0;
        }

        this.close();
        if (this.actor) {
            this.actor.destroy();
        }
    }

    // ── History management ──────────────────────────────────────────────

    async _updateDraftTokenCount() {
        let text = this._entry.get_text();
        if (!text) {
            this._draftUsage = 0;
            this._renderTokenCounter();
            return;
        }

        if (this._currentProvider === 'unsloth' || this._currentProvider === 'ollama') {
            try {
                let url;
                if (this._currentProvider === 'unsloth') {
                    let baseUrl = this._settings.get_string('unsloth-url') || 'http://127.0.0.1:8080';
                    if (baseUrl.endsWith('/')) baseUrl = baseUrl.slice(0, -1);
                    if (baseUrl.endsWith('/v1')) baseUrl = baseUrl.slice(0, -3);
                    url = baseUrl + '/tokenize';
                } else {
                    let baseUrl = this._settings.get_string('ollama-url') || 'http://127.0.0.1:11434';
                    if (baseUrl.endsWith('/')) baseUrl = baseUrl.slice(0, -1);
                    url = baseUrl + '/api/tokenize';
                }

                let body = this._currentProvider === 'ollama'
                    ? JSON.stringify({ model: this._settings.get_string('ollama-model') || 'llama3', prompt: text })
                    : JSON.stringify({ content: text });

                let message = Soup.Message.new('POST', url);
                message.set_request_body_from_bytes(
                    'application/json',
                    new GLib.Bytes(new TextEncoder().encode(body))
                );
                if (this._currentProvider === 'unsloth') {
                    let apiKey = '';
                    try { apiKey = this._settings.get_string('unsloth-api-key'); } catch (_e) { }
                    if (apiKey) message.get_request_headers().append('Authorization', `Bearer ${apiKey}`);
                }

                let bytes = await new Promise((resolve, reject) => {
                    this._soupSession.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (session, res) => {
                        try {
                            resolve(session.send_and_read_finish(res));
                        } catch (e) { reject(e); }
                    });
                });

                let data = JSON.parse(new TextDecoder('utf-8').decode(bytes.get_data()));

                this._draftUsage = data.tokens ? data.tokens.length : Math.ceil(text.length / 4);
            } catch (e) {
                this._draftUsage = Math.ceil(text.length / 4);
            }
            this._renderTokenCounter();
        }
    }

    async _fetchMaxContext() {
        if (this._currentProvider === 'unsloth') {
            let val = this._settings.get_int('unsloth-num-ctx');
            this._maxContextSize = val > 0 ? val : -1;
        } else if (this._currentProvider === 'ollama') {
            let val = this._settings.get_int('ollama-num-ctx');
            this._maxContextSize = val > 0 ? val : -1;
        } else {
            // openai / anthropic — context size not configurable here
            this._maxContextSize = -1;
        }
        this._renderTokenCounter();
    }

    _renderTokenCounter() {
        if (this._maxContextSize === 0) {
            // Still loading — keep hidden
            this._tokenBox.visible = false;
            return;
        }
        this._tokenBox.visible = true;

        if (this._maxContextSize < 0) {
            // Unknown context size — show warning icon, hide progress bar
            this._tokenLabel.set_text('⚠');
            this._tokenLabel.add_style_class_name('katab-token-warn');
            this._tokenProgressWrap.visible = false;
            return;
        }

        // Known context size — show counter and progress bar
        this._tokenLabel.remove_style_class_name('katab-token-warn');
        this._tokenProgressWrap.visible = true;

        let total = this._currentUsage + this._draftUsage;
        this._tokenLabel.set_text(`${total} / ${this._maxContextSize}`);

        let ratio = Math.min(total / this._maxContextSize, 1.0);
        this._tokenProgressFill.set_width(ratio * 60);

        this._tokenProgressFill.remove_style_class_name('warn');
        this._tokenProgressFill.remove_style_class_name('danger');
        if (ratio >= 0.9) {
            this._tokenProgressFill.add_style_class_name('danger');
        } else if (ratio >= 0.75) {
            this._tokenProgressFill.add_style_class_name('warn');
        }
    }

    _saveCurrentConversation() {
        let newId = HistoryManager.saveConversation(this._messageHistory, this._currentConversationId);
        if (newId) {
            this._currentConversationId = newId;
        }
    }

    _deleteConversation(id) {
        HistoryManager.deleteConversation(id);
        if (this._currentConversationId === id) {
            this._currentConversationId = null;
        }
    }

    _loadConversation(entry) {
        this._cancelStream();
        this._currentConversationId = entry.id;
        this._messageHistory = [...entry.messages];
        this._chatContainer.destroy_all_children();
        for (let msg of entry.messages) {
            if (msg.role === 'user') {
                this._addChatMessage('You', msg.content, 'user');
            } else if (msg.role === 'assistant') {
                this._addChatMessage('Katab AI', msg.content, 'assistant');
            }
        }
        this._showChatView();
    }

    // ── View switching ───────────────────────────────────────────────────

    _showChatView() {
        this._historyView.visible = false;
        this._chatScroll.visible = true;
        this._footerBox.visible = true;

        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            if (this.isOpen && this._entry) {
                this._entry.grab_key_focus();
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _showHistoryView() {
        this._chatScroll.visible = false;
        this._footerBox.visible = false;
        this._historyView.visible = true;
        this._renderHistoryList();
    }

    _toggleHistoryView() {
        if (this._historyView.visible) {
            this._showChatView();
        } else {
            this._showHistoryView();
        }
    }

    _renderHistoryList() {
        this._historyContainer.destroy_all_children();
        let arr = HistoryManager.load();

        if (arr.length === 0) {
            let emptyLabel = new St.Label({
                text: 'No saved conversations yet.\nStart chatting and use New Chat to save.',
                style_class: 'katab-history-empty',
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
                x_expand: true,
            });
            emptyLabel.clutter_text.line_wrap = true;
            emptyLabel.clutter_text.single_line_mode = false;
            this._historyContainer.add_child(emptyLabel);
            return;
        }

        for (let entry of arr) {
            let row = new St.BoxLayout({
                vertical: false,
                style_class: 'katab-history-row',
                x_expand: true,
            });

            let textCol = new St.BoxLayout({
                vertical: true,
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'katab-history-text-col',
            });

            let titleLabel = new St.Label({
                text: entry.title,
                style_class: 'katab-history-title',
                x_expand: true,
            });
            titleLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            titleLabel.clutter_text.single_line_mode = true;
            textCol.add_child(titleLabel);

            let date = new Date(entry.timestamp * 1000);
            let dateStr = date.toLocaleDateString(undefined, {
                month: 'short', day: 'numeric',
            }) + ' · ' + date.toLocaleTimeString(undefined, {
                hour: '2-digit', minute: '2-digit',
            });
            let dateLabel = new St.Label({
                text: dateStr,
                style_class: 'katab-history-date',
            });
            textCol.add_child(dateLabel);
            row.add_child(textCol);

            let loadBtn = new St.Button({
                label: 'Load',
                style_class: 'katab-history-load-btn',
                can_focus: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            loadBtn.connect('clicked', () => this._loadConversation(entry));
            row.add_child(loadBtn);

            let deleteBtn = new St.Button({
                child: new St.Icon({
                    icon_name: 'user-trash-symbolic',
                    style_class: 'katab-history-delete-icon',
                }),
                style_class: 'katab-history-delete-btn',
                can_focus: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            deleteBtn.connect('clicked', () => {
                this._deleteConversation(entry.id);
                this._renderHistoryList();
            });
            row.add_child(deleteBtn);

            this._historyContainer.add_child(row);
        }
    }

    // ── Chat management ──────────────────────────────────────────────────

    _cancelStream() {
        if (this._cancellable) {
            this._cancellable.cancel();
            this._cancellable = null;
        }
    }

    _newChat() {
        this._cancelStream();
        this._saveCurrentConversation();
        this._currentConversationId = null;
        this._messageHistory = [];
        this._currentUsage = 0;
        this._draftUsage = 0;
        this._renderTokenCounter();
        this._chatContainer.destroy_all_children();
        this._showChatView();
        this._addWelcomeMessage();
    }

    _escapeMarkup(text) {
        return String(text ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    _setLabelMarkup(label, markup, fallbackText) {
        try {
            label.clutter_text.set_markup(markup);
        } catch (e) {
            log(`Katab: failed to render formatted text: ${e.message}`);
            label.set_text(fallbackText);
        }
    }

    _renderPlainMarkup(text) {
        return this._escapeMarkup(text).replace(/\t/g, '    ');
    }

    _truncateText(text, maxLength = 48) {
        if (text.length <= maxLength) {
            return text;
        }

        return `${text.slice(0, maxLength - 3)}...`;
    }

    _normalizeUrl(url) {
        let trimmed = String(url ?? '').trim().replace(/[.,!?;:]+$/g, '');
        return /^https?:\/\/\S+$/i.test(trimmed) ? trimmed : null;
    }

    _extractLinks(text) {
        let collectedLinks = [];

        let transformedText = String(text ?? '').replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_match, label, url) => {
            let normalizedUrl = this._normalizeUrl(url);
            if (normalizedUrl) {
                collectedLinks.push({
                    label: label.trim(),
                    url: normalizedUrl,
                });

                return label;
            }

            return _match;
        });

        transformedText = transformedText.replace(/https?:\/\/[^\s<>()]+/g, match => {
            let normalizedUrl = this._normalizeUrl(match);
            if (!normalizedUrl) {
                return match;
            }

            collectedLinks.push({
                label: '',
                url: normalizedUrl,
            });

            return normalizedUrl + match.slice(normalizedUrl.length);
        });

        let links = [];
        let seen = new Set();
        for (let link of collectedLinks) {
            if (seen.has(link.url)) {
                continue;
            }

            seen.add(link.url);
            links.push(link);
        }

        return {
            text: transformedText,
            links: links,
        };
    }

    _formatInlineMarkdown(text) {
        let escapedText = this._escapeMarkup(text);
        let codeTokens = [];

        escapedText = escapedText.replace(/`([^`\n]+)`/g, (_match, code) => {
            let token = `@@KATAB_CODE_${codeTokens.length}@@`;
            codeTokens.push(
                `<span font_family="monospace" foreground="#f9e2af" background="#11111b">${code}</span>`
            );
            return token;
        });

        escapedText = escapedText.replace(/\*\*([^\n]+?)\*\*/g, '<b>$1</b>');
        escapedText = escapedText.replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s).,!?:;])/g, '$1<i>$2</i>');
        escapedText = escapedText.replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s).,!?:;])/g, '$1<i>$2</i>');

        for (let i = 0; i < codeTokens.length; i++) {
            escapedText = escapedText.replace(`@@KATAB_CODE_${i}@@`, codeTokens[i]);
        }

        return escapedText;
    }

    _formatMarkdownLine(line) {
        if (line === '') {
            return '';
        }

        let headingMatch = line.match(/^\s{0,3}(#{1,3})\s+(.*)$/);
        if (headingMatch) {
            let headingSizes = {
                1: 'x-large',
                2: 'large',
                3: 'medium',
            };

            return `<span size="${headingSizes[headingMatch[1].length]}" weight="bold">${this._formatInlineMarkdown(headingMatch[2].trim())}</span>`;
        }

        let quoteMatch = line.match(/^\s{0,3}>\s?(.*)$/);
        if (quoteMatch) {
            return `<span foreground="#a6adc8" style="italic">| ${this._formatInlineMarkdown(quoteMatch[1])}</span>`;
        }

        let bulletMatch = line.match(/^\s{0,3}[-*]\s+(.*)$/);
        if (bulletMatch) {
            return `• ${this._formatInlineMarkdown(bulletMatch[1])}`;
        }

        let orderedMatch = line.match(/^\s{0,3}(\d+)\.\s+(.*)$/);
        if (orderedMatch) {
            return `${orderedMatch[1]}. ${this._formatInlineMarkdown(orderedMatch[2])}`;
        }

        return this._formatInlineMarkdown(line);
    }

    _formatMarkdownTextSegment(text) {
        return String(text ?? '')
            .split('\n')
            .map(line => this._formatMarkdownLine(line))
            .join('\n');
    }

    _formatCodeBlock(language, codeText) {
        let safeLanguage = this._escapeMarkup(String(language ?? '').trim());
        let safeCode = this._escapeMarkup(String(codeText ?? '').replace(/\t/g, '    ').replace(/\n$/, ''));
        let header = safeLanguage
            ? `<span weight="bold" foreground="#89b4fa">${safeLanguage}</span>\n`
            : '';

        return `<span font_family="monospace" foreground="#f9e2af" background="#11111b">${header}${safeCode}</span>`;
    }

    _buildAssistantMarkup(rawText, { final = false, plain = false } = {}) {
        let sourceText = String(rawText ?? '');
        if (plain) {
            return {
                markup: this._renderPlainMarkup(sourceText),
                links: [],
            };
        }

        let parseableText = sourceText;
        let trailingPlainText = '';
        let fenceMatches = parseableText.match(/```/g) || [];
        if (!final && fenceMatches.length % 2 === 1) {
            let lastFenceIndex = parseableText.lastIndexOf('```');
            trailingPlainText = parseableText.slice(lastFenceIndex);
            parseableText = parseableText.slice(0, lastFenceIndex);
        }

        let markupParts = [];
        let links = [];
        let codeBlockRegex = /```([^\n`]*)\n([\s\S]*?)```/g;
        let lastIndex = 0;
        let match;

        while ((match = codeBlockRegex.exec(parseableText)) !== null) {
            if (match.index > lastIndex) {
                let extracted = this._extractLinks(parseableText.slice(lastIndex, match.index));
                links.push(...extracted.links);
                markupParts.push(this._formatMarkdownTextSegment(extracted.text));
            }

            markupParts.push(this._formatCodeBlock(match[1], match[2]));
            lastIndex = codeBlockRegex.lastIndex;
        }

        if (lastIndex < parseableText.length) {
            let extracted = this._extractLinks(parseableText.slice(lastIndex));
            links.push(...extracted.links);
            markupParts.push(this._formatMarkdownTextSegment(extracted.text));
        }

        if (trailingPlainText) {
            markupParts.push(this._renderPlainMarkup(trailingPlainText));
        }

        let uniqueLinks = [];
        let seen = new Set();
        for (let link of links) {
            if (seen.has(link.url)) {
                continue;
            }

            seen.add(link.url);
            uniqueLinks.push(link);
        }

        return {
            markup: markupParts.join(''),
            links: uniqueLinks,
        };
    }

    _getLinkButtonLabel(link) {
        let labelText = link.label && link.label !== link.url
            ? link.label
            : link.url.replace(/^https?:\/\//i, '');
        return this._truncateText(labelText, 54);
    }

    _openExternalLink(url) {
        try {
            Gio.AppInfo.launch_default_for_uri(url, null);
        } catch (e) {
            this._addSystemMessage(`Failed to open link: ${e.message}`);
        }
    }

    _updateLinkActions(linkBox, links) {
        if (!linkBox) {
            return;
        }

        linkBox.destroy_all_children();

        if (!links || links.length === 0) {
            linkBox.visible = false;
            return;
        }

        for (let link of links) {
            let button = new St.Button({
                label: this._getLinkButtonLabel(link),
                style_class: 'katab-chat-link-button',
                can_focus: true,
                x_expand: true,
                x_align: Clutter.ActorAlign.START,
            });
            button.connect('clicked', () => this._openExternalLink(link.url));
            linkBox.add_child(button);
        }

        linkBox.visible = true;
    }

    _applyAssistantRender(uiElements, rawText, options = {}) {
        if (!uiElements || !uiElements.contentLabel) {
            return;
        }

        let sourceText = String(rawText ?? '');
        let rendered = this._buildAssistantMarkup(sourceText, options);
        this._setLabelMarkup(uiElements.contentLabel, rendered.markup, sourceText);
        this._updateLinkActions(uiElements.linkBox, rendered.links);
    }

    _addWelcomeMessage() {
        this._addChatMessage(
            'Katab Assistant',
            'Hello! I am Katab, your Punjabi book of knowledge and AI assistant.\n\nI can help you explore ideas, explain concepts, and access local or remote AI models directly from your GNOME desktop.',
            'assistant'
        );
    }

    _addSystemMessage(text) {
        let msgBox = new St.BoxLayout({
            style_class: 'katab-system-message-box',
            x_align: Clutter.ActorAlign.CENTER,
        });
        let label = new St.Label({
            text: text,
            style_class: 'katab-system-message-text',
        });
        msgBox.add_child(label);
        this._chatContainer.add_child(msgBox);
        this._scrollToBottom();
    }

    _addChatMessage(sender, text, type) {
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

        let thinkWrapper = new St.BoxLayout({
            vertical: true,
            style_class: 'katab-think-wrapper',
            visible: false,
        });

        let thinkButton = new St.Button({
            label: 'Show Thinking',
            style_class: 'katab-think-toggle-btn',
            toggle_mode: true,
            can_focus: true,
        });

        let thinkLabel = new St.Label({
            text: '',
            style_class: 'katab-think-label',
            visible: false,
            x_expand: true,
        });
        thinkLabel.clutter_text.line_wrap = true;
        thinkLabel.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        thinkLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        thinkLabel.clutter_text.single_line_mode = false;
        thinkLabel.clutter_text.can_focus = false;

        thinkButton.connect('notify::checked', () => {
            thinkLabel.visible = thinkButton.checked;
            thinkButton.label = thinkButton.checked ? 'Hide Thinking' : 'Show Thinking';
        });

        thinkWrapper.add_child(thinkButton);
        thinkWrapper.add_child(thinkLabel);
        bubbleBox.add_child(thinkWrapper);

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

        bubbleBox.add_child(contentLabel);

        let copyBtnRow = new St.BoxLayout({
            vertical: false,
            x_expand: true,
            x_align: isUser ? Clutter.ActorAlign.END : Clutter.ActorAlign.START,
        });
        let copyBtn = new St.Button({
            style_class: 'katab-copy-btn',
            child: new St.Icon({
                gicon: Gio.ThemedIcon.new('edit-copy-symbolic'),
                icon_size: 14,
            }),
        });
        copyBtn.connect('clicked', () => {
            let txt = contentLabel.get_text();
            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, txt);
        });
        copyBtnRow.add_child(copyBtn);

        let tokenCountLabel = new St.Label({
            text: '',
            style_class: 'katab-message-token-label',
            visible: false
        });
        copyBtnRow.add_child(tokenCountLabel);

        // Push copy btn to right if user, otherwise keep it left and tokens right
        if (isUser) {
            copyBtnRow.set_pack_start(true);
        }

        bubbleBox.add_child(copyBtnRow);

        let linkBox = null;
        if (!isUser) {
            linkBox = new St.BoxLayout({
                vertical: true,
                style_class: 'katab-chat-link-list',
                x_expand: true,
                visible: false,
            });
            bubbleBox.add_child(linkBox);
        }

        let spacer = new St.Widget({ x_expand: true });
        if (isUser) {
            rowBox.add_child(spacer);
            rowBox.add_child(bubbleBox);
        } else {
            rowBox.add_child(bubbleBox);
            rowBox.add_child(spacer);
        }

        this._chatContainer.add_child(rowBox);

        if (isUser) {
            contentLabel.set_text(text);
        } else {
            this._applyAssistantRender({ contentLabel, linkBox }, text, { final: true });
        }

        this._scrollToBottom();

        return { contentLabel, thinkLabel, thinkWrapper, linkBox };
    }

    _scrollToBottom() {
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            let adj = this._chatScroll.get_vscroll_bar().get_adjustment();
            adj.value = adj.upper - adj.page_size;
            return GLib.SOURCE_REMOVE;
        });
    }

    _sendMessage() {
        let promptText = this._entry.get_text().trim();
        if (promptText === '')
            return;

        this._forcedTool = null;
        const tools = PROVIDER_TOOLS[this._currentProvider] || [];
        for (const t of tools) {
            if (promptText.startsWith(t.command + ' ') || promptText === t.command) {
                this._forcedTool = t.toolName;
                break;
            }
        }

        this._entry.set_text('');
        this._addChatMessage('You', promptText, 'user');

        this._messageHistory.push({ role: 'user', content: promptText });
        this._saveCurrentConversation();

        let uiElements = this._addChatMessage('Katab AI', '...', 'assistant');

        try {
            this._streamResponse(uiElements);
        } catch (e) {
            this._applyAssistantRender(uiElements, `Error constructing request: ${e.message}`, { plain: true });
        }
    }

    _streamResponse(uiElements) {
        const provider = this._settings.get_string('provider');
        let url = this._settings.get_string(`${provider}-url`);
        let apiKey = '';
        if (provider !== 'ollama') {
            try { apiKey = this._settings.get_string(`${provider}-api-key`); } catch (e) { }
        }
        let model = this._settings.get_string(`${provider}-model`);

        let endpoint = url;
        if (!endpoint.endsWith('/')) endpoint += '/';

        let headers = {};
        if (apiKey) {
            headers['Authorization'] = `Bearer ${apiKey}`;
        }

        let payload = {};

        // Prepare Dialects
        if (provider === 'unsloth' || provider === 'openai') {
            if (!endpoint.endsWith('chat/completions') && !endpoint.includes('v1/chat')) {
                endpoint += 'chat/completions';
            }
            headers['Content-Type'] = 'application/json';
            payload = {
                model: model,
                messages: this._messageHistory,
                stream: true
            };
            if (this._forcedTool) {
                payload.tool_choice = { type: "function", function: { name: this._forcedTool } };
            }
            if (provider === 'unsloth') {
                payload.enable_tools = true;
                payload.enabled_tools = ["web_search", "python", "terminal"];
                payload.session_id = this._currentConversationId || `session_${Date.now()}`;
            }
        } else if (provider === 'anthropic') {
            if (!endpoint.endsWith('messages') && !endpoint.includes('v1/messages')) {
                endpoint += 'v1/messages';
            }
            // Anthropic specific headers
            headers['x-api-key'] = apiKey;
            headers['anthropic-version'] = '2023-06-01';
            headers['Content-Type'] = 'application/json';

            // Format Anthropic messages (remove system prompts from history or map them)
            let anthropicMessages = this._messageHistory.filter(m => m.role !== 'system');

            payload = {
                model: model,
                messages: anthropicMessages,
                stream: true,
                max_tokens: 4096
            };
        } else if (provider === 'ollama') {
            if (!endpoint.endsWith('api/chat')) {
                endpoint += 'api/chat';
            }
            headers['Content-Type'] = 'application/json';

            let numCtx = this._settings.get_int('ollama-num-ctx');
            let keepAlive = this._settings.get_string('ollama-keep-alive');
            let temp = this._settings.get_double('ollama-temperature');

            payload = {
                model: model,
                messages: this._messageHistory,
                stream: true,
                keep_alive: keepAlive || "5m",
                think: true,
                options: {
                    temperature: temp,
                    num_ctx: numCtx
                },
                tools: [
                    {
                        type: "function",
                        function: {
                            name: "dummy_calculator",
                            description: "Calculates mathematical expressions. Use this tool any time the user asks a math question.",
                            parameters: {
                                type: "object",
                                properties: {
                                    expression: {
                                        type: "string",
                                        description: "The mathematical expression to evaluate"
                                    }
                                },
                                required: ["expression"]
                            }
                        }
                    }
                ]
            };
            if (this._forcedTool) {
                // Ollama tool choice (some versions/models may ignore it)
                payload.tool_choice = { type: "function", function: { name: this._forcedTool } };
            }
        }

        let message = Soup.Message.new('POST', endpoint);

        for (let key in headers) {
            message.get_request_headers().append(key, headers[key]);
        }

        let bodyBytes = new GLib.Bytes(JSON.stringify(payload));
        message.set_request_body_from_bytes('application/json', bodyBytes);

        let { thinkLabel, thinkWrapper } = uiElements;
        let accumulatedText = "";
        let accumulatedThink = "";
        let isThinking = false;

        this._applyAssistantRender(uiElements, 'Waiting for response...', { plain: true });
        this._cancelStream();
        this._cancellable = new Gio.Cancellable();
        let currentCancellable = this._cancellable;

        this._soupSession.send_async(message, GLib.PRIORITY_DEFAULT, currentCancellable, (session, res) => {
            if (currentCancellable.is_cancelled()) return;
            try {
                let inputStream = session.send_finish(res);
                if (message.status_code === 404 && provider === 'ollama') {
                    this._promptOllamaPull(inputStream, model, uiElements);
                    return;
                } else if (message.status_code !== 200) {
                    this._applyAssistantRender(uiElements, `Error: HTTP ${message.status_code}`, { plain: true });
                    return;
                }

                let dataInputStream = new Gio.DataInputStream({
                    base_stream: inputStream,
                    close_base_stream: true
                });

                this._readSSE(dataInputStream, uiElements, accumulatedText, accumulatedThink, isThinking, provider, currentCancellable, []);

            } catch (e) {
                if (currentCancellable.is_cancelled()) return;
                this._applyAssistantRender(uiElements, `Request Failed: ${e.message}`, { plain: true });
            }
        });
    }

    _readSSE(dataInputStream, uiElements, accumulatedText, accumulatedThink, isThinking, provider, cancellable, accumulatedToolCalls) {
        if (cancellable && cancellable.is_cancelled()) return;

        let { thinkLabel, thinkWrapper } = uiElements;
        dataInputStream.read_line_async(GLib.PRIORITY_DEFAULT, cancellable, (stream, res) => {
            if (cancellable && cancellable.is_cancelled()) return;
            try {
                let [lineBytes, length] = stream.read_line_finish(res);
                if (lineBytes === null) {
                    // Stream ended
                    let finalContent = accumulatedText;
                    if (accumulatedThink && !finalContent && (!accumulatedToolCalls || accumulatedToolCalls.length === 0)) finalContent = "Finished thinking, but no response provided.";

                    if (accumulatedToolCalls && accumulatedToolCalls.length > 0) {
                        this._handleToolCalls(accumulatedToolCalls, uiElements);
                    } else {
                        this._applyAssistantRender(uiElements, finalContent, { final: true });
                        this._messageHistory.push({ role: 'assistant', content: finalContent });
                        this._saveCurrentConversation();
                    }
                    return;
                }

                let lineStr = new TextDecoder('utf-8').decode(lineBytes).trim();
                let deltaText = "";

                if (provider === 'ollama' && lineStr.startsWith('{')) {
                    let parsed = JSON.parse(lineStr);
                    if (parsed.message) {
                        if (parsed.message.content) {
                            deltaText = parsed.message.content;
                        }
                        if (parsed.message.reasoning) {
                            isThinking = true;
                            thinkWrapper.visible = true;
                            accumulatedThink += parsed.message.reasoning;
                            thinkLabel.set_text(accumulatedThink);
                        }
                        if (parsed.message.tool_calls) {
                            for (let tc of parsed.message.tool_calls) {
                                accumulatedToolCalls.push(tc);
                            }
                        }
                    }
                    if (parsed.done === true && parsed.prompt_eval_count !== undefined && parsed.eval_count !== undefined) {
                        this._currentUsage += parsed.prompt_eval_count + parsed.eval_count;
                        this._renderTokenCounter();
                    }
                } else if (lineStr.startsWith('data: ')) {
                    let jsonStr = lineStr.substring(6).trim();
                    if (jsonStr && jsonStr !== '[DONE]') {
                        let parsed = JSON.parse(jsonStr);
                        if (provider === 'anthropic') {
                            if (parsed.type === 'content_block_delta' && parsed.delta && parsed.delta.text) {
                                deltaText = parsed.delta.text;
                            }
                            if (parsed.type === 'message_stop') {
                                // For Anthropic usage requires usage endpoint or parsing message start/stop
                            }
                        } else {
                            // OpenAI / Unsloth
                            if (parsed.type === 'tool_result') {
                                let toolContent = parsed.content || 'No output.';
                                let toolName = parsed.tool_use_id || 'Tool';
                                deltaText = `\n\n> **Server-side tool executed (${toolName})**:\n> \`\`\`\n> ${toolContent.split('\\n').join('\\n> ')}\n> \`\`\`\n\n`;
                            } else if (parsed.choices && parsed.choices.length > 0) {
                                let delta = parsed.choices[0].delta;
                                if (delta && delta.content) {
                                    deltaText = delta.content;
                                }
                            }
                        }
                        if (parsed.usage) {
                            let u = parsed.usage;
                            if (u.prompt_tokens !== undefined && u.completion_tokens !== undefined) {
                                this._currentUsage += u.prompt_tokens + u.completion_tokens;
                                this._renderTokenCounter();
                            }
                        }
                    }
                }

                if (deltaText) {
                    // Split the text based on tags
                    let i = 0;
                    while (i < deltaText.length) {
                        if (!isThinking && (deltaText.substring(i).startsWith('igid') || deltaText.substring(i).startsWith('<think>'))) {
                            isThinking = true;
                            thinkWrapper.visible = true;
                            i += deltaText.substring(i).startsWith('<think>') ? 7 : 4; // skip tag
                        } else if (isThinking && (deltaText.substring(i).startsWith('igr') || deltaText.substring(i).startsWith('</think>'))) {
                            isThinking = false;
                            i += deltaText.substring(i).startsWith('</think>') ? 8 : 3; // skip tag
                        } else {
                            if (isThinking) {
                                accumulatedThink += deltaText[i];
                            } else {
                                accumulatedText += deltaText[i];
                            }
                            i++;
                        }
                    }

                    if (accumulatedThink) {
                        thinkLabel.set_text(accumulatedThink);
                    }
                    if (accumulatedText) {
                        this._applyAssistantRender(uiElements, accumulatedText, { final: false });
                    }

                    this._scrollToBottom();
                }

                // Read next line
                this._readSSE(dataInputStream, uiElements, accumulatedText, accumulatedThink, isThinking, provider, cancellable, accumulatedToolCalls);

            } catch (e) {
                if (cancellable && cancellable.is_cancelled()) return;
                // Ignore parse errors from partial or non-json lines and continue
                this._readSSE(dataInputStream, uiElements, accumulatedText, accumulatedThink, isThinking, provider, cancellable, accumulatedToolCalls);
            }
        });
    }

    _handleToolCalls(toolCalls, uiElements) {
        this._applyAssistantRender(uiElements, 'Executing requested tools...', { plain: true });

        // Push the assistant's tool call message
        this._messageHistory.push({
            role: 'assistant',
            content: '',
            tool_calls: toolCalls
        });

        for (let tc of toolCalls) {
            let result = "";
            try {
                if (tc.function.name === "dummy_calculator") {
                    let args = JSON.parse(tc.function.arguments);
                    // Safe mock eval for demonstration
                    result = `Calculated result: Evaluated ${args.expression} successfully (mocked).`;
                } else {
                    result = `Tool ${tc.function.name} not found.`;
                }
            } catch (e) {
                result = `Error executing tool: ${e.message}`;
            }

            this._messageHistory.push({
                role: 'tool',
                name: tc.function.name,
                content: result
            });
        }

        // Bounce back to API with the tool results
        this._applyAssistantRender(uiElements, 'Waiting for final response...', { plain: true });
        this._streamResponse(uiElements);
    }

    _promptOllamaPull(inputStream, model, uiElements) {
        // Need to close stream since we got a 404
        try { inputStream.close(null); } catch (e) { }

        let { contentLabel } = uiElements;
        this._applyAssistantRender(uiElements, `Model '${model}' not found locally.\n\nDo you want to download it now?`, { plain: true });

        // Let's create an interactive prompt inline
        let box = new St.BoxLayout({ vertical: false, style_class: 'katab-prompt-box' });

        let confirmBtn = new St.Button({
            label: "Yes, Download",
            style_class: 'katab-prompt-btn-yes',
            x_expand: true
        });

        let cancelBtn = new St.Button({
            label: "No, Cancel",
            style_class: 'katab-prompt-btn-no',
            x_expand: true
        });

        confirmBtn.connect('clicked', () => {
            box.destroy();
            this._pullOllamaModel(model, uiElements);
        });

        cancelBtn.connect('clicked', () => {
            box.destroy();
            this._applyAssistantRender(uiElements, 'Download cancelled.', { plain: true });
        });

        box.add_child(confirmBtn);
        box.add_child(cancelBtn);

        // Find the container parent of contentLabel and push the box there
        contentLabel.get_parent().add_child(box);
    }

    _pullOllamaModel(model, uiElements) {
        let { contentLabel } = uiElements;
        this._applyAssistantRender(uiElements, `Downloading model '${model}'... (0%)`, { plain: true });

        let provider = this._settings.get_string('provider');
        let url = this._settings.get_string(`${provider}-url`);
        let endpoint = url;
        if (!endpoint.endsWith('/')) endpoint += '/';
        endpoint += 'api/pull';

        let payload = {
            name: model,
            stream: true
        };

        let message = Soup.Message.new('POST', endpoint);
        let bodyBytes = new GLib.Bytes(JSON.stringify(payload));
        message.set_request_body_from_bytes('application/json', bodyBytes);

        this._cancelStream(); // cancel any active stream
        this._cancellable = new Gio.Cancellable();
        let currentCancellable = this._cancellable;

        let cancelBtn = new St.Button({
            label: "Cancel Download",
            style_class: 'katab-prompt-btn-no',
            x_expand: false
        });
        cancelBtn.connect('clicked', () => {
            currentCancellable.cancel();
            this._applyAssistantRender(uiElements, 'Download cancelled.', { plain: true });
            cancelBtn.destroy();
        });
        contentLabel.get_parent().add_child(cancelBtn);

        this._soupSession.send_async(message, GLib.PRIORITY_DEFAULT, currentCancellable, (session, res) => {
            if (currentCancellable.is_cancelled()) {
                if (cancelBtn) cancelBtn.destroy();
                return;
            }
            try {
                let inputStream = session.send_finish(res);
                if (message.status_code !== 200) {
                    cancelBtn.destroy();
                    this._applyAssistantRender(uiElements, `Pull Error: HTTP ${message.status_code}`, { plain: true });
                    return;
                }

                let dataInputStream = new Gio.DataInputStream({
                    base_stream: inputStream,
                    close_base_stream: true
                });

                this._readPullSSE(dataInputStream, model, uiElements, currentCancellable, cancelBtn);

            } catch (e) {
                if (cancelBtn) cancelBtn.destroy();
                if (currentCancellable.is_cancelled()) return;
                this._applyAssistantRender(uiElements, `Pull Failed: ${e.message}`, { plain: true });
            }
        });
    }

    _readPullSSE(dataInputStream, model, uiElements, cancellable, cancelBtn) {
        if (cancellable && cancellable.is_cancelled()) return;

        let { contentLabel } = uiElements;
        dataInputStream.read_line_async(GLib.PRIORITY_DEFAULT, cancellable, (stream, res) => {
            if (cancellable && cancellable.is_cancelled()) {
                if (cancelBtn) cancelBtn.destroy();
                return;
            }
            try {
                let [lineBytes, length] = stream.read_line_finish(res);
                if (lineBytes === null) {
                    // Pull finished
                    if (cancelBtn) cancelBtn.destroy();
                    this._applyAssistantRender(uiElements, `Model '${model}' pulled. Resuming request...`, { plain: true });
                    this._streamResponse(uiElements);
                    return;
                }

                let lineStr = new TextDecoder('utf-8').decode(lineBytes).trim();
                let parsed = JSON.parse(lineStr);

                if (parsed.status) {
                    let text = `Downloading model '${model}'...\n${parsed.status}`;
                    if (parsed.completed && parsed.total) {
                        let pct = Math.round((parsed.completed / parsed.total) * 100);
                        text += ` (${pct}%)`;
                    }
                    this._applyAssistantRender(uiElements, text, { plain: true });
                }

                this._readPullSSE(dataInputStream, model, uiElements, cancellable, cancelBtn);

            } catch (e) {
                if (cancellable && cancellable.is_cancelled()) {
                    if (cancelBtn) cancelBtn.destroy();
                    return;
                }
                this._readPullSSE(dataInputStream, model, uiElements, cancellable, cancelBtn);
            }
        });
    }

    _getMockResponse(prompt) {
        let lower = prompt.toLowerCase();
        if (lower.includes('hi') || lower.includes('hello') || lower.includes('hey')) {
            return `Sata srī akāla! 👋 Welcome back to Katab.\n\nI am configured with physical placeholders for Ollama and OpenAI/Unsloth interfaces. Ask me specific questions about your setups!`;
        }
        if (lower.includes('ollama') || lower.includes('local')) {
            return `[Ollama Mock Integration]\nHost detected: http://localhost:11434\nCurrent model active: llama3 (or unsloth fine-tuned)\n\nI will interface directly with local Ollama streams under prompt: "${prompt}". Ready for full local execution!`;
        }
        if (lower.includes('openai') || lower.includes('unsloth') || lower.includes('remote') || lower.includes('api')) {
            return `[OpenAI / Unsloth Mock Integration]\nEndpoint targeted: https://api.openai.com/v1 (or custom studio proxy)\nCredentials placeholder status: Active\n\nThis action would trigger a secure chat completions API payload using the model parameters specified in settings.`;
        }
        if (lower.includes('book') || lower.includes('katab') || lower.includes('punjabi')) {
            return `Katab (ਕਿਤਾਬ) means 'book' in Punjabi 📚.\n\nHistorically, books are vessels for preserving and spreading knowledge. In the same spirit, this GNOME extension transforms your desktop into an immediate gateway to open intelligence, whether run locally on your hardware or through custom cloud APIs.`;
        }

        return `I successfully registered your request:\n"${prompt}"\n\nWe are currently operating in UI layout mock mode. Under production, this message is passed straight to the ${this._currentProvider === 'ollama' ? 'Local Ollama daemon at port 11434' : 'OpenAI endpoint'}.`;
    }
}

const Indicator = GObject.registerClass(
    class Indicator extends PanelMenu.Button {
        _init(extension) {
            super._init(0.0, 'Katab Menu');
            this._extension = extension;
            this._settings = extension.getSettings('org.gnome.shell.extensions.katabai');

            let panelGicon = Gio.icon_new_for_string(`${extension.path}/icons/katab-panel-icon.svg`);
            this.add_child(new St.Icon({
                gicon: panelGicon,
                style_class: 'system-status-icon',
            }));

            // Actions Section
            this._newChatMenuItem = new PopupMenu.PopupMenuItem('New Chat');
            let newChatIcon = new St.Icon({ icon_name: 'document-new-symbolic', style_class: 'popup-menu-icon' });
            this._newChatMenuItem.insert_child_at_index(newChatIcon, 0);
            this._newChatMenuItem.connect('activate', () => {
                if (!this._extension._dialog) this._extension.toggleDialog();
                if (!this._extension._dialog.isOpen) this._extension._dialog.open();
                this._extension._dialog._newChat();
            });
            this.menu.addMenuItem(this._newChatMenuItem);

            this._settingsMenuItem = new PopupMenu.PopupMenuItem('Settings');
            let settingsIcon = new St.Icon({ icon_name: 'emblem-system-symbolic', style_class: 'popup-menu-icon' });
            this._settingsMenuItem.insert_child_at_index(settingsIcon, 0);
            this._settingsMenuItem.connect('activate', () => {
                this._extension.openPreferences();
            });
            this.menu.addMenuItem(this._settingsMenuItem);

            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            // Provider Switcher
            this._providerMenu = new PopupMenu.PopupSubMenuMenuItem('Model Provider');
            this.menu.addMenuItem(this._providerMenu);
            this._providerItems = {};
            const providers = {
                'ollama': 'Ollama (Local)',
                'unsloth': 'Unsloth Studio',
                'openai': 'OpenAI',
                'anthropic': 'Anthropic'
            };

            for (let [key, name] of Object.entries(providers)) {
                let item = new PopupMenu.PopupMenuItem(name);
                item.connect('activate', () => {
                    this._settings.set_string('provider', key);
                });
                this._providerItems[key] = item;
                this._providerMenu.menu.addMenuItem(item);
            }

            this._syncProvider();
            this._settings.connect('changed::provider', () => this._syncProvider());

            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            // History Section
            this._historySection = new PopupMenu.PopupMenuSection();
            this.menu.addMenuItem(this._historySection);

            this.menu.connect('open-state-changed', (menu, open) => {
                if (open) {
                    this._updateHistoryMenu();
                }
            });
        }

        _syncProvider() {
            let current = this._settings.get_string('provider');
            for (let [key, item] of Object.entries(this._providerItems)) {
                item.setOrnament(current === key ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NONE);
            }
        }

        _updateHistoryMenu() {
            this._historySection.removeAll();
            let arr = HistoryManager.load();

            if (arr.length === 0) {
                let emptyItem = new PopupMenu.PopupMenuItem('No history', { reactive: false });
                this._historySection.addMenuItem(emptyItem);
                return;
            }

            let historyTitle = new PopupMenu.PopupSeparatorMenuItem('Recent Chats');
            this._historySection.addMenuItem(historyTitle);

            for (let i = 0; i < Math.min(arr.length, 5); i++) {
                let entry = arr[i];
                let item = new PopupMenu.PopupBaseMenuItem();

                let titleLabel = new St.Label({
                    text: entry.title,
                    x_expand: true,
                    y_align: Clutter.ActorAlign.CENTER
                });
                titleLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
                item.add_child(titleLabel);

                let loadBtn = new St.Button({
                    child: new St.Icon({ icon_name: 'document-open-symbolic', style_class: 'popup-menu-icon' }),
                    style_class: 'katab-history-load-btn',
                    can_focus: true,
                    y_align: Clutter.ActorAlign.CENTER,
                    x_align: Clutter.ActorAlign.CENTER
                });
                loadBtn.connect('clicked', () => {
                    this.menu.close();
                    if (!this._extension._dialog) this._extension.toggleDialog();
                    if (!this._extension._dialog.isOpen) this._extension._dialog.open();
                    this._extension._dialog._loadConversation(entry);
                });
                item.add_child(loadBtn);

                let deleteBtn = new St.Button({
                    child: new St.Icon({ icon_name: 'user-trash-symbolic', style_class: 'popup-menu-icon' }),
                    style_class: 'katab-history-delete-btn',
                    can_focus: true,
                    y_align: Clutter.ActorAlign.CENTER,
                    x_align: Clutter.ActorAlign.CENTER
                });
                // Avoid bubbling the clicked event to the main item
                deleteBtn.connect('clicked', () => {
                    HistoryManager.deleteConversation(entry.id);
                    this._updateHistoryMenu();
                });
                item.add_child(deleteBtn);

                item.connect('activate', () => {
                    this.menu.close();
                    if (!this._extension._dialog) this._extension.toggleDialog();
                    if (!this._extension._dialog.isOpen) this._extension._dialog.open();
                    this._extension._dialog._loadConversation(entry);
                });

                this._historySection.addMenuItem(item);
            }
        }
    });

export default class KatabExtension extends Extension {
    enable() {
        this._indicator = new Indicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
        this._dialog = null;
    }

    disable() {
        if (this._dialog) {
            this._dialog.destroy();
            this._dialog = null;
        }
        this._indicator.destroy();
        this._indicator = null;
    }

    toggleDialog() {
        if (!this._dialog) {
            this._dialog = new KatabDialog(this);
        }

        if (this._dialog.isOpen) {
            this._dialog.close();
        } else {
            this._dialog.open();
        }
    }
}
