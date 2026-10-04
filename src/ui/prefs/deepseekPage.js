// DeepSeek provider preferences page — connection/model, system prompt,
// reasoning, vision-model image support, output mode, and account balance.
import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import Soup from 'gi://Soup?version=3.0';

export function buildDeepSeekPage(ctx) {
    const {
        settings,
        window,
        createProviderPage,
        createPreferencesGroup,
        createStringRow,
        createMultilineStringRow,
        createBooleanRow,
        createChoiceRow,
        setStringList,
        createButtonRow,
        createInstructionRow,
        addCssClasses,
        stylePreferenceRow,
        addPreferenceRow,
    } = ctx;

    // --- DeepSeek Settings ---
    const deepseekPage = createProviderPage('deepseek');

    const deepseekConnectionGroup = createPreferencesGroup({ title: 'Connection & Model' });
    createStringRow(
        'Base URL',
        'The DeepSeek API endpoint. Change only when routing through a compatible proxy.',
        'deepseek-url',
        deepseekConnectionGroup,
    );
    createStringRow(
        'API Key',
        'Enter your DeepSeek API key. Ensure your account holds a positive prepaid balance — the API operates exclusively on a pre-funded model.',
        'deepseek-api-key',
        deepseekConnectionGroup,
        true,
    );
    createStringRow(
        'Model',
        'Use deepseek-flash (V4.1) for general tasks, rapid coding, and image input, or deepseek-v4-pro for complex reasoning and multi-step workflows.',
        'deepseek-model',
        deepseekConnectionGroup,
    );
    deepseekPage.add(deepseekConnectionGroup);

    const deepseekPromptGroup = createPreferencesGroup({
        title: 'System Prompt',
        description:
            'Katab prepends this system prompt to DeepSeek requests. By default it keeps replies in your language and treats web/tool output as untrusted data to analyze, not instructions to obey.',
    });
    createMultilineStringRow('', '', 'deepseek-system-prompt', deepseekPromptGroup, 160);
    deepseekPage.add(deepseekPromptGroup);

    const deepseekReasoningGroup = createPreferencesGroup({
        title: 'Reasoning',
        description:
            'DeepSeek can perform extended chain-of-thought reasoning before responding. Thinking content is shown in a collapsible panel in chat.',
    });

    createBooleanRow(
        'Thinking Mode',
        'Enable extended reasoning. Increases response time but significantly improves quality on complex tasks.',
        'deepseek-thinking-enabled',
        deepseekReasoningGroup,
    );

    const effortValues = ['high', 'max'];
    const effortLabels = ['High (balanced speed and depth)', 'Max (maximum reasoning depth)'];
    const effortRow = createChoiceRow(
        'Reasoning Effort',
        'Computational budget for the thinking phase. ‘High’ is the recommended default; ‘Max’ allocates the deepest analysis.',
        deepseekReasoningGroup,
    );
    setStringList(effortRow, effortLabels);
    effortRow._choiceValues = effortValues;

    // Sync effort row ↔ GSettings
    const syncEffortRow = () => {
        const currentEffort = settings.get_string('deepseek-reasoning-effort') || 'high';
        const idx = effortValues.indexOf(currentEffort);
        effortRow.selected = idx >= 0 ? idx : 0;
    };
    syncEffortRow();
    settings.connect('changed::deepseek-reasoning-effort', syncEffortRow);
    effortRow.connect('notify::selected', () => {
        const effort = effortRow._choiceValues?.[effortRow.selected] || 'high';
        if (settings.get_string('deepseek-reasoning-effort') !== effort) {
            settings.set_string('deepseek-reasoning-effort', effort);
        }
    });

    // Show effort row only when thinking is enabled
    const syncEffortRowVisibility = () => {
        effortRow.sensitive = settings.get_boolean('deepseek-thinking-enabled');
    };
    syncEffortRowVisibility();
    settings.connect('changed::deepseek-thinking-enabled', syncEffortRowVisibility);

    deepseekPage.add(deepseekReasoningGroup);

    // --- DeepSeek Image Support (Vision Model) ---
    // deepseek-flash (V4.1) accepts images natively. deepseek-v4-pro is
    // text-only, so when images are attached while Pro is the active
    // provider, Katab routes them through a separately-configured vision
    // model (local Ollama or any OpenAI-compatible endpoint).
    const deepseekVisionGroup = createPreferencesGroup({
        title: 'Image Support (Vision Model)',
        description:
            'deepseek-flash (V4.1) handles images natively — no setup needed. This section only applies to deepseek-v4-pro, which cannot see images: Katab analyzes attached images with the vision model below, then passes the analysis to Pro, which writes the reply. Text-only DeepSeek models (pro) cannot be used here as the vision model.',
    });

    // Routing mode: preprocess (default) vs direct.
    const visionModeValues = ['preprocess', 'direct'];
    const visionModeLabels = [
        'Describe images, then DeepSeek writes the answer',
        'Route the whole request to the vision model',
    ];
    const visionModeRow = createChoiceRow(
        'Routing Mode',
        'In the default mode the vision model describes the image(s) and DeepSeek writes the final answer. In direct mode the whole request is sent to the vision model, which replies directly (no tools or thinking).',
        deepseekVisionGroup,
    );
    setStringList(visionModeRow, visionModeLabels);
    visionModeRow._choiceValues = visionModeValues;
    const syncVisionModeRow = () => {
        const current = settings.get_string('deepseek-vision-mode') || 'preprocess';
        const idx = visionModeValues.indexOf(current);
        visionModeRow.selected = idx >= 0 ? idx : 0;
    };
    syncVisionModeRow();
    settings.connect('changed::deepseek-vision-mode', syncVisionModeRow);
    visionModeRow.connect('notify::selected', () => {
        const value = visionModeRow._choiceValues?.[visionModeRow.selected] || 'preprocess';
        if (settings.get_string('deepseek-vision-mode') !== value) {
            settings.set_string('deepseek-vision-mode', value);
        }
    });

    // Backend selector: off / ollama / openai.
    const visionBackendValues = ['', 'ollama', 'openai'];
    const visionBackendLabels = ['Disabled', 'Ollama (local)', 'OpenAI-compatible'];
    const visionBackendRow = createChoiceRow(
        'Vision Backend',
        'Ollama reuses your existing Ollama URL, sampling settings (including loaded presets), and installed models. OpenAI-compatible uses any vision-capable endpoint with a URL and optional API key.',
        deepseekVisionGroup,
    );
    setStringList(visionBackendRow, visionBackendLabels);
    visionBackendRow._choiceValues = visionBackendValues;
    const syncVisionBackendRow = () => {
        const current = settings.get_string('deepseek-vision-backend') || '';
        const idx = visionBackendValues.indexOf(current);
        visionBackendRow.selected = idx >= 0 ? idx : 0;
    };
    syncVisionBackendRow();
    settings.connect('changed::deepseek-vision-backend', syncVisionBackendRow);
    visionBackendRow.connect('notify::selected', () => {
        const value = visionBackendRow._choiceValues?.[visionBackendRow.selected] || '';
        if (settings.get_string('deepseek-vision-backend') !== value) {
            settings.set_string('deepseek-vision-backend', value);
        }
    });

    // "Pick installed Ollama model" helper (Ollama backend only).
    const visionOllamaPickerRow = createButtonRow(
        'Installed Ollama Models',
        'Query your Ollama instance for locally installed models and pick a vision-capable one.',
        'Pick Model…',
        () => {
            const ollamaUrl = (settings.get_string('ollama-url') || '').replace(/\/+$/, '');
            if (!ollamaUrl) {
                const dlg = new Gtk.MessageDialog({
                    transient_for: window,
                    modal: true,
                    message_type: Gtk.MessageType.ERROR,
                    buttons: Gtk.ButtonsType.CLOSE,
                    text: 'No Ollama URL configured',
                    secondary_text: 'Set the Ollama Base URL on the Ollama settings tab first.',
                });
                dlg.connect('response', () => dlg.destroy());
                dlg.present();
                return;
            }

            const session = new Soup.Session();
            session.timeout = 8;
            const message = Soup.Message.new('GET', `${ollamaUrl}/api/tags`);
            message.request_headers.append('Accept', 'application/json');
            const btn = visionOllamaPickerRow.activatable_widget;
            if (btn) {
                btn.set_label('Loading…');
                btn.sensitive = false;
            }
            session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (s, result) => {
                if (btn) {
                    btn.set_label('Pick Model…');
                    btn.sensitive = true;
                }
                let models = [];
                try {
                    const bytes = s.send_and_read_finish(result);
                    const body = JSON.parse(
                        new TextDecoder('utf-8').decode(bytes.get_data() || new Uint8Array()),
                    );
                    models = Array.isArray(body?.models)
                        ? body.models.map((m) => m.name).filter(Boolean)
                        : [];
                } catch (_e) {
                    models = [];
                }
                if (!models.length) {
                    const dlg = new Gtk.MessageDialog({
                        transient_for: window,
                        modal: true,
                        message_type: Gtk.MessageType.ERROR,
                        buttons: Gtk.ButtonsType.CLOSE,
                        text: 'No models found',
                        secondary_text:
                            'Could not list models from the Ollama instance. Is it running and reachable at the configured URL?',
                    });
                    dlg.connect('response', () => dlg.destroy());
                    dlg.present();
                    return;
                }

                const list = new Gtk.StringList();
                for (const name of models) list.append(name);
                const dropdown = new Gtk.DropDown({ model: list, selected: 0 });
                const current = settings.get_string('deepseek-vision-model') || '';
                const currentIdx = models.indexOf(current);
                if (currentIdx >= 0) dropdown.selected = currentIdx;

                const dialog = new Gtk.MessageDialog({
                    transient_for: window,
                    modal: true,
                    message_type: Gtk.MessageType.QUESTION,
                    buttons: Gtk.ButtonsType.OK_CANCEL,
                    text: 'Pick a vision model',
                    secondary_text: `Select one of ${models.length} installed Ollama models. Vision-capable models include llava, llama3.2-vision, qwen2.5vl, janus-pro, deepseek-vl2.`,
                });
                dialog.get_content_area().append(dropdown);
                dialog.connect('response', (dlg, responseId) => {
                    if (responseId === Gtk.ResponseType.OK) {
                        const selectedStr = list.get_string(dropdown.selected);
                        const selectedName =
                            typeof selectedStr === 'object' && selectedStr !== null
                                ? selectedStr.string
                                : selectedStr;
                        if (
                            selectedName &&
                            settings.get_string('deepseek-vision-model') !== selectedName
                        ) {
                            settings.set_string('deepseek-vision-model', selectedName);
                        }
                    }
                    dlg.destroy();
                });
                dialog.present();
            });
        },
        deepseekVisionGroup,
    );

    // Vision model name (shared by both backends).
    const visionModelRow = createStringRow(
        'Vision Model',
        'A vision-capable model. For Ollama: llama3.2-vision, qwen2.5vl, llava, janus-pro, deepseek-vl2, minicpm-v. For OpenAI-compatible: any vision model. DeepSeek text models are rejected.',
        'deepseek-vision-model',
        deepseekVisionGroup,
    );

    // Optional fallback model (same backend).
    const visionFallbackRow = createStringRow(
        'Vision Fallback Model',
        'Optional. Tried if the primary vision model is unavailable or times out. Uses the same backend.',
        'deepseek-vision-fallback-model',
        deepseekVisionGroup,
    );

    // DeepSeek text-model guard notice.
    const visionGuardRow = createInstructionRow(
        'DeepSeek text models cannot see images',
        'The Vision Model is set to a text-only DeepSeek model, which cannot analyze images. Choose a vision-capable model instead (e.g. deepseek-flash).',
        deepseekVisionGroup,
    );

    // OpenAI-compatible: URL + API key (only when backend=openai).
    const visionUrlRow = createStringRow(
        'Vision Base URL',
        'OpenAI-compatible endpoint root. Leave empty to fall back to the DeepSeek base URL (useful behind a compatible proxy).',
        'deepseek-vision-url',
        deepseekVisionGroup,
    );
    const visionKeyRow = createStringRow(
        'Vision API Key',
        'Optional bearer token for the vision endpoint.',
        'deepseek-vision-api-key',
        deepseekVisionGroup,
        true,
    );

    // Visibility: only show the rows relevant to the selected backend.
    const syncVisionVisibility = () => {
        const backend = settings.get_string('deepseek-vision-backend') || '';
        const enabled = backend !== '';
        const model = (settings.get_string('deepseek-vision-model') || '').toLowerCase();
        // Mirror extension.js::_isDeepSeekNativeVisionModel — the Flash
        // family (V4.1+) accepts images natively; only other deepseek-*
        // models are text-only.
        const isFlashFamily =
            model.startsWith('deepseek-flash') || model.startsWith('deepseek-v4-flash');
        visionModelRow.visible = enabled;
        visionFallbackRow.visible = enabled;
        visionGuardRow.visible = enabled && model.startsWith('deepseek-') && !isFlashFamily;
        visionOllamaPickerRow.visible = backend === 'ollama';
        visionUrlRow.visible = backend === 'openai';
        visionKeyRow.visible = backend === 'openai';
    };
    syncVisionVisibility();
    settings.connect('changed::deepseek-vision-backend', syncVisionVisibility);
    settings.connect('changed::deepseek-vision-model', syncVisionVisibility);

    deepseekPage.add(deepseekVisionGroup);

    const deepseekOutputGroup = createPreferencesGroup({
        title: 'Output',
        description:
            'Control structured output mode. When JSON mode is on, Katab automatically injects a JSON reminder into the system prompt if needed to satisfy the DeepSeek API requirement.',
    });
    createBooleanRow(
        'JSON Output Mode',
        'Force the model to return a valid JSON object. Useful for structured data extraction tasks.',
        'deepseek-json-mode',
        deepseekOutputGroup,
    );
    deepseekPage.add(deepseekOutputGroup);

    // --- DeepSeek Account Balance ---
    const deepseekBalanceGroup = createPreferencesGroup({
        title: 'Account Balance',
        description:
            'Current DeepSeek account balance. Refreshed automatically by the provider health check every 30 seconds while the extension is running.',
    });

    const balanceSyncers = [];

    const createBalanceDisplayRow = (title, subtitle, getter) => {
        const valueLabel = addCssClasses(
            new Gtk.Label({
                label: '—',
                xalign: 0,
                halign: Gtk.Align.START,
                valign: Gtk.Align.CENTER,
                selectable: true,
            }),
            'katab-prefs-balance-value',
        );

        const row = stylePreferenceRow(
            new Adw.ActionRow({
                title,
                ...(subtitle && { subtitle }),
                activatable: false,
            }),
            'katab-prefs-info-row',
        );

        const syncFromSettings = () => {
            valueLabel.set_text(getter() || '—');
        };
        syncFromSettings();
        balanceSyncers.push(syncFromSettings);

        row.add_suffix(valueLabel);
        addPreferenceRow(deepseekBalanceGroup, row);
        return { row, valueLabel };
    };

    // Available indicator
    createBalanceDisplayRow(
        'Available',
        'Whether the current balance is sufficient for API calls.',
        () => {
            let ts = settings.get_int64('deepseek-balance-last-checked');
            if (!ts) return 'Not checked yet';
            return settings.get_boolean('deepseek-balance-available')
                ? 'Yes'
                : 'No — top up needed';
        },
    );

    // Currency
    createBalanceDisplayRow(
        'Currency',
        'The currency of your DeepSeek account balance.',
        () => settings.get_string('deepseek-balance-currency') || '—',
    );

    // Total Balance
    createBalanceDisplayRow('Total Balance', 'Total available funds (granted + topped-up).', () => {
        let total = settings.get_string('deepseek-balance-total');
        let currency = settings.get_string('deepseek-balance-currency');
        if (!total) return '—';
        return currency ? `${currency} ${total}` : total;
    });

    // Granted Balance
    createBalanceDisplayRow(
        'Granted (Free Credits)',
        'Promotional or free credits that may expire.',
        () => {
            let granted = settings.get_string('deepseek-balance-granted');
            let currency = settings.get_string('deepseek-balance-currency');
            if (!granted) return '—';
            return currency ? `${currency} ${granted}` : granted;
        },
    );

    // Topped-Up Balance
    createBalanceDisplayRow('Topped Up', 'Funds added via top-up that do not expire.', () => {
        let toppedUp = settings.get_string('deepseek-balance-topped-up');
        let currency = settings.get_string('deepseek-balance-currency');
        if (!toppedUp) return '—';
        return currency ? `${currency} ${toppedUp}` : toppedUp;
    });

    // Last Checked
    createBalanceDisplayRow(
        'Last Checked',
        'When the balance was last fetched from the DeepSeek API.',
        () => {
            let ts = settings.get_int64('deepseek-balance-last-checked');
            if (!ts) return 'Never';
            try {
                let date = new Date(ts);
                return date.toLocaleString();
            } catch (_e) {
                return 'Unknown';
            }
        },
    );

    // One shared set of six GSettings watchers refreshes every balance row
    // (each getter may depend on several keys — total/granted rows show the
    // currency, the Available row reads last-checked).
    for (const key of [
        'deepseek-balance-available',
        'deepseek-balance-currency',
        'deepseek-balance-total',
        'deepseek-balance-granted',
        'deepseek-balance-topped-up',
        'deepseek-balance-last-checked',
    ]) {
        settings.connect(`changed::${key}`, () => {
            for (const sync of balanceSyncers) {
                sync();
            }
        });
    }

    // Refresh Balance button
    const refreshBalanceBtn = addCssClasses(
        new Gtk.Button({
            label: 'Refresh Balance',
            valign: Gtk.Align.CENTER,
            halign: Gtk.Align.START,
        }),
        'katab-prefs-button',
        'suggested-action',
    );
    const refreshBtnRow = stylePreferenceRow(
        new Adw.ActionRow({
            title: 'Check Balance Now',
            subtitle:
                'Makes a direct request to the DeepSeek /user/balance endpoint and updates the display above.',
            activatable: false,
        }),
        'katab-prefs-info-row',
    );
    refreshBtnRow.add_suffix(refreshBalanceBtn);
    refreshBtnRow.activatable_widget = refreshBalanceBtn;
    addPreferenceRow(deepseekBalanceGroup, refreshBtnRow);

    refreshBalanceBtn.connect('clicked', () => {
        refreshBalanceBtn.set_label('Checking...');
        refreshBalanceBtn.sensitive = false;
        refreshDeepSeekBalance(settings, () => {
            refreshBalanceBtn.set_label('Refresh Balance');
            refreshBalanceBtn.sensitive = true;
        });
    });

    deepseekPage.add(deepseekBalanceGroup);
}

