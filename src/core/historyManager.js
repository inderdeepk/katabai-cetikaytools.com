// historyManager.js — Conversation history persistence for Katab.
//
// Stores up to 50 conversations as a JSON array at
//   ~/.local/share/katabai/history.json
// with an in-memory cache and debounced (200 ms) writes.  Extracted from
// extension.js so it can be unit-tested with a redirected storage path.
//
// IMPORTANT: saveConversation must keep mutating the cached array IN PLACE
// (findIndex/splice).  Using Array.filter() returned a new array that
// silently detached the cache from the persisted file and lost every
// assistant response (June 2026 regression).

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

const MAX_CONVERSATIONS = 50;

// Storage caps for the user-managed metadata fields (UI also enforces these
// as entry max_length so the values survive round-trips unchanged).
export const HISTORY_TITLE_MAX_CHARS = 120;
export const HISTORY_DESCRIPTION_MAX_CHARS = 400;

let _historyPathOverride = null;

/** Test seam: redirect history storage; pass null to restore the real path. */
export function _setHistoryPathForTesting(path) {
    _historyPathOverride = path || null;
}

function getHistoryFilePath() {
    if (_historyPathOverride) {
        return _historyPathOverride;
    }
    return GLib.build_filenamev([GLib.get_user_data_dir(), 'katabai', 'history.json']);
}

export class HistoryManager {
    static _cache = null;
    static _dirty = false;
    static _flushSourceId = 0;
    static _idSeq = 0;
    static FLUSH_DELAY_MS = 200;

    static get filePath() {
        return getHistoryFilePath();
    }

    static ensureDir() {
        let dir = Gio.File.new_for_path(GLib.path_get_dirname(getHistoryFilePath()));
        try {
            dir.make_directory_with_parents(null);
        } catch (_e) {
            // already exists
        }
    }

    static _backupCorruptFile(file) {
        try {
            const backupPath = `${this.filePath}.corrupt.${Date.now()}`;
            file.copy(Gio.File.new_for_path(backupPath), Gio.FileCopyFlags.OVERWRITE, null, null);
            log(`[Katab:history] Backed up corrupt history file to ${backupPath}`);
        } catch (_e) {
            /* best effort */
        }
    }

    static _readFromDisk() {
        const file = Gio.File.new_for_path(this.filePath);
        try {
            let [, bytes] = file.load_contents(null);
            const parsed = JSON.parse(new TextDecoder('utf-8').decode(bytes));
            if (Array.isArray(parsed)) {
                this._cache = parsed;
            } else {
                log('[Katab:history] History file is not a JSON array — starting fresh.');
                this._backupCorruptFile(file);
                this._cache = [];
            }
        } catch (e) {
            if (!e?.matches?.(Gio.io_error_quark(), Gio.IOErrorEnum.NOT_FOUND)) {
                log(`[Katab:history] Failed to read history file: ${e.message || e}`);
                this._backupCorruptFile(file);
            }
            this._cache = [];
        }
        return this._cache;
    }

    /** Returns the cached array (reads disk once on first access). */
    static load() {
        if (this._cache === null) {
            this._readFromDisk();
        }
        return this._cache;
    }

    /** Returns the cached array (loads once on first access). */
    static getCached() {
        return this.load();
    }

