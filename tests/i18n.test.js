// i18n.test.js — Unit tests for the shared gettext bridge (src/shared/i18n.js).
//
// The bridge must be safe BEFORE initialization (identity translation) because
// it is imported by modules under plain gjs (tests, import smoke), and must
// delegate to the injected functions after initI18n() — the two entry points
// (extension enable(), prefs fillPreferencesWindow()) inject the shell's own
// gettext/ngettext.
//
// Order matters: the identity assertions run BEFORE initI18n() is called;
// injection assertions run after. The module intentionally has no "reset"
// export, so the file exercises the real lifecycle once.
import { assert, assertEqual, runTests } from './testUtils.js';
import { gettext, ngettext, format, initI18n } from '../src/shared/i18n.js';

await runTests([
    [
        'gettext is identity before initI18n()',
        () => {
            assertEqual(gettext('Ask anything...'), 'Ask anything...');
        },
    ],
    [
        'ngettext falls back to singular/plural before initI18n()',
        () => {
            assertEqual(ngettext('one item', 'many items', 1), 'one item');
            assertEqual(ngettext('one item', 'many items', 0), 'many items');
            assertEqual(ngettext('one item', 'many items', 5), 'many items');
        },
    ],
    [
        'format substitutes {token} placeholders',
        () => {
            assertEqual(format('Delete preset "{name}"', { name: 'Fast' }), 'Delete preset "Fast"');
        },
    ],
    [
        'format substitutes multiple tokens and stringifies values',
        () => {
            assertEqual(
                format('{a} and {b} and {c}', { a: 'x', b: 2, c: false }),
                'x and 2 and false',
            );
        },
    ],
    [
        'format leaves unknown placeholders verbatim',
        () => {
            assertEqual(format('Keep {missing} as-is', { other: 1 }), 'Keep {missing} as-is');
        },
    ],
    [
        'format is an identity when params are omitted or not a string',
        () => {
            assertEqual(format('No params here'), 'No params here');
            assertEqual(format('No params here', null), 'No params here');
            assertEqual(format(null, { a: 1 }), null);
        },
    ],
    [
        'format ignores brace content that is not a simple token',
        () => {
            assertEqual(
                format('css { color: red; } stays', { color: 'blue' }),
                'css { color: red; } stays',
            );
        },
    ],
    [
        'initI18n() injects gettext/ngettext (missing args keep previous)',
        () => {
            initI18n({
                gettext: (s) => `xx:${s}`,
                ngettext: (s, p, n) => `${n === 1 ? s : p}!`,
            });
            assertEqual(gettext('Open'), 'xx:Open');
            assertEqual(ngettext('cat', 'cats', 1), 'cat!');
            assertEqual(ngettext('cat', 'cats', 3), 'cats!');
            initI18n({});
            assertEqual(gettext('Open'), 'xx:Open');
            initI18n({ gettext: 'not-a-function' });
            assertEqual(gettext('Open'), 'xx:Open');
        },
    ],
    [
        'format composes with an injected translation',
        () => {
            initI18n({ gettext: (s) => s.replace('Delete preset', 'Supprimer le préréglage') });
            assertEqual(
                format(gettext('Delete preset "{name}"'), { name: 'Fast' }),
                'Supprimer le préréglage "Fast"',
            );
        },
    ],
    [
        'assert utility is wired (sanity)',
        () => {
            assert(true, 'this must not throw');
        },
    ],
]);
