// presetManager.test.js — Tests for Ollama preset CRUD & reconciliation
import GLib from 'gi://GLib';
import {
    PRESET_SETTINGS,
    capturePresetFromSettings,
    applyPresetToSettings,
    settingsMatchPreset,
    reconcileActivePreset,
    loadPresets,
    savePresets,
    addPreset,
    deletePreset,
    getPresetById,
    updatePresetFromSettings,
    updatePresetName,
    _setPresetsPathForTesting,
} from '../src/usage/presetManager.js';
import {
    assert,
    assertEqual,
    assertDeepEqual,
    runTests,
    createMockSettings,
    makeTempDir,
    removeTempDir,
} from './testUtils.js';

// Redirect the presets file into a throwaway directory so the suite never
// touches the real ~/.local/share/katabai/presets.json.
const TEMP_DIR = makeTempDir('katabai-presets-XXXXXX');
const PRESETS_PATH = GLib.build_filenamev([TEMP_DIR, 'presets.json']);
_setPresetsPathForTesting(PRESETS_PATH);

function writePresetsFile(contents) {
    GLib.mkdir_with_parents(GLib.path_get_dirname(PRESETS_PATH), 0o755);
    GLib.file_set_contents(PRESETS_PATH, contents);
}

function presetForEveryKey(prefix) {
    const preset = { id: `${prefix}_id`, name: prefix, createdAt: 1 };
    PRESET_SETTINGS.forEach(({ key, type }, index) => {
        if (type === 'string') preset[key] = `${prefix}-${index}`;
        else if (type === 'int') preset[key] = 1000 + index;
        else if (type === 'double') preset[key] = 0.5 + index;
        else preset[key] = index % 2 === 0;
    });
    return preset;
}

