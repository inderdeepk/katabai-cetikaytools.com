// historyView.js — History panel (conversation list, search, tabs, KB search)
// plus the conversation metadata editor (title/description + AI generator).
//
// Self-contained component: owns the history view actor tree (search bar,
// Active/Archived tabs, KB search bar, scrollable list), the editor panel,
// the list render cache, and the title-generation lifecycle. The dialog keeps
// the root-actor fields (`_historyView`, `_historyEditorPanel`) for visibility
// checks plus thin wrappers; everything else flows through the host bag.
//
// Shell-only module: imports gi://St + Clutter (excluded from the plain-gjs
// import smoke test, like src/pets/petSpriteActor.js).
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import {
    HistoryManager,
    HISTORY_TITLE_MAX_CHARS,
    HISTORY_DESCRIPTION_MAX_CHARS,
} from '../core/historyManager.js';
import {
    buildTitleGenerationMessages,
    parseTitleDescriptionResponse,
    TITLE_GEN_MAX_TOKENS,
} from '../core/titleGenerator.js';
import { extractMessageText } from '../providers/historyPayload.js';
import { createRagGicon, readRagConfig } from '../tools/ragTools.js';

export class HistoryView {
    /**
     * @param {Object} host — dialog surface:
     *   settings, extensionPath,
     *   buildPickerShell(titleText), closeDialog(),
     *   openAuxPanel(panel), showChatView(), showHistoryView(),
     *   loadConversation(entry), deleteConversation(id),
     *   notifyCurrentChatChanged(), hideRecentChatsPopup(),
     *   addSystemMessage(text, opts),
     *   requestNonStreamingCompletion(messages, opts),
     *   isActorDisposed(actor),
     *   getRagRuntime(), withTimeout(promise, ms), ragManualSearchTimeoutMs
     */
    constructor(host) {
        this._host = host;
        this._settings = host.settings;

        this._searchQuery = '';
        this._searchTimeoutId = 0;
        this._tab = 'active';
        this._listCacheKey = null;
        this._editorTargetId = null;
        this._titleGenInFlight = false;
        this._editorCancellable = null;
        this._kbSearchViewActive = false;

        this.editor = null;
        this._buildView();
    }

