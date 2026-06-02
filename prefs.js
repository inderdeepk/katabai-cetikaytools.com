import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class KatabPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        window.search_enabled = true;
        window.add_css_class('katab-prefs-window');

        const settings = this.getSettings('org.gnome.shell.extensions.katabai');
        const extensionPath = this.path;
        const iconDirectory = `${extensionPath}/icons`;

        const display = window.get_display();
        if (display) {
            const iconTheme = Gtk.IconTheme.get_for_display(display);
            try {
                const searchPaths = iconTheme.get_search_path();
                if (!searchPaths.includes(iconDirectory)) {
                    iconTheme.add_search_path(iconDirectory);
                }
            } catch (_e) {
                iconTheme.add_search_path(iconDirectory);
            }

            if (!this._prefsCssLoaded) {
                const cssProvider = new Gtk.CssProvider();
                cssProvider.load_from_path(`${extensionPath}/prefs.css`);
                Gtk.StyleContext.add_provider_for_display(
                    display,
                    cssProvider,
                    Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION
                );
                this._prefsCssLoaded = true;
            }
        }

        const addCssClasses = (widget, ...cssClasses) => {
            for (const cssClass of cssClasses) {
                if (cssClass) {
                    widget.add_css_class(cssClass);
                }
            }

            return widget;
        };

        const createPreferencesPage = params => addCssClasses(
            new Adw.PreferencesPage(params),
            'katab-prefs-page'
        );

        const createPreferencesGroup = params => addCssClasses(
            new Adw.PreferencesGroup(params),
            'katab-prefs-group'
        );

        const stylePreferenceRow = (row, ...cssClasses) => addCssClasses(
            row,
            'katab-prefs-row',
            ...cssClasses
        );

        const createExpanderRow = params => stylePreferenceRow(
            new Adw.ExpanderRow(params),
            'katab-prefs-expander'
        );

        const page = createPreferencesPage({
            title: 'General',
            icon_name: 'katab-logo',
        });
        window.add(page);

        const ollamaSettingTypes = {
            'format': 'string',
            'frequency-penalty': 'double',
            'min-p': 'double',
            'mirostat': 'int',
            'mirostat-eta': 'double',
            'mirostat-tau': 'double',
            'presence-penalty': 'double',
            'raw': 'boolean',
            'repeat-penalty': 'double',
            'temperature': 'double',
            'tfs-z': 'double',
            'top-k': 'int',
            'top-p': 'double',
            'typical-p': 'double',
        };

        const presetDefinitions = {
            balanced: {
                'format': '',
                'raw': false,
                'temperature': 0.7,
                'top-k': 40,
                'top-p': 0.9,
                'min-p': 0.05,
                'mirostat': 0,
                'repeat-penalty': 1.1,
                'presence-penalty': 0.0,
                'frequency-penalty': 0.0,
                'tfs-z': 1.0,
                'typical-p': 1.0,
            },
            code: {
                'format': '',
                'raw': false,
                'temperature': 0.1,
                'top-k': 40,
                'top-p': 1.0,
                'min-p': 0.05,
                'mirostat': 0,
                'repeat-penalty': 1.0,
                'presence-penalty': 0.0,
                'frequency-penalty': 0.0,
                'tfs-z': 1.0,
                'typical-p': 1.0,
            },
            factual: {
                'format': '',
                'raw': false,
                'temperature': 0.3,
                'top-k': 40,
                'top-p': 0.9,
                'min-p': 0.05,
                'mirostat': 0,
                'repeat-penalty': 1.05,
                'presence-penalty': 0.0,
                'frequency-penalty': 0.0,
                'tfs-z': 1.0,
                'typical-p': 1.0,
            },
            creative: {
                'format': '',
                'raw': false,
                'temperature': 1.1,
                'top-k': 40,
                'top-p': 0.95,
                'min-p': 0.05,
                'mirostat': 0,
                'repeat-penalty': 1.1,
                'presence-penalty': 0.2,
                'frequency-penalty': 0.0,
                'tfs-z': 1.0,
                'typical-p': 1.0,
            },
            json: {
                'format': 'json',
                'raw': false,
                'temperature': 0.0,
                'top-k': 40,
                'top-p': 1.0,
                'min-p': 0.05,
                'mirostat': 0,
                'repeat-penalty': 1.05,
                'presence-penalty': 0.0,
                'frequency-penalty': 0.0,
                'tfs-z': 1.0,
                'typical-p': 1.0,
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

        const providerDetails = {
            ollama: {
                label: 'Ollama',
                pageTitle: 'Ollama',
                iconFile: 'ollama.svg',
                description: 'Run local models with a fast desktop-native workflow and deep tuning controls.',
            },
            unsloth: {
                label: 'Unsloth Studio',
                pageTitle: 'Unsloth',
                iconFile: 'unsloth.png',
                description: 'Connect to optimized local Unsloth Studio endpoints for heavier or longer-context jobs.',
            },
            openai: {
                label: 'OpenAI',
                pageTitle: 'OpenAI',
                iconFile: 'openai.svg',
                description: 'Use hosted OpenAI models when you want broad capability and reliable cloud access.',
            },
            anthropic: {
                label: 'Anthropic Claude',
                pageTitle: 'Claude',
                iconFile: 'claude.svg',
                description: 'Use Claude models through Anthropic for careful reasoning, writing, and long-context work.',
            },
        };

        // General Provider Selection
        const generalGroup = createPreferencesGroup({
            title: 'AI Provider Settings',
        });
        page.add(generalGroup);

        const accessibilityGroup = createPreferencesGroup({
            title: 'Accessibility',
        });
        page.add(accessibilityGroup);

        const addPreferenceRow = (group, row) => {
            if (typeof group.add_row === 'function') {
                group.add_row(row);
                return;
            }

            group.add(row);
        };

        const setStringList = (row, labels) => {
            const list = new Gtk.StringList();
            for (const label of labels) {
                list.append(label);
            }
            row.model = list;
        };

        const syncRowWithSetting = (key, row, property, getter, setter, signal, normalize = value => value) => {
            let syncing = false;

            const syncFromSettings = () => {
                const nextValue = getter(key);
                if (row[property] === nextValue)
                    return;

                syncing = true;
                row[property] = nextValue;
                syncing = false;
            };

            syncFromSettings();
            settings.connect(`changed::${key}`, syncFromSettings);

            row.connect(signal, () => {
                if (syncing)
                    return;

                const nextValue = normalize(row[property]);
                if (getter(key) === nextValue)
                    return;

                setter(key, nextValue);
            });

            return row;
        };

        const formatShortcutValue = shortcuts => {
            const labels = (shortcuts || []).map(shortcut => {
                const [, keyval, modifierMask] = Gtk.accelerator_parse(shortcut);
                return Gtk.accelerator_get_label(keyval, modifierMask);
            }).filter(Boolean);

            return labels.join(' / ') || 'Disabled';
        };

        const isShortcutKeyvalForbidden = keyval => {
            const forbiddenKeyvals = [
                Gdk.KEY_Home,
                Gdk.KEY_Left,
                Gdk.KEY_Up,
                Gdk.KEY_Right,
                Gdk.KEY_Down,
                Gdk.KEY_Page_Up,
                Gdk.KEY_Page_Down,
                Gdk.KEY_End,
                Gdk.KEY_Tab,
                Gdk.KEY_KP_Enter,
                Gdk.KEY_Return,
                Gdk.KEY_Mode_switch,
            ];

            return forbiddenKeyvals.includes(keyval);
        };

        const isShortcutBindingValid = ({ mask, keycode, keyval }) => {
            if ((mask === 0 || mask === Gdk.ModifierType.SHIFT_MASK) && keycode !== 0) {
                if (
                    (keyval >= Gdk.KEY_a && keyval <= Gdk.KEY_z) ||
                    (keyval >= Gdk.KEY_A && keyval <= Gdk.KEY_Z) ||
                    (keyval >= Gdk.KEY_0 && keyval <= Gdk.KEY_9) ||
                    (keyval === Gdk.KEY_space && mask === 0) ||
                    isShortcutKeyvalForbidden(keyval)
                ) {
                    return false;
                }
            }

            return true;
        };

        const shortcutCaptureState = {
            active: false,
            button: null,
        };

        const stopShortcutCapture = () => {
            if (!shortcutCaptureState.active) {
                return;
            }

            shortcutCaptureState.active = false;
            if (shortcutCaptureState.button) {
                shortcutCaptureState.button.set_label(formatShortcutValue(settings.get_strv('toggle-current-chat')));
            }
        };

        const shortcutKeyController = new Gtk.EventControllerKey();
        window.add_controller(shortcutKeyController);
        shortcutKeyController.connect('key-pressed', (_controller, keyval, keycode, state) => {
            if (!shortcutCaptureState.active) {
                return Gdk.EVENT_PROPAGATE;
            }

            let mask = state & Gtk.accelerator_get_default_mod_mask();
            mask &= ~Gdk.ModifierType.LOCK_MASK;

            if (mask === 0) {
                switch (keyval) {
                    case Gdk.KEY_BackSpace:
                        settings.set_strv('toggle-current-chat', []);
                        stopShortcutCapture();
                        return Gdk.EVENT_STOP;
                    case Gdk.KEY_Escape:
                        stopShortcutCapture();
                        return Gdk.EVENT_STOP;
                }
            }

            if (!isShortcutBindingValid({ mask, keycode, keyval }) || !Gtk.accelerator_valid(keyval, mask)) {
                return Gdk.EVENT_STOP;
            }

            const shortcut = Gtk.accelerator_name_with_keycode(null, keyval, keycode, mask);
            settings.set_strv('toggle-current-chat', [shortcut]);
            stopShortcutCapture();
            return Gdk.EVENT_STOP;
        });

        const getOllamaValue = suffix => {
            const type = ollamaSettingTypes[suffix];
            if (!type)
                throw new Error(`Unknown Ollama setting: ${suffix}`);

            return settings[`get_${type}`](`ollama-${suffix}`);
        };

        const setOllamaValue = (suffix, value) => {
            const type = ollamaSettingTypes[suffix];
            if (!type)
                throw new Error(`Unknown Ollama setting: ${suffix}`);

            settings[`set_${type}`](`ollama-${suffix}`, value);
        };

        const valuesEqual = (left, right) => {
            if (typeof left === 'number' && typeof right === 'number') {
                return Math.abs(left - right) < 0.000001;
            }

            return left === right;
        };

        const createChoiceRow = (title, subtitle, group) => {
            const row = stylePreferenceRow(new Adw.ComboRow({
                title,
                ...(subtitle && { subtitle }),
            }), 'katab-prefs-choice-row');

            addPreferenceRow(group, row);
            return row;
        };

        const createProviderImage = (provider, pixelSize = 26) => {
            const iconFile = providerDetails[provider]?.iconFile;
            if (!iconFile) {
                return addCssClasses(new Gtk.Image({
                    icon_name: 'applications-science-symbolic',
                    pixel_size: pixelSize,
                    valign: Gtk.Align.CENTER,
                }), 'katab-prefs-provider-image');
            }

            return addCssClasses(new Gtk.Image({
                gicon: Gio.icon_new_for_string(`${extensionPath}/icons/${iconFile}`),
                pixel_size: pixelSize,
                valign: Gtk.Align.CENTER,
            }), 'katab-prefs-provider-image');
        };

        const getProviderThemeIconName = provider => {
            const iconFile = providerDetails[provider]?.iconFile;
            if (!iconFile) {
                return 'applications-science-symbolic';
            }

            return iconFile.replace(/\.[^.]+$/, '');
        };

        const createProviderActiveBadge = () => {
            const badge = addCssClasses(new Gtk.Box({
                orientation: Gtk.Orientation.HORIZONTAL,
                spacing: 6,
                valign: Gtk.Align.CENTER,
            }), 'katab-prefs-provider-badge');

            const checkIcon = addCssClasses(new Gtk.Image({
                icon_name: 'object-select-symbolic',
                valign: Gtk.Align.CENTER,
            }), 'katab-prefs-provider-badge-icon');
            const badgeLabel = addCssClasses(new Gtk.Label({
                label: 'Active',
                valign: Gtk.Align.CENTER,
            }), 'katab-prefs-provider-badge-label');
            badgeLabel.add_css_class('dim-label');

            badge.append(checkIcon);
            badge.append(badgeLabel);
            return badge;
        };

        const toolStatusClasses = [
            'katab-prefs-status-builtin',
            'katab-prefs-status-detected',
            'katab-prefs-status-install',
        ];

        const createStatusBadge = (label = 'Checking') => addCssClasses(new Gtk.Label({
            label,
            valign: Gtk.Align.CENTER,
            xalign: 0.5,
        }), 'katab-prefs-status-badge');

        const setStatusBadge = (badge, label, statusClass) => {
            badge.label = label;
            for (const className of toolStatusClasses) {
                badge.remove_css_class(className);
            }

            if (statusClass) {
                badge.add_css_class(statusClass);
            }
        };

        const createInfoRow = (title, subtitle, group, suffix = null) => {
            const row = stylePreferenceRow(new Adw.ActionRow({
                title,
                ...(subtitle && { subtitle }),
                activatable: false,
            }), 'katab-prefs-info-row');

            if (suffix) {
                row.add_suffix(suffix);
            }

            addPreferenceRow(group, row);
            return row;
        };

        const createButtonRow = (title, subtitle, buttonLabel, callback, group) => {
            const button = addCssClasses(new Gtk.Button({
                label: buttonLabel,
                valign: Gtk.Align.CENTER,
            }), 'katab-prefs-button');
            button.connect('clicked', callback);

            const row = createInfoRow(title, subtitle, group, button);
            row.activatable_widget = button;
            return row;
        };

        const createStatusRow = (title, subtitle, group) => {
            const badge = createStatusBadge();
            const row = createInfoRow(title, subtitle, group, badge);
            return { row, badge };
        };

        const createProviderCardRow = (provider, group, subtitle = null) => {
            const detail = providerDetails[provider];
            const row = stylePreferenceRow(new Adw.ActionRow({
                title: detail.label,
                subtitle: subtitle || detail.description,
                activatable: true,
            }), 'katab-prefs-provider-row');

            row.add_prefix(createProviderImage(provider));

            const activeBadge = createProviderActiveBadge();
            row.add_suffix(activeBadge);

            const syncRowState = () => {
                activeBadge.visible = settings.get_string('provider') === provider;
            };

            syncRowState();
            settings.connect('changed::provider', syncRowState);

            row.connect('activated', () => {
                settings.set_string('provider', provider);
            });

            addPreferenceRow(group, row);
            return row;
        };

        const createProviderPage = (provider, subtitle = null) => {
            const detail = providerDetails[provider];
            const providerPage = createPreferencesPage({
                title: detail.pageTitle || detail.label,
                icon_name: getProviderThemeIconName(provider),
            });
            window.add(providerPage);

            const brandGroup = createPreferencesGroup();
            createProviderCardRow(provider, brandGroup, subtitle);
            providerPage.add(brandGroup);

            return providerPage;
        };

        const bindChoiceRow = (row, key, choices, getter, setter, formatUnknown = value => `Custom (${value})`) => {
            let syncing = false;

            const syncFromSettings = () => {
                const currentValue = getter(key);
                const values = choices.map(choice => choice.value);
                const labels = choices.map(choice => choice.label);

                if (!values.includes(currentValue)) {
                    values.push(currentValue);
                    labels.push(formatUnknown(currentValue));
                }

                setStringList(row, labels);
                row._choiceValues = values;

                syncing = true;
                row.selected = Math.max(0, values.indexOf(currentValue));
                syncing = false;
            };

            syncFromSettings();
            settings.connect(`changed::${key}`, syncFromSettings);

            row.connect('notify::selected', () => {
                if (syncing)
                    return;

                const nextValue = row._choiceValues?.[row.selected];
                if (nextValue === undefined || getter(key) === nextValue)
                    return;

                setter(key, nextValue);
            });

            return row;
        };

        // Helper to create string input rows binding to GSettings
        const createStringRow = (title, subtitle, key, group, isPassword = false) => {
            const row = stylePreferenceRow(new Adw.ActionRow({
                title,
                ...(subtitle && { subtitle }),
            }), 'katab-prefs-input-row');

            const entry = addCssClasses(new Gtk.Entry({
                hexpand: true,
                valign: Gtk.Align.CENTER,
                visibility: !isPassword,
                input_purpose: isPassword ? Gtk.InputPurpose.PASSWORD : Gtk.InputPurpose.FREE_FORM,
                width_chars: 24,
            }), 'katab-prefs-entry');

            row.add_suffix(entry);
            row.activatable_widget = entry;

            addPreferenceRow(group, row);
            syncRowWithSetting(key, entry, 'text', settings.get_string.bind(settings), settings.set_string.bind(settings), 'notify::text');
            return row;
        };

        const createIntRow = (title, subtitle, key, group, min, max, step) => {
            const row = stylePreferenceRow(new Adw.SpinRow({
                title,
                ...(subtitle && { subtitle }),
                adjustment: new Gtk.Adjustment({
                    lower: min,
                    upper: max,
                    step_increment: step,
                    page_increment: Math.max(step, step * 4),
                }),
                numeric: true,
            }), 'katab-prefs-spin-row');

            addPreferenceRow(group, row);
            return syncRowWithSetting(key, row, 'value', settings.get_int.bind(settings), settings.set_int.bind(settings), 'notify::value', value => Math.round(value));
        };

        const createDoubleRow = (title, subtitle, key, group, min, max, step, digits = 2) => {
            const row = stylePreferenceRow(new Adw.SpinRow({
                title,
                ...(subtitle && { subtitle }),
                adjustment: new Gtk.Adjustment({
                    lower: min,
                    upper: max,
                    step_increment: step,
                    page_increment: Math.max(step, step * 5),
                }),
                numeric: true,
                digits,
            }), 'katab-prefs-spin-row');

            addPreferenceRow(group, row);
            return syncRowWithSetting(key, row, 'value', settings.get_double.bind(settings), settings.set_double.bind(settings), 'notify::value');
        };

        const createBooleanRow = (title, subtitle, key, group) => {
            const row = stylePreferenceRow(new Adw.SwitchRow({
                title,
                ...(subtitle && { subtitle }),
            }), 'katab-prefs-switch-row');

            addPreferenceRow(group, row);
            return syncRowWithSetting(key, row, 'active', settings.get_boolean.bind(settings), settings.set_boolean.bind(settings), 'notify::active');
        };

        const createShortcutRow = (title, subtitle, key, group) => {
            const row = stylePreferenceRow(new Adw.ActionRow({
                title,
                ...(subtitle && { subtitle }),
            }), 'katab-prefs-shortcut-row');

            const buttonBox = addCssClasses(new Gtk.Box({
                orientation: Gtk.Orientation.HORIZONTAL,
                spacing: 6,
                valign: Gtk.Align.CENTER,
            }), 'katab-prefs-button-box');

            const shortcutButton = addCssClasses(new Gtk.Button({
                label: formatShortcutValue(settings.get_strv(key)),
                valign: Gtk.Align.CENTER,
            }), 'katab-prefs-button', 'katab-prefs-shortcut-button');
            shortcutButton.connect('clicked', () => {
                shortcutCaptureState.active = true;
                shortcutCaptureState.button = shortcutButton;
                shortcutButton.set_label('Press shortcut...');
            });
            buttonBox.append(shortcutButton);

            const clearButton = addCssClasses(new Gtk.Button({
                icon_name: 'edit-clear-symbolic',
                valign: Gtk.Align.CENTER,
                tooltip_text: 'Clear shortcut',
            }), 'katab-prefs-button', 'katab-prefs-clear-button');
            clearButton.connect('clicked', () => {
                settings.set_strv(key, []);
                stopShortcutCapture();
            });
            buttonBox.append(clearButton);

            const syncShortcutRow = () => {
                if (!shortcutCaptureState.active || shortcutCaptureState.button !== shortcutButton) {
                    shortcutButton.set_label(formatShortcutValue(settings.get_strv(key)));
                }
                clearButton.set_sensitive(settings.get_strv(key).length > 0);
            };

            syncShortcutRow();
            settings.connect(`changed::${key}`, syncShortcutRow);

            row.add_suffix(buttonBox);
            row.activatable_widget = shortcutButton;
            addPreferenceRow(group, row);
            return row;
        };

        createProviderCardRow('ollama', generalGroup);
        createProviderCardRow('unsloth', generalGroup);
        createProviderCardRow('openai', generalGroup);
        createProviderCardRow('anthropic', generalGroup);
        createShortcutRow(
            'Current Chat Shortcut',
            'Open or hide the current chat while keeping active responses running in the background. GNOME Shell requires one non-modifier key, so modifier-only shortcuts like Ctrl+Shift+Super are not valid.',
            'toggle-current-chat',
            accessibilityGroup
        );

        // --- Ollama Page ---
        const ollamaPage = createProviderPage(
            'ollama',
            'Local inference with fine-grained hardware, memory, and sampling controls.'
        );

        const presetGroup = createPreferencesGroup({
            title: 'Workload Preset',
            description: 'Start from recommended Ollama settings for the kind of output you want Katab to produce.',
        });
        ollamaPage.add(presetGroup);

        const presetRow = createChoiceRow(
            'Workload Preset',
            'Applies recommended settings for desktop assistant chat, coding, factual answers, creativity, or JSON extraction.',
            presetGroup
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

                if (matches)
                    return presetId;
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
            setStringList(presetRow, presetOptions.map(option => option.label));
            presetRow._choiceValues = presetOptions.map(option => option.value);
            presetRow.selected = Math.max(0, presetRow._choiceValues.indexOf(selectedPreset));
            syncingPresetRow = false;
        };

        const applyPreset = presetId => {
            const presetValues = presetDefinitions[presetId];
            if (!presetValues)
                return;

            applyingPreset = true;
            for (const [suffix, value] of Object.entries(presetValues)) {
                setOllamaValue(suffix, value);
            }
            applyingPreset = false;

            settings.set_string('ollama-preset', presetId);
        };

        presetRow.connect('notify::selected', () => {
            if (syncingPresetRow)
                return;

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
                if (applyingPreset)
                    return;

                syncPresetRow();
            });
        }

        syncPresetRow();

        // Connection & Model
        const connectionGroup = createPreferencesGroup({ title: 'Connection & Request Shape' });
        createStringRow('Base URL', 'The HTTP address where Ollama is hosted.', 'ollama-url', connectionGroup);
        createStringRow('Model', 'The exact Ollama model tag to load for this provider.', 'ollama-model', connectionGroup);

        const formatRow = createChoiceRow(
            'Response Format',
            'Keep standard text for chat. Switch to JSON mode when another app needs machine-readable output.',
            connectionGroup
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
            value => value === '' ? 'Standard Text' : `Custom (${value})`
        );

        createBooleanRow(
            'Raw Prompt Mode',
            'Bypass Ollama chat templating. Leave this off unless your prompt is already fully structured.',
            'ollama-raw',
            connectionGroup
        );
        createStringRow('Keep Alive', 'How long to keep the model loaded between requests, such as 5m, 0, or -1.', 'ollama-keep-alive', connectionGroup);

        const contextGroup = createPreferencesGroup({ title: 'Context Limits' });
        const ctxRow = createChoiceRow(
            'Context Window Size',
            'Choose a standard context size. If a custom value is already saved, it stays visible instead of snapping back to 4096.',
            contextGroup
        );
        const ctxValues = [1024, 2048, 4096, 8192, 16384, 32768, 65536, 131072];
        let syncingContextRow = false;

        const syncContextRow = () => {
            const currentCtx = settings.get_int('ollama-num-ctx');
            const values = [...ctxValues];
            const labels = ctxValues.map(value => value.toString());

            if (!values.includes(currentCtx) && currentCtx > 0) {
                values.push(currentCtx);
                labels.push(`${currentCtx} (custom)`);
            }

            setStringList(ctxRow, labels);
            ctxRow._choiceValues = values;

            syncingContextRow = true;
            ctxRow.selected = Math.max(0, values.indexOf(currentCtx));
            syncingContextRow = false;
        };

        settings.connect('changed::ollama-num-ctx', syncContextRow);
        syncContextRow();

        ctxRow.connect('notify::selected', () => {
            if (syncingContextRow)
                return;

            const nextValue = ctxRow._choiceValues?.[ctxRow.selected];
            if (nextValue === undefined || nextValue === settings.get_int('ollama-num-ctx'))
                return;

            settings.set_int('ollama-num-ctx', nextValue);
        });

        createIntRow('Predict Tokens', 'Maximum number of tokens Ollama may generate for a reply. Use -1 for no hard cap.', 'ollama-num-predict', contextGroup, -1, 128000, 100);
        createIntRow('Keep Tokens', 'Preserve this many leading tokens when the context window rolls over so core instructions stay anchored.', 'ollama-num-keep', contextGroup, 0, 128000, 100);
        ollamaPage.add(connectionGroup);
        ollamaPage.add(contextGroup);

        // Hardware & Memory
        const hardwareExpander = createExpanderRow({
            title: 'Advanced Hardware Settings',
            subtitle: 'Control how aggressively Ollama uses RAM, CPU, and GPU resources.',
        });
        createBooleanRow('Use MMAP', 'Map model weights through virtual memory so the kernel can page them in on demand.', 'ollama-use-mmap', hardwareExpander);
        createBooleanRow('Use MLOCK', 'Lock model pages in RAM to avoid swap latency. Leave this off unless you are certain your system has headroom.', 'ollama-use-mlock', hardwareExpander);
        createIntRow('GPU Layers', 'Number of transformer layers to offload to the GPU. Use -1 for all layers or 0 for CPU-only runs.', 'ollama-num-gpu', hardwareExpander, -1, 500, 1);
        createIntRow('CPU Threads', 'Worker threads for inference. Staying near your physical core count usually gives the best latency.', 'ollama-num-thread', hardwareExpander, 1, 128, 1);
        const hardwareGroup = createPreferencesGroup();
        hardwareGroup.add(hardwareExpander);
        ollamaPage.add(hardwareGroup);

        // Generation Options
        const generationGroup = createPreferencesGroup({ title: 'Model Behavior & Sampling' });

        const tempRow = createDoubleRow('Temperature', 'Controls randomness. Lower values stay focused and predictable; higher values explore more unusual tokens.', 'ollama-temperature', generationGroup, 0.0, 2.0, 0.05, 2);
        const topKRow = createIntRow('Top-K', 'Keep only the K most likely next tokens before sampling. Lower values are stricter.', 'ollama-top-k', generationGroup, 0, 150, 1);
        const topPRow = createDoubleRow('Top-P', 'Nucleus sampling. Keeps the smallest token set whose combined probability reaches this value.', 'ollama-top-p', generationGroup, 0.0, 1.0, 0.05, 2);
        const minPRow = createDoubleRow('Min-P', 'Alternative to Top-P. Filters out tokens that fall too far below the most likely option.', 'ollama-min-p', generationGroup, 0.0, 1.0, 0.01, 2);

        const mirostatExpander = createExpanderRow({
            title: 'Dynamic Entropy (Mirostat)',
            subtitle: 'Let Ollama adjust sampling on the fly to keep responses near a target creativity level.',
        });
        const mirostatRow = createChoiceRow(
            'Mirostat Mode',
            'When enabled, Ollama dynamically manages entropy and the static temperature and top-p controls become advisory only.',
            mirostatExpander
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
            value => `Custom (${value})`
        );
        const mirostatTauRow = createDoubleRow('Target Entropy (tau)', 'Higher values allow more surprise. Lower values keep text tighter and more predictable.', 'ollama-mirostat-tau', mirostatExpander, 0.0, 10.0, 0.5, 2);
        const mirostatEtaRow = createDoubleRow('Learning Rate (eta)', 'How aggressively Mirostat corrects drift from the target entropy.', 'ollama-mirostat-eta', mirostatExpander, 0.0, 1.0, 0.05, 2);

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
        createDoubleRow('Tail Free Sampling (tfs_z)', 'Cuts off the low-value tail of the distribution where choices stop being meaningfully distinct. Set 1.0 to disable it.', 'ollama-tfs-z', advancedSamplingExpander, 0.0, 1.0, 0.05, 2);
        createDoubleRow('Typical-P', 'Biases generation toward tokens with typical information content so output stays natural instead of too flat or too erratic.', 'ollama-typical-p', advancedSamplingExpander, 0.0, 1.0, 0.05, 2);
        generationGroup.add(advancedSamplingExpander);

        const loopMitigationExpander = createExpanderRow({
            title: 'Degeneration and Loop Mitigation',
            subtitle: 'Penalize repetition when the model starts circling the same words or phrases.',
        });
        createIntRow('Repeat Last N', 'How far back Ollama should look for repetition. Use -1 to scan the full active context.', 'ollama-repeat-last-n', loopMitigationExpander, -1, 128000, 64);
        createDoubleRow('Repeat Penalty', 'Multiplicative repetition penalty. Keep this near 1.0 for code and raise it gently for chat if loops appear.', 'ollama-repeat-penalty', loopMitigationExpander, 1.0, 2.0, 0.05, 2);
        createDoubleRow('Presence Penalty', 'Encourages fresh vocabulary by penalizing any token that has appeared at least once.', 'ollama-presence-penalty', loopMitigationExpander, 0.0, 2.0, 0.05, 2);
        createDoubleRow('Frequency Penalty', 'Penalizes tokens in proportion to how often they have already appeared.', 'ollama-frequency-penalty', loopMitigationExpander, 0.0, 2.0, 0.05, 2);
        generationGroup.add(loopMitigationExpander);

        ollamaPage.add(generationGroup);

        // --- Unsloth Settings ---
        const unslothPage = createProviderPage('unsloth');
        const unslothGroup = createPreferencesGroup({ title: 'Connection & Model' });
        createStringRow('Base URL', null, 'unsloth-url', unslothGroup);
        createStringRow('API Key', null, 'unsloth-api-key', unslothGroup, true);
        createStringRow('Model', null, 'unsloth-model', unslothGroup);
        createIntRow('Context Window Size', null, 'unsloth-num-ctx', unslothGroup, 1024, 1048576, 1024);
        unslothPage.add(unslothGroup);

        // --- OpenAI Settings ---
        const openaiPage = createProviderPage('openai');
        const openaiGroup = createPreferencesGroup({ title: 'Connection & Model' });
        createStringRow('Base URL', null, 'openai-url', openaiGroup);
        createStringRow('API Key', null, 'openai-api-key', openaiGroup, true);
        createStringRow('Model', null, 'openai-model', openaiGroup);
        openaiPage.add(openaiGroup);

        // --- Anthropic Settings ---
        const anthropicPage = createProviderPage('anthropic');
        const anthropicGroup = createPreferencesGroup({ title: 'Connection & Model' });
        createStringRow('Base URL', null, 'anthropic-url', anthropicGroup);
        createStringRow('API Key', null, 'anthropic-api-key', anthropicGroup, true);
        createStringRow('Model', null, 'anthropic-model', anthropicGroup);
        anthropicPage.add(anthropicGroup);

        // --- Tools Settings ---
        const toolsPage = createPreferencesPage({
            title: 'Tools',
            icon_name: 'applications-utilities-symbolic',
        });
        window.add(toolsPage);

        const documentToolGroup = createPreferencesGroup({
            title: 'Document Tool',
            description: 'Optional local document parsing for chat. Basic chat keeps working unchanged when this stays off.',
        });
        toolsPage.add(documentToolGroup);

        createBooleanRow(
            'Enable Document Tool',
            'Show the chat document button and enable the /doc command for local files.',
            'document-tool-enabled',
            documentToolGroup
        );

        const documentUsageRow = createInfoRow(
            'How it works',
            '',
            documentToolGroup
        );

        const syncDocumentUsageRow = () => {
            documentUsageRow.subtitle = settings.get_boolean('document-tool-enabled')
                ? 'Use the document button in chat or type /doc with a quoted path. Katab will parse supported files locally before sending them to your provider.'
                : 'Turn this on only if you want local document parsing. Normal chat does not depend on any of these tools.';
        };
        settings.connect('changed::document-tool-enabled', syncDocumentUsageRow);
        syncDocumentUsageRow();

        const capabilityGroup = createPreferencesGroup({
            title: 'Detected Capabilities',
            description: 'Katab checks the local system at runtime. Install the listed packages only if you want that file type.',
        });
        toolsPage.add(capabilityGroup);

        const textStatusRow = createStatusRow(
            'Text and Markdown',
            'Plain text and Markdown are handled directly through native Gio file reads.',
            capabilityGroup
        );
        const pdfStatusRow = createStatusRow(
            'PDF Documents',
            'Install poppler-utils to expose pdftotext for fast PDF text extraction.',
            capabilityGroup
        );
        const docxStatusRow = createStatusRow(
            'Word Documents (.docx)',
            'Install pandoc to convert DOCX files into plain text before sending them to the model.',
            capabilityGroup
        );

        const refreshDocumentToolStatus = () => {
            setStatusBadge(textStatusRow.badge, 'Built in', 'katab-prefs-status-builtin');

            const pdfPath = GLib.find_program_in_path('pdftotext');
            if (pdfPath) {
                pdfStatusRow.row.subtitle = `Detected pdftotext at ${pdfPath}. PDF parsing is ready.`;
                setStatusBadge(pdfStatusRow.badge, 'Detected', 'katab-prefs-status-detected');
            } else {
                pdfStatusRow.row.subtitle = 'Install poppler-utils to expose pdftotext for fast PDF text extraction.';
                setStatusBadge(pdfStatusRow.badge, 'Install', 'katab-prefs-status-install');
            }

            const pandocPath = GLib.find_program_in_path('pandoc');
            if (pandocPath) {
                docxStatusRow.row.subtitle = `Detected pandoc at ${pandocPath}. DOCX parsing is ready.`;
                setStatusBadge(docxStatusRow.badge, 'Detected', 'katab-prefs-status-detected');
            } else {
                docxStatusRow.row.subtitle = 'Install pandoc to convert DOCX files into plain text before sending them to the model.';
                setStatusBadge(docxStatusRow.badge, 'Install', 'katab-prefs-status-install');
            }
        };

        createButtonRow(
            'Refresh Detection',
            'Re-scan the local system after installing or removing parser packages.',
            'Refresh',
            refreshDocumentToolStatus,
            capabilityGroup
        );

        const installGroup = createPreferencesGroup({
            title: 'Install Hints',
            description: 'Package names vary a little by distribution, but these are the common ones Katab expects.',
        });
        toolsPage.add(installGroup);

        createInfoRow(
            'PDF package',
            'Install poppler-utils so Katab can call pdftotext for PDFs.',
            installGroup
        );
        createInfoRow(
            'DOCX package',
            'Install pandoc so Katab can convert .docx files into plain text.',
            installGroup
        );

        refreshDocumentToolStatus();
    }
}
