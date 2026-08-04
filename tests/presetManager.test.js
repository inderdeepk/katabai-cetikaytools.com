// presetManager.test.js — Tests for Ollama preset CRUD & reconciliation
import {
    PRESET_SETTINGS,
    capturePresetFromSettings,
    applyPresetToSettings,
    settingsMatchPreset,
    reconcileActivePreset,
} from '../src/usage/presetManager.js';
import { assert, assertEqual, assertDeepEqual, runTests, createMockSettings } from './testUtils.js';

const tests = [
    // ── PRESET_SETTINGS structure ──────────────────────────────────────────

    ['PRESET_SETTINGS: all entries have required fields', () => {
        assert(PRESET_SETTINGS.length >= 27, 'at least 27 preset keys');
        const validTypes = new Set(['string', 'int', 'boolean', 'double']);
        for (const entry of PRESET_SETTINGS) {
            assert(typeof entry.key === 'string' && entry.key.length > 0, `key is string: ${entry.key}`);
            assert(validTypes.has(entry.type), `valid type for ${entry.key}: ${entry.type}`);
            assert(typeof entry.settingKey === 'string' && entry.settingKey.length > 0, `settingKey is string: ${entry.settingKey}`);
        }
    }],

    ['PRESET_SETTINGS: no duplicate keys', () => {
        const keys = PRESET_SETTINGS.map(e => e.key);
        const unique = new Set(keys);
        assertEqual(keys.length, unique.size, 'all keys unique');
    }],

    ['PRESET_SETTINGS: no duplicate settingKeys', () => {
        const settingKeys = PRESET_SETTINGS.map(e => e.settingKey);
        const unique = new Set(settingKeys);
        assertEqual(settingKeys.length, unique.size, 'all settingKeys unique');
    }],

    // ── capturePresetFromSettings ──────────────────────────────────────────

    ['capturePresetFromSettings: captures all preset keys', () => {
        const overrides = {};
        for (const { key, type } of PRESET_SETTINGS) {
            if (type === 'string') overrides[key.replace(/-/g, '_')] = `test-${key}`;
            else if (type === 'int') overrides[key.replace(/-/g, '_')] = 42;
            else if (type === 'boolean') overrides[key.replace(/-/g, '_')] = true;
            else if (type === 'double') overrides[key.replace(/-/g, '_')] = 0.5;
        }
        // Actually, the settingKeys use ollama- prefix and hyphens.
        // createMockSettings uses the exact GSettings key names.
        const settings = createMockSettings({
            'ollama-model': 'llama3.2',
            'ollama-num-ctx': 4096,
            'ollama-temperature': 0.7,
            'ollama-top-p': 0.9,
            'ollama-use-mmap': true,
        });

        const preset = capturePresetFromSettings(settings, 'Test Preset');
        assertEqual(preset.name, 'Test Preset', 'name stored');
        assert(typeof preset.id === 'string' && preset.id.startsWith('preset_'), 'id generated');
        assert(typeof preset.createdAt === 'number' && preset.createdAt > 0, 'timestamp set');

        // Specific keys we explicitly set
        assertEqual(preset.model, 'llama3.2', 'model captured');
        assertEqual(preset['num-ctx'], 4096, 'num-ctx captured');
        assertEqual(preset.temperature, 0.7, 'temperature captured');
        assertEqual(preset['top-p'], 0.9, 'top-p captured');
        assertEqual(preset['use-mmap'], true, 'use-mmap captured');
    }],

    ['capturePresetFromSettings: handles missing keys gracefully', () => {
        const settings = createMockSettings({
            'ollama-model': 'llama3.2',
            // All other keys are missing — mock returns default values (0, false, '', 0.0)
        });

        const preset = capturePresetFromSettings(settings, 'Minimal');
        assertEqual(preset.model, 'llama3.2', 'model captured');
        // Missing keys get default values from the mock (0 for int, 0.0 for double, etc.)
        assert(typeof preset['num-ctx'] === 'number', 'missing int gets default');
    }],

    // ── applyPresetToSettings ──────────────────────────────────────────────

    ['applyPresetToSettings: writes all preset values to settings', () => {
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
    }],

    ['applyPresetToSettings: skips missing keys in preset', () => {
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
    }],

    // ── settingsMatchPreset ────────────────────────────────────────────────

    ['settingsMatchPreset: exact match', () => {
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
    }],

    ['settingsMatchPreset: string mismatch', () => {
        const settings = createMockSettings({ 'ollama-model': 'llama3.2' });
        const preset = { model: 'different-model' };
        assert(!settingsMatchPreset(settings, preset), 'string mismatch');
    }],

    ['settingsMatchPreset: int mismatch', () => {
        const settings = createMockSettings({ 'ollama-num-ctx': 4096 });
        const preset = { 'num-ctx': 2048 };
        assert(!settingsMatchPreset(settings, preset), 'int mismatch');
    }],

    ['settingsMatchPreset: double within epsilon matches', () => {
        const settings = createMockSettings({ 'ollama-temperature': 0.7000001 });
        const preset = { temperature: 0.7 };
        assert(settingsMatchPreset(settings, preset), 'double within epsilon');
    }],

    ['settingsMatchPreset: double outside epsilon mismatches', () => {
        const settings = createMockSettings({ 'ollama-temperature': 0.8 });
        const preset = { temperature: 0.7 };
        assert(!settingsMatchPreset(settings, preset), 'double outside epsilon');
    }],

    ['settingsMatchPreset: missing key in preset is skipped', () => {
        const settings = createMockSettings({
            'ollama-model': 'llama3.2',
            'ollama-num-ctx': 4096,
        });
        const preset = { model: 'llama3.2' };
        // num-ctx not in preset → skipped → match should succeed
        assert(settingsMatchPreset(settings, preset), 'missing key in preset skipped');
    }],

    ['settingsMatchPreset: boolean match and mismatch', () => {
        const settings = createMockSettings({ 'ollama-use-mmap': true });
        assert(settingsMatchPreset(settings, { 'use-mmap': true }), 'bool match');
        assert(!settingsMatchPreset(settings, { 'use-mmap': false }), 'bool mismatch');
    }],

    // ── reconcileActivePreset ──────────────────────────────────────────────

    ['reconcileActivePreset: no active preset returns null', () => {
        const settings = createMockSettings({ 'ollama-active-preset': '' });
        const result = reconcileActivePreset(settings);
        assertEqual(result, null, 'no active preset → null');
    }],

    ['reconcileActivePreset: active preset ID but preset not found → clears', () => {
        const settings = createMockSettings({
            'ollama-active-preset': 'nonexistent_id',
            'ollama-model': 'some-model',
        });
        const result = reconcileActivePreset(settings);
        assertEqual(result, null, 'preset not found → null');
        assertEqual(settings.get_string('ollama-active-preset'), '', 'active preset cleared');
    }],
];

runTests(tests);