const tests = [
    // ── PRESET_SETTINGS structure ──────────────────────────────────────────

    [
        'PRESET_SETTINGS: all entries have required fields',
        () => {
            assert(PRESET_SETTINGS.length >= 26, 'at least 26 preset keys');
            const validTypes = new Set(['string', 'int', 'boolean', 'double']);
            for (const entry of PRESET_SETTINGS) {
                assert(
                    typeof entry.key === 'string' && entry.key.length > 0,
                    `key is string: ${entry.key}`,
                );
                assert(validTypes.has(entry.type), `valid type for ${entry.key}: ${entry.type}`);
                assert(
                    typeof entry.settingKey === 'string' && entry.settingKey.length > 0,
                    `settingKey is string: ${entry.settingKey}`,
                );
            }
        },
    ],

    [
        'PRESET_SETTINGS: no duplicate keys',
        () => {
            const keys = PRESET_SETTINGS.map((e) => e.key);
            const unique = new Set(keys);
            assertEqual(keys.length, unique.size, 'all keys unique');
        },
    ],

    [
        'PRESET_SETTINGS: no duplicate settingKeys',
        () => {
            const settingKeys = PRESET_SETTINGS.map((e) => e.settingKey);
            const unique = new Set(settingKeys);
            assertEqual(settingKeys.length, unique.size, 'all settingKeys unique');
        },
    ],

    // ── capturePresetFromSettings ──────────────────────────────────────────

    [
        'capturePresetFromSettings: captures all preset keys',
        () => {
            const store = {};
            PRESET_SETTINGS.forEach(({ key, type, settingKey }, index) => {
                if (type === 'string') store[settingKey] = `test-${key}`;
                else if (type === 'int') store[settingKey] = 1000 + index;
                else if (type === 'double') store[settingKey] = 0.5 + index;
                else store[settingKey] = index % 2 === 0;
            });
            const settings = createMockSettings(store);

            const preset = capturePresetFromSettings(settings, 'Test Preset');
            assertEqual(preset.name, 'Test Preset', 'name stored');
            assert(
                typeof preset.id === 'string' && preset.id.startsWith('preset_'),
                'id generated',
            );
            assert(typeof preset.createdAt === 'number' && preset.createdAt > 0, 'timestamp set');

            for (const { key, settingKey } of PRESET_SETTINGS) {
                assertEqual(preset[key], store[settingKey], `${key} captured from ${settingKey}`);
            }
        },
    ],

    [
        'capturePresetFromSettings: handles missing keys gracefully',
        () => {
            const settings = createMockSettings({
                'ollama-model': 'llama3.2',
                // All other keys are missing — mock returns default values (0, false, '', 0.0)
            });

            const preset = capturePresetFromSettings(settings, 'Minimal');
            assertEqual(preset.model, 'llama3.2', 'model captured');
            // Missing keys get default values from the mock (0 for int, 0.0 for double, etc.)
            assert(typeof preset['num-ctx'] === 'number', 'missing int gets default');
        },
    ],

    // ── applyPresetToSettings ──────────────────────────────────────────────

    [
        'applyPresetToSettings: writes all preset values to settings',
        () => {
            const settings = createMockSettings({});
            const preset = {
                id: 'preset_test',
                name: 'Test',
                createdAt: 1700000000,
                model: 'llama3.2',
                'num-ctx': 8192,
                temperature: 0.5,
                'use-mmap': false,
            };

            applyPresetToSettings(settings, preset);
            assertEqual(settings.get_string('ollama-model'), 'llama3.2', 'model applied');
            assertEqual(settings.get_int('ollama-num-ctx'), 8192, 'num-ctx applied');
            assertEqual(settings.get_double('ollama-temperature'), 0.5, 'temperature applied');
            assertEqual(settings.get_boolean('ollama-use-mmap'), false, 'use-mmap applied');
        },
    ],

    [
        'applyPresetToSettings: skips missing keys in preset',
        () => {
            const settings = createMockSettings({
                'ollama-model': 'original',
                'ollama-num-ctx': 2048,
            });
            const preset = {
                model: 'updated',
                // num-ctx is NOT in the preset
            };

            applyPresetToSettings(settings, preset);
            // model should be updated
            assertEqual(settings.get_string('ollama-model'), 'updated', 'model updated');
            // num-ctx should be preserved (not touched)
            assertEqual(settings.get_int('ollama-num-ctx'), 2048, 'num-ctx unchanged');
        },
    ],

    // ── settingsMatchPreset ────────────────────────────────────────────────

    [
        'settingsMatchPreset: exact match',
        () => {
            const settings = createMockSettings({
                'ollama-model': 'llama3.2',
                'ollama-num-ctx': 4096,
                'ollama-temperature': 0.7,
            });
            const preset = {
                model: 'llama3.2',
                'num-ctx': 4096,
                temperature: 0.7,
            };
            assert(settingsMatchPreset(settings, preset), 'exact match');
        },
    ],

    [
        'settingsMatchPreset: string mismatch',
        () => {
            const settings = createMockSettings({ 'ollama-model': 'llama3.2' });
            const preset = { model: 'different-model' };
            assert(!settingsMatchPreset(settings, preset), 'string mismatch');
        },
    ],

    [
        'settingsMatchPreset: int mismatch',
        () => {
            const settings = createMockSettings({ 'ollama-num-ctx': 4096 });
            const preset = { 'num-ctx': 2048 };
            assert(!settingsMatchPreset(settings, preset), 'int mismatch');
        },
    ],

    [
        'settingsMatchPreset: double within epsilon matches',
        () => {
            const settings = createMockSettings({ 'ollama-temperature': 0.7000001 });
            const preset = { temperature: 0.7 };
            assert(settingsMatchPreset(settings, preset), 'double within epsilon');
        },
    ],

    [
        'settingsMatchPreset: double outside epsilon mismatches',
        () => {
            const settings = createMockSettings({ 'ollama-temperature': 0.8 });
            const preset = { temperature: 0.7 };
            assert(!settingsMatchPreset(settings, preset), 'double outside epsilon');
        },
    ],

    [
        'settingsMatchPreset: missing key in preset is skipped',
        () => {
            const settings = createMockSettings({
                'ollama-model': 'llama3.2',
                'ollama-num-ctx': 4096,
            });
            const preset = { model: 'llama3.2' };
            // num-ctx not in preset → skipped → match should succeed
            assert(settingsMatchPreset(settings, preset), 'missing key in preset skipped');
        },
    ],

    [
        'settingsMatchPreset: boolean match and mismatch',
        () => {
            const settings = createMockSettings({ 'ollama-use-mmap': true });
            assert(settingsMatchPreset(settings, { 'use-mmap': true }), 'bool match');
            assert(!settingsMatchPreset(settings, { 'use-mmap': false }), 'bool mismatch');
        },
    ],

    // ── reconcileActivePreset ──────────────────────────────────────────────

    [
        'reconcileActivePreset: no active preset returns null',
        () => {
            const settings = createMockSettings({ 'ollama-active-preset': '' });
            const result = reconcileActivePreset(settings);
            assertEqual(result, null, 'no active preset → null');
        },
    ],

    [
        'reconcileActivePreset: active preset ID but preset not found → clears',
        () => {
            const settings = createMockSettings({
                'ollama-active-preset': 'nonexistent_id',
                'ollama-model': 'some-model',
            });
            const result = reconcileActivePreset(settings);
            assertEqual(result, null, 'preset not found → null');
            assertEqual(settings.get_string('ollama-active-preset'), '', 'active preset cleared');
        },
    ],

    // ── Disk persistence ───────────────────────────────────────────────────
    // These exercise the real Gio file I/O through the _setPresetsPathForTesting seam.

    [
        'disk: loadPresets on a missing file returns an empty array',
        () => {
            try {
                GLib.unlink(PRESETS_PATH);
            } catch (_e) {
                /* not present */
            }
            assertEqual(loadPresets().length, 0, 'empty store when no presets.json');
        },
    ],

    [
        'disk: savePresets + loadPresets round-trip every field',
        () => {
            const presets = [presetForEveryKey('one'), presetForEveryKey('two')];
            assert(savePresets(presets), 'savePresets reports success');
            assert(GLib.file_test(PRESETS_PATH, GLib.FileTest.EXISTS), 'presets.json written');
            assertDeepEqual(loadPresets(), presets, 'round-trip preserves all fields');
        },
    ],

    [
        'disk: loadPresets recovers from corrupt JSON with an empty array',
        () => {
            writePresetsFile('{not valid json');
            assertEqual(loadPresets().length, 0, 'corrupt file → empty store');
        },
    ],

    [
        'disk: loadPresets returns [] when the file holds a non-array',
        () => {
            writePresetsFile('{"presets":[]}');
            assertEqual(loadPresets().length, 0, 'non-array payload → empty store');
        },
    ],

    [
        'disk: addPreset appends and persists',
        () => {
            savePresets([]);
            const first = presetForEveryKey('first');
            const second = presetForEveryKey('second');
            assertEqual(addPreset(first), first.id, 'addPreset returns the id');
            addPreset(second);
            assertDeepEqual(
                loadPresets().map((p) => p.id),
                [first.id, second.id],
                'both presets persisted in order',
            );
        },
    ],

    [
        'getPresetById: finds by id, rejects unknown/empty ids',
        () => {
            const presets = [presetForEveryKey('a'), presetForEveryKey('b')];
            assertEqual(getPresetById('a_id', presets)?.name, 'a', 'explicit list lookup');
            assertEqual(getPresetById('b_id', presets)?.name, 'b', 'second entry lookup');
            assertEqual(getPresetById('missing', presets), null, 'unknown id → null');
            assertEqual(getPresetById('', presets), null, 'empty id → null');
            assertEqual(getPresetById(null, presets), null, 'null id → null');
        },
    ],

    [
        'deletePreset: removes only the matching id',
        () => {
            savePresets([presetForEveryKey('keep'), presetForEveryKey('drop')]);
            deletePreset('drop_id');
            assertDeepEqual(
                loadPresets().map((p) => p.id),
                ['keep_id'],
                'only the requested preset removed',
            );
            deletePreset('not-there');
            assertEqual(loadPresets().length, 1, 'deleting an unknown id is a no-op');
        },
    ],

    [
        'updatePresetName: renames, trims, and ignores blank or unknown ids',
        () => {
            savePresets([presetForEveryKey('rename')]);
            updatePresetName('rename_id', '  New Name  ');
            assertEqual(loadPresets()[0].name, 'New Name', 'name updated and trimmed');
            updatePresetName('rename_id', '   ');
            assertEqual(loadPresets()[0].name, 'New Name', 'blank name keeps the old one');
            updatePresetName('not-there', 'Ignored');
            assertEqual(loadPresets().length, 1, 'unknown id is a no-op');
        },
    ],

    [
        'updatePresetFromSettings: writes changed values and reports the preset',
        () => {
            savePresets([presetForEveryKey('update')]);
            const settings = createMockSettings({
                'ollama-model': 'qwen3',
                'ollama-num-ctx': 8192,
            });

            const updated = updatePresetFromSettings(settings, 'update_id');
            assert(updated, 'returns the updated preset');
            assertEqual(updated.model, 'qwen3', 'model refreshed from settings');
            assertEqual(updated['num-ctx'], 8192, 'num-ctx refreshed from settings');
            assertEqual(loadPresets()[0].model, 'qwen3', 'change persisted to disk');
        },
    ],

    [
        'updatePresetFromSettings: onlyMissing preserves stored values',
        () => {
            const stored = presetForEveryKey('partial');
            delete stored.model;
            delete stored['num-ctx'];
            savePresets([stored]);
            const settings = createMockSettings({
                'ollama-url': 'http://other-host:11434',
                'ollama-model': 'from-settings',
                'ollama-num-ctx': 8192,
            });

            const updated = updatePresetFromSettings(settings, 'partial_id', {
                onlyMissing: true,
            });
            assertEqual(updated.url, stored.url, 'existing field preserved');
            assertEqual(updated.model, 'from-settings', 'missing field backfilled');
            assertEqual(updated['num-ctx'], 8192, 'second missing field backfilled');
        },
    ],

    [
        'updatePresetFromSettings: unknown id returns null and writes nothing',
        () => {
            savePresets([presetForEveryKey('stable')]);
            const before = loadPresets();
            assertEqual(
                updatePresetFromSettings(createMockSettings({}), 'nope'),
                null,
                'unknown id → null',
            );
            assertDeepEqual(loadPresets(), before, 'store untouched');
        },
    ],

    [
        'cleanup: restore the real path and remove the temp dir',
        () => {
            _setPresetsPathForTesting(null);
            removeTempDir(TEMP_DIR);
            assert(!GLib.file_test(PRESETS_PATH, GLib.FileTest.EXISTS), 'temp presets removed');
        },
    ],
];

await runTests(tests);
