// historyManager.test.js — Tests for the extracted conversation-history store.
//
// Uses the _setHistoryPathForTesting seam so the suite never touches the real
// ~/.local/share/katabai/history.json.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import {
    HistoryManager,
    _setHistoryPathForTesting,
} from '../src/core/historyManager.js';
import { assert, assertEqual, runTests } from './testUtils.js';

const TEST_PATH = GLib.build_filenamev([GLib.get_tmp_dir(), 'katabai-history-test.json']);

function removeTestFile() {
    try {
        Gio.File.new_for_path(TEST_PATH).delete(null);
    } catch (_e) {
        // not present
    }
}

function readPersisted() {
    const [, bytes] = Gio.File.new_for_path(TEST_PATH).load_contents(null);
    return JSON.parse(new TextDecoder('utf-8').decode(bytes));
}

// Order matters: these tests share the static HistoryManager cache.
_setHistoryPathForTesting(TEST_PATH);
removeTestFile();
HistoryManager.invalidateCache();

const userMsg = (text) => [{ role: 'user', content: text }, { role: 'assistant', content: 'ok' }];

const tests = [
    ['save + flushSync writes the file; invalidate + load reads it back', () => {
        const id = HistoryManager.saveConversation(userMsg('Hello world'));
        assert(id && id.startsWith('conv_'), 'id returned');
        HistoryManager.flushSync();
        assert(GLib.file_test(TEST_PATH, GLib.FileTest.EXISTS), 'file written');

        HistoryManager.invalidateCache();
        const loaded = HistoryManager.load();
        assertEqual(loaded.length, 1, 'one entry');
        assertEqual(loaded[0].id, id, 'id round-trips');
        assertEqual(loaded[0].title, 'Hello world', 'title from first user message');
    }],

    ['save with existingId replaces in place (no duplicate, cache stays attached)', () => {
        const before = HistoryManager.getCached().length;
        const id = HistoryManager.getCached()[0].id;
        HistoryManager.saveConversation(userMsg('Hello world updated'), id);
        HistoryManager.flushSync();

        const loaded = HistoryManager.getCached();
        assertEqual(loaded.length, before, 'no duplicate entry');
        assertEqual(loaded[0].id, id, 'same id retained');
        assertEqual(loaded[0].messages[0].content, 'Hello world updated', 'messages replaced');
    }],

    ['title: array content is flattened; long titles get an ellipsis', () => {
        const longText = 'A'.repeat(80);
        HistoryManager.saveConversation([
            { role: 'user', content: [{ type: 'text', text: longText }] },
        ]);
        const entry = HistoryManager.getCached()[0];
        assertEqual(entry.title.length, 61, '60 chars + ellipsis');
        assert(entry.title.endsWith('\u2026'), 'ellipsis appended');
        assert(entry.title.startsWith('A'.repeat(60)), 'content prefix kept');
    }],

    ['title: whitespace/newlines collapsed', () => {
        HistoryManager.saveConversation(userMsg('  first line\n\n   second line  '));
        const entry = HistoryManager.getCached()[0];
        assertEqual(entry.title, 'first line second line', 'single-line title');
    }],

    ['save returns null when there is no user message', () => {
        const countBefore = HistoryManager.getCached().length;
        const result = HistoryManager.saveConversation([{ role: 'assistant', content: 'hi' }]);
        assertEqual(result, null, 'null returned');
        assertEqual(HistoryManager.getCached().length, countBefore, 'cache untouched');
    }],

    ['cap: never more than 50 conversations, newest first', () => {
        for (let i = 0; i < 55; i++) {
            HistoryManager.saveConversation(userMsg(`entry ${i}`));
        }
        const cached = HistoryManager.getCached();
        assertEqual(cached.length, 50, 'capped at 50');
        assertEqual(cached[0].title, 'entry 54', 'newest first');
        assertEqual(cached[49].title, 'entry 5', 'oldest kept entry');
    }],

    ['deleteConversation removes the entry', () => {
        const id = HistoryManager.getCached()[0].id;
        HistoryManager.deleteConversation(id);
        assert(!HistoryManager.getCached().some(e => e.id === id), 'entry deleted');
    }],

    ['corrupt JSON on disk tolerates to an empty store', () => {
        GLib.file_set_contents(TEST_PATH, 'this is not json');
        HistoryManager.invalidateCache();
        assertEqual(HistoryManager.load().length, 0, 'empty after corrupt file');
    }],

    ['valid-but-non-array JSON tolerates to an empty store', () => {
        GLib.file_set_contents(TEST_PATH, '{"not":"an array"}');
        HistoryManager.invalidateCache();
        assertEqual(HistoryManager.load().length, 0, 'empty after non-array file');
    }],

    ['flushSync after load of an empty store is a no-op', () => {
        HistoryManager.flushSync();
        assert(true, 'no throw');
    }],

    ['cleanup: restore path and remove temp file', () => {
        removeTestFile();
        _setHistoryPathForTesting(null);
        HistoryManager.invalidateCache();
        assert(true, 'cleaned up');
    }],
];

await runTests(tests);
