/* presetManager.js
 *
 * Shared preset CRUD helpers used by both extension.js (GNOME Shell overlay)
 * and prefs.js (GTK4 preferences window).
 *
 * Presets are stored as a JSON array in
 *   ~/.local/share/katabai/presets.json
 *
 * Each preset object shape:
 *   {
 *     id:        string  (unique, e.g. "preset_1712345678000")
 *     name:      string  (user-visible label)
 *     createdAt: number  (unix timestamp)
 *     model:     string
 *     num-ctx:   number
 *     ... all other ollama-* settings
 *   }
 *
 * SPDX-License-Identifier: GPL-2.0-or-later
 */

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

// All Ollama GSettings keys captured and restored by a preset.
export const PRESET_SETTINGS = [
    { key: 'url', type: 'string', settingKey: 'ollama-url' },
    { key: 'model', type: 'string', settingKey: 'ollama-model' },
    { key: 'num-ctx', type: 'int', settingKey: 'ollama-num-ctx' },
    { key: 'num-predict', type: 'int', settingKey: 'ollama-num-predict' },
    { key: 'num-keep', type: 'int', settingKey: 'ollama-num-keep' },
    { key: 'keep-alive', type: 'string', settingKey: 'ollama-keep-alive' },
    { key: 'format', type: 'string', settingKey: 'ollama-format' },
    { key: 'raw', type: 'boolean', settingKey: 'ollama-raw' },
    { key: 'use-mmap', type: 'boolean', settingKey: 'ollama-use-mmap' },
    { key: 'use-mlock', type: 'boolean', settingKey: 'ollama-use-mlock' },
    { key: 'num-gpu', type: 'int', settingKey: 'ollama-num-gpu' },
    { key: 'num-thread', type: 'int', settingKey: 'ollama-num-thread' },
    { key: 'temperature', type: 'double', settingKey: 'ollama-temperature' },
    { key: 'top-k', type: 'int', settingKey: 'ollama-top-k' },
    { key: 'top-p', type: 'double', settingKey: 'ollama-top-p' },
    { key: 'min-p', type: 'double', settingKey: 'ollama-min-p' },
    { key: 'tfs-z', type: 'double', settingKey: 'ollama-tfs-z' },
    { key: 'typical-p', type: 'double', settingKey: 'ollama-typical-p' },
    { key: 'mirostat', type: 'int', settingKey: 'ollama-mirostat' },
    { key: 'mirostat-tau', type: 'double', settingKey: 'ollama-mirostat-tau' },
    { key: 'mirostat-eta', type: 'double', settingKey: 'ollama-mirostat-eta' },
    { key: 'repeat-last-n', type: 'int', settingKey: 'ollama-repeat-last-n' },
    { key: 'repeat-penalty', type: 'double', settingKey: 'ollama-repeat-penalty' },
    { key: 'presence-penalty', type: 'double', settingKey: 'ollama-presence-penalty' },
    { key: 'frequency-penalty', type: 'double', settingKey: 'ollama-frequency-penalty' },
];

function _getPresetsFilePath() {
    return GLib.build_filenamev([GLib.get_user_data_dir(), 'katabai', 'presets.json']);
}

function _ensureKatabaiDir() {
    try {
        Gio.File.new_for_path(
            GLib.build_filenamev([GLib.get_user_data_dir(), 'katabai'])
        ).make_directory_with_parents(null);
    } catch (_e) { /* already exists */ }
}

/**
 * Load all saved presets from disk. Returns an empty array on any error.
 * @returns {Array<Object>}
 */
export function loadPresets() {
    try {
        const file = Gio.File.new_for_path(_getPresetsFilePath());
        const [, bytes] = file.load_contents(null);
        const parsed = JSON.parse(new TextDecoder('utf-8').decode(bytes));
        return Array.isArray(parsed) ? parsed : [];
    } catch (_e) {
        return [];
    }
}

/**
 * Persist the full presets array to disk.
 * @param {Array<Object>} presets
 * @returns {boolean} true on success
 */
