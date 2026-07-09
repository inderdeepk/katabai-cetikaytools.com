import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import Soup from 'gi://Soup?version=3.0';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
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
} from './presetManager.js';
import { WebSearchRuntime, readWebSearchConfig } from './webSearchTools.js';
import { Crawl4AIRuntime, readCrawl4AIConfig } from './crawl4aiTools.js';
import {
    formatTokenCount,
    TOKEN_USAGE_RANGES,
    TokenUsageManager,
} from './tokenUsageManager.js';

export default class KatabPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        window.search_enabled = true;
        window.add_css_class('katab-prefs-window');
        window.default_width = 740;
        window.default_height = 660;

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

            const applyPrefsTheme = () => {
                try {
                    const styleManager = Adw.StyleManager.get_default();
                    const isDark = styleManager.get_dark();
                    window.remove_css_class('katab-prefs-theme-dark');
                    window.remove_css_class('katab-prefs-theme-light');
                    window.add_css_class(isDark ? 'katab-prefs-theme-dark' : 'katab-prefs-theme-light');
                } catch (_e) {
                    window.add_css_class('katab-prefs-theme-dark');
                }
            };
            applyPrefsTheme();
            try {
                const styleManager = Adw.StyleManager.get_default();
                const themeHandlerId = styleManager.connect('notify::dark', applyPrefsTheme);
                window.connect('destroy', () => styleManager.disconnect(themeHandlerId));
            } catch (_e) { /* StyleManager unavailable */ }
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
            'think': 'boolean',
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
            deepseek: {
                label: 'DeepSeek',
                pageTitle: 'DeepSeek',
                iconFile: 'deepseek.svg',
                description: 'Access DeepSeek V4 models with a 1M token context window and advanced reasoning. Requires a funded prepaid account.',
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
            title: 'Active Provider',
            description: 'Choose which AI backend powers your conversations. Click a provider to switch; your settings for each are kept separately.',
        });
        page.add(generalGroup);

        const accessibilityGroup = createPreferencesGroup({
            title: 'Keyboard Shortcut',
            description: 'Set a global shortcut to open or hide the chat from anywhere on the desktop.',
        });
        page.add(accessibilityGroup);

        const tokenUsageGroup = createPreferencesGroup({
            title: 'AI Token Breakdown',
            description: 'Control the local-only usage ledger, companion celebrations, default range, retention, reset, and export.',
        });
        page.add(tokenUsageGroup);

        const addPreferenceRow = (group, row) => {
            if (typeof group.add_row === 'function') {
                group.add_row(row);
                return;
            }

            group.add(row);
        };

        const setStringList = (row, labels) => {
            const currentModel = row.model;
            if (currentModel instanceof Gtk.StringList) {
                currentModel.splice(0, currentModel.get_n_items(), labels);
            } else {
                const list = new Gtk.StringList();
                for (const label of labels) {
                    list.append(label);
                }
                row.model = list;
            }
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

                syncing = true;
                setStringList(row, labels);
                row._choiceValues = values;
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

        const getTextBufferContents = buffer => {
            const [startIter, endIter] = buffer.get_bounds();
            return buffer.get_text(startIter, endIter, false);
        };

        const createMultilineStringRow = (title, subtitle, key, group, minHeight = 140) => {
            const row = stylePreferenceRow(
                new Adw.PreferencesRow(),
                'katab-prefs-input-row',
                'katab-prefs-multiline-row'
            );

            const box = addCssClasses(new Gtk.Box({
                orientation: Gtk.Orientation.VERTICAL,
                spacing: 10,
                margin_top: 12,
                margin_bottom: 12,
                margin_start: 12,
                margin_end: 12,
                hexpand: true,
            }), 'katab-prefs-multiline-box');

            if (title) {
                const titleLabel = new Gtk.Label({
                    label: title,
                    xalign: 0,
                    wrap: true,
                    halign: Gtk.Align.START,
                    hexpand: true,
                });
                box.append(titleLabel);
            }

            if (subtitle) {
                const subtitleLabel = addCssClasses(new Gtk.Label({
                    label: subtitle,
                    xalign: 0,
                    wrap: true,
                    halign: Gtk.Align.START,
                    hexpand: true,
                }), 'dim-label', 'caption');
                box.append(subtitleLabel);
            }

            const scroller = addCssClasses(new Gtk.ScrolledWindow({
                hexpand: true,
                min_content_height: minHeight,
                propagate_natural_height: true,
                hscrollbar_policy: Gtk.PolicyType.NEVER,
                vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
            }), 'katab-prefs-textarea');

            const textView = addCssClasses(new Gtk.TextView({
                wrap_mode: Gtk.WrapMode.WORD_CHAR,
                accepts_tab: true,
                monospace: false,
                top_margin: 10,
                bottom_margin: 10,
                left_margin: 10,
                right_margin: 10,
                hexpand: true,
                vexpand: true,
            }), 'katab-prefs-textview');
            scroller.set_child(textView);
            box.append(scroller);

            row.set_child(box);
            addPreferenceRow(group, row);

            const buffer = textView.get_buffer();
            let syncing = false;

            const syncFromSettings = () => {
                const nextValue = settings.get_string(key);
                const currentValue = getTextBufferContents(buffer);
                if (currentValue === nextValue) {
                    return;
                }

                syncing = true;
                buffer.set_text(nextValue, -1);
                syncing = false;
            };

            syncFromSettings();
            settings.connect(`changed::${key}`, syncFromSettings);
            buffer.connect('changed', () => {
                if (syncing) {
                    return;
                }

                const nextValue = getTextBufferContents(buffer);
                if (settings.get_string(key) === nextValue) {
                    return;
                }

                settings.set_string(key, nextValue);
            });

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
        createProviderCardRow('deepseek', generalGroup);
        createShortcutRow(
            'Toggle Chat',
            'Open or hide the current chat without cancelling active responses. Press to record a key combination; Backspace clears it.',
            'toggle-current-chat',
            accessibilityGroup
        );

        createBooleanRow(
            'Track Token Usage',
            'Record local-only token totals for the Tokens panel. Existing data stays on disk when this is off.',
            'token-usage-enabled',
            tokenUsageGroup
        );

        const tokenRangeRow = createChoiceRow(
            'Default Range',
            'Initial range shown when opening the AI Token Breakdown panel or top-bar snapshot.',
            tokenUsageGroup
        );
        bindChoiceRow(
            tokenRangeRow,
            'token-usage-default-range',
            TOKEN_USAGE_RANGES.map(range => ({ label: range.label, value: range.key })),
            settings.get_string.bind(settings),
            settings.set_string.bind(settings),
            value => `Custom (${value})`
        );

        const retentionRow = createChoiceRow(
            'Retention',
            'How long to keep daily token buckets before pruning. Forever keeps the local ledger until you reset it.',
            tokenUsageGroup
        );
        bindChoiceRow(
            retentionRow,
            'token-usage-retention-days',
            [
                { label: 'Forever', value: 0 },
                { label: '90 days', value: 90 },
                { label: '1 year', value: 365 },
            ],
            settings.get_int.bind(settings),
            settings.set_int.bind(settings),
            value => `${value} days`
        );

        createBooleanRow(
            'Companion Celebrations',
            'Show a small in-chat message when the token companion reaches a new growth stage.',
            'token-usage-celebrations-enabled',
            tokenUsageGroup
        );

        const { badge: tokenUsageBadge } = createStatusRow(
            'Usage Ledger',
            'Private JSON ledger stored under ~/.local/share/katabai/token-usage.json.',
            tokenUsageGroup
        );
        const refreshTokenUsageBadge = () => {
            try {
                const summary = TokenUsageManager.getSummary('all');
                setStatusBadge(tokenUsageBadge, `${formatTokenCount(summary.totalTokens)} tokens`, 'katab-prefs-status-detected');
            } catch (_e) {
                setStatusBadge(tokenUsageBadge, 'Unavailable', 'katab-prefs-status-install');
            }
        };
        refreshTokenUsageBadge();

        createButtonRow(
            'Export Usage JSON',
            'Write a timestamped copy of the local ledger into your Documents folder (or home folder if Documents is unavailable).',
            'Export',
            () => {
                try {
                    const path = TokenUsageManager.exportCopy();
                    setStatusBadge(tokenUsageBadge, 'Exported', 'katab-prefs-status-detected');
                    log(`Katab: exported token usage ledger to ${path}`);
                } catch (e) {
                    setStatusBadge(tokenUsageBadge, 'Export failed', 'katab-prefs-status-install');
                    log(`Katab: failed to export token usage ledger: ${e.message || e}`);
                }
            },
            tokenUsageGroup
        );

        createButtonRow(
            'Reset Usage Ledger',
            'Delete all local token analytics and restart the companion from an egg. This does not affect chat history.',
            'Reset',
            () => {
                TokenUsageManager.reset();
                refreshTokenUsageBadge();
            },
            tokenUsageGroup
        );

        // --- Ollama Page ---
        const ollamaPage = createProviderPage(
            'ollama',
            'Local inference with fine-grained hardware, memory, and sampling controls.'
        );

        // ── Model Presets section ──────────────────────────────────────────────
        const modelPresetsGroup = createPreferencesGroup({
            title: 'Model Presets',
            description: 'Save named snapshots of all current Ollama settings (model, context, sampling, etc.). Load a preset to instantly switch configurations.',
        });
        ollamaPage.add(modelPresetsGroup);

        // Entry row for the new preset name
        const newPresetNameRow = addCssClasses(new Adw.EntryRow({
            title: 'New Preset Name',
        }), 'katab-prefs-row');
        const saveCurrentBtn = addCssClasses(new Gtk.Button({
            label: 'Save Current Settings',
            valign: Gtk.Align.CENTER,
        }), 'katab-prefs-button', 'suggested-action');
        newPresetNameRow.add_suffix(saveCurrentBtn);
        addPreferenceRow(modelPresetsGroup, newPresetNameRow);

        // Container tracking for dynamically built preset rows
        let _savedPresetRows = [];
        let applyingSavedPreset = false;
        let presetDriftCheckTimeoutId = 0;
        let pendingPresetChangeId = '';
        let lastChangedPresetSettingKey = '';
        const presetSettingKeyMap = new Map(PRESET_SETTINGS.map(({ settingKey, key }) => [settingKey, key]));

        const applySavedPreset = preset => {
            if (!preset)
                return;

            applyingSavedPreset = true;
            pendingPresetChangeId = '';
            lastChangedPresetSettingKey = '';
            settings.set_string('ollama-active-preset', preset.id);
            applyPresetToSettings(settings, preset);
            updatePresetFromSettings(settings, preset.id, { onlyMissing: true });
            applyingSavedPreset = false;
        };

        const queuePresetDriftCheck = settingKey => {
            if (applyingSavedPreset)
                return;

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
                if (!activePresetId)
                    return GLib.SOURCE_REMOVE;

                const activePreset = getPresetById(activePresetId);
                if (!activePreset) {
                    settings.set_string('ollama-active-preset', '');
                    refreshSavedPresetRows();
                    return GLib.SOURCE_REMOVE;
                }

                const changedPresetKey = presetSettingKeyMap.get(lastChangedPresetSettingKey);
                const changedMissingField = changedPresetKey
                    && (activePreset[changedPresetKey] === undefined || activePreset[changedPresetKey] === null);

                if (changedMissingField || !settingsMatchPreset(settings, activePreset)) {
                    pendingPresetChangeId = activePreset.id;
                    settings.set_string('ollama-active-preset', '');
                    refreshSavedPresetRows();
                }

                return GLib.SOURCE_REMOVE;
            });
        };

        window.connect('destroy', () => {
            if (!presetDriftCheckTimeoutId)
                return;

            GLib.source_remove(presetDriftCheckTimeoutId);
            presetDriftCheckTimeoutId = 0;
        });

        const refreshSavedPresetRows = () => {
            // Remove stale rows
            for (const row of _savedPresetRows) {
                try { modelPresetsGroup.remove(row); } catch (_e) { }
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
                const emptyRow = stylePreferenceRow(new Adw.ActionRow({
                    title: 'No presets saved yet',
                    subtitle: 'Fill in a name above and click "Save Current Settings" to create your first preset.',
                    activatable: false,
                }), 'katab-prefs-info-row');
                addPreferenceRow(modelPresetsGroup, emptyRow);
                _savedPresetRows.push(emptyRow);
                return;
            }

            if (pendingPreset) {
                const pendingRow = stylePreferenceRow(new Adw.ActionRow({
                    title: `${pendingPreset.name || 'Unnamed Preset'} has unsaved changes`,
                    subtitle: 'Save changes to update this preset, or discard changes to restore its saved values.',
                    activatable: false,
                }), 'katab-prefs-row', 'katab-prefs-info-row');

                const pendingBtnBox = addCssClasses(new Gtk.Box({
                    orientation: Gtk.Orientation.HORIZONTAL,
                    spacing: 6,
                    valign: Gtk.Align.CENTER,
                }), 'katab-prefs-button-box');

                const saveChangesBtn = addCssClasses(new Gtk.Button({
                    label: 'Save Changes',
                    valign: Gtk.Align.CENTER,
                }), 'katab-prefs-button', 'suggested-action');
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

                const discardChangesBtn = addCssClasses(new Gtk.Button({
                    label: 'Discard Changes',
                    valign: Gtk.Align.CENTER,
                }), 'katab-prefs-button');
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
                const isActive = preset.id === activePresetId
                    && (applyingSavedPreset || settingsMatchPreset(settings, preset));
                const modelName = preset['model'] || '—';
                const ctx = preset['num-ctx'] ? `${preset['num-ctx']} ctx` : '';
                const temp = preset['temperature'] !== undefined
                    ? `temp ${Number(preset['temperature']).toFixed(2)}`
                    : '';
                const subtitleParts = [modelName, ctx, temp].filter(Boolean);

                const presetRow = stylePreferenceRow(new Adw.ActionRow({
                    title: preset.name || 'Unnamed Preset',
                    subtitle: subtitleParts.join('  ·  '),
                    activatable: false,
                }), 'katab-prefs-row', isActive ? 'katab-prefs-preset-row-active' : '');

                const rowBtnBox = addCssClasses(new Gtk.Box({
                    orientation: Gtk.Orientation.HORIZONTAL,
                    spacing: 6,
                    valign: Gtk.Align.CENTER,
                }), 'katab-prefs-button-box');

                const applyBtn = addCssClasses(new Gtk.Button({
                    label: isActive ? 'Active' : 'Load',
                    valign: Gtk.Align.CENTER,
                    sensitive: !isActive && !hasPendingPresetChanges,
                }), 'katab-prefs-button', isActive ? '' : 'suggested-action');
                applyBtn.connect('clicked', () => {
                    // Set ID first so drift observers keep the preset marked
                    // active while each saved key is being written.
                    applySavedPreset(preset);
                    refreshSavedPresetRows();
                });
                rowBtnBox.append(applyBtn);

                const deleteBtn = addCssClasses(new Gtk.Button({
                    icon_name: 'edit-delete-symbolic',
                    valign: Gtk.Align.CENTER,
                    tooltip_text: 'Delete this preset',
                }), 'katab-prefs-button', 'destructive-action');
                deleteBtn.connect('clicked', () => {
                    deletePreset(preset.id);
                    if (pendingPresetChangeId === preset.id)
                        pendingPresetChangeId = '';
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
        createBooleanRow(
            'Thinking Mode',
            'Enable reasoning traces for models that support hybrid-thinking (Qwen3, DeepSeek-R1, etc.). When off, the model answers directly without a thinking step.',
            'ollama-think',
            connectionGroup
        );
        createStringRow('Keep Alive', 'How long to keep the model loaded between requests. Must include a time unit (s, m, h), e.g. 5m, 0, or 999999h for indefinite.', 'ollama-keep-alive', connectionGroup);

        const contextGroup = createPreferencesGroup({ title: 'Context Limits' });
        const ctxRow = createChoiceRow(
            'Context Window Size',
            'Choose a standard context size. If a custom value is already saved, it stays visible instead of snapping back to 4096.',
            contextGroup
        );
        const ctxValues = [1024, 2048, 4096, 8192, 16384, 32768, 65536, 131072, 147456, 163840, 196608, 229376, 262144, 524288, 1048576];
        let syncingContextRow = false;

        const fmtCtx = v => {
            if (v >= 1048576 && v % 1048576 === 0) return `${v} (${v / 1048576}M)`;
            if (v >= 1024 && v % 1024 === 0) return `${v} (${v / 1024}K)`;
            return `${v}`;
        };

        const syncContextRow = () => {
            const currentCtx = settings.get_int('ollama-num-ctx');
            const values = [...ctxValues];
            const labels = ctxValues.map(value => fmtCtx(value));

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
            if (syncingContextRow)
                return;

            const nextValue = ctxRow._choiceValues?.[ctxRow.selected];
            if (nextValue === undefined || nextValue === settings.get_int('ollama-num-ctx'))
                return;

            settings.set_int('ollama-num-ctx', nextValue);
        });

        createIntRow('Predict Tokens', 'Maximum number of tokens Ollama may generate for a reply. Use -1 for no hard cap.', 'ollama-num-predict', contextGroup, -1, 128000, 100);
        createIntRow('Keep Tokens', 'Preserve this many leading tokens when the context window rolls over so core instructions stay anchored.', 'ollama-num-keep', contextGroup, 0, 1048576, 100);
        ollamaPage.add(connectionGroup);

        const ollamaPromptGroup = createPreferencesGroup({
            title: 'System Prompt',
            description: 'Katab prepends this system prompt to Ollama requests and always appends the current date so the model knows what "today" is. By default it keeps replies in your language and treats web/tool output as untrusted data to analyze, not instructions to obey. This value is captured by presets.',
        });
        createMultilineStringRow(
            '',
            '',
            'ollama-system-prompt',
            ollamaPromptGroup,
            160
        );
        ollamaPage.add(ollamaPromptGroup);

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

        // --- DeepSeek Settings ---
        const deepseekPage = createProviderPage('deepseek');

        const deepseekConnectionGroup = createPreferencesGroup({ title: 'Connection & Model' });
        createStringRow('Base URL', 'The DeepSeek API endpoint. Change only when routing through a compatible proxy.', 'deepseek-url', deepseekConnectionGroup);
        createStringRow(
            'API Key',
            'Enter your DeepSeek API key. Ensure your account holds a positive prepaid balance — the API operates exclusively on a pre-funded model.',
            'deepseek-api-key',
            deepseekConnectionGroup,
            true
        );
        createStringRow(
            'Model',
            'Use deepseek-v4-flash for general tasks and rapid coding, or deepseek-v4-pro for complex reasoning and multi-step workflows.',
            'deepseek-model',
            deepseekConnectionGroup
        );
        deepseekPage.add(deepseekConnectionGroup);

        const deepseekPromptGroup = createPreferencesGroup({
            title: 'System Prompt',
            description: 'Katab prepends this system prompt to DeepSeek requests. By default it keeps replies in your language and treats web/tool output as untrusted data to analyze, not instructions to obey.',
        });
        createMultilineStringRow(
            '',
            '',
            'deepseek-system-prompt',
            deepseekPromptGroup,
            160
        );
        deepseekPage.add(deepseekPromptGroup);

        const deepseekReasoningGroup = createPreferencesGroup({
            title: 'Reasoning',
            description: 'DeepSeek can perform extended chain-of-thought reasoning before responding. Thinking content is shown in a collapsible panel in chat.',
        });

        const deepseekThinkingRow = createBooleanRow(
            'Thinking Mode',
            'Enable extended reasoning. Increases response time but significantly improves quality on complex tasks.',
            'deepseek-thinking-enabled',
            deepseekReasoningGroup
        );

        const effortValues = ['high', 'max'];
        const effortLabels = ['High (balanced speed and depth)', 'Max (maximum reasoning depth)'];
        const effortRow = createChoiceRow(
            'Reasoning Effort',
            'Computational budget for the thinking phase. \u2018High\u2019 is the recommended default; \u2018Max\u2019 allocates the deepest analysis.',
            deepseekReasoningGroup
        );
        setStringList(effortRow, effortLabels);
        effortRow._choiceValues = effortValues;

        // Sync effort row \u2194 GSettings
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

        const deepseekOutputGroup = createPreferencesGroup({
            title: 'Output',
            description: 'Control structured output mode. When JSON mode is on, Katab automatically injects a JSON reminder into the system prompt if needed to satisfy the DeepSeek API requirement.',
        });
        createBooleanRow(
            'JSON Output Mode',
            'Force the model to return a valid JSON object. Useful for structured data extraction tasks.',
            'deepseek-json-mode',
            deepseekOutputGroup
        );
        deepseekPage.add(deepseekOutputGroup);

        // --- DeepSeek Account Balance ---
        const deepseekBalanceGroup = createPreferencesGroup({
            title: 'Account Balance',
            description: 'Current DeepSeek account balance. Refreshed automatically by the provider health check every 30 seconds while the extension is running.',
        });

        const createBalanceDisplayRow = (title, subtitle, getter) => {
            const valueLabel = addCssClasses(new Gtk.Label({
                label: '\u2014',
                xalign: 0,
                halign: Gtk.Align.START,
                valign: Gtk.Align.CENTER,
                selectable: true,
            }), 'katab-prefs-balance-value');

            const row = stylePreferenceRow(new Adw.ActionRow({
                title,
                ...(subtitle && { subtitle }),
                activatable: false,
            }), 'katab-prefs-info-row');

            const syncFromSettings = () => {
                valueLabel.set_text(getter() || '\u2014');
            };
            syncFromSettings();
            settings.connect(`changed::deepseek-balance-${title.toLowerCase().replace(/\s+/g, '-')}`, syncFromSettings);
            // Also refresh on these keys since the display row title may not match the key directly
            settings.connect('changed::deepseek-balance-available', syncFromSettings);
            settings.connect('changed::deepseek-balance-currency', syncFromSettings);
            settings.connect('changed::deepseek-balance-total', syncFromSettings);
            settings.connect('changed::deepseek-balance-granted', syncFromSettings);
            settings.connect('changed::deepseek-balance-topped-up', syncFromSettings);
            settings.connect('changed::deepseek-balance-last-checked', syncFromSettings);

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
                return settings.get_boolean('deepseek-balance-available') ? 'Yes' : 'No \u2014 top up needed';
            }
        );

        // Currency
        createBalanceDisplayRow(
            'Currency',
            'The currency of your DeepSeek account balance.',
            () => settings.get_string('deepseek-balance-currency') || '\u2014'
        );

        // Total Balance
        createBalanceDisplayRow(
            'Total Balance',
            'Total available funds (granted + topped-up).',
            () => {
                let total = settings.get_string('deepseek-balance-total');
                let currency = settings.get_string('deepseek-balance-currency');
                if (!total) return '\u2014';
                return currency ? `${currency} ${total}` : total;
            }
        );

        // Granted Balance
        createBalanceDisplayRow(
            'Granted (Free Credits)',
            'Promotional or free credits that may expire.',
            () => {
                let granted = settings.get_string('deepseek-balance-granted');
                let currency = settings.get_string('deepseek-balance-currency');
                if (!granted) return '\u2014';
                return currency ? `${currency} ${granted}` : granted;
            }
        );

        // Topped-Up Balance
        createBalanceDisplayRow(
            'Topped Up',
            'Funds added via top-up that do not expire.',
            () => {
                let toppedUp = settings.get_string('deepseek-balance-topped-up');
                let currency = settings.get_string('deepseek-balance-currency');
                if (!toppedUp) return '\u2014';
                return currency ? `${currency} ${toppedUp}` : toppedUp;
            }
        );

        // Last Checked
        const lastCheckedRow = createBalanceDisplayRow(
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
            }
        );

        // Refresh Balance button
        const refreshBalanceBtn = addCssClasses(new Gtk.Button({
            label: 'Refresh Balance',
            valign: Gtk.Align.CENTER,
            halign: Gtk.Align.START,
        }), 'katab-prefs-button', 'suggested-action');
        const refreshBtnRow = stylePreferenceRow(new Adw.ActionRow({
            title: 'Check Balance Now',
            subtitle: 'Makes a direct request to the DeepSeek /user/balance endpoint and updates the display above.',
            activatable: false,
        }), 'katab-prefs-info-row');
        refreshBtnRow.add_suffix(refreshBalanceBtn);
        refreshBtnRow.activatable_widget = refreshBalanceBtn;
        addPreferenceRow(deepseekBalanceGroup, refreshBtnRow);

        refreshBalanceBtn.connect('clicked', () => {
            refreshBalanceBtn.set_label('Checking...');
            refreshBalanceBtn.sensitive = false;
            this._refreshDeepSeekBalance(settings, () => {
                refreshBalanceBtn.set_label('Refresh Balance');
                refreshBalanceBtn.sensitive = true;
            });
        });

        deepseekPage.add(deepseekBalanceGroup);

        // --- Unsloth Settings ---
        const unslothPage = createProviderPage('unsloth');
        const unslothGroup = createPreferencesGroup({ title: 'Connection & Model' });
        createStringRow('Base URL', 'e.g. http://localhost:8888/v1 — the Unsloth Studio API root.', 'unsloth-url', unslothGroup);
        createStringRow('API Key', 'Leave blank for local instances running without authentication.', 'unsloth-api-key', unslothGroup, true);
        createStringRow('Model', 'The model identifier served by your Unsloth Studio instance.', 'unsloth-model', unslothGroup);
        createIntRow('Context Window Size', 'Maximum tokens per request. Match this to your loaded model capacity.', 'unsloth-num-ctx', unslothGroup, 1024, 1048576, 1024);
        unslothPage.add(unslothGroup);

        const unslothToolsGroup = createPreferencesGroup({
            title: 'Tools',
            description: 'Unsloth Studio runs web search, Python, and terminal as server-side tools on its own backend.',
        });
        unslothPage.add(unslothToolsGroup);
        createInfoRow(
            'Server-side tools',
            'When Unsloth is the active provider, tool calls are executed by Unsloth Studio, not by Katab. The local SearxNG Web Search tool on the Tools page applies to the Ollama, OpenAI, Anthropic, and DeepSeek providers instead.',
            unslothToolsGroup
        );
        const openaiPage = createProviderPage('openai');
        const openaiGroup = createPreferencesGroup({ title: 'Connection & Model' });
        createStringRow('Base URL', 'e.g. https://api.openai.com/v1 — change only when using a proxy or compatible endpoint.', 'openai-url', openaiGroup);
        createStringRow('API Key', 'Your OpenAI secret key starting with sk-. Never share or commit this value.', 'openai-api-key', openaiGroup, true);
        createStringRow('Model', 'The model ID from your OpenAI account, such as gpt-4o or gpt-4o-mini.', 'openai-model', openaiGroup);
        openaiPage.add(openaiGroup);

        // --- Anthropic Settings ---
        const anthropicPage = createProviderPage('anthropic');
        const anthropicGroup = createPreferencesGroup({ title: 'Connection & Model' });
        createStringRow('Base URL', 'e.g. https://api.anthropic.com — change only when using a proxy.', 'anthropic-url', anthropicGroup);
        createStringRow('API Key', 'Your Anthropic key starting with sk-ant-. Never share or commit this value.', 'anthropic-api-key', anthropicGroup, true);
        createStringRow('Model', 'The Claude model ID from your account, such as claude-opus-4-5.', 'anthropic-model', anthropicGroup);
        anthropicPage.add(anthropicGroup);

        // --- Tools Settings ---
        const toolsPage = createPreferencesPage({
            title: 'Tools',
            icon_name: 'applications-utilities-symbolic',
        });
        window.add(toolsPage);

        const toolsIndexGroup = createPreferencesGroup({
            title: 'Available Tools',
            description: 'Optional capabilities Katab can offer the model. Select a tool to open its dedicated settings. Normal chat does not depend on any of these.',
        });
        toolsPage.add(toolsIndexGroup);

        // Build an empty detail subpage: a PreferencesPage wrapped in a NavigationPage.
        const createToolSubpage = subpageTitle => {
            const detailPage = createPreferencesPage({ title: subpageTitle });
            const backGroup = createPreferencesGroup({});
            const backButton = addCssClasses(new Gtk.Button({
                icon_name: 'go-previous-symbolic',
                valign: Gtk.Align.CENTER,
                tooltip_text: 'Back to Tools',
            }), 'katab-prefs-button', 'katab-prefs-tool-back-button');
            const backRow = stylePreferenceRow(new Adw.ActionRow({
                title: 'Back to Tools',
                subtitle: subpageTitle,
                activatable: true,
            }), 'katab-prefs-tool-back-row');
            backButton.connect('clicked', () => {
                window.pop_subpage();
            });
            backRow.add_prefix(backButton);
            backRow.activatable_widget = backButton;
            addPreferenceRow(backGroup, backRow);
            detailPage.add(backGroup);

            const navPage = new Adw.NavigationPage({
                title: subpageTitle,
                child: detailPage,
            });
            return { detailPage, navPage };
        };

        // Build a navigable index row that opens a tool's detail subpage when activated.
        const createToolIndexRow = (group, { title, subtitle, iconName, enabledKey, navPage }) => {
            const row = stylePreferenceRow(new Adw.ActionRow({
                title,
                subtitle,
                activatable: true,
            }), 'katab-prefs-tool-row');

            row.add_prefix(addCssClasses(new Gtk.Image({
                icon_name: iconName,
                valign: Gtk.Align.CENTER,
            }), 'katab-prefs-tool-icon'));

            if (enabledKey) {
                const toggle = addCssClasses(new Gtk.Switch({
                    valign: Gtk.Align.CENTER,
                }), 'katab-prefs-tool-switch');
                settings.bind(enabledKey, toggle, 'active', Gio.SettingsBindFlags.DEFAULT);
                row.add_suffix(toggle);
            }

            row.add_suffix(addCssClasses(new Gtk.Image({
                icon_name: 'go-next-symbolic',
                valign: Gtk.Align.CENTER,
            }), 'katab-prefs-tool-chevron'));

            row.connect('activated', () => {
                window.push_subpage(navPage);
            });

            addPreferenceRow(group, row);
            return row;
        };

        // ----- Document tool detail subpage -----
        const documentSubpage = createToolSubpage('Document Tool');
        {
            const detailPage = documentSubpage.detailPage;

            const documentToolGroup = createPreferencesGroup({
                title: 'Document Tool',
                description: 'Optional local file support for chat. Documents are parsed locally, and images can be sent to Ollama vision models.',
            });
            detailPage.add(documentToolGroup);

            createBooleanRow(
                'Enable Document Tool',
                'Show the chat attachment button and enable the /doc command for local files.',
                'document-tool-enabled',
                documentToolGroup
            );

            const documentUsageRow = createInfoRow('How it works', '', documentToolGroup);
            const syncDocumentUsageRow = () => {
                documentUsageRow.subtitle = settings.get_boolean('document-tool-enabled')
                    ? 'Use the attachment button in chat or type /doc with a quoted path. Katab extracts text from supported documents locally, and sends PNG/JPG images only to Ollama vision models.'
                    : 'Turn this on only if you want local file parsing. Normal chat does not depend on this tool.';
            };
            settings.connect('changed::document-tool-enabled', syncDocumentUsageRow);
            syncDocumentUsageRow();

            const capabilityGroup = createPreferencesGroup({
                title: 'Detected Capabilities',
                description: 'Katab scans the local system at runtime. PNG and JPG support is built in; PDF parsing needs poppler-utils; DOCX conversion needs pandoc.',
            });
            detailPage.add(capabilityGroup);

            const textStatusRow = createStatusRow(
                'Text and Markdown',
                'Plain text and Markdown are handled directly through native Gio file reads.',
                capabilityGroup
            );
            const imageStatusRow = createStatusRow(
                'Images (PNG/JPG)',
                'PNG and JPG attachments are base64-encoded locally and sent only to Ollama vision-capable models.',
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
                setStatusBadge(imageStatusRow.badge, 'Built in', 'katab-prefs-status-builtin');

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

            refreshDocumentToolStatus();
        }

        // ----- Web search tool detail subpage -----
        const webSearchSubpage = createToolSubpage('Web Search');
        {
            const detailPage = webSearchSubpage.detailPage;

            const noticeGroup = createPreferencesGroup({});
            detailPage.add(noticeGroup);
            const noticeRow = createInfoRow(
                'How web search works per provider',
                'When Unsloth Studio is the active provider, web search, Python, and terminal run on Unsloth\u2019s own servers. This local SearxNG-powered tool applies to the Ollama, OpenAI, Anthropic, and DeepSeek providers.',
                noticeGroup
            );
            noticeRow.add_prefix(addCssClasses(new Gtk.Image({
                icon_name: 'dialog-information-symbolic',
                valign: Gtk.Align.CENTER,
            }), 'katab-prefs-tool-icon'));

            const connectionGroup = createPreferencesGroup({
                title: 'Connection',
                description: 'Katab queries your own self-hosted SearxNG instance over its JSON API. No third-party search keys are required.',
            });
            detailPage.add(connectionGroup);

            createBooleanRow(
                'Enable Web Search',
                'Allow the /search command and let supported models look things up on the web.',
                'web-search-enabled',
                connectionGroup
            );

            createStringRow(
                'SearxNG Instance URL',
                'Base URL of your SearxNG instance, e.g. http://localhost:8080.',
                'web-search-url',
                connectionGroup
            );

            const { row: connStatusRow, badge: connBadge } = createStatusRow(
                'Connection Status',
                'Run a test query to confirm the instance is reachable and JSON output is enabled.',
                connectionGroup
            );
            setStatusBadge(connBadge, 'Untested', null);

            const webSearchTestRuntime = new WebSearchRuntime({ timeoutSeconds: 12 });
            createButtonRow(
                'Test Connection',
                'Send a sample query to verify the SearxNG endpoint responds with JSON results.',
                'Test',
                () => {
                    setStatusBadge(connBadge, 'Testing', null);
                    connStatusRow.subtitle = 'Contacting the SearxNG instance\u2026';
                    const config = readWebSearchConfig(settings);
                    webSearchTestRuntime.testConnection(config).then(result => {
                        if (result.ok) {
                            setStatusBadge(connBadge, 'Connected', 'katab-prefs-status-detected');
                            connStatusRow.subtitle = `Reachable. Sample query returned ${result.resultCount} result(s).`;
                        } else {
                            setStatusBadge(connBadge, 'Failed', 'katab-prefs-status-install');
                            connStatusRow.subtitle = result.message;
                        }
                    }).catch(error => {
                        setStatusBadge(connBadge, 'Failed', 'katab-prefs-status-install');
                        connStatusRow.subtitle = error?.message || 'Connection test failed.';
                    });
                },
                connectionGroup
            );

            const behaviorGroup = createPreferencesGroup({
                title: 'Search Behavior',
                description: 'Tune how Katab queries SearxNG and how much content it returns to the model.',
            });
            detailPage.add(behaviorGroup);

            createIntRow(
                'Result Limit',
                'Maximum number of search results passed to the model per query (1\u201320).',
                'web-search-result-limit',
                behaviorGroup,
                1,
                20,
                1
            );

            const timeRangeRow = createChoiceRow(
                'Time Range',
                'Restrict results to a recent time window.',
                behaviorGroup
            );
            bindChoiceRow(
                timeRangeRow,
                'web-search-time-range',
                [
                    { value: '', label: 'Any time' },
                    { value: 'day', label: 'Past day' },
                    { value: 'week', label: 'Past week' },
                    { value: 'month', label: 'Past month' },
                    { value: 'year', label: 'Past year' },
                ],
                settings.get_string.bind(settings),
                settings.set_string.bind(settings)
            );

            const safesearchRow = createChoiceRow(
                'Safe Search',
                'Content filtering level forwarded to SearxNG.',
                behaviorGroup
            );
            bindChoiceRow(
                safesearchRow,
                'web-search-safesearch',
                [
                    { value: 0, label: 'Off' },
                    { value: 1, label: 'Moderate' },
                    { value: 2, label: 'Strict' },
                ],
                settings.get_int.bind(settings),
                settings.set_int.bind(settings),
                value => `Level ${value}`
            );

            const categoriesRow = createChoiceRow(
                'Category',
                'Primary SearxNG category to search within.',
                behaviorGroup
            );
            bindChoiceRow(
                categoriesRow,
                'web-search-categories',
                [
                    { value: 'general', label: 'General' },
                    { value: 'news', label: 'News' },
                    { value: 'science', label: 'Science' },
                    { value: 'it', label: 'IT' },
                    { value: 'files', label: 'Files' },
                    { value: 'social media', label: 'Social Media' },
                ],
                settings.get_string.bind(settings),
                settings.set_string.bind(settings)
            );

            const languageRow = createChoiceRow(
                'Language',
                'Preferred result language.',
                behaviorGroup
            );
            bindChoiceRow(
                languageRow,
                'web-search-language',
                [
                    { value: '', label: 'Any language' },
                    { value: 'en', label: 'English' },
                    { value: 'es', label: 'Spanish' },
                    { value: 'fr', label: 'French' },
                    { value: 'de', label: 'German' },
                    { value: 'it', label: 'Italian' },
                    { value: 'pt', label: 'Portuguese' },
                    { value: 'ru', label: 'Russian' },
                    { value: 'zh', label: 'Chinese' },
                    { value: 'ja', label: 'Japanese' },
                ],
                settings.get_string.bind(settings),
                settings.set_string.bind(settings),
                value => `Custom (${value})`
            );

            createStringRow(
                'Preferred Engines',
                'Optional comma-separated SearxNG engine names, e.g. google,bing,duckduckgo. Leave blank for the instance default.',
                'web-search-engines',
                behaviorGroup
            );

            createStringRow(
                'API Key',
                'Optional value sent as the Authorization header if your instance is protected.',
                'web-search-api-key',
                behaviorGroup,
                true
            );

            const advancedGroup = createPreferencesGroup({
                title: 'Advanced',
                description: 'Page reading, multi-query expansion, and autonomous tool use.',
            });
            detailPage.add(advancedGroup);

            createBooleanRow(
                'Read Page Content',
                'Let the model open a result link and extract the readable text of that page (HTML and PDF).',
                'web-search-fetch-page-enabled',
                advancedGroup
            );

            createBooleanRow(
                'Multi-Query Expansion',
                'Generate a few related queries from your prompt and merge the results. Off by default for faster, cheaper searches.',
                'web-search-multiquery-enabled',
                advancedGroup
            );

            createBooleanRow(
                'Autonomous Tool Use',
                'Advertise web search to supported models so they can decide when to look things up. With this off, only the manual /search command runs.',
                'web-search-autonomous-enabled',
                advancedGroup
            );

            createBooleanRow(
                'Allow Local Addresses',
                'Permit fetching localhost and private LAN addresses when reading page content. Leave off unless you fully trust your network.',
                'web-search-allow-local-addresses',
                advancedGroup
            );

            createIntRow(
                'Max Tool Iterations',
                'Rounds of sequential tool calls the model may trigger per message before being forced to answer. Raise if the model needs more search/read steps.',
                'web-search-max-tool-iterations',
                advancedGroup,
                1, 50, 1
            );

            const setupGroup = createPreferencesGroup({
                title: 'SearxNG Setup',
                description: 'Katab does not bundle a search engine. Run your own SearxNG instance and enable its JSON API.',
            });
            detailPage.add(setupGroup);

            createInfoRow(
                'Run SearxNG with Docker',
                'docker run -d --name searxng -p 8080:8080 searxng/searxng',
                setupGroup
            );
            createInfoRow(
                'Enable the JSON API',
                'In settings.yml add "json" to the search.formats list, then restart the container. Without it SearxNG returns HTTP 403 to API calls.',
                setupGroup
            );
        }

        // ----- Web Scraper tool detail subpage (Crawl4AI) -----
        const crawl4aiSubpage = createToolSubpage('Web Scraper');
        {
            const detailPage = crawl4aiSubpage.detailPage;

            const noticeGroup = createPreferencesGroup({});
            detailPage.add(noticeGroup);
            const noticeRow = createInfoRow(
                'How web scraping works',
                'Crawl4AI is a high-performance, LLM-friendly web crawler that renders pages in a real browser (Chromium), executes JavaScript, and extracts clean Markdown. Katab uses it to deep-scrape page content after SearxNG discovers URLs. Deploy your own Crawl4AI v0.9.x Docker container on any machine with sufficient RAM for Chromium.',
                noticeGroup
            );
            noticeRow.add_prefix(addCssClasses(new Gtk.Image({
                icon_name: 'dialog-information-symbolic',
                valign: Gtk.Align.CENTER,
            }), 'katab-prefs-tool-icon'));

            // ---- Connection ----
            const connectionGroup = createPreferencesGroup({
                title: 'Connection',
                description: 'Point Katab at your self-hosted Crawl4AI Docker instance.',
            });
            detailPage.add(connectionGroup);

            createBooleanRow(
                'Enable Web Scraper',
                'Allow the /crawl command and let supported models deep-scrape web pages through Crawl4AI.',
                'crawl4ai-enabled',
                connectionGroup
            );

            createStringRow(
                'Crawl4AI Instance URL',
                'Base URL of your Crawl4AI v0.9.x instance, e.g. http://localhost:11235.',
                'crawl4ai-url',
                connectionGroup
            );

            createStringRow(
                'API Token',
                'JWT Bearer token set via CRAWL4AI_API_TOKEN when deploying the container. Required only when the instance has security enabled.',
                'crawl4ai-api-token',
                connectionGroup,
                true
            );

            const { row: crawlConnStatusRow, badge: crawlConnBadge } = createStatusRow(
                'Connection Status',
                'Run a health check to confirm the instance is reachable.',
                connectionGroup
            );
            setStatusBadge(crawlConnBadge, 'Untested', null);

            const crawlTestRuntime = new Crawl4AIRuntime({ timeoutSeconds: 12 });
            createButtonRow(
                'Test Connection',
                'Send a health check to verify the Crawl4AI endpoint responds.',
                'Test',
                () => {
                    setStatusBadge(crawlConnBadge, 'Testing', null);
                    crawlConnStatusRow.subtitle = 'Contacting the Crawl4AI instance\u2026';
                    const config = readCrawl4AIConfig(settings);
                    crawlTestRuntime.testConnection(config).then(result => {
                        if (result.ok) {
                            setStatusBadge(crawlConnBadge, 'Connected', 'katab-prefs-status-detected');
                            crawlConnStatusRow.subtitle = result.version
                                ? `Reachable. Server: ${result.version}`
                                : 'Reachable.';
                        } else {
                            setStatusBadge(crawlConnBadge, 'Failed', 'katab-prefs-status-install');
                            crawlConnStatusRow.subtitle = result.message || 'Connection test failed.';
                        }
                    }).catch(error => {
                        setStatusBadge(crawlConnBadge, 'Failed', 'katab-prefs-status-install');
                        crawlConnStatusRow.subtitle = error?.message || 'Connection test failed.';
                    });
                },
                connectionGroup
            );

            // ---- Extraction ----
            const extractionGroup = createPreferencesGroup({
                title: 'Extraction',
                description: 'How Crawl4AI filters and formats page content before sending it to the model.',
            });
            detailPage.add(extractionGroup);

            const fitMarkdownRow = createChoiceRow(
                'Content Filter',
                'Algorithm used to strip boilerplate and extract the core page content.',
                extractionGroup
            );
            bindChoiceRow(
                fitMarkdownRow,
                'crawl4ai-fit-markdown-mode',
                [
                    { value: 'pruning', label: 'Pruning (Heuristic)' },
                    { value: 'bm25', label: 'BM25 (Query-Focused)' },
                ],
                settings.get_string.bind(settings),
                settings.set_string.bind(settings)
            );

            const cacheRow = createChoiceRow(
                'Cache Mode',
                'Controls Crawl4AI\u2019s internal cache behavior.',
                extractionGroup
            );
            bindChoiceRow(
                cacheRow,
                'crawl4ai-cache-mode',
                [
                    { value: 'bypass', label: 'Bypass (Always Fresh)' },
                    { value: 'enabled', label: 'Enabled (Faster Repeats)' },
                    { value: 'read_only', label: 'Read-Only (No Network)' },
                ],
                settings.get_string.bind(settings),
                settings.set_string.bind(settings)
            );

            createIntRow(
                'Minimum Word Count',
                'Pages with fewer words are discarded before Markdown generation (1\u2013200).',
                'crawl4ai-word-count-threshold',
                extractionGroup,
                1,
                200,
                1
            );

            createIntRow(
                'Page Timeout',
                'Maximum seconds to wait for a page to render before giving up (10\u2013300).',
                'crawl4ai-page-timeout',
                extractionGroup,
                10,
                300,
                5
            );

            createIntRow(
                'Maximum Output Characters',
                'Truncation cap on extracted Markdown fed to the model context (500\u2013100000).',
                'crawl4ai-max-chars',
                extractionGroup,
                500,
                100000,
                500
            );

            // ---- Advanced ----
            const advancedGroup = createPreferencesGroup({
                title: 'Advanced',
                description: 'Anti-bot stealth, autonomous model use, and network address restrictions.',
            });
            detailPage.add(advancedGroup);

            createBooleanRow(
                'Stealth Mode',
                'Mimic human mouse movements, scrolls, and timing to reduce CAPTCHA and bot-detection challenges. Slower but more reliable for protected sites.',
                'crawl4ai-simulate-user',
                advancedGroup
            );

            createBooleanRow(
                'Autonomous Tool Use',
                'Advertise the crawl_url tool to supported models so they can decide when to deep-scrape a page. With this off, only the manual /crawl command runs.',
                'crawl4ai-autonomous-enabled',
                advancedGroup
            );

            createBooleanRow(
                'Allow Local Addresses',
                'Permit scraping of private, loopback, and link-local addresses. Leave off unless you fully trust your network.',
                'crawl4ai-allow-local-addresses',
                advancedGroup
            );

            createIntRow(
                'Async Polling Interval',
                'Milliseconds between status checks when using async crawl jobs (500\u201310000).',
                'crawl4ai-job-poll-ms',
                advancedGroup,
                500,
                10000,
                500
            );

            // ---- Setup ----
            const setupGroup = createPreferencesGroup({
                title: 'Crawl4AI Setup',
                description: 'Katab does not bundle a web scraper. Deploy Crawl4AI with Docker on any machine with at least 2 GB RAM for Chromium.',
            });
            detailPage.add(setupGroup);

            createInfoRow(
                'Run Crawl4AI with Docker',
                'docker run -d --name crawl4ai -p 11235:11235 \\\n  -e CRAWL4AI_API_TOKEN=your-secret-token \\\n  --shm-size=1g unclecode/crawl4ai:0.9.0',
                setupGroup
            );

            createInfoRow(
                'Security Note',
                'Katab connects to Crawl4AI over HTTP by default. For remote deployments, place a reverse proxy (nginx / Caddy) with TLS in front, or use a VPN tunnel.',
                setupGroup
            );
        }

        // Tool index rows (order defines display order on the Tools page).
        createToolIndexRow(toolsIndexGroup, {
            title: 'Document Tool',
            subtitle: 'Attach and parse local files, and send images to Ollama vision models.',
            iconName: 'text-x-generic-symbolic',
            enabledKey: 'document-tool-enabled',
            navPage: documentSubpage.navPage,
        });

        createToolIndexRow(toolsIndexGroup, {
            title: 'Web Search',
            subtitle: 'Look things up on the web through your self-hosted SearxNG instance.',
            iconName: 'system-search-symbolic',
            enabledKey: 'web-search-enabled',
            navPage: webSearchSubpage.navPage,
        });

        createToolIndexRow(toolsIndexGroup, {
            title: 'Web Scraper',
            subtitle: 'Deep-scrape web pages into clean Markdown through your self-hosted Crawl4AI instance.',
            iconName: 'document-open-symbolic',
            enabledKey: 'crawl4ai-enabled',
            navPage: crawl4aiSubpage.navPage,
        });
    }

    async _refreshDeepSeekBalance(settings, onDone) {
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
            session.timeout = 8;  // seconds, same as health monitor probe

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
}
