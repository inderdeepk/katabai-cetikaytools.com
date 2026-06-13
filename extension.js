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
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import Soup from 'gi://Soup?version=3.0';

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {
    buildDocumentPromptBlock,
    buildMissingDocumentPromptBlock,
    DOCUMENT_TOOL_COMMAND,
    DOCUMENT_TOOL_ICON,
    DOCUMENT_TOOL_NAME,
    DocumentToolError,
    DocumentToolRuntime,
    parseDocumentCommand,
    resolveDocumentPath,
} from './documentTools.js';

const PROVIDER_TOOLS = {
    'unsloth': [
        { label: 'Web Search', command: '/search', icon: 'system-search-symbolic', toolName: 'web_search' },
        { label: 'Python', command: '/python', icon: 'applications-development-symbolic', toolName: 'python' },
        { label: 'Terminal', command: '/terminal', icon: 'utilities-terminal-symbolic', toolName: 'terminal' }
    ],
    'ollama': [],
    'openai': [],
    'anthropic': []
};

const LOCAL_TOOLS = [
    { label: 'Document', command: DOCUMENT_TOOL_COMMAND, icon: DOCUMENT_TOOL_ICON, toolName: DOCUMENT_TOOL_NAME }
];

const PROVIDER_META = {
    'ollama': { label: 'Ollama', iconFile: 'ollama.svg' },
    'unsloth': { label: 'Unsloth Studio', iconFile: 'unsloth.png' },
    'openai': { label: 'OpenAI', iconFile: 'openai.svg' },
    'anthropic': { label: 'Anthropic', iconFile: 'claude.svg' },
};

const PROVIDER_LABELS = Object.fromEntries(
    Object.entries(PROVIDER_META).map(([provider, meta]) => [provider, meta.label])
);

const PROVIDER_ICON_STYLE_CLASSES = Object.keys(PROVIDER_META)
    .map(provider => `katab-provider-icon-${provider}`);

const PROVIDER_STATUS = {
    CHECKING: 'checking',
    ONLINE: 'online',
    DOWN: 'down',
    NEEDS_SETUP: 'needs-setup'
};

const PROVIDER_STATUS_STYLE_CLASSES = Object.values(PROVIDER_STATUS)
    .map(status => `katab-provider-status-${status}`);

const PROVIDER_STATUS_POLL_MS = 15000;
const PROVIDER_STATUS_TIMEOUT_SECONDS = 8;
const PROMPT_INPUT_MIN_HEIGHT = 44;
const PROMPT_INPUT_MAX_HEIGHT = 220;
const PROMPT_INPUT_VERTICAL_PADDING = 20;
const PROMPT_INPUT_SCROLL_STEP = 36;

function getProviderLabel(provider) {
    return PROVIDER_META[provider]?.label || provider;
}

function getProviderIconPath(extensionPath, provider) {
    let iconFile = PROVIDER_META[provider]?.iconFile;
    if (!iconFile) {
        return null;
    }

    return `${extensionPath}/icons/${iconFile}`;
}

function syncProviderIconClasses(actor, provider) {
    if (!actor) {
        return;
    }

    for (let className of PROVIDER_ICON_STYLE_CLASSES) {
        actor.remove_style_class_name(className);
    }

    if (provider && PROVIDER_META[provider]) {
        actor.add_style_class_name(`katab-provider-icon-${provider}`);
    }
}

function setProviderIcon(actor, provider, extensionPath, fallbackIconName = 'applications-science-symbolic') {
    if (!actor) {
        return;
    }

    syncProviderIconClasses(actor, provider);

    let iconPath = getProviderIconPath(extensionPath, provider);
    if (iconPath) {
        actor.gicon = Gio.icon_new_for_string(iconPath);
        return;
    }

    actor.gicon = null;
    actor.icon_name = fallbackIconName;
}

function createProviderIcon(provider, extensionPath, styleClass, fallbackIconName = 'applications-science-symbolic') {
    let icon = new St.Icon({
        style_class: styleClass,
        y_align: Clutter.ActorAlign.CENTER,
    });
    setProviderIcon(icon, provider, extensionPath, fallbackIconName);
    return icon;
}

function getProviderStatusText(status) {
    if (status === PROVIDER_STATUS.ONLINE) {
        return 'Online';
    }
    if (status === PROVIDER_STATUS.DOWN) {
        return 'Down';
    }
    if (status === PROVIDER_STATUS.NEEDS_SETUP) {
        return 'Needs setup';
    }
    return 'Checking';
}

function syncProviderStatusClasses(actor, status) {
    if (!actor) {
        return;
    }

    for (let className of PROVIDER_STATUS_STYLE_CLASSES) {
        actor.remove_style_class_name(className);
    }

    actor.add_style_class_name(`katab-provider-status-${status}`);
}

function trimTrailingSlash(value) {
    let next = `${value || ''}`.trim();
    while (next.length > 1 && next.endsWith('/')) {
        next = next.slice(0, -1);
    }
    return next;
}

function joinUrl(baseUrl, path) {
    let base = trimTrailingSlash(baseUrl);
    let suffix = `${path || ''}`;
    if (!suffix.startsWith('/')) {
        suffix = `/${suffix}`;
    }
    return `${base}${suffix}`;
}

function getProviderBaseUrl(provider, rawUrl) {
    let baseUrl = trimTrailingSlash(rawUrl);
    if (!baseUrl) {
        return '';
    }

    if (provider !== 'ollama' && baseUrl.endsWith('/v1')) {
        return baseUrl.slice(0, -3);
    }

    return baseUrl;
}

function getProviderConfig(settings, provider = null) {
    let activeProvider = provider || settings.get_string('provider');
    let baseUrl = '';
    let apiKey = '';
    let model = '';

    try {
        baseUrl = getProviderBaseUrl(activeProvider, settings.get_string(`${activeProvider}-url`));
    } catch (_e) {
    }

    if (activeProvider !== 'ollama') {
        try {
            apiKey = settings.get_string(`${activeProvider}-api-key`).trim();
        } catch (_e) {
        }
    }

    try {
        model = settings.get_string(`${activeProvider}-model`).trim();
    } catch (_e) {
    }

    return {
        provider: activeProvider,
        label: getProviderLabel(activeProvider),
        baseUrl,
        apiKey,
        model,
    };
}

function decodeBytes(bytes) {
    if (!bytes) {
        return '';
    }

    let data = bytes.get_data();
    if (!data) {
        return '';
    }

    return new TextDecoder('utf-8').decode(data).trim();
}

function extractErrorSummary(responseBody) {
    if (!responseBody) {
        return '';
    }

    try {
        let parsed = JSON.parse(responseBody);
        if (typeof parsed.error === 'string' && parsed.error.trim()) {
            return parsed.error.trim();
        }
        if (typeof parsed.message === 'string' && parsed.message.trim()) {
            return parsed.message.trim();
        }
    } catch (_e) {
    }

    let firstLine = responseBody.split('\n').map(line => line.trim()).find(Boolean);
    return firstLine || '';
}

class ProviderHealthMonitor {
    constructor(extension) {
        this._extension = extension;
        this._settings = extension.getSettings('org.gnome.shell.extensions.katabai');
        this._listeners = new Set();
        this._soupSession = new Soup.Session();
        this._soupSession.timeout = PROVIDER_STATUS_TIMEOUT_SECONDS;
        this._cancellables = new Map();
        this._refreshSerials = new Map();
        this._pollSourceId = 0;
        this._states = new Map();

        for (let provider of Object.keys(PROVIDER_LABELS)) {
            this._states.set(provider, this._getInitialState(provider));
        }

        this._settingsChangedId = this._settings.connect('changed', (_settings, key) => {
            if (!key || !this._shouldRefreshForKey(key)) {
                return;
            }

            if (key === 'provider') {
                this._emit();
                this.refresh({ immediate: true });
                return;
            }

            let provider = this._getProviderFromKey(key);
            if (provider) {
                this.refresh({ provider, immediate: true });
            }
        });
    }

    _shouldRefreshForKey(key) {
        return key === 'provider' || key.endsWith('-url') || key.endsWith('-api-key') || key.endsWith('-model');
    }

    _getProviderFromKey(key) {
        return Object.keys(PROVIDER_LABELS).find(provider => key.startsWith(`${provider}-`)) || null;
    }

    _buildState({ provider, status, detail = '', lastChecked = 0 }) {
        return {
            provider,
            label: getProviderLabel(provider),
            status,
            detail,
            lastChecked,
        };
    }

    _getInitialState(provider) {
        let config = getProviderConfig(this._settings, provider);
        return this._getSetupState(config) || this._buildState({
            provider,
            status: PROVIDER_STATUS.CHECKING,
            detail: `Check ${getProviderLabel(provider)} availability.`,
            lastChecked: 0,
        });
    }

    _emit() {
        let activeState = this.getState();
        let allStates = this.getAllStates();
        for (let listener of this._listeners) {
            listener(activeState, allStates);
        }
    }

    _setProviderState(nextState) {
        let previous = this._states.get(nextState.provider);
        if (previous
            && previous.provider === nextState.provider
            && previous.status === nextState.status
            && previous.detail === nextState.detail
            && previous.lastChecked === nextState.lastChecked) {
            return;
        }

        this._states.set(nextState.provider, nextState);
        this._emit();
    }

