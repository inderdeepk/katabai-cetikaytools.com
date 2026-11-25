// Ollama provider preferences page — workload presets, saved model presets
// (with drift tracking), connection/request shape, context limits, system
// prompt, hardware/memory expander, and generation/sampling controls.
import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import Soup from 'gi://Soup?version=3.0';

import {
    loadPresets,
    addPreset,
    deletePreset,
    capturePresetFromSettings,
    applyPresetToSettings,
    getPresetById,
    PRESET_SETTINGS,
    reconcileActivePreset,
    settingsMatchPreset,
    updatePresetFromSettings,
} from '../../usage/presetManager.js';
import {
    formatBytesCompact,
    parseOllamaPsResponse,
    parseOllamaShowResponse,
    parseOllamaTagsResponse,
    resolveOllamaEndpoint,
    validateOllamaFormatSchema,
} from '../../providers/ollamaCapabilities.js';
import { gettext as _, format } from '../../shared/i18n.js';

export function buildOllamaPage(ctx) {
    const {
        settings,
        watch,
        isDisposed,
        onDestroy,
        window,
        createProviderPage,
        createPreferencesGroup,
        createExpanderRow,
        addCssClasses,
        addPreferenceRow,
        stylePreferenceRow,
        createChoiceRow,
        createStringRow,
        createMultilineStringRow,
        createIntRow,
        createDoubleRow,
        createBooleanRow,
        createButtonRow,
        createInfoRow,
        bindChoiceRow,
        setStringList,
        ollamaSettingTypes,
        getOllamaValue,
        setOllamaValue,
        valuesEqual,
    } = ctx;

    const activeSessions = new Set();
    onDestroy(() => {
        for (const session of activeSessions) {
            try {
                session.abort();
            } catch (_e) {
                /* already aborted */
            }
        }
        activeSessions.clear();
    });

    const presetDefinitions = {
        balanced: {
            format: '',
            'use-model-defaults': false,
            temperature: 0.7,
            'top-k': 40,
            'top-p': 0.9,
            'min-p': 0.05,
            'repeat-penalty': 1.1,
            'presence-penalty': 0.0,
            'frequency-penalty': 0.0,
        },
        code: {
            format: '',
            'use-model-defaults': false,
            temperature: 0.1,
            'top-k': 40,
            'top-p': 1.0,
            'min-p': 0.05,
            'repeat-penalty': 1.0,
            'presence-penalty': 0.0,
            'frequency-penalty': 0.0,
        },
        factual: {
            format: '',
            'use-model-defaults': false,
            temperature: 0.3,
            'top-k': 40,
            'top-p': 0.9,
            'min-p': 0.05,
            'repeat-penalty': 1.05,
            'presence-penalty': 0.0,
            'frequency-penalty': 0.0,
        },
        creative: {
            format: '',
            'use-model-defaults': false,
            temperature: 1.1,
            'top-k': 40,
            'top-p': 0.95,
            'min-p': 0.05,
            'repeat-penalty': 1.1,
            'presence-penalty': 0.2,
            'frequency-penalty': 0.0,
        },
        json: {
            format: 'json',
            'use-model-defaults': false,
            temperature: 0.0,
            'top-k': 40,
            'top-p': 1.0,
            'min-p': 0.05,
            'repeat-penalty': 1.05,
            'presence-penalty': 0.0,
            'frequency-penalty': 0.0,
        },
    };

    const presetOptions = [
        { label: _('Balanced Assistant'), value: 'balanced' },
        { label: _('Deterministic Programming'), value: 'code' },
        { label: _('Factual Query / RAG'), value: 'factual' },
        { label: _('Creative Ideation'), value: 'creative' },
        { label: _('JSON Extraction'), value: 'json' },
        { label: _('Custom'), value: 'custom' },
    ];

    // --- Ollama Page ---
    const ollamaPage = createProviderPage(
        'ollama',
        _('Local inference with fine-grained hardware, memory, and sampling controls.'),
    );

    // ── Model Presets section ──────────────────────────────────────────────
    const modelPresetsGroup = createPreferencesGroup({
        title: _('Model Presets'),
        description: _(
            'Save named snapshots of all current Ollama settings (model, context, sampling, etc.). Load a preset to instantly switch configurations.',
        ),
    });
    ollamaPage.add(modelPresetsGroup);

    // Entry row for the new preset name
    const newPresetNameRow = addCssClasses(
        new Adw.EntryRow({
            title: _('New Preset Name'),
        }),
        'katab-prefs-row',
    );
    const saveCurrentBtn = addCssClasses(
        new Gtk.Button({
            label: _('Save Current Settings'),
            valign: Gtk.Align.CENTER,
        }),
        'katab-prefs-button',
        'suggested-action',
    );
    newPresetNameRow.add_suffix(saveCurrentBtn);
    addPreferenceRow(modelPresetsGroup, newPresetNameRow);

    // Container tracking for dynamically built preset rows
    let _savedPresetRows = [];
    let applyingSavedPreset = false;
    let presetDriftCheckTimeoutId = 0;
    let pendingPresetChangeId = '';
    let lastChangedPresetSettingKey = '';
    const presetSettingKeyMap = new Map(
        PRESET_SETTINGS.map(({ settingKey, key }) => [settingKey, key]),
    );

    const applySavedPreset = (preset) => {
        if (!preset) return;

        applyingSavedPreset = true;
        pendingPresetChangeId = '';
        lastChangedPresetSettingKey = '';
        settings.set_string('ollama-active-preset', preset.id);
        applyPresetToSettings(settings, preset);
        updatePresetFromSettings(settings, preset.id, { onlyMissing: true });
        applyingSavedPreset = false;
    };

    const queuePresetDriftCheck = (settingKey) => {
        if (applyingSavedPreset) return;

        lastChangedPresetSettingKey = settingKey || '';

        if (presetDriftCheckTimeoutId) {
            GLib.source_remove(presetDriftCheckTimeoutId);
        }

        presetDriftCheckTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
            presetDriftCheckTimeoutId = 0;

            if (pendingPresetChangeId) {
                const pendingPreset = getPresetById(pendingPresetChangeId);
                if (!pendingPreset) {
                    pendingPresetChangeId = '';
                    refreshSavedPresetRows();
                    return GLib.SOURCE_REMOVE;
                }

                if (settingsMatchPreset(settings, pendingPreset)) {
                    pendingPresetChangeId = '';
                    settings.set_string('ollama-active-preset', pendingPreset.id);
                    refreshSavedPresetRows();
                    return GLib.SOURCE_REMOVE;
                }
            }

            const activePresetId = settings.get_string('ollama-active-preset');
            if (!activePresetId) return GLib.SOURCE_REMOVE;

            const activePreset = getPresetById(activePresetId);
            if (!activePreset) {
                settings.set_string('ollama-active-preset', '');
                refreshSavedPresetRows();
                return GLib.SOURCE_REMOVE;
            }

            const changedPresetKey = presetSettingKeyMap.get(lastChangedPresetSettingKey);
            const changedMissingField =
                changedPresetKey &&
                (activePreset[changedPresetKey] === undefined ||
                    activePreset[changedPresetKey] === null);

            if (changedMissingField || !settingsMatchPreset(settings, activePreset)) {
                pendingPresetChangeId = activePreset.id;
                settings.set_string('ollama-active-preset', '');
                refreshSavedPresetRows();
            }

            return GLib.SOURCE_REMOVE;
        });
    };

    window.connect('destroy', () => {
        if (!presetDriftCheckTimeoutId) return;

        GLib.source_remove(presetDriftCheckTimeoutId);
        presetDriftCheckTimeoutId = 0;
    });

    const refreshSavedPresetRows = () => {
        // Remove stale rows
        for (const row of _savedPresetRows) {
            try {
                modelPresetsGroup.remove(row);
            } catch (_e) {}
        }
        _savedPresetRows = [];

        const presets = loadPresets();
        const activePresetId = settings.get_string('ollama-active-preset');
        const pendingPreset = pendingPresetChangeId
            ? getPresetById(pendingPresetChangeId, presets)
            : null;

        if (pendingPresetChangeId && !pendingPreset) {
            pendingPresetChangeId = '';
        }

        if (presets.length === 0) {
            const emptyRow = stylePreferenceRow(
                new Adw.ActionRow({
                    title: _('No presets saved yet'),
                    subtitle: _(
                        'Fill in a name above and click "Save Current Settings" to create your first preset.',
                    ),
                    activatable: false,
                }),
                'katab-prefs-info-row',
            );
            addPreferenceRow(modelPresetsGroup, emptyRow);
            _savedPresetRows.push(emptyRow);
            return;
        }

        if (pendingPreset) {
            const pendingRow = stylePreferenceRow(
                new Adw.ActionRow({
                    title: GLib.markup_escape_text(
                        format(_('{name} has unsaved changes'), {
                            name: pendingPreset.name || _('Unnamed Preset'),
                        }),
                        -1,
                    ),
                    subtitle: _(
                        'Save changes to update this preset, or discard changes to restore its saved values.',
                    ),
                    activatable: false,
                }),
                'katab-prefs-row',
                'katab-prefs-info-row',
            );

            const pendingBtnBox = addCssClasses(
                new Gtk.Box({
                    orientation: Gtk.Orientation.HORIZONTAL,
                    spacing: 6,
                    valign: Gtk.Align.CENTER,
                }),
                'katab-prefs-button-box',
            );

            const saveChangesBtn = addCssClasses(
                new Gtk.Button({
                    label: _('Save Changes'),
                    valign: Gtk.Align.CENTER,
                }),
                'katab-prefs-button',
                'suggested-action',
            );
            saveChangesBtn.connect('clicked', () => {
                const updatedPreset = updatePresetFromSettings(settings, pendingPreset.id);
                pendingPresetChangeId = '';
                lastChangedPresetSettingKey = '';
                if (updatedPreset) {
                    settings.set_string('ollama-active-preset', updatedPreset.id);
                }
                refreshSavedPresetRows();
            });
            pendingBtnBox.append(saveChangesBtn);

            const discardChangesBtn = addCssClasses(
                new Gtk.Button({
                    label: _('Discard Changes'),
                    valign: Gtk.Align.CENTER,
                }),
                'katab-prefs-button',
            );
            discardChangesBtn.connect('clicked', () => {
                const presetToRestore = getPresetById(pendingPreset.id);
                pendingPresetChangeId = '';
                lastChangedPresetSettingKey = '';
                applySavedPreset(presetToRestore);
                refreshSavedPresetRows();
            });
            pendingBtnBox.append(discardChangesBtn);

            pendingRow.add_suffix(pendingBtnBox);
            addPreferenceRow(modelPresetsGroup, pendingRow);
            _savedPresetRows.push(pendingRow);
        }

        const hasPendingPresetChanges = Boolean(pendingPresetChangeId);

        for (const preset of presets) {
            const isActive =
                preset.id === activePresetId &&
                (applyingSavedPreset || settingsMatchPreset(settings, preset));
            const modelName = preset['model'] || '—';
            const ctx = preset['num-ctx']
                ? format(_('{value} ctx'), { value: preset['num-ctx'] })
                : '';
            const temp =
                preset['temperature'] !== undefined
                    ? format(_('temp {value}'), {
                          value: Number(preset['temperature']).toFixed(2),
                      })
                    : '';
            const subtitleParts = [modelName, ctx, temp].filter(Boolean);

            const presetRow = stylePreferenceRow(
                new Adw.ActionRow({
                    title: GLib.markup_escape_text(preset.name || _('Unnamed Preset'), -1),
                    subtitle: GLib.markup_escape_text(subtitleParts.join('  ·  '), -1),
                    activatable: false,
                }),
                'katab-prefs-row',
                isActive ? 'katab-prefs-preset-row-active' : '',
            );

            const rowBtnBox = addCssClasses(
                new Gtk.Box({
                    orientation: Gtk.Orientation.HORIZONTAL,
                    spacing: 6,
                    valign: Gtk.Align.CENTER,
                }),
                'katab-prefs-button-box',
            );

            const applyBtn = addCssClasses(
                new Gtk.Button({
                    label: isActive ? _('Active') : _('Load'),
                    valign: Gtk.Align.CENTER,
                    sensitive: !isActive && !hasPendingPresetChanges,
                }),
                'katab-prefs-button',
                isActive ? '' : 'suggested-action',
            );
            applyBtn.connect('clicked', () => {
                // Set ID first so drift observers keep the preset marked
                // active while each saved key is being written.
                applySavedPreset(preset);
                refreshSavedPresetRows();
            });
            rowBtnBox.append(applyBtn);

            const deleteBtn = addCssClasses(
                new Gtk.Button({
                    icon_name: 'edit-delete-symbolic',
                    valign: Gtk.Align.CENTER,
                    tooltip_text: _('Delete this preset'),
                }),
                'katab-prefs-button',
                'destructive-action',
            );
            deleteBtn.connect('clicked', () => {
                deletePreset(preset.id);
                if (pendingPresetChangeId === preset.id) pendingPresetChangeId = '';
                if (isActive) settings.set_string('ollama-active-preset', '');
                refreshSavedPresetRows();
            });
            rowBtnBox.append(deleteBtn);

            presetRow.add_suffix(rowBtnBox);
            addPreferenceRow(modelPresetsGroup, presetRow);
            _savedPresetRows.push(presetRow);
        }
    };

    // Wire up "Save Current Settings" button
    saveCurrentBtn.connect('clicked', () => {
        const name = newPresetNameRow.text.trim();
        if (!name) {
            newPresetNameRow.grab_focus();
            return;
        }
        const preset = capturePresetFromSettings(settings, name);
        addPreset(preset);
        pendingPresetChangeId = '';
        lastChangedPresetSettingKey = '';
        settings.set_string('ollama-active-preset', preset.id);
        newPresetNameRow.set_text('');
        refreshSavedPresetRows();
    });

    // Refresh list when active preset changes (e.g., from chat window) or
    // when the prefs window is shown (in case presets.json changed)
    watch('changed::ollama-active-preset', refreshSavedPresetRows);
    for (const { settingKey } of PRESET_SETTINGS) {
        watch(`changed::${settingKey}`, () => queuePresetDriftCheck(settingKey));
    }

    const reconciledActivePreset = reconcileActivePreset(settings);
    if (reconciledActivePreset) {
        updatePresetFromSettings(settings, reconciledActivePreset.id, { onlyMissing: true });
    }
    refreshSavedPresetRows();
    // ─────────────────────────────────────────────────────────────────────

    const presetGroup = createPreferencesGroup({
        title: _('Workload Preset'),
        description: _(
            'Start from recommended Ollama settings for the kind of output you want Katab to produce.',
        ),
    });
    ollamaPage.add(presetGroup);

    const presetRow = createChoiceRow(
        _('Workload Preset'),
        _(
            'Applies recommended settings for desktop assistant chat, coding, factual answers, creativity, or JSON extraction.',
        ),
        presetGroup,
    );
    let syncingPresetRow = false;
    let applyingPreset = false;

    const findMatchingPreset = () => {
        for (const [presetId, presetValues] of Object.entries(presetDefinitions)) {
            let matches = true;
            for (const [suffix, expectedValue] of Object.entries(presetValues)) {
                if (!valuesEqual(getOllamaValue(suffix), expectedValue)) {
                    matches = false;
                    break;
                }
            }

            if (matches) return presetId;
        }

        return 'custom';
    };

    const syncPresetRow = () => {
        const storedPreset = settings.get_string('ollama-preset');
        const selectedPreset = findMatchingPreset();

        if (storedPreset !== selectedPreset) {
            settings.set_string('ollama-preset', selectedPreset);
            return;
        }

        syncingPresetRow = true;
        setStringList(
            presetRow,
            presetOptions.map((option) => option.label),
        );
        presetRow._choiceValues = presetOptions.map((option) => option.value);
        presetRow.selected = Math.max(0, presetRow._choiceValues.indexOf(selectedPreset));
        syncingPresetRow = false;
    };

    const applyPreset = (presetId) => {
        const presetValues = presetDefinitions[presetId];
        if (!presetValues) return;

        applyingPreset = true;
        for (const [suffix, value] of Object.entries(presetValues)) {
            setOllamaValue(suffix, value);
        }
        applyingPreset = false;

        settings.set_string('ollama-preset', presetId);
    };

    presetRow.connect('notify::selected', () => {
        if (syncingPresetRow) return;

        const presetId = presetRow._choiceValues?.[presetRow.selected];
        if (!presetId || presetId === 'custom') {
            settings.set_string('ollama-preset', 'custom');
            return;
        }

        applyPreset(presetId);
    });

    watch('changed::ollama-preset', syncPresetRow);
    for (const suffix of Object.keys(ollamaSettingTypes)) {
        watch(`changed::ollama-${suffix}`, () => {
            if (applyingPreset) return;

            syncPresetRow();
        });
    }

    syncPresetRow();

    // Connection & Model
    const connectionGroup = createPreferencesGroup({ title: _('Connection &amp; Request Shape') });
    createStringRow(
        _('Base URL'),
        _(
            'Local Ollama server (e.g. http://localhost:11434) or Ollama Cloud (https://ollama.com).',
        ),
        'ollama-url',
        connectionGroup,
    );
    createStringRow(
        _('API Key (Optional)'),
        _('Bearer token for Ollama Cloud (https://ollama.com) or authenticated remote hosts.'),
        'ollama-api-key',
        connectionGroup,
        true,
    );
    createStringRow(
        _('Model'),
        _('The exact Ollama model tag to load (e.g. gemma4, qwen3, llama3.2, or :cloud tags).'),
        'ollama-model',
        connectionGroup,
    );

    const requestOllamaJson = async (method, path, bodyObj = null) => {
        const baseUrl = (settings.get_string('ollama-url') || '').trim();
        if (!baseUrl) {
            throw new Error(_('Set the Ollama Base URL first.'));
        }
        const endpoint = resolveOllamaEndpoint(baseUrl, path);
        const apiKey = (settings.get_string('ollama-api-key') || '').trim();
        const session = new Soup.Session();
        session.timeout = 8;
        activeSessions.add(session);
        try {
            const message = Soup.Message.new(method, endpoint);
            message.request_headers.append('Accept', 'application/json');
            if (apiKey) {
                message.request_headers.append('Authorization', `Bearer ${apiKey}`);
            }
            if (bodyObj !== null) {
                message.set_request_body_from_bytes(
                    'application/json',
                    new GLib.Bytes(new TextEncoder().encode(JSON.stringify(bodyObj))),
                );
            }
            const bytes = await new Promise((resolve, reject) => {
                session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (s, res) => {
                    try {
                        resolve(s.send_and_read_finish(res));
                    } catch (err) {
                        reject(err);
                    }
                });
            });
            const text = new TextDecoder('utf-8').decode(bytes?.get_data() || new Uint8Array());
            if (message.status_code < 200 || message.status_code >= 300) {
                throw new Error(`HTTP ${message.status_code}`);
            }
            return JSON.parse(text);
        } finally {
            activeSessions.delete(session);
        }
    };

    const browseModelsRow = createButtonRow(
        _('Installed Models'),
        _('Query your Ollama server for installed models and select one.'),
        _('Browse Models…'),
        () => {
            const btn = browseModelsRow.activatable_widget;
            if (btn) {
                btn.set_label(_('Loading…'));
                btn.sensitive = false;
            }
            Promise.allSettled([
                requestOllamaJson('GET', '/api/tags'),
                requestOllamaJson('GET', '/api/ps'),
            ]).then(([tagsRes, psRes]) => {
                if (isDisposed()) return;
                if (btn) {
                    btn.set_label(_('Browse Models…'));
                    btn.sensitive = true;
                }
                const models =
                    tagsRes.status === 'fulfilled' ? parseOllamaTagsResponse(tagsRes.value) : [];
                const running =
                    psRes.status === 'fulfilled' ? parseOllamaPsResponse(psRes.value) : [];
                if (!models.length) {
                    const dlg = new Gtk.MessageDialog({
                        transient_for: window,
                        modal: true,
                        message_type: Gtk.MessageType.ERROR,
                        buttons: Gtk.ButtonsType.CLOSE,
                        text: _('No models found'),
                        secondary_text: _(
                            'Could not list models from the Ollama server. Verify the Base URL, API key (if cloud), and that Ollama is running.',
                        ),
                    });
                    dlg.connect('response', () => dlg.destroy());
                    dlg.present();
                    return;
                }

                const runningSet = new Set(running.map((r) => r.name));
                const list = new Gtk.StringList();
                const labels = models.map((m) => {
                    const parts = [m.name];
                    if (m.parameterSize) parts.push(m.parameterSize);
                    if (m.isCloud) parts.push(_('Cloud'));
                    if (runningSet.has(m.name)) parts.push(_('Loaded'));
                    return parts.join(' · ');
                });
                for (const label of labels) list.append(label);
                const dropdown = new Gtk.DropDown({ model: list, selected: 0 });
                const current = (settings.get_string('ollama-model') || '').trim();
                const currentIdx = models.findIndex((m) => m.name === current);
                if (currentIdx >= 0) dropdown.selected = currentIdx;

                const dialog = new Gtk.MessageDialog({
                    transient_for: window,
                    modal: true,
                    message_type: Gtk.MessageType.QUESTION,
                    buttons: Gtk.ButtonsType.OK_CANCEL,
                    text: _('Select an Ollama model'),
                    secondary_text: format(
                        _('Found {count} models on the configured Ollama instance.'),
                        { count: models.length },
                    ),
                });
                dialog.get_content_area().append(dropdown);
                dialog.connect('response', (dlg, responseId) => {
                    if (responseId === Gtk.ResponseType.OK) {
                        const chosen = models[dropdown.selected]?.name;
                        if (chosen && settings.get_string('ollama-model') !== chosen) {
                            settings.set_string('ollama-model', chosen);
                        }
                    }
                    dlg.destroy();
                });
                dialog.present();
            });
        },
        connectionGroup,
    );

    const inspectBtn = addCssClasses(
        new Gtk.Button({
            label: _('Inspect'),
            valign: Gtk.Align.CENTER,
        }),
        'katab-prefs-button',
    );
    const inspectorRow = createInfoRow(
        _('Model Capabilities (/api/show)'),
        _('Click Inspect to check native thinking, vision, tools, and context length.'),
        connectionGroup,
        inspectBtn,
    );
    inspectorRow.activatable_widget = inspectBtn;

    const refreshInspector = () => {
        const model = (settings.get_string('ollama-model') || '').trim();
        if (!model) {
            inspectorRow.set_subtitle(_('Set a model name above first.'));
            return;
        }
        inspectBtn.set_label(_('Checking…'));
        inspectBtn.sensitive = false;
        requestOllamaJson('POST', '/api/show', { model })
            .then((payload) => {
                if (isDisposed()) return;
                const info = parseOllamaShowResponse(payload, model);
                const caps = [];
                if (info.vision) caps.push(_('Vision'));
                if (info.tools) caps.push(_('Tools'));
                if (info.thinking) caps.push(_('Thinking'));
                const parts = [];
                if (info.parameterSize || info.quantizationLevel) {
                    parts.push(
                        [info.parameterSize, info.quantizationLevel].filter(Boolean).join(' '),
                    );
                }
                parts.push(caps.length ? caps.join(', ') : _('Text completion'));
                if (info.contextLength) {
                    parts.push(format(_('{ctx} max ctx'), { ctx: info.contextLength }));
                }
                if (info.thinkingValues?.length) {
                    parts.push(format(_('think: {vals}'), { vals: info.thinkingValues.join('/') }));
                }
                inspectorRow.set_subtitle(GLib.markup_escape_text(parts.join('  ·  '), -1));
            })
            .catch((err) => {
                if (isDisposed()) return;
                inspectorRow.set_subtitle(
                    GLib.markup_escape_text(
                        format(_('Could not inspect model: {err}'), {
                            err: err?.message || 'Error',
                        }),
                        -1,
                    ),
                );
            })
            .finally(() => {
                if (isDisposed()) return;
                inspectBtn.set_label(_('Inspect'));
                inspectBtn.sensitive = true;
            });
    };
    inspectBtn.connect('clicked', refreshInspector);
    watch('changed::ollama-model', () => {
        inspectorRow.set_subtitle(
            _('Click Inspect to check native thinking, vision, tools, and context length.'),
        );
    });

    const memoryBtnBox = addCssClasses(
        new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6,
            valign: Gtk.Align.CENTER,
        }),
        'katab-prefs-button-box',
    );
    const refreshPsBtn = addCssClasses(
        new Gtk.Button({ label: _('Check'), valign: Gtk.Align.CENTER }),
        'katab-prefs-button',
    );
    const unloadCurrentBtn = addCssClasses(
        new Gtk.Button({ label: _('Unload Current'), valign: Gtk.Align.CENTER }),
        'katab-prefs-button',
    );
    memoryBtnBox.append(refreshPsBtn);
    memoryBtnBox.append(unloadCurrentBtn);
    const psRow = createInfoRow(
        _('Loaded in Memory (/api/ps)'),
        _('Check which models are currently occupying VRAM/RAM.'),
        connectionGroup,
        memoryBtnBox,
    );

    const refreshPsRow = () => {
        refreshPsBtn.sensitive = false;
        requestOllamaJson('GET', '/api/ps')
            .then((payload) => {
                if (isDisposed()) return;
                const running = parseOllamaPsResponse(payload);
                if (!running.length) {
                    psRow.set_subtitle(_('No models currently loaded in memory.'));
                    return;
                }
                const summary = running
                    .map((r) => {
                        const vram =
                            r.sizeVram > 0 ? `${formatBytesCompact(r.sizeVram)} VRAM` : _('CPU');
                        return r.contextLength > 0
                            ? `${r.name} (${vram}, ${r.contextLength} ctx)`
                            : `${r.name} (${vram})`;
                    })
                    .join('  ·  ');
                psRow.set_subtitle(GLib.markup_escape_text(summary, -1));
            })
            .catch((err) => {
                if (isDisposed()) return;
                psRow.set_subtitle(
                    GLib.markup_escape_text(
                        format(_('Could not query /api/ps: {err}'), {
                            err: err?.message || 'Error',
                        }),
                        -1,
                    ),
                );
            })
            .finally(() => {
                if (isDisposed()) return;
                refreshPsBtn.sensitive = true;
            });
    };
    refreshPsBtn.connect('clicked', refreshPsRow);
    unloadCurrentBtn.connect('clicked', () => {
        const model = (settings.get_string('ollama-model') || '').trim();
        if (!model) return;
        unloadCurrentBtn.sensitive = false;
        requestOllamaJson('POST', '/api/generate', {
            model,
            prompt: '',
            stream: false,
            keep_alive: 0,
        })
            .then(() => {
                if (isDisposed()) return;
                refreshPsRow();
            })
            .catch(() => {})
            .finally(() => {
                if (isDisposed()) return;
                unloadCurrentBtn.sensitive = true;
            });
    });

    const formatRow = createChoiceRow(
        _('Response Format'),
        _(
            'Standard text for chat, JSON Mode for freeform JSON, or JSON Schema for strict Structured Outputs.',
        ),
        connectionGroup,
    );
    bindChoiceRow(
        formatRow,
        'ollama-format',
        [
            { label: _('Standard Text'), value: '' },
            { label: _('JSON Mode'), value: 'json' },
            { label: _('JSON Schema (Structured Outputs)'), value: 'schema' },
        ],
        settings.get_string.bind(settings),
        settings.set_string.bind(settings),
        (value) => (value === '' ? _('Standard Text') : format(_('Custom ({value})'), { value })),
    );

    const schemaEditorRow = createMultilineStringRow(
        _('Structured Output JSON Schema'),
        _(
            'Enforced at token sampling time when Response Format is set to JSON Schema (e.g. {"type":"object","properties":{"answer":{"type":"string"}},"required":["answer"]}).',
        ),
        'ollama-format-schema',
        connectionGroup,
        120,
    );
    const schemaValidationRow = createInfoRow(_('Schema Validation'), '', connectionGroup);
    const syncFormatSchemaVisibility = () => {
        const isSchema = settings.get_string('ollama-format') === 'schema';
        schemaEditorRow.visible = isSchema;
        schemaValidationRow.visible = isSchema;
        if (isSchema) {
            const check = validateOllamaFormatSchema(settings.get_string('ollama-format-schema'));
            schemaValidationRow.set_subtitle(
                check.valid
                    ? _('Valid JSON Schema object — enforced on every Ollama chat reply.')
                    : GLib.markup_escape_text(
                          format(_('Fallback to plain JSON mode: {err}'), { err: check.error }),
                          -1,
                      ),
            );
        }
    };
    syncFormatSchemaVisibility();
    watch('changed::ollama-format', syncFormatSchemaVisibility);
    watch('changed::ollama-format-schema', syncFormatSchemaVisibility);

    createBooleanRow(
        _('Thinking Mode'),
        _(
            'Enable reasoning traces for thinking-capable models (Gemma 4, Qwen 3/3.5, DeepSeek-R1). Automatically omitted when a model does not support thinking.',
        ),
        'ollama-think',
        connectionGroup,
    );

    const thinkLevelRow = createChoiceRow(
        _('Thinking Effort'),
        _(
            'Reasoning effort level passed when the model supports graded thinking (low/medium/high/max), or Auto for the model default.',
        ),
        connectionGroup,
    );
    bindChoiceRow(
        thinkLevelRow,
        'ollama-think-level',
        [
            { label: _('Auto (Model Default)'), value: 'auto' },
            { label: _('Low'), value: 'low' },
            { label: _('Medium'), value: 'medium' },
            { label: _('High'), value: 'high' },
            { label: _('Max'), value: 'max' },
        ],
        settings.get_string.bind(settings),
        settings.set_string.bind(settings),
    );
    const syncThinkLevelSensitivity = () => {
        thinkLevelRow.sensitive = settings.get_boolean('ollama-think');
    };
    syncThinkLevelSensitivity();
    watch('changed::ollama-think', syncThinkLevelSensitivity);

    createStringRow(
        _('Keep Alive'),
        _(
            'How long to keep the model loaded between requests (e.g. 5m, 0 to unload immediately, -1 or 999999h for indefinite).',
        ),
        'ollama-keep-alive',
        connectionGroup,
    );

    const contextGroup = createPreferencesGroup({ title: _('Context Limits') });
    const ctxRow = createChoiceRow(
        _('Context Window Size'),
        _(
            'Choose a standard context size. If a custom value is already saved, it stays visible instead of snapping back to 4096.',
        ),
        contextGroup,
    );
    const ctxValues = [
        1024, 2048, 4096, 8192, 16384, 32768, 65536, 131072, 147456, 163840, 196608, 229376, 262144,
        524288, 1048576,
    ];
    let syncingContextRow = false;

    const fmtCtx = (v) => {
        if (v >= 1048576 && v % 1048576 === 0) return `${v} (${v / 1048576}M)`;
        if (v >= 1024 && v % 1024 === 0) return `${v} (${v / 1024}K)`;
        return `${v}`;
    };

    const syncContextRow = () => {
        const currentCtx = settings.get_int('ollama-num-ctx');
        const values = [...ctxValues];
        const labels = ctxValues.map((value) => fmtCtx(value));

        if (!values.includes(currentCtx) && currentCtx > 0) {
            values.push(currentCtx);
            labels.push(format(_('{value} (custom)'), { value: fmtCtx(currentCtx) }));
        }

        syncingContextRow = true;
        setStringList(ctxRow, labels);
        ctxRow._choiceValues = values;
        ctxRow.selected = Math.max(0, values.indexOf(currentCtx));
        syncingContextRow = false;
    };

    watch('changed::ollama-num-ctx', syncContextRow);
    syncContextRow();

    ctxRow.connect('notify::selected', () => {
        if (syncingContextRow) return;

        const nextValue = ctxRow._choiceValues?.[ctxRow.selected];
        if (nextValue === undefined || nextValue === settings.get_int('ollama-num-ctx')) return;

        settings.set_int('ollama-num-ctx', nextValue);
    });

    createIntRow(
        _('Predict Tokens'),
        _('Maximum number of tokens Ollama may generate for a reply. Use -1 for no hard cap.'),
        'ollama-num-predict',
        contextGroup,
        -1,
        128000,
        100,
    );
    createIntRow(
        _('Keep Tokens'),
        _(
            'Preserve this many leading tokens when the context window rolls over so core instructions stay anchored.',
        ),
        'ollama-num-keep',
        contextGroup,
        0,
        1048576,
        100,
    );
    ollamaPage.add(connectionGroup);

    const ollamaPromptGroup = createPreferencesGroup({
        title: _('System Prompt'),
        description: _(
            'Katab prepends this system prompt to Ollama requests and always appends the current date so the model knows what "today" is. By default it keeps replies in your language and treats web/tool output as untrusted data to analyze, not instructions to obey. This value is captured by presets.',
        ),
    });
    createMultilineStringRow('', '', 'ollama-system-prompt', ollamaPromptGroup, 160);
    ollamaPage.add(ollamaPromptGroup);

    ollamaPage.add(contextGroup);

    // Hardware & Memory
    const hardwareExpander = createExpanderRow({
        title: _('Advanced Hardware Settings'),
        subtitle: _('Control how aggressively Ollama uses RAM, CPU, and GPU resources.'),
    });
    createBooleanRow(
        _('Use MMAP'),
        _('Map model weights through virtual memory so the kernel can page them in on demand.'),
        'ollama-use-mmap',
        hardwareExpander,
    );
    createIntRow(
        _('GPU Layers'),
        _(
            'Number of transformer layers to offload to the GPU. Use -1 for all layers or 0 for CPU-only runs.',
        ),
        'ollama-num-gpu',
        hardwareExpander,
        -1,
        500,
        1,
    );
    createIntRow(
        _('CPU Threads'),
        _('Worker threads for inference. 0 lets Ollama auto-detect your physical CPU cores.'),
        'ollama-num-thread',
        hardwareExpander,
        0,
        128,
        1,
    );
    const hardwareGroup = createPreferencesGroup();
    hardwareGroup.add(hardwareExpander);
    ollamaPage.add(hardwareGroup);

    // Generation Options
    const generationGroup = createPreferencesGroup({ title: _('Model Behavior &amp; Sampling') });

    createBooleanRow(
        _('Use Model Sampler Defaults'),
        _(
            "Omit temperature, top-k, top-p, min-p, and repetition penalties so Ollama preserves the model's packaged Modelfile defaults.",
        ),
        'ollama-use-model-defaults',
        generationGroup,
    );

    const tempRow = createDoubleRow(
        _('Temperature'),
        _(
            'Controls randomness. Lower values stay focused and predictable; higher values explore more unusual tokens.',
        ),
        'ollama-temperature',
        generationGroup,
        0.0,
        2.0,
        0.05,
        2,
    );
    const topKRow = createIntRow(
        _('Top-K'),
        _('Keep only the K most likely next tokens before sampling. Lower values are stricter.'),
        'ollama-top-k',
        generationGroup,
        0,
        150,
        1,
    );
    const topPRow = createDoubleRow(
        _('Top-P'),
        _(
            'Nucleus sampling. Keeps the smallest token set whose combined probability reaches this value.',
        ),
        'ollama-top-p',
        generationGroup,
        0.0,
        1.0,
        0.05,
        2,
    );
    const minPRow = createDoubleRow(
        _('Min-P'),
        _(
            'Alternative to Top-P. Filters out tokens that fall too far below the most likely option.',
        ),
        'ollama-min-p',
        generationGroup,
        0.0,
        1.0,
        0.01,
        2,
    );

    createIntRow(
        _('Random Seed'),
        _('Fixed integer seed for reproducible outputs. Use -1 for random generation.'),
        'ollama-seed',
        generationGroup,
        -1,
        2147483647,
        1,
    );
    createStringRow(
        _('Stop Sequences'),
        _('Optional comma-separated sequences that halt generation when encountered.'),
        'ollama-stop',
        generationGroup,
    );

    const loopMitigationExpander = createExpanderRow({
        title: _('Degeneration and Loop Mitigation'),
        subtitle: _(
            'Penalize repetition when the model starts circling the same words or phrases.',
        ),
    });
    const repeatLastNRow = createIntRow(
        _('Repeat Last N'),
        _(
            'How far back Ollama should look for repetition. Use -1 to scan the full active context.',
        ),
        'ollama-repeat-last-n',
        loopMitigationExpander,
        -1,
        128000,
        64,
    );
    const repeatPenaltyRow = createDoubleRow(
        _('Repeat Penalty'),
        _(
            'Multiplicative repetition penalty. Keep this near 1.0 for code and raise it gently for chat if loops appear.',
        ),
        'ollama-repeat-penalty',
        loopMitigationExpander,
        1.0,
        2.0,
        0.05,
        2,
    );
    const presencePenaltyRow = createDoubleRow(
        _('Presence Penalty'),
        _('Encourages fresh vocabulary by penalizing any token that has appeared at least once.'),
        'ollama-presence-penalty',
        loopMitigationExpander,
        0.0,
        2.0,
        0.05,
        2,
    );
    const frequencyPenaltyRow = createDoubleRow(
        _('Frequency Penalty'),
        _('Penalizes tokens in proportion to how often they have already appeared.'),
        'ollama-frequency-penalty',
        loopMitigationExpander,
        0.0,
        2.0,
        0.05,
        2,
    );
    generationGroup.add(loopMitigationExpander);

    const syncModelDefaultsState = () => {
        const useDefaults = settings.get_boolean('ollama-use-model-defaults');
        const custom = !useDefaults;
        tempRow.sensitive = custom;
        topKRow.sensitive = custom;
        topPRow.sensitive = custom;
        minPRow.sensitive = custom;
        repeatLastNRow.sensitive = custom;
        repeatPenaltyRow.sensitive = custom;
        presencePenaltyRow.sensitive = custom;
        frequencyPenaltyRow.sensitive = custom;
    };
    syncModelDefaultsState();
    watch('changed::ollama-use-model-defaults', syncModelDefaultsState);

    ollamaPage.add(generationGroup);
}