async function refreshDeepSeekBalance(settings, onDone) {
    let baseUrl = settings.get_string('deepseek-url');
    let apiKey = settings.get_string('deepseek-api-key');

    if (!baseUrl || !apiKey) {
        onDone();
        return;
    }

    // Strip trailing slash so joinUrl-like behaviour works
    baseUrl = baseUrl.replace(/\/+$/, '');
    let url = `${baseUrl}/user/balance`;

    try {
        let session = new Soup.Session();
        session.timeout = 8; // seconds, same as health monitor probe

        let message = Soup.Message.new('GET', url);
        message.get_request_headers().append('Authorization', `Bearer ${apiKey}`);

        let bytes = await new Promise((resolve, reject) => {
            session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (s, res) => {
                try {
                    resolve(s.send_and_read_finish(res));
                } catch (e) {
                    reject(e);
                }
            });
        });

        if (message.status_code === 402) {
            settings.set_boolean('deepseek-balance-available', false);
            settings.set_int64('deepseek-balance-last-checked', Date.now());
            onDone();
            return;
        }

        if (message.status_code < 200 || message.status_code >= 300) {
            onDone();
            return;
        }

        let decoder = new TextDecoder('utf-8');
        let responseBody = decoder.decode(bytes);
        let parsed = JSON.parse(responseBody);

        let balanceInfo = parsed.balance_infos?.[0] ?? null;
        settings.set_boolean('deepseek-balance-available', Boolean(parsed.is_available));
        settings.set_string('deepseek-balance-currency', balanceInfo?.currency ?? '');
        settings.set_string('deepseek-balance-total', balanceInfo?.total_balance ?? '');
        settings.set_string('deepseek-balance-granted', balanceInfo?.granted_balance ?? '');
        settings.set_string('deepseek-balance-topped-up', balanceInfo?.topped_up_balance ?? '');
        settings.set_int64('deepseek-balance-last-checked', Date.now());
    } catch (_e) {
        // Silently ignore errors — the UI already shows '—' for missing data.
    }

    onDone();
}