    _buildView() {
        // History view (hidden by default) — wrapper with search bar + scrollable list
        this.view = new St.BoxLayout({
            vertical: true,
            style_class: 'katab-history-view',
            x_expand: true,
            y_expand: true,
            visible: false,
        });

        // Search bar for filtering conversations
        this._searchBox = new St.BoxLayout({
            vertical: false,
            style_class: 'katab-history-search-box',
            x_expand: true,
        });
        this.view.add_child(this._searchBox);

        let searchIcon = new St.Icon({
            icon_name: 'edit-find-symbolic',
            style_class: 'katab-history-search-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._searchBox.add_child(searchIcon);

        this._searchEntry = new St.Entry({
            style_class: 'katab-history-search-entry',
            hint_text: 'Search conversations…',
            x_expand: true,
            can_focus: true,
            track_hover: true,
        });
        this._searchBox.add_child(this._searchEntry);

        // Debounced search: re-render history list ~200ms after typing stops
        this._searchEntry.clutter_text.connect('text-changed', () => {
            if (this._searchTimeoutId) {
                GLib.source_remove(this._searchTimeoutId);
            }
            this._searchTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
                this._searchTimeoutId = 0;
                let q = this._searchEntry.get_text();
                this._searchQuery = q;
                this.renderList(q || null);
                return GLib.SOURCE_REMOVE;
            });
        });

        // Escape closes the dialog (consistent with other ESC handling)
        this._searchEntry.clutter_text.connect('key-press-event', (entry, event) => {
            let keyval = event.get_key_symbol();
            if (keyval === Clutter.KEY_Escape) {
                this._host.closeDialog();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        // ── Active / Archived tabs ───────────────────────────────────────
        this._tabRow = new St.BoxLayout({
            vertical: false,
            style_class: 'katab-history-tabs',
            x_expand: true,
        });
        this.view.add_child(this._tabRow);

        this._activeTabBtn = new St.Button({
            label: 'Active',
            style_class: 'katab-history-tab',
            can_focus: true,
        });
        this._activeTabBtn.connect('clicked', () => this._setTab('active'));
        this._tabRow.add_child(this._activeTabBtn);

        this._archivedTabBtn = new St.Button({
            label: 'Archived',
            style_class: 'katab-history-tab',
            can_focus: true,
        });
        this._archivedTabBtn.connect('clicked', () => this._setTab('archived'));
        this._tabRow.add_child(this._archivedTabBtn);

        this._syncTabButtons();

        // ── Knowledge Base search bar (Phase 2) ──────────────────────────
        this._kbSearchBox = new St.BoxLayout({
            vertical: false,
            style_class: 'katab-kb-search-box',
            x_expand: true,
            visible: false,
        });
        this.view.add_child(this._kbSearchBox);

        let kbSearchIcon = new St.Icon({
            gicon: createRagGicon(this._host.extensionPath),
            style_class: 'katab-kb-search-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._kbSearchBox.add_child(kbSearchIcon);

        this._kbSearchEntry = new St.Entry({
            style_class: 'katab-kb-search-entry',
            hint_text: 'Search knowledge base…',
            x_expand: true,
            can_focus: true,
            track_hover: true,
        });
        this._kbSearchBox.add_child(this._kbSearchEntry);

        let kbSearchBtn = new St.Button({
            label: 'Search',
            style_class: 'katab-kb-search-btn',
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._kbSearchBox.add_child(kbSearchBtn);

        kbSearchBtn.connect('clicked', () => {
            const query = (this._kbSearchEntry?.get_text() || '').trim();
            if (query) this._executeKbSearch(query);
        });

        this._kbSearchEntry.clutter_text.connect('key-press-event', (entry, event) => {
            let keyval = event.get_key_symbol();
            if (keyval === Clutter.KEY_Return || keyval === Clutter.KEY_KP_Enter) {
                const query = (entry.get_text() || '').trim();
                if (query) this._executeKbSearch(query);
                return Clutter.EVENT_STOP;
            }
            if (keyval === Clutter.KEY_Escape) {
                // If KB results are showing, return to history list
                if (this._kbSearchViewActive) {
                    this.renderList(this._searchQuery || null);
                    return Clutter.EVENT_STOP;
                }
                this._host.closeDialog();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        // Scrollable history list
        let historyScroll = new St.ScrollView({
            style_class: 'katab-history-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            x_expand: true,
            y_expand: true,
        });
        this.view.add_child(historyScroll);

        this._container = new St.BoxLayout({
            vertical: true,
            style_class: 'katab-history-container',
        });
        historyScroll.add_child(this._container);
    }

    // ── Conversation metadata editor (title / description) ────────────────
    // Manual editor for a saved conversation's title + description with an
    // optional "Generate with AI" action that asks the active provider for a
    // suggested pair (the user reviews the fields before pressing Save).

    buildEditorPanel() {
        const { picker, listBox, closePickerBtn } =
            this._host.buildPickerShell('Edit Conversation');
        this.editor = picker;
        closePickerBtn.connect('clicked', () => this.closeEditor());

        const form = new St.BoxLayout({
            vertical: true,
            style_class: 'katab-history-editor-form',
            x_expand: true,
        });
        listBox.add_child(form);

        form.add_child(
            new St.Label({ text: 'Title', style_class: 'katab-history-editor-field-label' }),
        );
        this._editorTitleEntry = new St.Entry({
            style_class: 'katab-history-editor-entry',
            hint_text: 'Conversation title',
            x_expand: true,
            can_focus: true,
        });
        this._editorTitleEntry.clutter_text.max_length = HISTORY_TITLE_MAX_CHARS;
        form.add_child(this._editorTitleEntry);

        form.add_child(
            new St.Label({
                text: 'Description',
                style_class: 'katab-history-editor-field-label',
            }),
        );
        this._editorDescEntry = new St.Entry({
            style_class: 'katab-history-editor-entry',
            hint_text: 'Short one-line summary (optional)',
            x_expand: true,
            can_focus: true,
        });
        this._editorDescEntry.clutter_text.max_length = HISTORY_DESCRIPTION_MAX_CHARS;
        form.add_child(this._editorDescEntry);

        const hint = new St.Label({
            text: 'Leave the title empty to restore the automatic title. The AI generator uses the active provider and only changes these fields once you press Save.',
            style_class: 'katab-history-editor-hint',
            x_expand: true,
        });
        hint.clutter_text.line_wrap = true;
        hint.clutter_text.single_line_mode = false;
        form.add_child(hint);

        const actions = new St.BoxLayout({
            vertical: false,
            style_class: 'katab-history-editor-actions',
            x_expand: true,
        });
        form.add_child(actions);

        this._editorGenerateBtn = new St.Button({
            label: 'Generate with AI',
            style_class: 'katab-history-editor-generate-btn',
            can_focus: true,
        });
        this._editorGenerateBtn.connect('clicked', () => this._generateMeta());
        actions.add_child(this._editorGenerateBtn);

        this._editorSaveBtn = new St.Button({
            label: 'Save',
            style_class: 'katab-history-editor-save-btn',
            can_focus: true,
        });
        this._editorSaveBtn.connect('clicked', () => this._saveEditor());
        actions.add_child(this._editorSaveBtn);

        this._editorCancelBtn = new St.Button({
            label: 'Cancel',
            style_class: 'katab-history-editor-cancel-btn',
            can_focus: true,
        });
        this._editorCancelBtn.connect('clicked', () => this.closeEditor());
        actions.add_child(this._editorCancelBtn);

        this._editorStatus = new St.Label({
            text: '',
            style_class: 'katab-history-editor-status',
            x_expand: true,
        });
        this._editorStatus.clutter_text.line_wrap = true;
        this._editorStatus.clutter_text.single_line_mode = false;
        form.add_child(this._editorStatus);

        // Enter in either field saves; Escape returns to the history list.
        for (const entry of [this._editorTitleEntry, this._editorDescEntry]) {
            entry.clutter_text.connect('key-press-event', (actor, event) => {
                const keyval = event.get_key_symbol();
                if (keyval === Clutter.KEY_Return || keyval === Clutter.KEY_KP_Enter) {
                    this._saveEditor();
                    return Clutter.EVENT_STOP;
                }
                if (keyval === Clutter.KEY_Escape) {
                    this.closeEditor();
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });
        }

        return picker;
    }

    _openEditor(entry) {
        if (!this.editor || !entry) return;
        this.cancelTitleGeneration();
        this._editorTargetId = entry.id;
        this._editorTitleEntry.set_text(String(entry.title || ''));
        this._editorDescEntry.set_text(String(entry.description || ''));
        this._editorStatus.set_text('');
        this._host.openAuxPanel(this.editor);
        this._editorTitleEntry.grab_key_focus();
    }

    closeEditor() {
        this.cancelTitleGeneration();
        this._editorTargetId = null;
        this._host.showHistoryView();
    }

    _saveEditor() {
        const id = this._editorTargetId;
        if (!id) return;
        const title = (this._editorTitleEntry?.get_text() || '').trim();
        const description = (this._editorDescEntry?.get_text() || '').trim();
        const ok = HistoryManager.updateConversationMeta(id, { title, description });
        if (!ok) {
            this._editorStatus.set_text(
                'This conversation is no longer in history — nothing was saved.',
            );
            return;
        }
        this.cancelTitleGeneration();
        this._editorTargetId = null;
        this._listCacheKey = null;
        this._host.showHistoryView();
        this._host.notifyCurrentChatChanged();
    }

    async _generateMeta() {
        if (this._titleGenInFlight) return;
        const id = this._editorTargetId;
        const entry = id ? HistoryManager.getCached().find((e) => e.id === id) : null;
        if (!entry) {
            this._editorStatus.set_text('This conversation is no longer in history.');
            return;
        }
        const messages = buildTitleGenerationMessages(entry.messages);
        if (!messages) {
            this._editorStatus.set_text('There is nothing to summarize in this conversation yet.');
            return;
        }

        const request = { cancellable: new Gio.Cancellable(), id };
        this._editorCancellable = request.cancellable;
        this._titleGenInFlight = true;
        this._setTitleGenBusy(true);
        this._editorStatus.set_text('Generating a title and description…');
        try {
            const raw = await this._host.requestNonStreamingCompletion(messages, {
                cancellable: request.cancellable,
                maxTokens: TITLE_GEN_MAX_TOKENS,
                countAsPipeline: false,
            });
            if (request.cancellable.is_cancelled()) return;
            if (this._editorTargetId !== id || this._host.isActorDisposed(this._editorTitleEntry)) {
                return;
            }
            const parsed = parseTitleDescriptionResponse(raw);
            if (parsed) {
                this._editorTitleEntry.set_text(parsed.title);
                if (parsed.description) {
                    this._editorDescEntry.set_text(parsed.description);
                }
                this._editorStatus.set_text('Generated — review the fields and press Save.');
            } else if (raw && raw.trim()) {
                this._editorStatus.set_text(
                    'Could not parse the model response. Edit the fields manually or try again.',
                );
            } else {
                this._editorStatus.set_text(
                    'The model returned an empty response. Check the provider settings and try again.',
                );
            }
        } catch (e) {
            if (
                !request.cancellable.is_cancelled() &&
                !this._host.isActorDisposed(this._editorStatus)
            ) {
                this._editorStatus.set_text(`Generation failed: ${e.message || 'unknown error'}`);
            }
        } finally {
            // Only clear the busy state when this request is still the current
            // one — a cancelled request has already been reset by the caller.
            if (this._editorCancellable === request.cancellable) {
                this._editorCancellable = null;
                this._titleGenInFlight = false;
                this._setTitleGenBusy(false);
            }
        }
    }

    cancelTitleGeneration() {
        if (this._editorCancellable) {
            try {
                this._editorCancellable.cancel();
            } catch (_e) {
                /* already cancelled */
            }
        }
        this._editorCancellable = null;
        this._titleGenInFlight = false;
        this._setTitleGenBusy(false);
    }

    _setTitleGenBusy(busy) {
        const btn = this._editorGenerateBtn;
        if (!btn || this._host.isActorDisposed(btn)) return;
        btn.set_label(busy ? 'Generating…' : 'Generate with AI');
        btn.reactive = !busy;
        if (busy) {
            btn.add_style_class_name('katab-history-editor-generate-busy');
        } else {
            btn.remove_style_class_name('katab-history-editor-generate-busy');
        }
    }

    // ── History tabs (Active / Archived) ─────────────────────────────────

    _setTab(tab) {
        const next = tab === 'archived' ? 'archived' : 'active';
        if (this._tab === next) return;
        this._tab = next;
        this._syncTabButtons();
        this.renderList(this._searchQuery || null);
    }

    _syncTabButtons() {
        const archived = this._tab === 'archived';
        const apply = (btn, active) => {
            if (!btn) return;
            if (active) {
                btn.add_style_class_name('katab-history-tab-active');
            } else {
                btn.remove_style_class_name('katab-history-tab-active');
            }
        };
        apply(this._activeTabBtn, !archived);
        apply(this._archivedTabBtn, archived);
    }

    _updateTabLabels(entries = HistoryManager.getCached()) {
        const archivedCount = entries.filter((e) => e.archived === true).length;
        const activeCount = entries.length - archivedCount;
        if (this._activeTabBtn) {
            this._activeTabBtn.set_label(`Active (${activeCount})`);
        }
        if (this._archivedTabBtn) {
            this._archivedTabBtn.set_label(`Archived (${archivedCount})`);
        }
    }

    _setArchived(id, archived) {
        if (!HistoryManager.setConversationArchived(id, archived)) return;
        this._listCacheKey = null;
        this._host.hideRecentChatsPopup();
        this.renderList(this._searchQuery || null);
        this._host.notifyCurrentChatChanged();
    }

    renderList(filterQuery = null) {
        let allEntries = HistoryManager.getCached();
        const tab = this._tab === 'archived' ? 'archived' : 'active';
        this._updateTabLabels(allEntries);
        // The normal conversation list replaces any KB search results view.
        this._kbSearchViewActive = false;

        // Filter by tab first, then by search query (case-insensitive match
        // against title, description, and message text).
        let arr =
            tab === 'archived'
                ? HistoryManager.getArchivedConversations()
                : HistoryManager.getActiveConversations();

        // Avoid redundant rebuilds when neither the cached history, the tab,
        // nor the search query has changed. Titles/descriptions/timestamps are
        // part of the key so metadata edits always refresh the rows.
        let currentIds = arr
            .map(
                (e) =>
                    `${e.id}:${e.archived ? 1 : 0}:${e.timestamp}:${e.title}:${e.description || ''}`,
            )
            .join(',');
        let cacheKey = `${tab}|${currentIds}|${filterQuery || ''}`;
        if (this._listCacheKey === cacheKey && this._container.get_n_children() > 0) {
            return;
        }
        this._listCacheKey = cacheKey;

        if (filterQuery) {
            let q = filterQuery.toLowerCase();
            arr = arr.filter((entry) => {
                if ((entry.title || '').toLowerCase().includes(q)) {
                    return true;
                }
                if ((entry.description || '').toLowerCase().includes(q)) {
                    return true;
                }
                return entry.messages.some((msg) =>
                    extractMessageText(msg).toLowerCase().includes(q),
                );
            });
        }

        this._container.destroy_all_children();

        if (arr.length === 0) {
            let msg;
            if (filterQuery) {
                msg =
                    tab === 'archived'
                        ? 'No archived conversations match your search.'
                        : 'No conversations match your search.';
            } else {
                msg =
                    tab === 'archived'
                        ? 'No archived conversations yet.\nArchive a conversation to keep it out of the main list.'
                        : 'No saved conversations yet.\nStart chatting and use New Chat to save.';
            }
            let emptyLabel = new St.Label({
                text: msg,
                style_class: 'katab-history-empty',
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
                x_expand: true,
            });
            emptyLabel.clutter_text.line_wrap = true;
            emptyLabel.clutter_text.single_line_mode = false;
            this._container.add_child(emptyLabel);
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
                text: entry.title || 'Untitled',
                style_class: 'katab-history-title',
                x_expand: true,
            });
            titleLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            titleLabel.clutter_text.single_line_mode = true;
            textCol.add_child(titleLabel);

            if (entry.description) {
                let descriptionLabel = new St.Label({
                    text: entry.description,
                    style_class: 'katab-history-description',
                    x_expand: true,
                });
                descriptionLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
                descriptionLabel.clutter_text.single_line_mode = true;
                textCol.add_child(descriptionLabel);
            }

            let date = new Date(entry.timestamp * 1000);
            let dateStr =
                date.toLocaleDateString(undefined, {
                    month: 'short',
                    day: 'numeric',
                }) +
                ' · ' +
                date.toLocaleTimeString(undefined, {
                    hour: '2-digit',
                    minute: '2-digit',
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
            loadBtn.connect('clicked', () => this._host.loadConversation(entry));
            row.add_child(loadBtn);

            let archiveBtn = new St.Button({
                label: tab === 'archived' ? 'Unarchive' : 'Archive',
                style_class: 'katab-history-archive-btn',
                can_focus: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            archiveBtn.connect('clicked', () => this._setArchived(entry.id, tab !== 'archived'));
            row.add_child(archiveBtn);

            let editBtn = new St.Button({
                child: new St.Icon({
                    icon_name: 'document-edit-symbolic',
                    style_class: 'katab-history-edit-icon',
                }),
                style_class: 'katab-history-edit-btn',
                can_focus: true,
                y_align: Clutter.ActorAlign.CENTER,
                accessible_name: 'Edit title and description',
            });
            editBtn.connect('clicked', () => this._openEditor(entry));
            row.add_child(editBtn);

            let deleteBtn = new St.Button({
                child: new St.Icon({
                    icon_name: 'user-trash-symbolic',
                    style_class: 'katab-history-delete-icon',
                }),
                style_class: 'katab-history-delete-btn',
                can_focus: true,
                y_align: Clutter.ActorAlign.CENTER,
                accessible_name: 'Delete conversation',
            });
            deleteBtn.connect('clicked', () => {
                this._host.deleteConversation(entry.id);
                this.renderList(this._searchQuery || null);
            });
            row.add_child(deleteBtn);

            this._container.add_child(row);
        }
    }

    // ── Knowledge Base search (Phase 2: cross-session retrieval) ──────────

    /** Execute a KB search query and render the results in the history view. */
    async _executeKbSearch(query) {
        const ragConfig = readRagConfig(this._settings);
        if (!ragConfig.enabled) {
            this._host.addSystemMessage(
                'Knowledge Base is disabled. Enable it in Settings > Tools > Knowledge Base.',
                { variant: 'warning' },
            );
            return;
        }

        // Show loading state in the history container
        this._container.destroy_all_children();
        let loadingLabel = new St.Label({
            text: `Searching knowledge base for "${query}"…`,
            style_class: 'katab-history-empty',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            x_expand: true,
        });
        this._container.add_child(loadingLabel);

        try {
            const searchOutcome = await this._host.withTimeout(
                this._host.getRagRuntime().search(query, ragConfig, null),
                this._host.ragManualSearchTimeoutMs,
            );
            if (searchOutcome.kind === 'timeout') {
                log(
                    `[Katab:rag] KB search timed out after ${this._host.ragManualSearchTimeoutMs}ms`,
                );
                this._container.destroy_all_children();
                let timeoutLabel = new St.Label({
                    text: `Knowledge Base search timed out — the RAG service is unresponsive.`,
                    style_class: 'katab-history-empty',
                    x_align: Clutter.ActorAlign.CENTER,
                    y_align: Clutter.ActorAlign.CENTER,
                    x_expand: true,
                });
                this._container.add_child(timeoutLabel);
            } else {
                this._renderKbSearchResults(query, searchOutcome.value);
            }
        } catch (e) {
            log(`[Katab:rag] KB search failed: ${e.message}`);
            this._container.destroy_all_children();
            let errorLabel = new St.Label({
                text: `Search failed: ${e.message}`,
                style_class: 'katab-history-empty',
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
                x_expand: true,
            });
            this._container.add_child(errorLabel);
        }
    }

    /** Render KB search results as clickable rows in the history container.
     *  Each row shows: score badge, source collection, snippet, timestamp. */
    _renderKbSearchResults(query, searchResult) {
        this._kbSearchViewActive = true;
        this._container.destroy_all_children();

        const results = Array.isArray(searchResult?.results) ? searchResult.results : [];

        // Back button to return to normal history view
        let backRow = new St.BoxLayout({
            vertical: false,
            style_class: 'katab-kb-back-row',
            x_expand: true,
        });
        let backBtn = new St.Button({
            label: '← Back to conversations',
            style_class: 'katab-kb-back-btn',
            can_focus: true,
        });
        backBtn.connect('clicked', () => {
            this.renderList(this._searchQuery || null);
        });
        backRow.add_child(backBtn);
        this._container.add_child(backRow);

        if (results.length === 0) {
            let emptyLabel = new St.Label({
                text: `No results found for "${query}".`,
                style_class: 'katab-history-empty',
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
                x_expand: true,
            });
            this._container.add_child(emptyLabel);
            return;
        }

        let resultCountLabel = new St.Label({
            text: `${results.length} result${results.length !== 1 ? 's' : ''} for "${query}"`,
            style_class: 'katab-kb-result-count',
            x_expand: true,
        });
        this._container.add_child(resultCountLabel);

        for (const result of results) {
            const meta = result.metadata || {};
            const sourceLabel = meta.source || 'document';
            const scorePct = Math.round((result.score || 0) * 100);
            const snippet = (result.content || '').substring(0, 200);
            const title = meta.title || '';
            const ts = meta.timestamp || '';

            let row = new St.BoxLayout({
                vertical: false,
                style_class: 'katab-kb-result-row',
                x_expand: true,
                reactive: true,
                track_hover: true,
            });

            // Score badge
            let scoreClass =
                scorePct >= 80
                    ? 'katab-kb-score-high'
                    : scorePct >= 60
                      ? 'katab-kb-score-mid'
                      : 'katab-kb-score-low';
            let scoreBadge = new St.Label({
                text: `${scorePct}%`,
                style_class: `katab-kb-score-badge ${scoreClass}`,
                y_align: Clutter.ActorAlign.START,
            });
            row.add_child(scoreBadge);

            // Text column
            let textCol = new St.BoxLayout({
                vertical: true,
                x_expand: true,
                style_class: 'katab-kb-result-text-col',
            });

            if (title) {
                let titleLabel = new St.Label({
                    text: title,
                    style_class: 'katab-kb-result-title',
                    x_expand: true,
                });
                titleLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
                titleLabel.clutter_text.single_line_mode = true;
                textCol.add_child(titleLabel);
            }

            let sourceAndDate = sourceLabel;
            if (ts) {
                try {
                    const d = new Date(ts);
                    sourceAndDate += ` · ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
                } catch (_) {
                    /* use raw ts */
                }
            }
            let sourceLabelWidget = new St.Label({
                text: sourceAndDate,
                style_class: 'katab-kb-result-source',
            });
            textCol.add_child(sourceLabelWidget);

            let snippetLabel = new St.Label({
                text: snippet + (result.content && result.content.length > 200 ? '…' : ''),
                style_class: 'katab-kb-result-snippet',
                x_expand: true,
            });
            snippetLabel.clutter_text.line_wrap = true;
            snippetLabel.clutter_text.single_line_mode = false;
            snippetLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            textCol.add_child(snippetLabel);

            row.add_child(textCol);

            // Click: navigate to source conversation or expand snippet
            row.connect('button-press-event', () => {
                if (sourceLabel === 'conversation' && meta.sessionId) {
                    // Find and load the conversation
                    const allEntries = HistoryManager.getCached();
                    const entry = allEntries.find((e) => e.id === meta.sessionId);
                    if (entry) {
                        this._host.loadConversation(entry);
                        this._host.showChatView();
                    }
                }
                return Clutter.EVENT_STOP;
            });

            this._container.add_child(row);
        }
    }

    // ── Called by the dialog's view-switching methods ─────────────────────

    /** Prepare the panel for display: KB search box visibility, fresh list,
     *  auto-focus the search bar. */
    prepareForShow() {
        // Phase 2: show KB search box if RAG is enabled, reset KB search state
        this._kbSearchViewActive = false;
        try {
            const ragConfig = readRagConfig(this._settings);
            if (this._kbSearchBox) {
                this._kbSearchBox.visible = ragConfig.enabled;
            }
            if (this._kbSearchEntry) {
                this._kbSearchEntry.set_text('');
            }
        } catch (_e) {
            if (this._kbSearchBox) this._kbSearchBox.visible = false;
        }
        this.renderList(this._searchQuery || null);
        // Auto-focus the search bar so the user can start typing immediately
        if (this._searchEntry) {
            this._searchEntry.grab_key_focus();
        }
    }

    /** Clear search + KB state when the history panel is left. */
    resetViewState() {
        // Clear any active history search so the user gets a fresh list
        // next time they open the history panel.
        if (this._searchEntry) {
            this._searchEntry.set_text('');
        }
        if (this._searchTimeoutId) {
            GLib.source_remove(this._searchTimeoutId);
            this._searchTimeoutId = 0;
        }
        this._searchQuery = '';
        // Phase 2: reset KB search state
        this._kbSearchViewActive = false;
        if (this._kbSearchEntry) {
            this._kbSearchEntry.set_text('');
        }
    }

    /** Force the next renderList() call to rebuild the rows. */
    invalidateList() {
        this._listCacheKey = null;
    }

    /** Remove pending timers/cancellables so nothing fires post-destroy. */
    destroy() {
        if (this._searchTimeoutId) {
            GLib.source_remove(this._searchTimeoutId);
            this._searchTimeoutId = 0;
        }
        if (this._editorCancellable) {
            try {
                this._editorCancellable.cancel();
            } catch (_e) {
                /* already cancelled */
            }
            this._editorCancellable = null;
        }
        this._titleGenInFlight = false;
    }
}