    /** Marks cache dirty and schedules a debounced flush to disk. */
    static _scheduleFlush() {
        this._dirty = true;
        if (this._flushSourceId) {
            return;
        }
        this._flushSourceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, this.FLUSH_DELAY_MS, () => {
            this._flushSourceId = 0;
            this._flushNow();
            return GLib.SOURCE_REMOVE;
        });
    }

    /** Writes the cache to disk immediately (called by the flush timer). */
    static _flushNow() {
        if (!this._dirty || this._cache === null) {
            return;
        }
        try {
            this.ensureDir();
            let file = Gio.File.new_for_path(this.filePath);
            let data = new TextEncoder().encode(JSON.stringify(this._cache, null, 2));
            file.replace_contents(data, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);
            this._dirty = false;
        } catch (e) {
            log(`Katab: failed to save history: ${e.message}`);
        }
    }

    /** Force an immediate disk flush. Call on disable/destroy. */
    static flushSync() {
        if (this._flushSourceId) {
            GLib.source_remove(this._flushSourceId);
            this._flushSourceId = 0;
        }
        this._flushNow();
    }

    /** Invalidate the in-memory cache so the next load() re-reads disk. */
    static invalidateCache() {
        if (this._flushSourceId) {
            GLib.source_remove(this._flushSourceId);
            this._flushSourceId = 0;
        }
        this._dirty = false;
        this._cache = null;
    }

    /** Default title = first 60 code points of the first user message. */
    static _computeDefaultTitle(messageHistory) {
        let userMsgs = messageHistory.filter((m) => m.role === 'user');
        if (userMsgs.length === 0) return '';

        // Safely extract the title from the first user message, handling
        // array content (Anthropic blocks) and non-string edge cases.
        let firstContent = userMsgs[0].content;
        let rawTitle = (
            typeof firstContent === 'string'
                ? firstContent
                : Array.isArray(firstContent)
                  ? firstContent.map((b) => b?.text || b?.content || '').join(' ')
                  : String(firstContent ?? '')
        )
            .replace(/\s*\n\s*/g, ' ')
            .trim();
        const chars = Array.from(rawTitle);
        if (chars.length <= 60) {
            return rawTitle;
        }
        return `${chars.slice(0, 60).join('')}\u2026`;
    }

    /**
     * Persist a conversation.  Entry shape:
     *   { id, title, timestamp, messages,
     *     customTitle?,  // title was set manually/generated — never auto-overwrite
     *     description?,  // user-managed one-line summary
     *     archived? }    // hidden from the active list when true
     *
     * User-managed metadata is carried over from the previous snapshot on
     * every re-save so it survives automatic saves during chatting.
     */
    static saveConversation(messageHistory, existingId = null) {
        let userMsgs = messageHistory.filter((m) => m.role === 'user');
        if (userMsgs.length === 0) return null;

        let arr = this.load();
        let id = existingId || `conv_${Date.now()}_${++this._idSeq}`;

        // Use cache instead of re-reading disk — mutate in-place so that
        // _flushNow writes the updated array. Array.filter() returns a new
        // array, which would silently detach from this._cache.
        let existing = null;
        if (existingId) {
            let idx = arr.findIndex((e) => e.id === existingId);
            if (idx >= 0) existing = arr.splice(idx, 1)[0];
        }

        let entry = {
            id: id,
            title: this._computeDefaultTitle(messageHistory),
            timestamp: Math.floor(Date.now() / 1000),
            messages: messageHistory.map((m) => (m && typeof m === 'object' ? { ...m } : m)),
        };

        // Carry over user-managed metadata: a manual/generated title must not
        // be replaced by the first-message fallback, and an archived chat
        // must not silently return to the active list.
        if (existing) {
            if (existing.customTitle && typeof existing.title === 'string' && existing.title) {
                entry.title = existing.title;
                entry.customTitle = true;
            }
            if (existing.description) entry.description = existing.description;
            if (existing.archived) entry.archived = true;
        }

        arr.unshift(entry);
        // Prefer evicting oldest non-archived entries first so explicitly
        // archived chats aren't silently purged by active chatting.
        while (arr.length > MAX_CONVERSATIONS) {
            let evictIdx = -1;
            for (let i = arr.length - 1; i >= 1; i--) {
                if (!arr[i]?.archived) {
                    evictIdx = i;
                    break;
                }
            }
            if (evictIdx >= 0) {
                arr.splice(evictIdx, 1);
            } else {
                arr.pop();
            }
        }
        this._scheduleFlush();
        return id;
    }

    /** Archive / unarchive a conversation. Returns false when not found. */
    static setConversationArchived(id, archived) {
        let arr = this.load();
        let entry = arr.find((e) => e.id === id);
        if (!entry) return false;
        if (archived) {
            entry.archived = true;
        } else {
            delete entry.archived;
        }
        this._scheduleFlush();
        return true;
    }

    /**
     * Update the user-managed title/description of a conversation.
     * An empty title resets it to the automatic first-message title.
     * Returns false when the entry is not found.
     */
    static updateConversationMeta(id, { title, description } = {}) {
        let arr = this.load();
        let entry = arr.find((e) => e.id === id);
        if (!entry) return false;

        if (typeof title === 'string') {
            let nextTitle = title.replace(/\s*\n\s*/g, ' ').trim();
            if (nextTitle) {
                entry.title = Array.from(nextTitle).slice(0, HISTORY_TITLE_MAX_CHARS).join('');
                entry.customTitle = true;
            } else {
                delete entry.customTitle;
                entry.title = this._computeDefaultTitle(entry.messages) || entry.title;
            }
        }
        if (typeof description === 'string') {
            let nextDesc = description.replace(/\s+/g, ' ').trim();
            if (nextDesc) {
                entry.description = Array.from(nextDesc)
                    .slice(0, HISTORY_DESCRIPTION_MAX_CHARS)
                    .join('');
            } else {
                delete entry.description;
            }
        }
        this._scheduleFlush();
        return true;
    }

    /** Conversations not archived (newest first). Read-only view. */
    static getActiveConversations() {
        return this.getCached().filter((e) => !e.archived);
    }

    /** Archived conversations (newest first). Read-only view. */
    static getArchivedConversations() {
        return this.getCached().filter((e) => e.archived === true);
    }

    static deleteConversation(id) {
        let arr = this.load();
        let removed = false;
        for (let i = arr.length - 1; i >= 0; i--) {
            if (arr[i]?.id === id) {
                arr.splice(i, 1);
                removed = true;
            }
        }
        if (removed) {
            this._scheduleFlush();
        }
    }
}
