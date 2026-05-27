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

    static saveConversation(messageHistory) {
        let userMsgs = messageHistory.filter(m => m.role === 'user');
        if (userMsgs.length === 0) return;

        let title = userMsgs[0].content.slice(0, 60);
        if (userMsgs[0].content.length > 60) title += '…';

        let entry = {
            id: `conv_${Date.now()}`,
            title: title,
            timestamp: Math.floor(Date.now() / 1000),
            messages: [...messageHistory],
        };

        let arr = this.load();
        arr.unshift(entry);
        if (arr.length > 50) arr.length = 50;
        this.save(arr);
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

        this._settings.connect('changed::provider', () => {
            this._currentProvider = this._settings.get_string('provider');
            this._addSystemMessage(`Switched engine to ${this._currentProvider === 'ollama' ? 'Ollama (Local)' : this._currentProvider === 'unsloth' ? 'Unsloth Studio' : this._currentProvider}.`);
        });

        this._monitorChangedId = 0;
        this.isOpen = false;
        this._messageHistory = [];
        this._soupSession = new Soup.Session();
        this._soupSession.timeout = 30; // 30 seconds
        this._cancellable = null;

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

        this._entry = new St.Entry({
            hint_text: 'Ask Katab (Punjabi book of knowledge)...',
            style_class: 'katab-prompt-entry',
            can_focus: true,
            x_expand: true,
        });
        footerBox.add_child(this._entry);

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
    }

    open() {
        if (!this.actor.get_parent()) {
            Main.layoutManager.addTopChrome(this.actor, { trackFullscreen: true });
        }
        this._syncGeometry();
        this.actor.show();
        this.isOpen = true;
        this._entry.grab_key_focus();
        return true;
    }

    close() {
        this._cancelStream();
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

    _saveCurrentConversation() {
        HistoryManager.saveConversation(this._messageHistory);
    }

    _deleteConversation(id) {
        HistoryManager.deleteConversation(id);
    }

    _loadConversation(entry) {
        this._cancelStream();
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
        this._entry.grab_key_focus();
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
        this._messageHistory = [];
        this._chatContainer.destroy_all_children();
        this._showChatView();
        this._addWelcomeMessage();
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
            x_align: isUser ? Clutter.ActorAlign.END : Clutter.ActorAlign.START,
            x_expand: true,
        });

        let bubbleBox = new St.BoxLayout({
            vertical: true,
            style_class: isUser ? 'katab-chat-bubble user' : 'katab-chat-bubble assistant',
            x_expand: true,
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

        thinkButton.connect('notify::checked', () => {
            thinkLabel.visible = thinkButton.checked;
            thinkButton.label = thinkButton.checked ? 'Hide Thinking' : 'Show Thinking';
        });

        thinkWrapper.add_child(thinkButton);
        thinkWrapper.add_child(thinkLabel);
        bubbleBox.add_child(thinkWrapper);

        let contentLabel = new St.Label({
            text: text,
            style_class: 'katab-chat-content-label',
            x_expand: true,
        });
        contentLabel.clutter_text.line_wrap = true;
        contentLabel.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        contentLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        contentLabel.clutter_text.single_line_mode = false;

        bubbleBox.add_child(contentLabel);
        rowBox.add_child(bubbleBox);
        this._chatContainer.add_child(rowBox);

        this._scrollToBottom();

        return { contentLabel, thinkLabel, thinkWrapper };
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

        this._entry.set_text('');
        this._addChatMessage('You', promptText, 'user');

        this._messageHistory.push({ role: 'user', content: promptText });

        let uiElements = this._addChatMessage('Katab AI', '...', 'assistant');

        try {
            this._streamResponse(uiElements);
        } catch (e) {
            uiElements.contentLabel.set_text(`Error constructing request: ${e.message}`);
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
            if (provider === 'unsloth') {
                payload.extra_body = {
                    enable_tools: true,
                    enabled_tools: ["python", "web_search"]
                };
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
        }

        let message = Soup.Message.new('POST', endpoint);

        for (let key in headers) {
            message.get_request_headers().append(key, headers[key]);
        }

        let bodyBytes = new GLib.Bytes(JSON.stringify(payload));
        message.set_request_body_from_bytes('application/json', bodyBytes);

        let { contentLabel, thinkLabel, thinkWrapper } = uiElements;
        let accumulatedText = "";
        let accumulatedThink = "";
        let isThinking = false;

        contentLabel.set_text("Waiting for response...");
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
                    contentLabel.set_text(`Error: HTTP ${message.status_code}`);
                    return;
                }

                let dataInputStream = new Gio.DataInputStream({
                    base_stream: inputStream,
                    close_base_stream: true
                });

                this._readSSE(dataInputStream, uiElements, accumulatedText, accumulatedThink, isThinking, provider, currentCancellable, []);

            } catch (e) {
                if (currentCancellable.is_cancelled()) return;
                contentLabel.set_text(`Request Failed: ${e.message}`);
            }
        });
    }

    _readSSE(dataInputStream, uiElements, accumulatedText, accumulatedThink, isThinking, provider, cancellable, accumulatedToolCalls) {
        if (cancellable && cancellable.is_cancelled()) return;

        let { contentLabel, thinkLabel, thinkWrapper } = uiElements;
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
                        this._messageHistory.push({ role: 'assistant', content: finalContent });
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
                } else if (lineStr.startsWith('data: ')) {
                    let jsonStr = lineStr.substring(6).trim();
                    if (jsonStr && jsonStr !== '[DONE]') {
                        let parsed = JSON.parse(jsonStr);
                        if (provider === 'anthropic') {
                            if (parsed.type === 'content_block_delta' && parsed.delta && parsed.delta.text) {
                                deltaText = parsed.delta.text;
                            }
                        } else {
                            // OpenAI / Unsloth
                            if (parsed.choices && parsed.choices.length > 0) {
                                let delta = parsed.choices[0].delta;
                                if (delta && delta.content) {
                                    deltaText = delta.content;
                                }
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
                        contentLabel.set_text(accumulatedText);
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
        let { contentLabel } = uiElements;
        contentLabel.set_text("Executing requested tools...");

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
        contentLabel.set_text("Waiting for final response...");
        this._streamResponse(uiElements);
    }

    _promptOllamaPull(inputStream, model, uiElements) {
        // Need to close stream since we got a 404
        try { inputStream.close(null); } catch (e) { }

        let { contentLabel } = uiElements;
        contentLabel.set_text(`Model '${model}' not found locally.\n\nDo you want to download it now?`);

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
            contentLabel.set_text("Download cancelled.");
        });

        box.add_child(confirmBtn);
        box.add_child(cancelBtn);

        // Find the container parent of contentLabel and push the box there
        contentLabel.get_parent().add_child(box);
    }

    _pullOllamaModel(model, uiElements) {
        let { contentLabel } = uiElements;
        contentLabel.set_text(`Downloading model '${model}'... (0%)`);

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
            contentLabel.set_text("Download cancelled.");
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
                    contentLabel.set_text(`Pull Error: HTTP ${message.status_code}`);
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
                contentLabel.set_text(`Pull Failed: ${e.message}`);
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
                    contentLabel.set_text(`Model '${model}' pulled. Resuming request...`);
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
                    contentLabel.set_text(text);
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
                'unsloth': 'Unsloth Studio',
                'openai': 'OpenAI',
                'anthropic': 'Anthropic',
                'ollama': 'Ollama (Local)'
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
