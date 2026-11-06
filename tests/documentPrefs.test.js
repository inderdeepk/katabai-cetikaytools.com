// documentPrefs.test.js — Verifies the Document Tool preferences section wires
// every capability row to the runtime detector without GTK/Adwaita.
import { buildDocumentSection } from '../src/ui/prefs/tools/document.js';
import { getDocumentToolCapabilities } from '../src/tools/documentTools.js';
import { assert, assertEqual, runTests } from './testUtils.js';

function makeContext({ enabled = true } = {}) {
    const badges = [];
    const rows = [];
    const buttons = [];

    const ctx = {
        settings: { get_boolean: () => enabled },
        watch: () => {},
        createToolSubpage: () => ({ detailPage: { add: () => {} }, navPage: {} }),
        createPreferencesGroup: () => ({}),
        createBooleanRow: () => ({}),
        createInfoRow: (title, subtitle = '') => {
            const row = { title, subtitle };
            rows.push(row);
            return row;
        },
        createStatusRow: (title, subtitle = '') => {
            const row = { title, subtitle };
            rows.push(row);
            return { row, badge: {} };
        },
        setStatusBadge: (badge, label, styleClass) => {
            badge.label = label;
            badge.styleClass = styleClass;
            badges.push({ label, styleClass });
        },
        createButtonRow: (title, subtitle, label, onClick) => {
            buttons.push({ title, label, onClick });
        },
    };

    return { ctx, badges, rows, buttons };
}

const tests = [
    [
        'buildDocumentSection: builds a row for every supported format group',
        () => {
            const { ctx, rows } = makeContext();
            const page = buildDocumentSection(ctx);
            assert(page, 'section returned a subpage');

            const titles = rows.map((row) => row.title);
            for (const expected of [
                'Text and Markdown',
                'Images (PNG/JPG)',
                'Spreadsheet Text (CSV/TSV)',
                'Word and OpenDocument Text',
                'Excel and OpenDocument Spreadsheets',
                'PowerPoint and OpenDocument Presentations',
                'PDF Documents',
                'Legacy Office (.doc, .xls, .ppt)',
                'Email Messages (.eml)',
            ]) {
                assert(titles.includes(expected), `${expected} row present`);
            }
        },
    ],

    [
        'buildDocumentSection: built-in readers advertise "Built in"',
        () => {
            const { ctx, rows, badges } = makeContext();
            buildDocumentSection(ctx);

            const builtinRows = [
                'Text and Markdown',
                'Images (PNG/JPG)',
                'Spreadsheet Text (CSV/TSV)',
                'Word and OpenDocument Text',
                'Excel and OpenDocument Spreadsheets',
                'PowerPoint and OpenDocument Presentations',
                'Email Messages (.eml)',
            ];
            assertEqual(
                badges.filter((badge) => badge.label === 'Built in').length,
                builtinRows.length,
                'one Built in badge per built-in row',
            );

            for (const title of builtinRows) {
                assert(
                    rows.some((row) => row.title === title),
                    `${title} rendered`,
                );
            }
        },
    ],

    [
        'buildDocumentSection: helper-backed rows mirror the detected capabilities',
        () => {
            const capabilities = getDocumentToolCapabilities();
            const { ctx, rows, badges } = makeContext();
            buildDocumentSection(ctx);

            const helperRows = [
                ['PDF Documents', capabilities.pdf],
                ['Legacy Office (.doc, .xls, .ppt)', capabilities.legacy],
            ];
            for (const [title, capability] of helperRows) {
                const row = rows.find((candidate) => candidate.title === title);
                assert(row, `${title} rendered`);
                const expectedBadge = capability.available ? 'Detected' : 'Install';
                assert(
                    badges.some((badge) => badge.label === expectedBadge),
                    `${title} badge reflects ${expectedBadge}`,
                );
                if (capability.available) {
                    assert(row.subtitle.includes(capability.commandPath), `${title} shows path`);
                } else {
                    assert(row.subtitle.includes('Install'), `${title} shows install hint`);
                }
            }
        },
    ],

    [
        'buildDocumentSection: refresh button re-runs detection without throwing',
        () => {
            const { ctx, buttons } = makeContext();
            buildDocumentSection(ctx);
            const refresh = buttons.find((button) => button.title === 'Refresh Detection');
            assert(refresh, 'refresh button created');
            refresh.onClick();
        },
    ],
];

await runTests(tests);
