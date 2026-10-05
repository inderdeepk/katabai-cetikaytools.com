// historyManager.test.js — Tests for the extracted conversation-history store.
//
// Uses the _setHistoryPathForTesting seam so the suite never touches the real
// ~/.local/share/katabai/history.json.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import {
    HISTORY_DESCRIPTION_MAX_CHARS,
    HISTORY_TITLE_MAX_CHARS,
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

// Order matters: these tests share the static HistoryManager cache.
_setHistoryPathForTesting(TEST_PATH);
removeTestFile();
HistoryManager.invalidateCache();

const userMsg = (text) => [
    { role: 'user', content: text },
    { role: 'assistant', content: 'ok' },
];

const tests = [
    [
        'save + flushSync writes the file; invalidate + load reads it back',
        () => {
            const id = HistoryManager.saveConversation(userMsg('Hello world'));
            assert(id && id.startsWith('conv_'), 'id returned');
            HistoryManager.flushSync();
            assert(GLib.file_test(TEST_PATH, GLib.FileTest.EXISTS), 'file written');

            HistoryManager.invalidateCache();
            const loaded = HistoryManager.load();
            assertEqual(loaded.length, 1, 'one entry');
            assertEqual(loaded[0].id, id, 'id round-trips');
            assertEqual(loaded[0].title, 'Hello world', 'title from first user message');
        },
    ],

    [
        'save with existingId replaces in place (no duplicate, cache stays attached)',
        () => {
            const before = HistoryManager.getCached().length;
            const id = HistoryManager.getCached()[0].id;
            HistoryManager.saveConversation(userMsg('Hello world updated'), id);
            HistoryManager.flushSync();

            const loaded = HistoryManager.getCached();
            assertEqual(loaded.length, before, 'no duplicate entry');
            assertEqual(loaded[0].id, id, 'same id retained');
            assertEqual(loaded[0].messages[0].content, 'Hello world updated', 'messages replaced');
        },
    ],

    [
        'title: array content is flattened; long titles get an ellipsis',
        () => {
            const longText = 'A'.repeat(80);
            HistoryManager.saveConversation([
                { role: 'user', content: [{ type: 'text', text: longText }] },
            ]);
            const entry = HistoryManager.getCached()[0];
            assertEqual(entry.title.length, 61, '60 chars + ellipsis');
            assert(entry.title.endsWith('\u2026'), 'ellipsis appended');
            assert(entry.title.startsWith('A'.repeat(60)), 'content prefix kept');
        },
    ],

    [
        'title: whitespace/newlines collapsed',
        () => {
            HistoryManager.saveConversation(userMsg('  first line\n\n   second line  '));
            const entry = HistoryManager.getCached()[0];
            assertEqual(entry.title, 'first line second line', 'single-line title');
        },
    ],

    [
        'save returns null when there is no user message',
        () => {
            const countBefore = HistoryManager.getCached().length;
            const result = HistoryManager.saveConversation([{ role: 'assistant', content: 'hi' }]);
            assertEqual(result, null, 'null returned');
            assertEqual(HistoryManager.getCached().length, countBefore, 'cache untouched');
        },
    ],

    [
        'cap: never more than 50 conversations, newest first',
        () => {
            for (let i = 0; i < 55; i++) {
                HistoryManager.saveConversation(userMsg(`entry ${i}`));
            }
            const cached = HistoryManager.getCached();
            assertEqual(cached.length, 50, 'capped at 50');
            assertEqual(cached[0].title, 'entry 54', 'newest first');
            assertEqual(cached[49].title, 'entry 5', 'oldest kept entry');
        },
    ],

    [
        'deleteConversation removes the entry',
        () => {
            const id = HistoryManager.getCached()[0].id;
            HistoryManager.deleteConversation(id);
            assert(!HistoryManager.getCached().some((e) => e.id === id), 'entry deleted');
        },
    ],

    [
        'archive: setConversationArchived toggles, persists, and survives auto-save',
        () => {
            const id = HistoryManager.saveConversation(userMsg('archivable conversation'));
            assert(HistoryManager.setConversationArchived(id, true), 'archive call returned true');
            HistoryManager.flushSync();
            HistoryManager.invalidateCache();

            let entry = HistoryManager.getCached().find((e) => e.id === id);
            assertEqual(entry.archived, true, 'archived flag persisted to disk');
            assert(
                HistoryManager.getArchivedConversations().some((e) => e.id === id),
                'present in the archived view',
            );
            assert(
                !HistoryManager.getActiveConversations().some((e) => e.id === id),
                'absent from the active view',
            );

            // A later auto-save must not silently unarchive the conversation.
            HistoryManager.saveConversation(userMsg('archivable conversation updated'), id);
            entry = HistoryManager.getCached().find((e) => e.id === id);
            assertEqual(entry.archived, true, 'archived survives auto-save');

            HistoryManager.setConversationArchived(id, false);
            entry = HistoryManager.getCached().find((e) => e.id === id);
            assertEqual(entry.archived, undefined, 'flag removed on unarchive');
            assertEqual(
                HistoryManager.setConversationArchived('conv_missing', true),
                false,
                'unknown id returns false',
            );
        },
    ],

    [
        'meta: updateConversationMeta sets custom title/description; auto-save preserves them',
        () => {
            const id = HistoryManager.saveConversation(userMsg('original first message'));
            assert(
                HistoryManager.updateConversationMeta(id, {
                    title: 'Manual Title',
                    description: 'One line summary.',
                }),
                'update returned true',
            );
            let entry = HistoryManager.getCached().find((e) => e.id === id);
            assertEqual(entry.title, 'Manual Title', 'title set');
            assertEqual(entry.customTitle, true, 'custom-title flag set');
            assertEqual(entry.description, 'One line summary.', 'description set');

            // Re-saving (as the auto-save does) must not clobber the metadata.
            HistoryManager.saveConversation(userMsg('different first message'), id);
            entry = HistoryManager.getCached().find((e) => e.id === id);
            assertEqual(entry.title, 'Manual Title', 'title survives auto-save');
            assertEqual(entry.description, 'One line summary.', 'description survives auto-save');
            assertEqual(entry.customTitle, true, 'custom-title flag survives auto-save');
            assertEqual(
                HistoryManager.updateConversationMeta('conv_missing', { title: 'x' }),
                false,
                'unknown id returns false',
            );
        },
    ],

    [
        'meta: empty title resets to the automatic title; empty description clears',
        () => {
            const id = HistoryManager.saveConversation(userMsg('auto title source'));
            HistoryManager.updateConversationMeta(id, { title: 'Custom', description: 'desc' });
            HistoryManager.updateConversationMeta(id, { title: '   ', description: '' });
            const entry = HistoryManager.getCached().find((e) => e.id === id);
            assertEqual(entry.title, 'auto title source', 'automatic title restored');
            assertEqual(entry.customTitle, undefined, 'custom-title flag cleared');
            assertEqual(entry.description, undefined, 'description cleared');
        },
    ],

    [
        'meta: stored title/description are normalized and length-capped',
        () => {
            const id = HistoryManager.saveConversation(userMsg('cap test'));
            HistoryManager.updateConversationMeta(id, {
                title: `  first\nline ${'T'.repeat(500)}  `,
                description: 'D'.repeat(2000),
            });
            const entry = HistoryManager.getCached().find((e) => e.id === id);
            assertEqual(entry.title.length, HISTORY_TITLE_MAX_CHARS, 'title capped');
            assert(entry.title.startsWith('first line T'), 'title newline collapsed');
            assertEqual(
                entry.description.length,
                HISTORY_DESCRIPTION_MAX_CHARS,
                'description capped',
            );
        },
    ],

    [
        'corrupt JSON on disk tolerates to an empty store',
        () => {
            GLib.file_set_contents(TEST_PATH, 'this is not json');
            HistoryManager.invalidateCache();
            assertEqual(HistoryManager.load().length, 0, 'empty after corrupt file');
        },
    ],

    [
        'valid-but-non-array JSON tolerates to an empty store',
        () => {
            GLib.file_set_contents(TEST_PATH, '{"not":"an array"}');
            HistoryManager.invalidateCache();
            assertEqual(HistoryManager.load().length, 0, 'empty after non-array file');
        },
    ],

    [
        'flushSync after load of an empty store is a no-op',
        () => {
            HistoryManager.flushSync();
            assert(true, 'no throw');
        },
    ],

    [
        'cleanup: restore path and remove temp file',
        () => {
            removeTestFile();
            _setHistoryPathForTesting(null);
            HistoryManager.invalidateCache();
            assert(true, 'cleaned up');
        },
    ],
];

await runTests(tests);
