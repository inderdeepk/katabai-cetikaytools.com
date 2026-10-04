// Ollama provider preferences page — workload presets, saved model presets
// (with drift tracking), connection/request shape, context limits, system
// prompt, hardware/memory expander, and generation/sampling controls.
import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

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

export function buildOllamaPage(ctx) {
    const {
        settings,
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
        bindChoiceRow,
        setStringList,
        ollamaSettingTypes,
        getOllamaValue,
        setOllamaValue,
        valuesEqual,
    } = ctx;

    const presetDefinitions = {
        balanced: {
            format: '',
            raw: false,
            temperature: 0.7,
            'top-k': 40,
            'top-p': 0.9,
            'min-p': 0.05,
            mirostat: 0,
            'repeat-penalty': 1.1,
            'presence-penalty': 0.0,
            'frequency-penalty': 0.0,
            'tfs-z': 1.0,
        },
        code: {
            format: '',
            raw: false,
            temperature: 0.1,
            'top-k': 40,
            'top-p': 1.0,
            'min-p': 0.05,
            mirostat: 0,
            'repeat-penalty': 1.0,
            'presence-penalty': 0.0,
            'frequency-penalty': 0.0,
            'tfs-z': 1.0,
        },
        factual: {
            format: '',
            raw: false,
            temperature: 0.3,
            'top-k': 40,
            'top-p': 0.9,
            'min-p': 0.05,
            mirostat: 0,
            'repeat-penalty': 1.05,
            'presence-penalty': 0.0,
            'frequency-penalty': 0.0,
            'tfs-z': 1.0,
        },
        creative: {
            format: '',
            raw: false,
            temperature: 1.1,
            'top-k': 40,
            'top-p': 0.95,
            'min-p': 0.05,
            mirostat: 0,
            'repeat-penalty': 1.1,
            'presence-penalty': 0.2,
            'frequency-penalty': 0.0,
            'tfs-z': 1.0,
        },
        json: {
            format: 'json',
            raw: false,
            temperature: 0.0,
            'top-k': 40,
            'top-p': 1.0,
            'min-p': 0.05,
            mirostat: 0,
            'repeat-penalty': 1.05,
            'presence-penalty': 0.0,
            'frequency-penalty': 0.0,
            'tfs-z': 1.0,
        },
    };

    const presetOptions = [
        { label: 'Balanced Assistant', value: 'balanced' },
        { label: 'Deterministic Programming', value: 'code' },
        { label: 'Factual Query / RAG', value: 'factual' },
        { label: 'Creative Ideation', value: 'creative' },
        { label: 'JSON Extraction', value: 'json' },
        { label: 'Custom', value: 'custom' },
    ];

    // --- Ollama Page ---
    const ollamaPage = createProviderPage(
        'ollama',
        'Local inference with fine-grained hardware, memory, and sampling controls.',
    );

    // ── Model Presets section ──────────────────────────────────────────────
    const modelPresetsGroup = createPreferencesGroup({
        title: 'Model Presets',
        description:
            'Save named snapshots of all current Ollama settings (model, context, sampling, etc.). Load a preset to instantly switch configurations.',
    });
    ollamaPage.add(modelPresetsGroup);

    // Entry row for the new preset name
    const newPresetNameRow = addCssClasses(
        new Adw.EntryRow({
            title: 'New Preset Name',
        }),
        'katab-prefs-row',
    );
    const saveCurrentBtn = addCssClasses(
        new Gtk.Button({
            label: 'Save Current Settings',
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
                    title: 'No presets saved yet',
                    subtitle:
                        'Fill in a name above and click "Save Current Settings" to create your first preset.',
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
                    title: `${pendingPreset.name || 'Unnamed Preset'} has unsaved changes`,
                    subtitle:
                        'Save changes to update this preset, or discard changes to restore its saved values.',
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
                    label: 'Save Changes',
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
                    label: 'Discard Changes',
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
            const ctx = preset['num-ctx'] ? `${preset['num-ctx']} ctx` : '';
            const temp =
                preset['temperature'] !== undefined
                    ? `temp ${Number(preset['temperature']).toFixed(2)}`
                    : '';
            const subtitleParts = [modelName, ctx, temp].filter(Boolean);

            const presetRow = stylePreferenceRow(
                new Adw.ActionRow({
                    title: preset.name || 'Unnamed Preset',
                    subtitle: subtitleParts.join('  ·  '),
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
                    label: isActive ? 'Active' : 'Load',
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
                    tooltip_text: 'Delete this preset',
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
    settings.connect('changed::ollama-active-preset', refreshSavedPresetRows);
    for (const { settingKey } of PRESET_SETTINGS) {
        settings.connect(`changed::${settingKey}`, () => queuePresetDriftCheck(settingKey));
    }

    const reconciledActivePreset = reconcileActivePreset(settings);
    if (reconciledActivePreset) {
        updatePresetFromSettings(settings, reconciledActivePreset.id, { onlyMissing: true });
    }
    refreshSavedPresetRows();
    // ─────────────────────────────────────────────────────────────────────

    const presetGroup = createPreferencesGroup({
        title: 'Workload Preset',
        description:
            'Start from recommended Ollama settings for the kind of output you want Katab to produce.',
    });
    ollamaPage.add(presetGroup);

    const presetRow = createChoiceRow(
        'Workload Preset',
        'Applies recommended settings for desktop assistant chat, coding, factual answers, creativity, or JSON extraction.',
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

    settings.connect('changed::ollama-preset', syncPresetRow);
    for (const suffix of Object.keys(ollamaSettingTypes)) {
        settings.connect(`changed::ollama-${suffix}`, () => {
            if (applyingPreset) return;

            syncPresetRow();
        });
    }

    syncPresetRow();

    // Connection & Model
    const connectionGroup = createPreferencesGroup({ title: 'Connection & Request Shape' });
    createStringRow(
        'Base URL',
        'The HTTP address where Ollama is hosted.',
        'ollama-url',
        connectionGroup,
    );
    createStringRow(
        'Model',
        'The exact Ollama model tag to load for this provider.',
        'ollama-model',
        connectionGroup,
    );

    const formatRow = createChoiceRow(
        'Response Format',
        'Keep standard text for chat. Switch to JSON mode when another app needs machine-readable output.',
        connectionGroup,
    );
    bindChoiceRow(
        formatRow,
        'ollama-format',
        [
            { label: 'Standard Text', value: '' },
            { label: 'JSON Mode', value: 'json' },
        ],
        settings.get_string.bind(settings),
        settings.set_string.bind(settings),
        (value) => (value === '' ? 'Standard Text' : `Custom (${value})`),
    );

    createBooleanRow(
        'Raw Prompt Mode',
        'Bypass Ollama chat templating. Leave this off unless your prompt is already fully structured.',
        'ollama-raw',
        connectionGroup,
    );
    createBooleanRow(
        'Thinking Mode',
        'Enable reasoning traces for models that support hybrid-thinking (Qwen3, DeepSeek-R1, etc.). When off, the model answers directly without a thinking step.',
        'ollama-think',
        connectionGroup,
    );
    createStringRow(
        'Keep Alive',
        'How long to keep the model loaded between requests. Must include a time unit (s, m, h), e.g. 5m, 0, or 999999h for indefinite.',
        'ollama-keep-alive',
        connectionGroup,
    );

    const contextGroup = createPreferencesGroup({ title: 'Context Limits' });
    const ctxRow = createChoiceRow(
        'Context Window Size',
        'Choose a standard context size. If a custom value is already saved, it stays visible instead of snapping back to 4096.',
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
            labels.push(`${fmtCtx(currentCtx)} (custom)`);
        }

        syncingContextRow = true;
        setStringList(ctxRow, labels);
        ctxRow._choiceValues = values;
        ctxRow.selected = Math.max(0, values.indexOf(currentCtx));
        syncingContextRow = false;
    };

    settings.connect('changed::ollama-num-ctx', syncContextRow);
    syncContextRow();

    ctxRow.connect('notify::selected', () => {
        if (syncingContextRow) return;

        const nextValue = ctxRow._choiceValues?.[ctxRow.selected];
        if (nextValue === undefined || nextValue === settings.get_int('ollama-num-ctx')) return;

        settings.set_int('ollama-num-ctx', nextValue);
    });

    createIntRow(
        'Predict Tokens',
        'Maximum number of tokens Ollama may generate for a reply. Use -1 for no hard cap.',
        'ollama-num-predict',
        contextGroup,
        -1,
        128000,
        100,
    );
    createIntRow(
        'Keep Tokens',
        'Preserve this many leading tokens when the context window rolls over so core instructions stay anchored.',
        'ollama-num-keep',
        contextGroup,
        0,
        1048576,
        100,
    );
    ollamaPage.add(connectionGroup);

    const ollamaPromptGroup = createPreferencesGroup({
        title: 'System Prompt',
        description:
            'Katab prepends this system prompt to Ollama requests and always appends the current date so the model knows what "today" is. By default it keeps replies in your language and treats web/tool output as untrusted data to analyze, not instructions to obey. This value is captured by presets.',
    });
    createMultilineStringRow('', '', 'ollama-system-prompt', ollamaPromptGroup, 160);
    ollamaPage.add(ollamaPromptGroup);

    ollamaPage.add(contextGroup);

    // Hardware & Memory
    const hardwareExpander = createExpanderRow({
        title: 'Advanced Hardware Settings',
        subtitle: 'Control how aggressively Ollama uses RAM, CPU, and GPU resources.',
    });
    createBooleanRow(
        'Use MMAP',
        'Map model weights through virtual memory so the kernel can page them in on demand.',
        'ollama-use-mmap',
        hardwareExpander,
    );
    createBooleanRow(
        'Use MLOCK',
        'Lock model pages in RAM to avoid swap latency. Leave this off unless you are certain your system has headroom.',
        'ollama-use-mlock',
        hardwareExpander,
    );
    createIntRow(
        'GPU Layers',
        'Number of transformer layers to offload to the GPU. Use -1 for all layers or 0 for CPU-only runs.',
        'ollama-num-gpu',
        hardwareExpander,
        -1,
        500,
        1,
    );
    createIntRow(
        'CPU Threads',
        'Worker threads for inference. Staying near your physical core count usually gives the best latency.',
        'ollama-num-thread',
        hardwareExpander,
        1,
        128,
        1,
    );
    const hardwareGroup = createPreferencesGroup();
    hardwareGroup.add(hardwareExpander);
    ollamaPage.add(hardwareGroup);

    // Generation Options
    const generationGroup = createPreferencesGroup({ title: 'Model Behavior & Sampling' });

    const tempRow = createDoubleRow(
        'Temperature',
        'Controls randomness. Lower values stay focused and predictable; higher values explore more unusual tokens.',
        'ollama-temperature',
        generationGroup,
        0.0,
        2.0,
        0.05,
        2,
    );
    const topKRow = createIntRow(
        'Top-K',
        'Keep only the K most likely next tokens before sampling. Lower values are stricter.',
        'ollama-top-k',
        generationGroup,
        0,
        150,
        1,
    );
    const topPRow = createDoubleRow(
        'Top-P',
        'Nucleus sampling. Keeps the smallest token set whose combined probability reaches this value.',
        'ollama-top-p',
        generationGroup,
        0.0,
        1.0,
        0.05,
        2,
    );
    const minPRow = createDoubleRow(
        'Min-P',
        'Alternative to Top-P. Filters out tokens that fall too far below the most likely option.',
        'ollama-min-p',
        generationGroup,
        0.0,
        1.0,
        0.01,
        2,
    );

    const mirostatExpander = createExpanderRow({
        title: 'Dynamic Entropy (Mirostat)',
        subtitle:
            'Let Ollama adjust sampling on the fly to keep responses near a target creativity level.',
    });
    const mirostatRow = createChoiceRow(
        'Mirostat Mode',
        'When enabled, Ollama dynamically manages entropy and the static temperature and top-p controls become advisory only.',
        mirostatExpander,
    );
    bindChoiceRow(
        mirostatRow,
        'ollama-mirostat',
        [
            { label: 'Disabled', value: 0 },
            { label: 'Mirostat 1.0', value: 1 },
            { label: 'Mirostat 2.0', value: 2 },
        ],
        settings.get_int.bind(settings),
        settings.set_int.bind(settings),
        (value) => `Custom (${value})`,
    );
    const mirostatTauRow = createDoubleRow(
        'Target Entropy (tau)',
        'Higher values allow more surprise. Lower values keep text tighter and more predictable.',
        'ollama-mirostat-tau',
        mirostatExpander,
        0.0,
        10.0,
        0.5,
        2,
    );
    const mirostatEtaRow = createDoubleRow(
        'Learning Rate (eta)',
        'How aggressively Mirostat corrects drift from the target entropy.',
        'ollama-mirostat-eta',
        mirostatExpander,
        0.0,
        1.0,
        0.05,
        2,
    );

    const syncMirostatState = () => {
        const active = settings.get_int('ollama-mirostat') > 0;
        mirostatTauRow.visible = active;
        mirostatEtaRow.visible = active;
        mirostatTauRow.sensitive = active;
        mirostatEtaRow.sensitive = active;
        tempRow.sensitive = !active;
        topKRow.sensitive = !active;
        topPRow.sensitive = !active;
        minPRow.sensitive = !active;
    };
    settings.connect('changed::ollama-mirostat', syncMirostatState);
    syncMirostatState();
    generationGroup.add(mirostatExpander);

    const advancedSamplingExpander = createExpanderRow({
        title: 'Advanced Statistical Sampling',
        subtitle: 'Extra distribution-shaping controls for power users.',
    });
    createDoubleRow(
        'Tail Free Sampling (tfs_z)',
        'Cuts off the low-value tail of the distribution where choices stop being meaningfully distinct. Set 1.0 to disable it.',
        'ollama-tfs-z',
        advancedSamplingExpander,
        0.0,
        1.0,
        0.05,
        2,
    );
    generationGroup.add(advancedSamplingExpander);

    const loopMitigationExpander = createExpanderRow({
        title: 'Degeneration and Loop Mitigation',
        subtitle: 'Penalize repetition when the model starts circling the same words or phrases.',
    });
    createIntRow(
        'Repeat Last N',
        'How far back Ollama should look for repetition. Use -1 to scan the full active context.',
        'ollama-repeat-last-n',
        loopMitigationExpander,
        -1,
        128000,
        64,
    );
    createDoubleRow(
        'Repeat Penalty',
        'Multiplicative repetition penalty. Keep this near 1.0 for code and raise it gently for chat if loops appear.',
        'ollama-repeat-penalty',
        loopMitigationExpander,
        1.0,
        2.0,
        0.05,
        2,
    );
    createDoubleRow(
        'Presence Penalty',
        'Encourages fresh vocabulary by penalizing any token that has appeared at least once.',
        'ollama-presence-penalty',
        loopMitigationExpander,
        0.0,
        2.0,
        0.05,
        2,
    );
    createDoubleRow(
        'Frequency Penalty',
        'Penalizes tokens in proportion to how often they have already appeared.',
        'ollama-frequency-penalty',
        loopMitigationExpander,
        0.0,
        2.0,
        0.05,
        2,
    );
    generationGroup.add(loopMitigationExpander);

    ollamaPage.add(generationGroup);
}
