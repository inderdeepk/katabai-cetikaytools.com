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

let _historyPathOverride = null;

/** Test seam: redirect history storage; pass null to restore the real path. */
export function _setHistoryPathForTesting(path) {
    _historyPathOverride = path || null;
}

function getHistoryFilePath() {
    if (_historyPathOverride) {
        return _historyPathOverride;
    }
    return GLib.build_filenamev([
        GLib.get_user_data_dir(), 'katabai', 'history.json'
    ]);
}

export class HistoryManager {
    static _cache = null;
    static _dirty = false;
    static _flushSourceId = 0;
    static FLUSH_DELAY_MS = 200;

    static get filePath() {
        return getHistoryFilePath();
    }

    static ensureDir() {
        let dir = Gio.File.new_for_path(
            GLib.path_get_dirname(getHistoryFilePath())
        );
        try {
            dir.make_directory_with_parents(null);
        } catch (_e) {
            // already exists
        }
    }

    static _readFromDisk() {
        try {
            let file = Gio.File.new_for_path(this.filePath);
            let [, bytes] = file.load_contents(null);
            const parsed = JSON.parse(new TextDecoder('utf-8').decode(bytes));
            // Guard against a syntactically-valid but non-array file (external
            // corruption) — otherwise every save throws on .findIndex/.filter.
            this._cache = Array.isArray(parsed) ? parsed : [];
        } catch (_e) {
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

    /** Returns the cached array without ever touching disk. */
    static getCached() {
        if (this._cache === null) {
            this._readFromDisk();
        }
        return this._cache;
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
        this._dirty = false;
        try {
            this.ensureDir();
            let file = Gio.File.new_for_path(this.filePath);
            let data = new TextEncoder().encode(JSON.stringify(this._cache, null, 2));
            file.replace_contents(data, null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION, null);
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
        this._cache = null;
    }

    static saveConversation(messageHistory, existingId = null) {
        let userMsgs = messageHistory.filter(m => m.role === 'user');
        if (userMsgs.length === 0) return null;

        // Safely extract the title from the first user message, handling
        // array content (Anthropic blocks) and non-string edge cases.
        let firstContent = userMsgs[0].content;
        let rawTitle = (typeof firstContent === 'string'
            ? firstContent
            : Array.isArray(firstContent)
                ? firstContent.map(b => (b?.text || b?.content || '')).join(' ')
                : String(firstContent ?? '')
        ).replace(/\s*\n\s*/g, ' ').trim();
        let title = rawTitle.slice(0, 60);
        if (rawTitle.length > 60) title += '\u2026';

        let id = existingId || `conv_${Date.now()}`;
        let entry = {
            id: id,
            title: title,
            timestamp: Math.floor(Date.now() / 1000),
            messages: [...messageHistory],
        };

        // Use cache instead of re-reading disk — mutate in-place so that
        // _flushNow writes the updated array. Array.filter() returns a new
        // array, which would silently detach from this._cache.
        let arr = this.load();
        if (existingId) {
            let idx = arr.findIndex(e => e.id === existingId);
            if (idx >= 0) arr.splice(idx, 1);
        }
        arr.unshift(entry);
        if (arr.length > MAX_CONVERSATIONS) arr.length = MAX_CONVERSATIONS;
        this._scheduleFlush();
        return id;
    }

    static deleteConversation(id) {
        let arr = this.load();
        this._cache = arr.filter(e => e.id !== id);
        this._scheduleFlush();
    }
}