    _scheduleNextPoll(delayMs = PROVIDER_STATUS_POLL_MS) {
        if (this._pollSourceId) {
            GLib.source_remove(this._pollSourceId);
        }

        this._pollSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delayMs, () => {
            this._pollSourceId = 0;
            this.refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    _getSetupState(config) {
        if (!config.baseUrl) {
            return this._buildState({
                provider: config.provider,
                status: PROVIDER_STATUS.NEEDS_SETUP,
                detail: 'Set the provider URL.',
                lastChecked: Date.now(),
            });
        }

        if ((config.provider === 'openai' || config.provider === 'anthropic') && !config.apiKey) {
            return this._buildState({
                provider: config.provider,
                status: PROVIDER_STATUS.NEEDS_SETUP,
                detail: 'Add the API key.',
                lastChecked: Date.now(),
            });
        }

        return null;
    }

    _buildProbe(config) {
        if (config.provider === 'ollama') {
            return {
                method: 'GET',
                url: joinUrl(config.baseUrl, '/api/tags'),
                headers: {},
                body: null,
            };
        }

        if (config.provider === 'unsloth') {
            let headers = {};
            if (config.apiKey) {
                headers['Authorization'] = `Bearer ${config.apiKey}`;
            }
            return {
                method: 'POST',
                url: joinUrl(config.baseUrl, '/tokenize'),
                headers,
                body: { content: 'ping' },
            };
        }

        if (config.provider === 'openai') {
            return {
                method: 'GET',
                url: joinUrl(config.baseUrl, '/v1/models'),
                headers: {
                    'Authorization': `Bearer ${config.apiKey}`,
                },
                body: null,
            };
        }

        return {
            method: 'GET',
            url: joinUrl(config.baseUrl, '/v1/models'),
            headers: {
                'x-api-key': config.apiKey,
                'anthropic-version': '2023-06-01',
            },
            body: null,
        };
    }

    async _probeProvider(config, cancellable) {
        let probe = this._buildProbe(config);
        let message = Soup.Message.new(probe.method, probe.url);
        for (let [key, value] of Object.entries(probe.headers)) {
            if (value) {
                message.get_request_headers().append(key, value);
            }
        }

        if (probe.body !== null) {
            message.set_request_body_from_bytes(
                'application/json',
                new GLib.Bytes(new TextEncoder().encode(JSON.stringify(probe.body)))
            );
        }

        let bytes = await new Promise((resolve, reject) => {
            this._soupSession.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable, (session, res) => {
                try {
                    resolve(session.send_and_read_finish(res));
                } catch (e) {
                    reject(e);
                }
            });
        });

        if (message.status_code < 200 || message.status_code >= 300) {
            let responseBody = decodeBytes(bytes);
            let summary = extractErrorSummary(responseBody);
            if (summary) {
                throw new Error(`HTTP ${message.status_code}: ${summary}`);
            }
            throw new Error(`HTTP ${message.status_code}`);
        }
    }

    _cancelRefresh(provider) {
        let cancellable = this._cancellables.get(provider);
        if (!cancellable) {
            return;
        }

        cancellable.cancel();
        this._cancellables.delete(provider);
    }

    getState(provider = null) {
        let targetProvider = provider || this._settings.get_string('provider');
        if (!this._states.has(targetProvider)) {
            this._states.set(targetProvider, this._getInitialState(targetProvider));
        }

        return { ...this._states.get(targetProvider) };
    }

    getAllStates() {
        let states = {};
        for (let provider of Object.keys(PROVIDER_LABELS)) {
            states[provider] = this.getState(provider);
        }
        return states;
    }

    subscribe(listener) {
        this._listeners.add(listener);
        listener(this.getState(), this.getAllStates());
        return listener;
    }

    unsubscribe(listener) {
        this._listeners.delete(listener);
    }

    markRequestSuccess(provider, detail = 'Provider reachable.') {
        this._setProviderState(this._buildState({
            provider,
            status: PROVIDER_STATUS.ONLINE,
            detail,
            lastChecked: Date.now(),
        }));
        if (provider === this._settings.get_string('provider')) {
            this._scheduleNextPoll();
        }
    }

    markRequestFailure(provider, detail = 'Provider unavailable.') {
        this._setProviderState(this._buildState({
            provider,
            status: PROVIDER_STATUS.DOWN,
            detail,
            lastChecked: Date.now(),
        }));
        if (provider === this._settings.get_string('provider')) {
            this._scheduleNextPoll();
        }
    }

    async _refreshProvider(provider, { immediate = false } = {}) {
        let config = getProviderConfig(this._settings, provider);
        let setupState = this._getSetupState(config);
        let isActiveProvider = provider === this._settings.get_string('provider');

        if (setupState) {
            this._cancelRefresh(provider);
            this._setProviderState(setupState);
            if (isActiveProvider) {
                this._scheduleNextPoll();
            }
            return;
        }

        this._cancelRefresh(provider);

        let currentCancellable = new Gio.Cancellable();
        this._cancellables.set(provider, currentCancellable);

        let refreshSerial = (this._refreshSerials.get(provider) || 0) + 1;
        this._refreshSerials.set(provider, refreshSerial);

        let currentState = this.getState(provider);

        if (immediate || currentState.status === PROVIDER_STATUS.NEEDS_SETUP || !currentState.lastChecked) {
            this._setProviderState(this._buildState({
                provider: config.provider,
                status: PROVIDER_STATUS.CHECKING,
                detail: `Checking ${config.label}…`,
                lastChecked: currentState.lastChecked,
            }));
        }

        try {
            await this._probeProvider(config, currentCancellable);
            if (currentCancellable.is_cancelled() || refreshSerial !== this._refreshSerials.get(provider)) {
                return;
            }

            this._setProviderState(this._buildState({
                provider: config.provider,
                status: PROVIDER_STATUS.ONLINE,
                detail: `${config.label} is online.`,
                lastChecked: Date.now(),
            }));
        } catch (e) {
            if (currentCancellable.is_cancelled() || refreshSerial !== this._refreshSerials.get(provider)) {
                return;
            }

            this._setProviderState(this._buildState({
                provider: config.provider,
                status: PROVIDER_STATUS.DOWN,
                detail: e.message || `${config.label} is unavailable.`,
                lastChecked: Date.now(),
            }));
        } finally {
            if (this._cancellables.get(provider) === currentCancellable) {
                this._cancellables.delete(provider);
            }
            if (isActiveProvider) {
                this._scheduleNextPoll();
            }
        }
    }

    async refresh({ immediate = false, provider = null } = {}) {
        return this._refreshProvider(provider || this._settings.get_string('provider'), { immediate });
    }

    refreshAll({ immediate = false } = {}) {
        for (let provider of Object.keys(PROVIDER_LABELS)) {
            this._refreshProvider(provider, { immediate });
        }
    }

    destroy() {
        if (this._pollSourceId) {
            GLib.source_remove(this._pollSourceId);
            this._pollSourceId = 0;
        }

        for (let cancellable of this._cancellables.values()) {
            cancellable.cancel();
        }
        this._cancellables.clear();

        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = 0;
        }

        this._listeners.clear();
    }
}

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
        this._documentToolRuntime = new DocumentToolRuntime();
        this._sessionDocuments = new Map();
        this._pendingDocument = null;
        this._attachmentBox = null;
        this._attachmentLabel = null;

        this._settings.connect('changed::provider', () => {
            this._currentProvider = this._settings.get_string('provider');
            this._addSystemMessage(`Switched engine to ${getProviderLabel(this._currentProvider)}.`);
            if (this._toolsBox) this._updateToolButtons();
            setProviderIcon(this._providerStatusIcon, this._currentProvider, this._extension.path);
            if (this._extension.providerHealthMonitor) {
                this._extension.providerHealthMonitor.refresh({ immediate: true });
            }

            // Re-fetch context size when switching providers
            this._maxContextSize = 0;
            this._fetchMaxContext();
        });
        this._settings.connect('changed::document-tool-enabled', () => {
            if (!this._isDocumentToolEnabled()) {
                this._pendingDocument = null;
                this._sessionDocuments.clear();
                this._updatePendingDocumentUI();
            }

            if (this._toolsBox) {
                this._updateToolButtons();
            }
        });

        this._interfaceSettings = null;
        this._themeChangedId = 0;
        try {
            this._interfaceSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
        } catch (_e) { /* schema not available */ }

        this._monitorChangedId = 0;
        this.isOpen = false;
        this._messageHistory = [];
        this._soupSession = new Soup.Session();
        this._soupSession.timeout = 30; // 30 seconds
        this._cancellable = null;
        this._isStreaming = false;
        this._activeResponseState = null;
        this._sendBtn = null;
        this._sendIcon = null;

        this._maxContextSize = 0;
        this._currentUsage = 0;
        this._draftUsage = 0;
        this._tokenUpdateTimeout = 0;
        this._promptScrollFollowIdleId = 0;
        this._hasConversationStarted = false;
        this._welcomePanel = null;
        this._welcomeStage = null;
        this._messageList = null;
        this._welcomeAura = null;
        this._welcomePageActors = [];
        this._welcomeDustActors = [];
        this._welcomeAnimationLoopId = 0;
        this._welcomeAnimationSourceIds = [];

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

        this._applyDialogTheme();
        if (this._interfaceSettings) {
            this._themeChangedId = this._interfaceSettings.connect('changed::color-scheme', () => this._applyDialogTheme());
        }

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

        this._providerHealthListener = null;
        if (this._extension.providerHealthMonitor) {
            this._providerHealthListener = state => this._renderProviderStatus(state);
            this._extension.providerHealthMonitor.subscribe(this._providerHealthListener);
        }
    }

    hasCurrentChat() {
        return this._messageHistory.length > 0
            || Boolean(this._currentConversationId)
            || Boolean(this._activeResponseState);
    }

    getCurrentChatState() {
        let userMessage = this._messageHistory.find(message =>
            message.role === 'user'
            && typeof message.content === 'string'
            && message.content.trim()
        );

        let available = this.hasCurrentChat();
        let status = 'empty';
        if (this._isStreaming) {
            status = 'replying';
        } else if (available && this.isOpen) {
            status = 'open';
        } else if (available) {
            status = 'ready';
        }

        return {
            available,
            conversationId: this._currentConversationId,
            isOpen: this.isOpen,
            isStreaming: this._isStreaming,
            status,
            title: userMessage
                ? this._truncateText(userMessage.content.replace(/\s+/g, ' ').trim(), 44)
                : 'Current Chat',
        };
    }

    focusPrompt() {
        if (this._entry) {
            this._entry.grab_key_focus();
        }
    }

    _notifyCurrentChatChanged() {
        this._extension.notifyCurrentChatChanged();
    }

    _setStreamingState(isStreaming) {
        if (this._isStreaming === isStreaming) {
            return;
        }

        this._isStreaming = isStreaming;
        this._updateSendButton();
        this._notifyCurrentChatChanged();
    }

    _clearActiveResponseState() {
        this._activeResponseState = null;
        this._setStreamingState(false);
    }

    _buildAssistantHistoryMessage(content, assistantMeta = null) {
        let assistantMessage = { role: 'assistant', content };
        if (assistantMeta && assistantMeta.provider && assistantMeta.metrics) {
            assistantMessage.provider = assistantMeta.provider;
            assistantMessage.metrics = assistantMeta.metrics;
        }

        return assistantMessage;
    }

    _beginActiveResponse(uiElements, provider, mode = 'response', modelName = null) {
        this._activeResponseState = {
            accumulatedText: '',
            accumulatedThink: '',
            accumulatedToolCalls: [],
            assistantMeta: null,
            isThinking: false,
            mode,
            modelName,
            provider,
            uiElements,
        };
        this._setStreamingState(true);
        return this._activeResponseState;
    }

    _updateSendButton() {
        if (!this._sendBtn || !this._sendIcon) {
            return;
        }

        if (this._isStreaming) {
            this._sendBtn.add_style_class_name('katab-send-btn-stop');
            this._sendIcon.icon_name = 'process-stop-symbolic';
        } else {
            this._sendBtn.remove_style_class_name('katab-send-btn-stop');
            this._sendIcon.icon_name = 'mail-send-symbolic';
        }
    }

    _stopActiveResponse() {
        if (!this._cancellable) {
            return;
        }

        let responseState = this._activeResponseState;
        this._cancelStream({ clearState: false });

        if (!responseState) {
            this._clearActiveResponseState();
            return;
        }

        let { accumulatedText, accumulatedThink, accumulatedToolCalls, assistantMeta, mode, modelName, uiElements } = responseState;
        let finalContent = accumulatedText;
        let stopNotice = mode === 'pull' && modelName
            ? `Stopped while downloading model '${modelName}'.`
            : mode === 'document' && modelName
                ? `Stopped while preparing '${modelName}'.`
                : 'Response stopped.';

        if (!finalContent) {
            if (mode === 'pull' && modelName) {
                finalContent = stopNotice;
            } else if (accumulatedThink) {
                finalContent = 'Response stopped while the model was thinking.';
            } else if (accumulatedToolCalls.length > 0) {
                finalContent = 'Response stopped before tool execution completed.';
            } else {
                finalContent = stopNotice;
            }
        }

        this._applyAssistantRender(uiElements, finalContent, {
            final: true,
            plain: mode === 'pull',
        });
        this._messageHistory.push(this._buildAssistantHistoryMessage(finalContent, assistantMeta));
        this._saveCurrentConversation();
        this._clearActiveResponseState();

        if (accumulatedText) {
            this._addSystemMessage(stopNotice);
        }
    }

    _cancelStream({ clearState = true } = {}) {
        if (this._cancellable) {
            this._cancellable.cancel();
            this._cancellable = null;
        }

        if (clearState) {
            this._clearActiveResponseState();
        }
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

    _queuePromptScrollToBottom() {
        if (!this._promptScroll) {
            return;
        }

        if (this._promptScrollFollowIdleId) {
            GLib.source_remove(this._promptScrollFollowIdleId);
        }

        this._promptScrollFollowIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._promptScrollFollowIdleId = 0;

            if (!this._promptScroll) {
                return GLib.SOURCE_REMOVE;
            }

            let adjustment = this._promptScroll.vadjustment;
            if (!adjustment) {
                return GLib.SOURCE_REMOVE;
            }

            adjustment.set_value(Math.max(adjustment.lower, adjustment.upper - adjustment.page_size));
            return GLib.SOURCE_REMOVE;
        });
    }

    _syncPromptHintVisibility() {
        if (!this._entryHint || !this._entry) {
            return;
        }

        this._entryHint.visible = !(this._entry.get_text?.() ?? this._entry.text ?? '');
    }

    _syncPromptScrollHeight() {
        if (!this._promptScroll || !this._promptEditor) {
            return;
        }

        let forWidth = this._promptScroll.width > 0 ? this._promptScroll.width : -1;
        let contentHeight = PROMPT_INPUT_MIN_HEIGHT;

        try {
            let labelWidth = forWidth > 0
                ? Math.max(1, forWidth - PROMPT_INPUT_VERTICAL_PADDING)
                : -1;
            let [, preferredHeight] = this._entry.get_preferred_height(labelWidth);
            if (preferredHeight > 0) {
                contentHeight = Math.max(PROMPT_INPUT_MIN_HEIGHT, preferredHeight + PROMPT_INPUT_VERTICAL_PADDING);
            }
        } catch (_e) {
            contentHeight = PROMPT_INPUT_MIN_HEIGHT;
        }

        this._promptEditor.set_height(contentHeight);
        this._promptScroll.set_height(Math.max(PROMPT_INPUT_MIN_HEIGHT, Math.min(PROMPT_INPUT_MAX_HEIGHT, contentHeight)));
    }

    _scrollPromptBy(delta) {
        if (!this._promptScroll) {
            return Clutter.EVENT_PROPAGATE;
        }

        let adjustment = this._promptScroll.vadjustment;
        if (!adjustment) {
            return Clutter.EVENT_PROPAGATE;
        }

        let maxValue = Math.max(adjustment.lower, adjustment.upper - adjustment.page_size);
        if (maxValue <= adjustment.lower) {
            return Clutter.EVENT_PROPAGATE;
        }

        adjustment.set_value(Math.max(adjustment.lower, Math.min(maxValue, adjustment.value + delta)));
        return Clutter.EVENT_STOP;
    }

    _handlePromptScrollEvent(_actor, event) {
        let direction = event.get_scroll_direction();

        if (direction === Clutter.ScrollDirection.UP) {
            return this._scrollPromptBy(-PROMPT_INPUT_SCROLL_STEP);
        }

        if (direction === Clutter.ScrollDirection.DOWN) {
            return this._scrollPromptBy(PROMPT_INPUT_SCROLL_STEP);
        }

        if (direction === Clutter.ScrollDirection.SMOOTH) {
            let [, deltaY] = event.get_scroll_delta();
            if (deltaY !== 0) {
                return this._scrollPromptBy(deltaY * PROMPT_INPUT_SCROLL_STEP);
            }
        }

        return Clutter.EVENT_PROPAGATE;
    }

    _releasePromptFocus() {
        if (!this._entry) {
            return;
        }

        let keyFocus = global.stage.get_key_focus();
        if (keyFocus !== this._entry) {
            return;
        }

        if (this.dialogLayout && this.dialogLayout.can_focus) {
            this.dialogLayout.grab_key_focus();
        }
    }

    _renderProviderStatus(state) {
        if (!this._providerStatusBox || !this._providerStatusLabel || !this._providerStatusDot) {
            return;
        }

        this._providerStatusBox.visible = true;
        setProviderIcon(this._providerStatusIcon, state.provider, this._extension.path);
        this._providerStatusLabel.set_text(`${state.label} ${getProviderStatusText(state.status)}`);
        syncProviderStatusClasses(this._providerStatusBox, state.status);
        syncProviderStatusClasses(this._providerStatusLabel, state.status);
        syncProviderStatusClasses(this._providerStatusDot, state.status);
    }

    _disconnectProviderStatus() {
        if (this._providerHealthListener && this._extension.providerHealthMonitor) {
            this._extension.providerHealthMonitor.unsubscribe(this._providerHealthListener);
        }
        this._providerHealthListener = null;
    }

    _isDocumentToolEnabled() {
        return this._settings.get_boolean('document-tool-enabled');
    }

    _getProviderTools() {
        return PROVIDER_TOOLS[this._currentProvider] || [];
    }

    _getLocalTools() {
        return LOCAL_TOOLS;
    }

    _getAvailableTools() {
        return [...this._getLocalTools(), ...this._getProviderTools()];
    }

    _rememberSessionDocument(document) {
        if (!document?.path) {
            return;
        }

        this._sessionDocuments.set(document.path, document);
    }

    _serializeDocumentMeta(document) {
        return {
            displayName: document.displayName,
            extension: document.extension,
            originalCharCount: document.originalCharCount,
            parserName: document.parserName,
            path: document.path,
            truncated: Boolean(document.truncated),
        };
    }

    _buildDocumentMeta(path) {
        const resolvedPath = resolveDocumentPath(path);
        if (!resolvedPath) {
            return null;
        }

        return {
            displayName: GLib.path_get_basename(resolvedPath),
            path: resolvedPath,
        };
    }

    _setPendingDocument(documentMeta) {
        this._pendingDocument = documentMeta;
        this._updatePendingDocumentUI();
    }

    _updatePendingDocumentUI() {
        if (!this._attachmentBox || !this._attachmentLabel) {
            return;
        }

        if (!this._pendingDocument || !this._isDocumentToolEnabled()) {
            this._attachmentBox.hide();
            this._attachmentLabel.set_text('');
            return;
        }

        let label = `Document ready: ${this._pendingDocument.displayName}`;
        if (this._pendingDocument.path) {
            label = `${label} • ${this._pendingDocument.path}`;
        }

        this._attachmentLabel.set_text(label);
        this._attachmentBox.show();
    }

    _formatUserMessageDisplay(message) {
        const content = String(message?.content ?? '').trim();
        const documents = Array.isArray(message?.documents) ? message.documents : [];
        if (!documents.length) {
            return content;
        }

        const prefix = documents.length === 1
            ? `Attached document: ${documents[0].displayName}`
            : `Attached documents: ${documents.map(document => document.displayName).join(', ')}`;

        return content ? `${content}\n\n${prefix}` : prefix;
    }

    _buildApiMessageContent(message) {
        let content = String(message?.content ?? '');
        const documents = Array.isArray(message?.documents) ? message.documents : [];
        if (!documents.length) {
            return content;
        }

        const documentBlocks = documents.map(documentMeta => {
            const sessionDocument = documentMeta?.path ? this._sessionDocuments.get(documentMeta.path) : null;
            if (sessionDocument) {
                return buildDocumentPromptBlock(sessionDocument);
            }

            return buildMissingDocumentPromptBlock(documentMeta);
        }).filter(Boolean);

        if (!documentBlocks.length) {
            return content;
        }

        if (!content) {
            return documentBlocks.join('\n\n');
        }

        return `${content}\n\n${documentBlocks.join('\n\n')}`;
    }

    async _openDocumentPicker() {
        const connection = Gio.DBus.session;
        const handleToken = `katab${GLib.uuid_string_random().replace(/-/g, '')}`;
        const options = {
            handle_token: new GLib.Variant('s', handleToken),
            modal: new GLib.Variant('b', true),
            multiple: new GLib.Variant('b', false),
        };

        return await new Promise((resolve, reject) => {
            connection.call(
                'org.freedesktop.portal.Desktop',
                '/org/freedesktop/portal/desktop',
                'org.freedesktop.portal.FileChooser',
                'OpenFile',
                new GLib.Variant('(ssa{sv})', ['', 'Attach a document for Katab', options]),
                new GLib.VariantType('(o)'),
                Gio.DBusCallFlags.NONE,
                -1,
                null,
                (source, result) => {
                    try {
                        const [requestPath] = source.call_finish(result).deepUnpack();
                        let subscriptionId = 0;
                        subscriptionId = source.signal_subscribe(
                            'org.freedesktop.portal.Desktop',
                            'org.freedesktop.portal.Request',
                            'Response',
                            requestPath,
                            null,
                            Gio.DBusSignalFlags.NONE,
                            (_connection, _senderName, _objectPath, _interfaceName, _signalName, parameters) => {
                                source.signal_unsubscribe(subscriptionId);
                                const [responseCode, responseData] = parameters.deepUnpack();
                                if (responseCode !== 0) {
                                    resolve(null);
                                    return;
                                }

                                const uris = Array.isArray(responseData.uris)
                                    ? responseData.uris
                                    : responseData.uris?.deepUnpack?.() || [];
                                if (!uris.length) {
                                    resolve(null);
                                    return;
                                }

                                const file = Gio.File.new_for_uri(uris[0]);
                                const path = file.get_path();
                                if (!path) {
                                    reject(new DocumentToolError('Katab can only attach local files from the picker right now. Choose a local file or use /doc with an absolute path.', {
                                        code: 'non-local-picked-file',
                                    }));
                                    return;
                                }

                                resolve(path);
                            }
                        );
                    } catch (error) {
                        reject(new DocumentToolError('The document picker is unavailable. Use /doc "absolute/path/to/file" instead.', {
                            code: 'picker-unavailable',
                        }));
                    }
                }
            );
        });
    }

    async _pickDocumentPath() {
        const shouldRestoreDialog = this.isOpen;

        if (shouldRestoreDialog) {
            this.close({ cancelStream: false, saveConversation: true });
        }

        try {
            return await this._openDocumentPicker();
        } finally {
            if (shouldRestoreDialog) {
                this.open();
                this._updatePendingDocumentUI();
            }
        }
    }

    async _pickDocumentForAttachment() {
        if (!this._isDocumentToolEnabled()) {
            this._addSystemMessage('Enable the Document Tool in Settings before attaching a file.');
            return;
        }

        try {
            const pickedPath = await this._pickDocumentPath();
            if (!pickedPath) {
                return;
            }

            const documentMeta = this._buildDocumentMeta(pickedPath);
            if (!documentMeta) {
                throw new DocumentToolError('Katab could not resolve that file path. Use a local file and try again.', {
                    code: 'invalid-picked-path',
                });
            }

            this._setPendingDocument(documentMeta);
            if (this.isOpen) {
                this.focusPrompt();
            }
        } catch (error) {
            const message = error instanceof DocumentToolError
                ? error.message
                : `Could not attach a document: ${error.message}`;
            this._addSystemMessage(message);
        }
    }

    _updateToolButtons() {
        if (!this._toolsBox) return;
        this._toolsBox.destroy_all_children();

        const tools = this._getAvailableTools();
        for (const tool of tools) {
            const documentToolDisabled = tool.toolName === DOCUMENT_TOOL_NAME && !this._isDocumentToolEnabled();
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

            if (documentToolDisabled) {
                btn.add_style_class_name('katab-tool-btn-disabled');
            }

            btn.connect('clicked', async () => {
                if (tool.toolName === DOCUMENT_TOOL_NAME) {
                    if (!this._isDocumentToolEnabled()) {
                        this._addSystemMessage('Document tool is available, but it is currently off. Enable it in Settings > Tools to use the chat button or /doc command.');
                        return;
                    }

                    await this._pickDocumentForAttachment();
                    return;
                }

                let currentText = this._entry.get_text().trim();
                // Add the slash command, appending to existing text if any, or just starting it
                if (currentText && !currentText.includes(tool.command)) {
                    this._entry.set_text(currentText + ' ' + tool.command + ' ');
                } else {
                    this._entry.set_text(tool.command + ' ');
                }
                this.focusPrompt();
                // move cursor to end
                this._entry.set_cursor_position(-1);
            });
            this._toolsBox.add_child(btn);
        }
    }

    _resolveIsDark() {
        try {
            if (this._interfaceSettings) {
                const scheme = this._interfaceSettings.get_string('color-scheme');
                return scheme === 'prefer-dark';
            }
        } catch (_e) { /* fall through */ }
        return true;
    }

    _applyDialogTheme() {
        const isDark = this._resolveIsDark();
        this.actor.remove_style_class_name('katab-theme-dark');
        this.actor.remove_style_class_name('katab-theme-light');
        this.actor.add_style_class_name(isDark ? 'katab-theme-dark' : 'katab-theme-light');
        this._applyPromptTextColor();
    }

    _applyPromptTextColor() {
        if (!this._entry) {
            return;
        }

        const isDark = this._resolveIsDark();
        const [r, g, b, a] = isDark
            ? [255, 255, 255, 255]
            : [20, 20, 20, 210];

        this._entry.color = new Clutter.Color({ red: r, green: g, blue: b, alpha: a });
        this._entry.cursor_color = new Clutter.Color({ red: r, green: g, blue: b, alpha: 230 });
        this._entry.selected_text_color = new Clutter.Color({ red: r, green: g, blue: b, alpha: 255 });
        this._entry.selection_color = new Clutter.Color({ red: r, green: g, blue: b, alpha: 80 });
        this._entry.font_name = 'Sans 10';
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

        this._providerStatusBox = new St.BoxLayout({
            style_class: 'katab-provider-status-box',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });

        this._providerStatusIcon = createProviderIcon(
            this._currentProvider,
            this._extension.path,
            'katab-provider-badge-icon katab-provider-status-icon'
        );
        this._providerStatusBox.add_child(this._providerStatusIcon);

        this._providerStatusLabel = new St.Label({
            text: '',
            style_class: 'katab-provider-status-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._providerStatusBox.add_child(this._providerStatusLabel);

        this._providerStatusDot = new St.Widget({
            style_class: 'katab-provider-status-indicator',
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._providerStatusBox.add_child(this._providerStatusDot);
        headerBox.add_child(this._providerStatusBox);

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
            this.close();
            this._extension.showPreferences();
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

        this._welcomePanel = this._buildWelcomePanel();
        this._chatContainer.add_child(this._welcomePanel);

        this._messageList = new St.BoxLayout({
            vertical: true,
            style_class: 'katab-chat-message-list',
            x_expand: true,
        });
        this._chatContainer.add_child(this._messageList);

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

        this._attachmentBox = new St.BoxLayout({
            style_class: 'katab-attachment-box',
            vertical: false,
            visible: false,
        });
        this.contentLayout.add_child(this._attachmentBox);

        let attachmentIcon = new St.Icon({
            icon_name: 'text-x-generic-symbolic',
            style_class: 'katab-attachment-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._attachmentBox.add_child(attachmentIcon);

        this._attachmentLabel = new St.Label({
            text: '',
            style_class: 'katab-attachment-label',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._attachmentBox.add_child(this._attachmentLabel);

        let clearAttachmentBtn = new St.Button({
            label: 'Remove',
            style_class: 'katab-attachment-remove-btn',
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        clearAttachmentBtn.connect('clicked', () => this._setPendingDocument(null));
        this._attachmentBox.add_child(clearAttachmentBtn);

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

        this._promptScroll = new St.ScrollView({
            style_class: 'katab-prompt-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            height: PROMPT_INPUT_MIN_HEIGHT,
            x_expand: true,
            y_expand: false,
        });
        footerBox.add_child(this._promptScroll);

        this._promptScrollContent = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_expand: false,
        });
        this._promptScroll.add_child(this._promptScrollContent);

        this._promptEditor = new St.Widget({
            style_class: 'katab-prompt-editor',
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: false,
        });
        this._promptEditor.connect('button-press-event', () => {
            this.focusPrompt();
            // Move cursor to end when clicking in the padding area outside the
            // text actor (Clutter.Text stops propagation on its own clicks, so
            // this only fires for the surrounding whitespace).
            if (this._entry) {
                this._entry.set_cursor_position(this._entry.text.length);
            }
            return Clutter.EVENT_PROPAGATE;
        });
        this._promptEditor.connect('scroll-event', this._handlePromptScrollEvent.bind(this));
        this._promptScrollContent.add_child(this._promptEditor);

        this._entryHint = new St.Label({
            text: 'Ask anything...',
            style_class: 'katab-prompt-hint',
            x_expand: true,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._promptEditor.add_child(this._entryHint);

        this._entry = new Clutter.Text({
            editable: true,
            selectable: true,
            reactive: true,
            line_wrap: true,
            line_wrap_mode: Pango.WrapMode.WORD_CHAR,
            single_line_mode: false,
            x_expand: true,
            y_expand: false,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._entry.connect('scroll-event', this._handlePromptScrollEvent.bind(this));
        this._promptEditor.add_child(this._entry);
        this._applyPromptTextColor();
        this._syncPromptHintVisibility();

        this._toolsBox = new St.BoxLayout({
            style_class: 'katab-tools-box',
            vertical: false,
        });
        footerBox.add_child(this._toolsBox);

        this._entry.connect('text-changed', () => {
            if (this._tokenUpdateTimeout) {
                GLib.source_remove(this._tokenUpdateTimeout);
            }
            this._tokenUpdateTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 400, () => {
                this._updateDraftTokenCount();
                this._tokenUpdateTimeout = 0;
                return GLib.SOURCE_REMOVE;
            });

            this._syncPromptHintVisibility();
            this._syncPromptScrollHeight();
            this._queuePromptScrollToBottom();
        });

        this._entry.connect('key-press-event', (_actor, event) => {
            let symbol = event.get_key_symbol();
            if (symbol === Clutter.KEY_Escape) {
                this.close();
                return Clutter.EVENT_STOP;
            }

            if (symbol === Clutter.KEY_Return || symbol === Clutter.KEY_KP_Enter) {
                let modifiers = event.get_state();
                if (modifiers & Clutter.ModifierType.SHIFT_MASK)
                    return Clutter.EVENT_PROPAGATE;

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
        sendBtn.connect('clicked', () => {
            if (this._isStreaming) {
                this._stopActiveResponse();
            } else {
                this._sendMessage();
            }
        });
        this._sendBtn = sendBtn;
        this._sendIcon = sendBtn.child;
        footerBox.add_child(sendBtn);
        this._updateSendButton();

        this._addWelcomeMessage();
        this._updateToolButtons();
        this._updatePendingDocumentUI();
    }

    _buildWelcomePanel() {
        let panel = new St.BoxLayout({
            vertical: true,
            style_class: 'katab-welcome-panel',
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });

        this._welcomeStage = new St.Widget({
            style_class: 'katab-welcome-stage',
            layout_manager: new Clutter.BinLayout(),
            x_align: Clutter.ActorAlign.CENTER,
        });
        this._welcomeStage.set_size(280, 200);
        panel.add_child(this._welcomeStage);

        let scene = new St.Widget({
            style_class: 'katab-welcome-scene',
            layout_manager: new Clutter.FixedLayout(),
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        scene.set_size(280, 200);
        this._welcomeStage.add_child(scene);

        this._welcomeAura = new St.Widget({
            style_class: 'katab-welcome-aura',
            opacity: 120,
        });
        this._welcomeAura.set_size(184, 86);
        this._welcomeAura.set_position(48, 92);
        scene.add_child(this._welcomeAura);

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

        this._welcomePageActors = [backPage, frontPage];

        let dustLayer = new St.Widget({
            style_class: 'katab-welcome-dust-layer',
            layout_manager: new Clutter.FixedLayout(),
        });
        dustLayer.set_size(280, 200);
        scene.add_child(dustLayer);

        const dustSpecs = [
            { x: 94, y: 122, size: 8, driftX: -18, driftY: -74, delay: 40, duration: 1120, peakOpacity: 180, scale: 1.22 },
            { x: 112, y: 128, size: 5, driftX: -8, driftY: -92, delay: 180, duration: 1260, peakOpacity: 150, scale: 1.28 },
            { x: 126, y: 124, size: 7, driftX: 6, driftY: -86, delay: 320, duration: 1180, peakOpacity: 168, scale: 1.24 },
            { x: 138, y: 130, size: 5, driftX: 14, driftY: -96, delay: 460, duration: 1320, peakOpacity: 142, scale: 1.3 },
            { x: 152, y: 126, size: 6, driftX: 22, driftY: -76, delay: 620, duration: 1080, peakOpacity: 154, scale: 1.18 },
            { x: 118, y: 138, size: 4, driftX: -24, driftY: -66, delay: 780, duration: 980, peakOpacity: 132, scale: 1.16 },
            { x: 142, y: 140, size: 4, driftX: 20, driftY: -70, delay: 930, duration: 1020, peakOpacity: 128, scale: 1.18 },
            { x: 130, y: 118, size: 9, driftX: 0, driftY: -98, delay: 1080, duration: 1380, peakOpacity: 176, scale: 1.34 },
        ];

        this._welcomeDustActors = dustSpecs.map(spec => {
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

    _setWelcomeVisible(visible) {
        if (!this._welcomePanel) {
            return;
        }

        this._welcomePanel.visible = visible;

        if (visible && this.isOpen && this._chatScroll?.visible) {
            this._startWelcomeAnimation();
        } else {
            this._stopWelcomeAnimation();
        }
    }

    _scheduleWelcomeCallback(delayMs, callback) {
        let sourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delayMs, () => {
            this._welcomeAnimationSourceIds = this._welcomeAnimationSourceIds.filter(id => id !== sourceId);

            if (this._welcomePanel?.visible && this.isOpen && this._chatScroll?.visible) {
                callback();
            }

            return GLib.SOURCE_REMOVE;
        });

        this._welcomeAnimationSourceIds.push(sourceId);
    }

    _resetWelcomeAnimation() {
        if (this._welcomeAura) {
            this._welcomeAura.remove_all_transitions();
            this._welcomeAura.opacity = 120;
            this._welcomeAura.scale_x = 0.9;
            this._welcomeAura.scale_y = 0.9;
        }

        for (let [index, actor] of this._welcomePageActors.entries()) {
            actor.remove_all_transitions();
            actor.rotation_angle_y = 0;
            actor.translation_x = 0;
            actor.translation_y = 0;
            actor.scale_x = 1;
            actor.scale_y = 1;
            actor.opacity = index === 0 ? 170 : 235;
        }

        for (let dust of this._welcomeDustActors) {
            dust.actor.remove_all_transitions();
            dust.actor.translation_x = 0;
            dust.actor.translation_y = 0;
            dust.actor.scale_x = 0.72;
            dust.actor.scale_y = 0.72;
            dust.actor.opacity = 0;
        }
    }

    _runWelcomeAnimationCycle() {
        if (!this._welcomePanel?.visible || !this.isOpen || !this._chatScroll?.visible) {
            return;
        }

        this._resetWelcomeAnimation();

        if (this._welcomeAura) {
            this._welcomeAura.ease({
                duration: 920,
                opacity: 210,
                scale_x: 1.08,
                scale_y: 1.08,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });

            this._scheduleWelcomeCallback(980, () => {
                if (!this._welcomeAura) {
                    return;
                }

                this._welcomeAura.ease({
                    duration: 1220,
                    opacity: 120,
                    scale_x: 0.9,
                    scale_y: 0.9,
                    mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
                });
            });
        }

        const pageAnimations = [
            { actor: this._welcomePageActors[0], delay: 180, duration: 840, translationX: -10, rotation: -156, opacity: 68, scaleY: 1.03 },
            { actor: this._welcomePageActors[1], delay: 560, duration: 980, translationX: -14, rotation: -176, opacity: 0, scaleY: 1.05 },
        ];

        for (let animation of pageAnimations) {
            this._scheduleWelcomeCallback(animation.delay, () => {
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

        for (let dust of this._welcomeDustActors) {
            this._scheduleWelcomeCallback(dust.delay, () => {
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

    _startWelcomeAnimation() {
        if (!this._welcomePanel?.visible || !this.isOpen || !this._chatScroll?.visible) {
            return;
        }

        if (this._welcomeAnimationLoopId) {
            return;
        }

        this._runWelcomeAnimationCycle();
        this._welcomeAnimationLoopId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 2600, () => {
            this._runWelcomeAnimationCycle();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopWelcomeAnimation() {
        if (this._welcomeAnimationLoopId) {
            GLib.source_remove(this._welcomeAnimationLoopId);
            this._welcomeAnimationLoopId = 0;
        }

        for (let sourceId of this._welcomeAnimationSourceIds) {
            GLib.source_remove(sourceId);
        }
        this._welcomeAnimationSourceIds = [];

        this._resetWelcomeAnimation();
    }

    open() {
        if (this.isOpen) return true;

        if (!this.actor.get_parent()) {
            Main.layoutManager.addTopChrome(this.actor, { trackFullscreen: true });
        }
        this._syncGeometry();
        this.actor.show();
        this._updatePendingDocumentUI();

        this.isOpen = true;

        if (this._welcomePanel?.visible && this._chatScroll?.visible) {
            this._startWelcomeAnimation();
        }

        this._fetchMaxContext();
        if (this._extension.providerHealthMonitor) {
            this._extension.providerHealthMonitor.refresh({ immediate: true });
        }

        this._syncPromptScrollHeight();
        this._queuePromptScrollToBottom();

        // A slight timeout is often needed in GNOME Shell to reliably grab focus
        // after opening a window/overlay.
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 100, () => {
            if (this.isOpen && this._entry) {
                this._syncPromptScrollHeight();
                this._queuePromptScrollToBottom();
                this.focusPrompt();
            }
            return GLib.SOURCE_REMOVE;
        });

        this._notifyCurrentChatChanged();

        return true;
    }

    close({ cancelStream = false, saveConversation = true } = {}) {
        if (!this.isOpen) return;

        this._releasePromptFocus();
        if (cancelStream) {
            this._cancelStream();
        }
        if (saveConversation) {
            this._saveCurrentConversation();
        }
        this._stopWelcomeAnimation();
        this.isOpen = false;
        this.actor.hide();
        if (this.actor.get_parent()) {
            Main.layoutManager.removeChrome(this.actor);
        }
        this._notifyCurrentChatChanged();
    }

    destroy() {
        this.close({ cancelStream: true, saveConversation: true });
        this._disconnectProviderStatus();
        this._stopWelcomeAnimation();

        if (this._promptScrollFollowIdleId) {
            GLib.source_remove(this._promptScrollFollowIdleId);
            this._promptScrollFollowIdleId = 0;
        }

        if (this._themeChangedId && this._interfaceSettings) {
            this._interfaceSettings.disconnect(this._themeChangedId);
            this._themeChangedId = 0;
        }

        if (this._monitorChangedId) {
            Main.layoutManager.disconnect(this._monitorChangedId);
            this._monitorChangedId = 0;
        }

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

    _sanitizeHistoryMessage(message) {
        let sanitized = {
            role: message.role,
        };

        if (message.content !== undefined) {
            sanitized.content = this._buildApiMessageContent(message);
        }

        if (message.tool_calls !== undefined) {
            sanitized.tool_calls = message.tool_calls;
        }

        if (message.name !== undefined) {
            sanitized.name = message.name;
        }

        if (message.images !== undefined) {
            sanitized.images = message.images;
        }

        return sanitized;
    }

    _getApiMessageHistory() {
        return this._messageHistory.map(message => this._sanitizeHistoryMessage(message));
    }

    _numberOrNull(value) {
        return typeof value === 'number' && Number.isFinite(value) ? value : null;
    }

    _extractOllamaMetrics(payload) {
        let metrics = {
            total_duration: this._numberOrNull(payload.total_duration),
            load_duration: this._numberOrNull(payload.load_duration),
            prompt_eval_count: this._numberOrNull(payload.prompt_eval_count),
            prompt_eval_duration: this._numberOrNull(payload.prompt_eval_duration),
            eval_count: this._numberOrNull(payload.eval_count),
            eval_duration: this._numberOrNull(payload.eval_duration),
        };

        return Object.values(metrics).some(value => value !== null) ? metrics : null;
    }

    _formatMetricNumber(value, fractionDigits = 1) {
        return Number(value)
            .toFixed(fractionDigits)
            .replace(/\.0$/, '')
            .replace(/(\.\d*[1-9])0+$/, '$1');
    }

    _formatDurationNs(durationNs) {
        if (durationNs === null || durationNs === undefined || durationNs <= 0) {
            return '';
        }

        let milliseconds = durationNs / 1_000_000;
        if (milliseconds >= 1000) {
            let seconds = milliseconds / 1000;
            return `${this._formatMetricNumber(seconds, seconds >= 10 ? 0 : 1)} s`;
        }

        if (milliseconds >= 10) {
            return `${Math.round(milliseconds)} ms`;
        }

        if (milliseconds >= 1) {
            return `${this._formatMetricNumber(milliseconds, 1)} ms`;
        }

        let microseconds = durationNs / 1_000;
        return `${this._formatMetricNumber(microseconds, microseconds >= 10 ? 0 : 1)} us`;
    }

    _formatTokensPerSecond(evalCount, evalDuration) {
        if (evalCount === null || evalDuration === null || evalCount <= 0 || evalDuration <= 0) {
            return '';
        }

        let tokensPerSecond = (evalCount / evalDuration) * 1_000_000_000;
        return `${this._formatMetricNumber(tokensPerSecond, tokensPerSecond >= 100 ? 0 : 1)} tok/s`;
    }

    _formatAssistantMetrics(messageMeta) {
        if (!messageMeta || messageMeta.provider !== 'ollama' || !messageMeta.metrics) {
            return '';
        }

        let metrics = messageMeta.metrics;
        let parts = [];

        let promptDuration = this._formatDurationNs(metrics.prompt_eval_duration);
        if (promptDuration) {
            parts.push(`Prompt ${promptDuration}`);
        }

        let tokensPerSecond = this._formatTokensPerSecond(metrics.eval_count, metrics.eval_duration);
        if (tokensPerSecond) {
            parts.push(tokensPerSecond);
        }

        if (metrics.load_duration !== null || metrics.prompt_eval_duration !== null) {
            let ttftDuration = this._formatDurationNs((metrics.load_duration ?? 0) + (metrics.prompt_eval_duration ?? 0));
            if (ttftDuration) {
                parts.push(`TTFT ${ttftDuration}`);
            }
        }

        return parts.join(' • ');
    }

    _applyAssistantMetrics(label, messageMeta, footerRow = null) {
        if (!label) {
            return;
        }

        let summary = this._formatAssistantMetrics(messageMeta);
        label.set_text(summary);
        label.visible = Boolean(summary);

        if (footerRow) {
            footerRow.visible = Boolean(footerRow._katabHasReplyCopy) || label.visible;
        }
    }

    _saveCurrentConversation() {
        let newId = HistoryManager.saveConversation(this._messageHistory, this._currentConversationId);
        if (newId) {
            this._currentConversationId = newId;
        }
        this._notifyCurrentChatChanged();
    }

    _deleteConversation(id) {
        HistoryManager.deleteConversation(id);
        if (this._currentConversationId === id) {
            this._currentConversationId = null;
        }
        this._notifyCurrentChatChanged();
    }

    _loadConversation(entry) {
        this._cancelStream();
        this._currentConversationId = entry.id;
        this._messageHistory = [...entry.messages];
        this._sessionDocuments.clear();
        this._setPendingDocument(null);
        this._hasConversationStarted = entry.messages.length > 0;
        this._setWelcomeVisible(!this._hasConversationStarted);
        this._messageList.destroy_all_children();
        for (let msg of entry.messages) {
            if (msg.role === 'user') {
                this._addChatMessage('You', this._formatUserMessageDisplay(msg), 'user');
            } else if (msg.role === 'assistant') {
                this._addChatMessage('Katab AI', msg.content, 'assistant', msg);
            }
        }
        this._showChatView();
        this._notifyCurrentChatChanged();
    }

    // ── View switching ───────────────────────────────────────────────────

    _showChatView() {
        this._historyView.visible = false;
        this._chatScroll.visible = true;
        this._footerBox.visible = true;
        if (this._welcomePanel?.visible) {
            this._startWelcomeAnimation();
        }

        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 50, () => {
            if (this.isOpen && this._entry) {
                this.focusPrompt();
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _showHistoryView() {
        this._stopWelcomeAnimation();
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

    _newChat() {
        this._cancelStream();
        this._saveCurrentConversation();
        this._currentConversationId = null;
        this._messageHistory = [];
        this._sessionDocuments.clear();
        this._setPendingDocument(null);
        this._currentUsage = 0;
        this._draftUsage = 0;
        this._renderTokenCounter();
        this._messageList.destroy_all_children();
        this._showChatView();
        this._addWelcomeMessage();
        this._notifyCurrentChatChanged();
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

    _isRequestCancelled(error) {
        return Boolean(error?.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED));
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
                `<span font_family="monospace" weight="600">${code}</span>`
            );
            return token;
        });

        escapedText = escapedText.replace(/\*\*([^\n]+?)\*\*/g, '<b>$1</b>');
        escapedText = escapedText.replace(/__([^\n]+?)__/g, '<b>$1</b>');
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

        let headingMatch = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/);
        if (headingMatch) {
            let headingSizes = {
                1: 'x-large',
                2: 'large',
                3: 'medium',
                4: 'medium',
                5: 'small',
                6: 'small',
            };

            return `<span size="${headingSizes[headingMatch[1].length]}" weight="bold">${this._formatInlineMarkdown(headingMatch[2].trim())}</span>`;
        }

        let quoteMatch = line.match(/^\s{0,3}>\s?(.*)$/);
        if (quoteMatch) {
            return `<span style="italic">| ${this._formatInlineMarkdown(quoteMatch[1])}</span>`;
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

    _splitMarkdownTableRow(line) {
        let normalized = String(line ?? '').trim();
        if (!normalized.includes('|')) {
            return [];
        }

        if (normalized.startsWith('|')) {
            normalized = normalized.slice(1);
        }

        if (normalized.endsWith('|')) {
            normalized = normalized.slice(0, -1);
        }

        return normalized.split('|').map(cell => cell.trim());
    }

    _looksLikeMarkdownTableRow(line) {
        let cells = this._splitMarkdownTableRow(line);
        return cells.length > 1;
    }

    _isMarkdownTableSeparator(line) {
        let cells = this._splitMarkdownTableRow(line);
        return cells.length > 1 && cells.every(cell => /^:?-{3,}:?$/.test(cell));
    }

    _parseMarkdownTable(lines, startIndex) {
        if (startIndex + 1 >= lines.length) {
            return null;
        }

        let headerLine = lines[startIndex];
        let separatorLine = lines[startIndex + 1];
        if (!this._looksLikeMarkdownTableRow(headerLine) || !this._isMarkdownTableSeparator(separatorLine)) {
            return null;
        }

        let headers = this._splitMarkdownTableRow(headerLine);
        let separatorCells = this._splitMarkdownTableRow(separatorLine);
        if (headers.length < 2 || separatorCells.length !== headers.length) {
            return null;
        }

        let rows = [];
        let rawLines = [headerLine, separatorLine];
        let index = startIndex + 2;

        while (index < lines.length && this._looksLikeMarkdownTableRow(lines[index])) {
            let cells = this._splitMarkdownTableRow(lines[index]);
            if (cells.length !== headers.length) {
                break;
            }

            rows.push(cells);
            rawLines.push(lines[index]);
            index++;
        }

        return {
            headers,
            rows,
            nextIndex: index,
            rawText: rawLines.join('\n'),
        };
    }

    _isMarkdownDividerLine(line) {
        return /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(String(line ?? ''));
    }

    _appendMarkdownSegmentsFromText(segments, text) {
        let lines = String(text ?? '').split('\n');
        let bufferedLines = [];

        let flushBufferedLines = () => {
            if (bufferedLines.length === 0) {
                return;
            }

            let blockText = bufferedLines.join('\n');
            bufferedLines = [];

            if (blockText === '') {
                return;
            }

            segments.push({
                type: 'text',
                markup: this._formatMarkdownTextSegment(blockText),
                fallbackText: blockText,
            });
        };

        let index = 0;
        while (index < lines.length) {
            let table = this._parseMarkdownTable(lines, index);
            if (table) {
                flushBufferedLines();
                segments.push({
                    type: 'table',
                    headers: table.headers,
                    rows: table.rows,
                    fallbackText: table.rawText,
                });
                index = table.nextIndex;
                continue;
            }

            if (this._isMarkdownDividerLine(lines[index])) {
                flushBufferedLines();
                segments.push({ type: 'rule' });
                index++;
                continue;
            }

            bufferedLines.push(lines[index]);
            index++;
        }

        flushBufferedLines();
    }

    _buildCodeBlockSegment(language, codeText) {
        return {
            type: 'code',
            language: String(language ?? '').trim(),
            code: String(codeText ?? '').replace(/\t/g, '    ').replace(/\n$/, ''),
        };
    }

    _buildAssistantRenderModel(rawText, { final = false, plain = false } = {}) {
        let sourceText = String(rawText ?? '');
        if (plain) {
            return {
                segments: [{
                    type: 'text',
                    markup: this._renderPlainMarkup(sourceText),
                    fallbackText: sourceText,
                }],
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

        let segments = [];
        let links = [];
        let codeBlockRegex = /```([^\n`]*)\n([\s\S]*?)```/g;
        let lastIndex = 0;
        let match;

        while ((match = codeBlockRegex.exec(parseableText)) !== null) {
            if (match.index > lastIndex) {
                let extracted = this._extractLinks(parseableText.slice(lastIndex, match.index));
                links.push(...extracted.links);
                if (extracted.text !== '') {
                    this._appendMarkdownSegmentsFromText(segments, extracted.text);
                }
            }

            segments.push(this._buildCodeBlockSegment(match[1], match[2]));
            lastIndex = codeBlockRegex.lastIndex;
        }

        if (lastIndex < parseableText.length) {
            let extracted = this._extractLinks(parseableText.slice(lastIndex));
            links.push(...extracted.links);
            if (extracted.text !== '') {
                this._appendMarkdownSegmentsFromText(segments, extracted.text);
            }
        }

        if (trailingPlainText) {
            segments.push({
                type: 'text',
                markup: this._renderPlainMarkup(trailingPlainText),
                fallbackText: trailingPlainText,
            });
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
            segments,
            links: uniqueLinks,
        };
    }

    _createAssistantTextLabel(markup, fallbackText) {
        let label = new St.Label({
            text: '',
            style_class: 'katab-chat-content-label',
            x_expand: true,
        });
        label.clutter_text.line_wrap = true;
        label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        label.clutter_text.single_line_mode = false;
        label.clutter_text.can_focus = false;
        this._setLabelMarkup(label, markup, fallbackText);
        return label;
    }

    _createMarkdownRuleWidget() {
        return new St.Widget({
            style_class: 'katab-markdown-rule',
            x_expand: true,
            height: 1,
        });
    }

    _createMarkdownTableCell(text, { header = false } = {}) {
        let cellBox = new St.BoxLayout({
            vertical: true,
            style_class: 'katab-markdown-table-cell',
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
        });
        if (header) {
            cellBox.add_style_class_name('katab-markdown-table-cell-header');
        }

        let label = new St.Label({
            text: '',
            style_class: 'katab-markdown-table-cell-label',
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
        });
        if (header) {
            label.add_style_class_name('katab-markdown-table-cell-label-header');
        }

        label.clutter_text.line_wrap = true;
        label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        label.clutter_text.single_line_mode = false;
        label.clutter_text.can_focus = false;

        let markup = this._formatInlineMarkdown(text);
        if (header) {
            markup = `<b>${markup}</b>`;
        }

        this._setLabelMarkup(label, markup, text);
        cellBox.add_child(label);
        return cellBox;
    }

    _createMarkdownTableWidget(segment) {
        let tableBox = new St.BoxLayout({
            vertical: true,
            style_class: 'katab-markdown-table',
            x_expand: true,
        });

        let allRows = [segment.headers, ...(segment.rows || [])];
        for (let rowIndex = 0; rowIndex < allRows.length; rowIndex++) {
            let row = allRows[rowIndex];
            let rowBox = new St.Widget({
                layout_manager: new Clutter.BoxLayout({
                    orientation: Clutter.Orientation.HORIZONTAL,
                    homogeneous: true,
                    spacing: 0,
                }),
                style_class: 'katab-markdown-table-row',
                x_expand: true,
                x_align: Clutter.ActorAlign.FILL,
            });

            if (rowIndex === 0) {
                rowBox.add_style_class_name('katab-markdown-table-row-header');
            }

            for (let cellText of row) {
                rowBox.add_child(this._createMarkdownTableCell(cellText, { header: rowIndex === 0 }));
            }

            tableBox.add_child(rowBox);
        }

        return tableBox;
    }

    _createCodeBlockWidget(language, codeText) {
        let codeWindow = new St.BoxLayout({
            vertical: true,
            style_class: 'katab-code-window',
            x_expand: true,
        });

        let headerRow = new St.BoxLayout({
            vertical: false,
            style_class: 'katab-code-window-header',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        let languageLabel = new St.Label({
            text: language || 'Code',
            style_class: 'katab-code-window-language',
            y_align: Clutter.ActorAlign.CENTER,
        });
        headerRow.add_child(languageLabel);
        headerRow.add_child(new St.Widget({ x_expand: true }));

        let copyBtn = new St.Button({
            label: 'Copy',
            style_class: 'katab-code-copy-btn',
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        copyBtn.connect('clicked', () => {
            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, codeText);
        });
        headerRow.add_child(copyBtn);
        codeWindow.add_child(headerRow);

        let bodyBox = new St.BoxLayout({
            vertical: true,
            style_class: 'katab-code-window-body',
            x_expand: true,
        });

        let codeLabel = new St.Label({
            text: codeText,
            style_class: 'katab-code-window-label',
            x_expand: true,
        });
        codeLabel.clutter_text.line_wrap = true;
        codeLabel.clutter_text.line_wrap_mode = Pango.WrapMode.CHAR;
        codeLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        codeLabel.clutter_text.single_line_mode = false;
        codeLabel.clutter_text.can_focus = false;
        bodyBox.add_child(codeLabel);
        codeWindow.add_child(bodyBox);

        return codeWindow;
    }

    _renderAssistantSegments(contentBox, segments) {
        if (!contentBox) {
            return;
        }

        contentBox.destroy_all_children();

        let hasChildren = false;
        for (let segment of segments) {
            if (segment.type === 'code') {
                contentBox.add_child(this._createCodeBlockWidget(segment.language, segment.code));
                hasChildren = true;
                continue;
            }

            if (segment.type === 'table') {
                contentBox.add_child(this._createMarkdownTableWidget(segment));
                hasChildren = true;
                continue;
            }

            if (segment.type === 'rule') {
                contentBox.add_child(this._createMarkdownRuleWidget());
                hasChildren = true;
                continue;
            }

            if (!segment.markup && !segment.fallbackText) {
                continue;
            }

            contentBox.add_child(this._createAssistantTextLabel(segment.markup, segment.fallbackText));
            hasChildren = true;
        }

        if (!hasChildren) {
            contentBox.add_child(this._createAssistantTextLabel('', ''));
        }
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
        if (!uiElements || !uiElements.contentBox) {
            return;
        }

        let sourceText = String(rawText ?? '');
        if (uiElements.footerRow) {
            uiElements.footerRow._katabCopyText = sourceText;
        }
        let rendered = this._buildAssistantRenderModel(sourceText, options);
        this._renderAssistantSegments(uiElements.contentBox, rendered.segments);
        this._updateLinkActions(uiElements.linkBox, rendered.links);

        if (uiElements.diagnosticBox && uiElements.diagnosticLabel) {
            const details = options.errorDetails ? String(options.errorDetails).trim() : '';
            uiElements.diagnosticLabel.set_text(details);
            uiElements.diagnosticBox.visible = details.length > 0;
        }
    }

    _summarizeRequestPayload(payload) {
        let summary = { ...payload };

        if (Array.isArray(summary.messages)) {
            summary.messages = `[${summary.messages.length} messages omitted]`;
        }

        if (Array.isArray(summary.tools)) {
            summary.tools = `[${summary.tools.length} tools omitted]`;
        }

        return JSON.stringify(summary, null, 2);
    }

    _readErrorResponseBody(inputStream, cancellable = null) {
        if (!inputStream) {
            return '';
        }

        const decoder = new TextDecoder('utf-8');
        const chunks = [];
        let total = 0;

        try {
            while (total < 32768) {
                let bytes = inputStream.read_bytes(4096, cancellable);
                if (!bytes) {
                    break;
                }

                let data = bytes.get_data();
                if (!data || data.length === 0) {
                    break;
                }

                chunks.push(decoder.decode(data));
                total += data.length;

                if (data.length < 4096) {
                    break;
                }
            }
        } catch (e) {
            return `Unable to read response body: ${e.message}`;
        } finally {
            try {
                inputStream.close(null);
            } catch (_e) {
            }
        }

        return chunks.join('').trim();
    }

    _extractErrorSummary(responseBody) {
        if (!responseBody) {
            return '';
        }

        try {
            let parsed = JSON.parse(responseBody);
            if (typeof parsed.error === 'string' && parsed.error.trim()) {
                return parsed.error.trim();
            }
        } catch (_e) {
        }

        let firstLine = responseBody.split('\n').map(line => line.trim()).find(Boolean);
        return firstLine || '';
    }

    _buildRequestDiagnostics({ provider, endpoint, model, payload, statusCode = null, responseBody = '', errorMessage = '' }) {
        let lines = [
            `Provider: ${provider}`,
            `Endpoint: ${endpoint}`,
            `Model: ${model}`,
        ];

        if (statusCode !== null) {
            lines.push(`HTTP Status: ${statusCode}`);
        }

        if (errorMessage) {
            lines.push(`Client Error: ${errorMessage}`);
        }

        lines.push('');
        lines.push('Request Summary:');
        lines.push(this._summarizeRequestPayload(payload));

        if (responseBody) {
            lines.push('');
            lines.push('Response Body:');
            lines.push(responseBody);
        }

        return lines.join('\n').trim();
    }

    _renderRequestError(uiElements, summary, diagnostics) {
        this._applyAssistantRender(uiElements, summary, {
            plain: true,
            errorDetails: diagnostics,
        });

        let historyContent = diagnostics ? `${summary}\n\n${diagnostics}` : summary;
        this._messageHistory.push({ role: 'assistant', content: historyContent });
        this._saveCurrentConversation();
        this._cancellable = null;
        this._clearActiveResponseState();
        this._scrollToBottom();
    }

    _renderLocalAssistantError(uiElements, summary) {
        this._applyAssistantRender(uiElements, summary, { plain: true });
        this._messageHistory.push({ role: 'assistant', content: summary });
        this._saveCurrentConversation();
        this._cancellable = null;
        this._clearActiveResponseState();
        this._scrollToBottom();
    }

    _addWelcomeMessage() {
        this._hasConversationStarted = false;
        this._setWelcomeVisible(true);
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
        (this._messageList || this._chatContainer).add_child(msgBox);
        this._scrollToBottom();
    }

    _addChatMessage(sender, text, type, messageMeta = null) {
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
            });
            replyCopyBtn.connect('clicked', () => {
                let txt = copyBtnRow._katabCopyText ?? '';
                St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, txt);
            });
            copyBtnRow._katabHasReplyCopy = true;
            copyBtnRow.visible = true;
            copyBtnRow.add_child(replyCopyBtn);
        }

        let metricsLabel = new St.Label({
            text: '',
            style_class: 'katab-message-token-label',
            visible: false,
            y_align: Clutter.ActorAlign.CENTER,
        });
        copyBtnRow.add_child(metricsLabel);

        if (!isUser) {
            this._applyAssistantMetrics(metricsLabel, messageMeta, copyBtnRow);
        }

        // Push copy btn to right if user, otherwise keep it left and tokens right
        if (isUser) {
            copyBtnRow.set_pack_start(true);
        }

        bubbleBox.add_child(copyBtnRow);

        let linkBox = null;
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
            diagnosticBox.add_child(diagnosticLabel);

            bubbleBox.add_child(diagnosticBox);
        }

        let spacer = new St.Widget({ x_expand: true });
        if (isUser) {
            rowBox.add_child(spacer);
            rowBox.add_child(bubbleBox);
        } else {
            rowBox.add_child(bubbleBox);
            rowBox.add_child(spacer);
        }

        (this._messageList || this._chatContainer).add_child(rowBox);

        if (isUser) {
            contentLabel.set_text(text);
        } else {
            this._applyAssistantRender({ contentBox, linkBox, diagnosticBox, diagnosticLabel, footerRow: copyBtnRow }, text, { final: true });
        }

        this._scrollToBottom();

        return { contentBox, contentLabel, thinkLabel, thinkWrapper, linkBox, diagnosticBox, diagnosticLabel, metricsLabel, footerRow: copyBtnRow };
    }

    _scrollToBottom() {
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            let adj = this._chatScroll.get_vscroll_bar().get_adjustment();
            adj.value = adj.upper - adj.page_size;
            return GLib.SOURCE_REMOVE;
        });
    }

    async _sendMessage() {
        if (this._isStreaming) {
            this._stopActiveResponse();
            return;
        }

        let rawPromptText = this._entry.get_text().trim();
        if (rawPromptText === '' && !this._pendingDocument)
            return;

        let documentCommand = null;
        try {
            documentCommand = parseDocumentCommand(rawPromptText);
        } catch (error) {
            this._addSystemMessage(error.message);
            return;
        }

        if (documentCommand && !this._isDocumentToolEnabled()) {
            this._addSystemMessage('Enable the Document Tool in Settings before using /doc.');
            return;
        }

        let promptText = documentCommand ? documentCommand.promptText : rawPromptText;
        let shouldClearPendingAfterSend = Boolean(this._pendingDocument);
        let documentMeta = this._pendingDocument ? { ...this._pendingDocument } : null;

        if (documentCommand) {
            if (documentCommand.needsPicker) {
                try {
                    const pickedPath = await this._pickDocumentPath();
                    if (!pickedPath) {
                        return;
                    }

                    documentMeta = this._buildDocumentMeta(pickedPath);
                    if (!documentMeta) {
                        throw new DocumentToolError('Katab could not resolve that file path. Use a local file and try again.', {
                            code: 'invalid-picked-path',
                        });
                    }
                } catch (error) {
                    this._addSystemMessage(error.message || `Could not open the document picker: ${error}`);
                    return;
                }
            } else if (documentCommand.filePath) {
                const normalizedPath = resolveDocumentPath(documentCommand.filePath) || documentCommand.filePath.trim();
                documentMeta = {
                    displayName: GLib.path_get_basename(normalizedPath),
                    path: normalizedPath,
                };
            }
        }

        if (!promptText && documentMeta) {
            promptText = 'Please analyze the attached document.';
        }

        if (!promptText && !documentMeta) {
            return;
        }

        this._forcedTool = null;
        const tools = this._getProviderTools();
        for (const t of tools) {
            if (promptText.startsWith(t.command + ' ') || promptText === t.command) {
                this._forcedTool = t.toolName;
                break;
            }
        }

        const userMessage = {
            role: 'user',
            content: promptText,
        };
        if (documentMeta) {
            userMessage.documents = [documentMeta];
        }

        this._entry.set_text('');
        this._draftUsage = 0;
        this._renderTokenCounter();
        this._hasConversationStarted = true;
        this._setWelcomeVisible(false);
        this._addChatMessage('You', this._formatUserMessageDisplay(userMessage), 'user');

        this._messageHistory.push(userMessage);
        this._saveCurrentConversation();

        let uiElements = this._addChatMessage('Katab AI', '...', 'assistant');
        const requestCancellable = new Gio.Cancellable();
        this._cancellable = requestCancellable;
        this._beginActiveResponse(
            uiElements,
            this._currentProvider,
            documentMeta ? 'document' : 'response',
            documentMeta?.displayName || null
        );

        try {
            if (documentMeta) {
                this._applyAssistantRender(uiElements, `Reading ${documentMeta.displayName}...`, { plain: true });
                const parsedDocument = await this._documentToolRuntime.parseDocument(documentMeta.path, requestCancellable);
                this._rememberSessionDocument(parsedDocument);
                userMessage.documents = [this._serializeDocumentMeta(parsedDocument)];
                this._messageHistory[this._messageHistory.length - 1] = userMessage;
                this._saveCurrentConversation();
                if (shouldClearPendingAfterSend) {
                    this._setPendingDocument(null);
                }
            }

            this._streamResponse(uiElements, { cancellable: requestCancellable });
        } catch (e) {
            if (this._isRequestCancelled(e)) {
                return;
            }

            if (e instanceof DocumentToolError) {
                this._renderLocalAssistantError(uiElements, e.message);
                return;
            }

            const diagnostics = this._buildRequestDiagnostics({
                provider: this._currentProvider,
                endpoint: 'Not constructed',
                model: 'Unknown',
                payload: { reason: 'Request construction failed' },
                errorMessage: e.message,
            });
            this._renderRequestError(uiElements, `Error constructing request: ${e.message}`, diagnostics);
        }
    }

    _streamResponse(uiElements, { cancellable = null } = {}) {
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
        const apiMessages = this._getApiMessageHistory();

        // Prepare Dialects
        if (provider === 'unsloth' || provider === 'openai') {
            if (!endpoint.endsWith('chat/completions') && !endpoint.includes('v1/chat')) {
                endpoint += 'chat/completions';
            }
            headers['Content-Type'] = 'application/json';
            payload = {
                model: model,
                messages: apiMessages,
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
            let anthropicMessages = apiMessages.filter(m => m.role !== 'system');

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

            const getOpt = (prop, type) => {
                try {
                    return this._settings[`get_${type}`](`ollama-${prop}`);
                } catch (e) { return null; }
            };

            let options = {
                temperature: getOpt('temperature', 'double'),
                num_ctx: getOpt('num-ctx', 'int'),
                num_predict: getOpt('num-predict', 'int'),
                num_keep: getOpt('num-keep', 'int'),
                use_mmap: getOpt('use-mmap', 'boolean'),
                use_mlock: getOpt('use-mlock', 'boolean'),
                num_gpu: getOpt('num-gpu', 'int'),
                num_thread: getOpt('num-thread', 'int'),
                top_k: getOpt('top-k', 'int'),
                top_p: getOpt('top-p', 'double'),
                min_p: getOpt('min-p', 'double'),
                tfs_z: getOpt('tfs-z', 'double'),
                typical_p: getOpt('typical-p', 'double'),
                mirostat: getOpt('mirostat', 'int'),
                mirostat_tau: getOpt('mirostat-tau', 'double'),
                mirostat_eta: getOpt('mirostat-eta', 'double'),
                repeat_last_n: getOpt('repeat-last-n', 'int'),
                repeat_penalty: getOpt('repeat-penalty', 'double'),
                presence_penalty: getOpt('presence-penalty', 'double'),
                frequency_penalty: getOpt('frequency-penalty', 'double')
            };

            // Remove nulls just in case, though GSettings should provide defaults
            Object.keys(options).forEach(key => {
                if (options[key] === null || options[key] === undefined) {
                    delete options[key];
                }
            });

            let keepAlive = this._settings.get_string('ollama-keep-alive');
            let responseFormat = this._settings.get_string('ollama-format');
            let rawMode = this._settings.get_boolean('ollama-raw');

            payload = {
                model: model,
                messages: apiMessages,
                stream: true,
                keep_alive: keepAlive || "5m",
                think: true,
                options: options,
            };

            if (responseFormat) {
                payload.format = responseFormat;
            }

            if (rawMode) {
                payload.raw = true;
            }
        }

        let message = Soup.Message.new('POST', endpoint);

        for (let key in headers) {
            message.get_request_headers().append(key, headers[key]);
        }

        let bodyBytes = new GLib.Bytes(JSON.stringify(payload));
        message.set_request_body_from_bytes('application/json', bodyBytes);

        this._applyAssistantRender(uiElements, 'Waiting for response...', { plain: true });
        if (!cancellable) {
            this._cancelStream({ clearState: false });
            this._cancellable = new Gio.Cancellable();
        } else {
            this._cancellable = cancellable;
        }

        let responseState = this._beginActiveResponse(uiElements, provider);
        let currentCancellable = this._cancellable;

        this._soupSession.send_async(message, GLib.PRIORITY_DEFAULT, currentCancellable, (session, res) => {
            if (currentCancellable.is_cancelled()) return;
            try {
                let inputStream = session.send_finish(res);
                if (message.status_code === 404 && provider === 'ollama') {
                    this._extension.providerHealthMonitor?.markRequestSuccess(provider, `${getProviderLabel(provider)} responded.`);
                    this._promptOllamaPull(inputStream, model, uiElements);
                    return;
                } else if (message.status_code !== 200) {
                    this._extension.providerHealthMonitor?.refresh({ immediate: true });
                    const responseBody = this._readErrorResponseBody(inputStream, currentCancellable);
                    const summaryText = this._extractErrorSummary(responseBody);
                    const summary = summaryText
                        ? `Request failed: HTTP ${message.status_code} - ${summaryText}`
                        : `Request failed: HTTP ${message.status_code}`;
                    const diagnostics = this._buildRequestDiagnostics({
                        provider,
                        endpoint,
                        model,
                        payload,
                        statusCode: message.status_code,
                        responseBody,
                    });
                    this._renderRequestError(uiElements, summary, diagnostics);
                    return;
                }

                let dataInputStream = new Gio.DataInputStream({
                    base_stream: inputStream,
                    close_base_stream: true
                });

                this._extension.providerHealthMonitor?.markRequestSuccess(provider, `${getProviderLabel(provider)} responded.`);

                this._readSSE(dataInputStream, responseState, provider, currentCancellable);

            } catch (e) {
                if (currentCancellable.is_cancelled()) return;
                this._extension.providerHealthMonitor?.markRequestFailure(provider, e.message || `${getProviderLabel(provider)} is unavailable.`);
                const diagnostics = this._buildRequestDiagnostics({
                    provider,
                    endpoint,
                    model,
                    payload,
                    errorMessage: e.message,
                });
                this._renderRequestError(uiElements, `Request Failed: ${e.message}`, diagnostics);
            }
        });
    }

    _readSSE(dataInputStream, responseState, provider, cancellable) {
        if (cancellable && cancellable.is_cancelled()) return;

        let { uiElements } = responseState;
        let { thinkLabel, thinkWrapper } = uiElements;
        dataInputStream.read_line_async(GLib.PRIORITY_DEFAULT, cancellable, (stream, res) => {
            if (cancellable && cancellable.is_cancelled()) return;
            try {
                let [lineBytes, length] = stream.read_line_finish(res);
                if (lineBytes === null) {
                    // Stream ended
                    let finalContent = responseState.accumulatedText;
                    if (responseState.accumulatedThink && !finalContent && responseState.accumulatedToolCalls.length === 0) {
                        finalContent = 'Finished thinking, but no response provided.';
                    }

                    if (responseState.accumulatedToolCalls.length > 0) {
                        this._clearActiveResponseState();
                        this._handleToolCalls(responseState.accumulatedToolCalls, uiElements);
                    } else {
                        this._applyAssistantRender(uiElements, finalContent, { final: true });
                        this._messageHistory.push(this._buildAssistantHistoryMessage(finalContent, responseState.assistantMeta));
                        this._saveCurrentConversation();
                        this._clearActiveResponseState();
                    }
                    return;
                }

                let lineStr = new TextDecoder('utf-8').decode(lineBytes).trim();
                let deltaText = '';
                let nextAssistantMeta = responseState.assistantMeta;

                if (provider === 'ollama' && lineStr.startsWith('{')) {
                    let parsed = JSON.parse(lineStr);
                    if (parsed.message) {
                        if (parsed.message.content) {
                            deltaText = parsed.message.content;
                        }
                        if (parsed.message.reasoning) {
                            responseState.isThinking = true;
                            thinkWrapper.visible = true;
                            responseState.accumulatedThink += parsed.message.reasoning;
                            thinkLabel.set_text(responseState.accumulatedThink);
                        }
                        if (parsed.message.tool_calls) {
                            for (let tc of parsed.message.tool_calls) {
                                responseState.accumulatedToolCalls.push(tc);
                            }
                        }
                    }
                    if (parsed.done === true) {
                        let metrics = this._extractOllamaMetrics(parsed);
                        if (metrics) {
                            nextAssistantMeta = {
                                provider: 'ollama',
                                metrics,
                            };
                            this._applyAssistantMetrics(uiElements.metricsLabel, nextAssistantMeta, uiElements.footerRow);
                        }

                        if (metrics && metrics.prompt_eval_count !== null && metrics.eval_count !== null) {
                            this._currentUsage += metrics.prompt_eval_count + metrics.eval_count;
                            this._renderTokenCounter();
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

                responseState.assistantMeta = nextAssistantMeta;

                if (deltaText) {
                    // Split the text based on tags
                    let i = 0;
                    while (i < deltaText.length) {
                        if (!responseState.isThinking && (deltaText.substring(i).startsWith('igid') || deltaText.substring(i).startsWith('<think>'))) {
                            responseState.isThinking = true;
                            thinkWrapper.visible = true;
                            i += deltaText.substring(i).startsWith('<think>') ? 7 : 4; // skip tag
                        } else if (responseState.isThinking && (deltaText.substring(i).startsWith('igr') || deltaText.substring(i).startsWith('</think>'))) {
                            responseState.isThinking = false;
                            i += deltaText.substring(i).startsWith('</think>') ? 8 : 3; // skip tag
                        } else {
                            if (responseState.isThinking) {
                                responseState.accumulatedThink += deltaText[i];
                            } else {
                                responseState.accumulatedText += deltaText[i];
                            }
                            i++;
                        }
                    }

                    if (responseState.accumulatedThink) {
                        thinkLabel.set_text(responseState.accumulatedThink);
                    }
                    if (responseState.accumulatedText) {
                        this._applyAssistantRender(uiElements, responseState.accumulatedText, { final: false });
                    }

                    this._scrollToBottom();
                }

                // Read next line
                this._readSSE(dataInputStream, responseState, provider, cancellable);

            } catch (e) {
                if (cancellable && cancellable.is_cancelled()) return;
                // Ignore parse errors from partial or non-json lines and continue
                this._readSSE(dataInputStream, responseState, provider, cancellable);
            }
        });
    }

    _handleToolCalls(toolCalls, uiElements) {
        if (this._settings.get_string('provider') === 'ollama') {
            this._applyAssistantRender(
                uiElements,
                'Ollama tool calls were requested, but Katab does not advertise any local Ollama tools. Please retry without tool use or switch to a provider with server-side tools.',
                { plain: true }
            );
            return;
        }

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
                result = `Tool ${tc.function.name} is not implemented locally in Katab.`;
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

        let { contentBox } = uiElements;
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
            this._messageHistory.push(this._buildAssistantHistoryMessage('Download cancelled.'));
            this._saveCurrentConversation();
            this._clearActiveResponseState();
        });

        box.add_child(confirmBtn);
        box.add_child(cancelBtn);

        contentBox.get_parent().add_child(box);
    }

    _pullOllamaModel(model, uiElements) {
        let { contentBox } = uiElements;
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

        if (this._activeResponseState) {
            this._activeResponseState.mode = 'pull';
            this._activeResponseState.modelName = model;
            this._activeResponseState.uiElements = uiElements;
        }

        this._cancelStream({ clearState: false }); // cancel any active stream but keep the live response state
        this._cancellable = new Gio.Cancellable();
        let currentCancellable = this._cancellable;

        let cancelBtn = new St.Button({
            label: "Cancel Download",
            style_class: 'katab-prompt-btn-no',
            x_expand: false
        });
        cancelBtn.connect('clicked', () => {
            this._stopActiveResponse();
            cancelBtn.destroy();
        });
        contentBox.get_parent().add_child(cancelBtn);

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
                    this._clearActiveResponseState();
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
                this._clearActiveResponseState();
            }
        });
    }

    _readPullSSE(dataInputStream, model, uiElements, cancellable, cancelBtn) {
        if (cancellable && cancellable.is_cancelled()) return;

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

            this._indicatorInterfaceSettings = null;
            this._indicatorThemeChangedId = 0;
            try {
                this._indicatorInterfaceSettings = new Gio.Settings({ schema_id: 'org.gnome.desktop.interface' });
            } catch (_e) { /* schema not available */ }

            let panelGicon = Gio.icon_new_for_string(`${extension.path}/icons/katab-panel-icon.svg`);
            let iconStack = new St.BoxLayout({
                style_class: 'katab-panel-indicator-box',
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._panelIcon = new St.Icon({
                gicon: panelGicon,
                style_class: 'system-status-icon',
                y_align: Clutter.ActorAlign.CENTER,
            });
            iconStack.add_child(this._panelIcon);

            this._panelStatusDot = new St.Widget({
                style_class: 'katab-panel-status-dot',
                y_align: Clutter.ActorAlign.CENTER,
            });
            iconStack.add_child(this._panelStatusDot);
            this.add_child(iconStack);

            this._applyIndicatorTheme();
            if (this._indicatorInterfaceSettings) {
                this._indicatorThemeChangedId = this._indicatorInterfaceSettings.connect('changed::color-scheme', () => this._applyIndicatorTheme());
            }

            this._providerHealthListener = null;
            if (this._extension.providerHealthMonitor) {
                this._providerHealthListener = (state, states) => {
                    this._renderProviderStatus(state);
                    this._renderProviderMenuStatuses(states);
                };
                this._extension.providerHealthMonitor.subscribe(this._providerHealthListener);
            }

            this._currentChatListener = state => this._renderCurrentChatMenuItem(state);
            this._extension.subscribeCurrentChat(this._currentChatListener);
            this._currentChatBookIcon = Gio.icon_new_for_string(`${extension.path}/icons/katab-panel-icon.svg`);

            // Actions Section
            this._newChatMenuItem = new PopupMenu.PopupMenuItem('New Chat');
            let newChatIcon = new St.Icon({ icon_name: 'document-new-symbolic', style_class: 'popup-menu-icon' });
            this._newChatMenuItem.insert_child_at_index(newChatIcon, 0);
            this._newChatMenuItem.connect('activate', () => {
                let dialog = this._extension.showCurrentChat();
                dialog._newChat();
            });
            this.menu.addMenuItem(this._newChatMenuItem);

            this._currentChatMenuItem = new PopupMenu.PopupBaseMenuItem({
                reactive: true,
                can_focus: true,
            });
            this._currentChatMenuItem.visible = false;
            this._currentChatIcon = new St.Icon({
                gicon: this._currentChatBookIcon,
                style_class: 'popup-menu-icon katab-current-chat-icon katab-current-chat-icon-ready',
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._currentChatMenuItem.add_child(this._currentChatIcon);

            let currentChatTextCol = new St.BoxLayout({
                vertical: true,
                x_expand: true,
                style_class: 'katab-current-chat-text-col',
            });
            this._currentChatLabel = new St.Label({
                text: 'Current Chat',
                style_class: 'katab-current-chat-label',
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            currentChatTextCol.add_child(this._currentChatLabel);

            this._currentChatPreviewLabel = new St.Label({
                text: 'Resume your active conversation',
                style_class: 'katab-current-chat-preview',
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._currentChatPreviewLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            this._currentChatPreviewLabel.clutter_text.single_line_mode = true;
            currentChatTextCol.add_child(this._currentChatPreviewLabel);
            this._currentChatMenuItem.add_child(currentChatTextCol);

            this._currentChatStatusLabel = new St.Label({
                text: 'Ready',
                style_class: 'katab-current-chat-status katab-current-chat-status-ready',
                y_align: Clutter.ActorAlign.CENTER,
            });
            this._currentChatMenuItem.add_child(this._currentChatStatusLabel);
            this._currentChatMenuItem.connect('activate', () => {
                this.menu.close();
                this._extension.showCurrentChat();
            });
            this.menu.addMenuItem(this._currentChatMenuItem);
            this._renderCurrentChatMenuItem(this._extension.getCurrentChatState());

            this._settingsMenuItem = new PopupMenu.PopupMenuItem('Settings');
            let settingsIcon = new St.Icon({ icon_name: 'emblem-system-symbolic', style_class: 'popup-menu-icon' });
            this._settingsMenuItem.insert_child_at_index(settingsIcon, 0);
            this._settingsMenuItem.connect('activate', () => {
                this.menu.close();
                this._extension.showPreferences();
            });
            this.menu.addMenuItem(this._settingsMenuItem);

            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            // Provider Switcher
            this._providerMenu = new PopupMenu.PopupSubMenuMenuItem('Model Provider');
            this.menu.addMenuItem(this._providerMenu);
            this._providerItems = {};
            this._providerIcons = {};
            this._providerStatusDots = {};
            const providers = PROVIDER_LABELS;

            for (let [key, name] of Object.entries(providers)) {
                let item = new PopupMenu.PopupMenuItem(name);
                let providerIcon = createProviderIcon(
                    key,
                    this._extension.path,
                    'popup-menu-icon katab-provider-badge-icon katab-provider-menu-icon'
                );
                let statusDot = new St.Widget({
                    style_class: 'katab-provider-status-indicator katab-provider-menu-status-dot',
                    y_align: Clutter.ActorAlign.CENTER,
                });
                item.add_child(providerIcon);
                item.add_child(statusDot);
                item.connect('activate', () => {
                    this._settings.set_string('provider', key);
                });
                this._providerItems[key] = item;
                this._providerIcons[key] = providerIcon;
                this._providerStatusDots[key] = statusDot;
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
                    this._extension.providerHealthMonitor?.refreshAll({ immediate: true });
                }
            });
        }

        _renderProviderStatus(state) {
            if (!this._panelStatusDot) {
                return;
            }

            syncProviderStatusClasses(this._panelStatusDot, state.status);
        }

        _renderProviderMenuStatuses(states = {}) {
            for (let [provider, dot] of Object.entries(this._providerStatusDots || {})) {
                let state = states[provider] || this._extension.providerHealthMonitor?.getState(provider);
                if (!state || !dot) {
                    continue;
                }

                syncProviderStatusClasses(dot, state.status);
            }
        }

        _renderCurrentChatMenuItem(state) {
            if (!this._currentChatMenuItem || !this._currentChatStatusLabel || !this._currentChatPreviewLabel || !this._currentChatIcon) {
                return;
            }

            this._currentChatMenuItem.visible = state.available;
            if (!state.available) {
                return;
            }

            this._currentChatPreviewLabel.set_text(state.title || 'Resume your active conversation');

            let status = state.isStreaming ? 'replying' : (state.isOpen ? 'open' : 'ready');
            let statusLabel = state.isStreaming ? 'Replying' : (state.isOpen ? 'Open' : 'Ready');
            this._currentChatStatusLabel.set_text(statusLabel);

            const statusClasses = [
                'katab-current-chat-status-replying',
                'katab-current-chat-status-open',
                'katab-current-chat-status-ready',
            ];
            const iconClasses = [
                'katab-current-chat-icon-replying',
                'katab-current-chat-icon-open',
                'katab-current-chat-icon-ready',
            ];
            for (let className of statusClasses) {
                this._currentChatStatusLabel.remove_style_class_name(className);
            }
            for (let className of iconClasses) {
                this._currentChatIcon.remove_style_class_name(className);
            }

            this._currentChatStatusLabel.add_style_class_name(`katab-current-chat-status-${status}`);
            this._currentChatIcon.add_style_class_name(`katab-current-chat-icon-${status}`);

            if (status === 'replying') {
                this._currentChatIcon.gicon = null;
                this._currentChatIcon.icon_name = 'view-refresh-symbolic';
            } else {
                this._currentChatIcon.icon_name = null;
                this._currentChatIcon.gicon = this._currentChatBookIcon;
            }
        }

        _syncProvider() {
            let current = this._settings.get_string('provider');
            for (let [key, item] of Object.entries(this._providerItems)) {
                item.setOrnament(current === key ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NONE);
            }
        }

        _applyIndicatorTheme() {
            let isDark = true;
            try {
                if (this._indicatorInterfaceSettings) {
                    const scheme = this._indicatorInterfaceSettings.get_string('color-scheme');
                    isDark = scheme === 'prefer-dark';
                }
            } catch (_e) { /* fall through */ }
            this.remove_style_class_name('katab-theme-dark');
            this.remove_style_class_name('katab-theme-light');
            this.add_style_class_name(isDark ? 'katab-theme-dark' : 'katab-theme-light');

            if (this.menu?.actor) {
                this.menu.actor.remove_style_class_name('katab-theme-dark');
                this.menu.actor.remove_style_class_name('katab-theme-light');
                this.menu.actor.add_style_class_name(isDark ? 'katab-theme-dark' : 'katab-theme-light');
            }
        }

        destroy() {
            if (this._indicatorThemeChangedId && this._indicatorInterfaceSettings) {
                this._indicatorInterfaceSettings.disconnect(this._indicatorThemeChangedId);
                this._indicatorThemeChangedId = 0;
            }
            if (this._providerHealthListener && this._extension.providerHealthMonitor) {
                this._extension.providerHealthMonitor.unsubscribe(this._providerHealthListener);
            }
            this._providerHealthListener = null;
            if (this._currentChatListener) {
                this._extension.unsubscribeCurrentChat(this._currentChatListener);
            }
            this._currentChatListener = null;
            super.destroy();
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
                    let dialog = this._extension.showCurrentChat();
                    dialog._loadConversation(entry);
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
                    let dialog = this._extension.showCurrentChat();
                    dialog._loadConversation(entry);
                });

                this._historySection.addMenuItem(item);
            }
        }
    });

export default class KatabExtension extends Extension {
    enable() {
        this._currentChatListeners = new Set();
        this._settings = this.getSettings('org.gnome.shell.extensions.katabai');
        this._keybindingChangedId = this._settings.connect('changed::toggle-current-chat', () => this._registerKeybindings());
        this._keybindingRegisteredViaExtension = false;
        this._hasRegisteredKeybinding = false;
        this._providerHealthMonitor = new ProviderHealthMonitor(this);
        this._providerHealthMonitor.refresh({ immediate: true });
        this._indicator = new Indicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
        this._dialog = null;
        this._registerKeybindings();
    }

    disable() {
        this._removeKeybindings();
        if (this._keybindingChangedId && this._settings) {
            this._settings.disconnect(this._keybindingChangedId);
            this._keybindingChangedId = 0;
        }
        if (this._dialog) {
            this._dialog.destroy();
            this._dialog = null;
        }
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
        if (this._providerHealthMonitor) {
            this._providerHealthMonitor.destroy();
            this._providerHealthMonitor = null;
        }
        this._currentChatListeners?.clear();
        this._keybindingRegisteredViaExtension = false;
        this._hasRegisteredKeybinding = false;
        this._settings = null;
    }

    get providerHealthMonitor() {
        return this._providerHealthMonitor;
    }

    showPreferences() {
        if (this._dialog && this._dialog.isOpen) {
            this._dialog.close();
        }

        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this.openPreferences();
            return GLib.SOURCE_REMOVE;
        });
    }

    ensureDialog() {
        if (!this._dialog) {
            this._dialog = new KatabDialog(this);
            this.notifyCurrentChatChanged();
        }

        return this._dialog;
    }

    getCurrentChatState() {
        if (!this._dialog) {
            return {
                available: false,
                conversationId: null,
                isOpen: false,
                isStreaming: false,
                status: 'empty',
                title: 'Current Chat',
            };
        }

        return this._dialog.getCurrentChatState();
    }

    subscribeCurrentChat(listener) {
        this._currentChatListeners.add(listener);
        listener(this.getCurrentChatState());
    }

    unsubscribeCurrentChat(listener) {
        this._currentChatListeners.delete(listener);
    }

    notifyCurrentChatChanged() {
        let state = this.getCurrentChatState();
        for (let listener of this._currentChatListeners) {
            try {
                listener(state);
            } catch (e) {
                logError(e, 'Katab: current chat listener failed');
            }
        }
    }

    showCurrentChat() {
        let dialog = this.ensureDialog();
        dialog.open();
        dialog.focusPrompt();
        return dialog;
    }

    _registerKeybindings() {
        if (!this._settings) {
            return;
        }

        this._removeKeybindings();

        let actionMode = Shell.ActionMode.ALL;
        if (actionMode === undefined) {
            actionMode = Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP;
        }

        try {
            if (typeof this.addKeybinding === 'function') {
                this.addKeybinding(
                    'toggle-current-chat',
                    this._settings,
                    Meta.KeyBindingFlags.NONE,
                    actionMode,
                    () => this.toggleDialog()
                );
                this._keybindingRegisteredViaExtension = true;
                this._hasRegisteredKeybinding = true;
                return;
            }

            Main.wm.addKeybinding(
                'toggle-current-chat',
                this._settings,
                Meta.KeyBindingFlags.NONE,
                actionMode,
                () => this.toggleDialog()
            );
            this._keybindingRegisteredViaExtension = false;
            this._hasRegisteredKeybinding = true;
        } catch (e) {
            this._hasRegisteredKeybinding = false;
            logError(e, 'Katab: failed to register current chat keybinding');
        }
    }

    _removeKeybindings() {
        if (!this._hasRegisteredKeybinding) {
            return;
        }

        try {
            if (this._keybindingRegisteredViaExtension && typeof this.removeKeybinding === 'function') {
                this.removeKeybinding('toggle-current-chat');
            } else {
                Main.wm.removeKeybinding('toggle-current-chat');
            }
        } catch (_e) {
        }

        this._keybindingRegisteredViaExtension = false;
        this._hasRegisteredKeybinding = false;
    }

    toggleDialog() {
        let dialog = this.ensureDialog();

        if (dialog.isOpen) {
            dialog.close();
        } else {
            this.showCurrentChat();
        }
    }
}