export function savePresets(presets) {
    try {
        _ensureKatabaiDir();
        const file = Gio.File.new_for_path(_getPresetsFilePath());
        const data = new TextEncoder().encode(JSON.stringify(presets, null, 2));
        file.replace_contents(data, null, false,
            Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        return true;
    } catch (e) {
        log(`Katab: failed to save presets: ${e.message}`);
        return false;
    }
}

/**
 * Capture all current Ollama GSettings values into a new preset object.
 * The preset is NOT saved to disk — call addPreset() for that.
 *
 * @param {Gio.Settings} settings
 * @param {string}       name    User-visible label
 * @returns {Object}  preset object ready to be saved
 */
export function capturePresetFromSettings(settings, name) {
    const preset = {
        id: `preset_${Date.now()}`,
        name: (name || 'Unnamed Preset').trim(),
        createdAt: Math.floor(Date.now() / 1000),
    };
    for (const { key, type, settingKey } of PRESET_SETTINGS) {
        try {
            preset[key] = settings[`get_${type}`](settingKey);
        } catch (_e) { /* skip unavailable keys */ }
    }
    return preset;
}

/**
 * Write all values stored in a preset back into GSettings.
 * Only keys present in the preset object are touched.
 *
 * @param {Gio.Settings} settings
 * @param {Object}       preset
 */
export function applyPresetToSettings(settings, preset) {
    for (const { key, type, settingKey } of PRESET_SETTINGS) {
        if (preset[key] !== undefined && preset[key] !== null) {
            try {
                settings[`set_${type}`](settingKey, preset[key]);
            } catch (_e) { /* skip */ }
        }
    }
}

/**
 * Append a preset to the saved list. The preset object should already have
 * an `id` (e.g. from capturePresetFromSettings).
 *
 * @param {Object} preset
 * @returns {string} the preset id
 */
export function addPreset(preset) {
    const presets = loadPresets();
    presets.push(preset);
    savePresets(presets);
    return preset.id;
}

/**
 * Remove the preset with the given id.
 * @param {string} id
 */
export function deletePreset(id) {
    savePresets(loadPresets().filter(p => p.id !== id));
}

/**
 * Look up a preset by ID.
 *
 * @param {string} id
 * @param {Array<Object>|null} presets
 * @returns {Object|null}
 */
export function getPresetById(id, presets = null) {
    if (!id)
        return null;

    const presetList = Array.isArray(presets) ? presets : loadPresets();
    return presetList.find(p => p.id === id) ?? null;
}

/**
 * Update an existing preset in place using the current GSettings values.
 * When onlyMissing is true, fields already stored in the preset are preserved.
 *
 * @param {Gio.Settings} settings
 * @param {string}       id
 * @param {{ onlyMissing?: boolean }} options
 * @returns {Object|null}
 */
export function updatePresetFromSettings(settings, id, options = {}) {
    const presets = loadPresets();
    const idx = presets.findIndex(p => p.id === id);
    if (idx < 0)
        return null;

    const { onlyMissing = false } = options;
    const updatedPreset = { ...presets[idx] };
    let changed = false;

    for (const { key, type, settingKey } of PRESET_SETTINGS) {
        if (onlyMissing && updatedPreset[key] !== undefined && updatedPreset[key] !== null)
            continue;

        try {
            const nextValue = settings[`get_${type}`](settingKey);
            if (updatedPreset[key] !== nextValue) {
                updatedPreset[key] = nextValue;
                changed = true;
            }
        } catch (_e) { /* skip unavailable keys */ }
    }

    if (changed) {
        presets[idx] = updatedPreset;
        savePresets(presets);
    }

    return changed ? updatedPreset : presets[idx];
}

/**
 * Compare the current GSettings values against a saved preset.
 * Returns true only if every key stored in the preset matches what is
 * currently in GSettings.  Uses an epsilon for floating-point keys.
 *
 * @param {Gio.Settings} settings
 * @param {Object}       preset
 * @returns {boolean}
 */
export function settingsMatchPreset(settings, preset) {
    for (const { key, type, settingKey } of PRESET_SETTINGS) {
        if (preset[key] === undefined || preset[key] === null) continue;
        try {
            const current = settings[`get_${type}`](settingKey);
            if (type === 'double') {
                if (Math.abs(current - preset[key]) >= 0.000001) return false;
            } else {
                if (current !== preset[key]) return false;
            }
        } catch (_e) { /* key not in schema — skip */ }
    }
    return true;
}

/**
 * Clear the stored active preset ID if it no longer points to a saved preset
 * or if the live GSettings values no longer match that preset.
 *
 * @param {Gio.Settings} settings
 * @returns {Object|null} the matching active preset, or null if cleared/missing
 */
export function reconcileActivePreset(settings) {
    const presetId = settings.get_string('ollama-active-preset');
    if (!presetId)
        return null;

    const preset = getPresetById(presetId);
    if (!preset || !settingsMatchPreset(settings, preset)) {
        settings.set_string('ollama-active-preset', '');
        return null;
    }

    return preset;
}

/**
 * Rename an existing preset in place.
 * @param {string} id
 * @param {string} name
 */
export function updatePresetName(id, name) {
    const presets = loadPresets();
    const idx = presets.findIndex(p => p.id === id);
    if (idx >= 0) {
        presets[idx] = { ...presets[idx], name: (name || '').trim() || presets[idx].name };
        savePresets(presets);
    }
}
