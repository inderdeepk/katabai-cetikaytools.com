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
import {
    getPetDefinition,
    parsePetForm,
    PET_SELECTION_MODES,
} from './petCollection.js';

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

        const petCompanionGroup = createPreferencesGroup({
            title: 'Pet Companion',
            description: 'Choose whether the visible companion follows the active provider or stays pinned to a form selected in the Pet Collection.',
        });
        page.add(petCompanionGroup);

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

        const createInstructionRow = (title, text, group) => {
            const body = new Gtk.Box({
                orientation: Gtk.Orientation.VERTICAL,
                spacing: 6,
                margin_top: 10,
                margin_bottom: 10,
                margin_start: 12,
                margin_end: 12,
            });

            const titleLabel = new Gtk.Label({
                label: title,
                xalign: 0,
                halign: Gtk.Align.START,
            });
            titleLabel.add_css_class('katab-prefs-instruction-title');

            const bodyLabel = new Gtk.Label({
                label: text,
                selectable: true,
                wrap: true,
                xalign: 0,
                halign: Gtk.Align.START,
            });
            bodyLabel.add_css_class('katab-prefs-instruction-body');

            body.append(titleLabel);
            body.append(bodyLabel);

            const row = stylePreferenceRow(new Adw.PreferencesRow({
                child: body,
                activatable: false,
            }), 'katab-prefs-instruction-row');

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
            'Show in-chat messages for pet hatches, growth stages, crossbreed unlocks, and Mixie milestones.',
            'token-usage-celebrations-enabled',
            tokenUsageGroup
        );

        const petSelectionRow = createChoiceRow(
            'Active Companion',
            'Follow the provider selected for chat, or keep showing the form chosen from Token Breakdown → View Collection.',
            petCompanionGroup
        );
        bindChoiceRow(
            petSelectionRow,
            'pet-selection-mode',
            [
                { label: 'Follow Current Provider', value: PET_SELECTION_MODES.FOLLOW_PROVIDER },
                { label: 'Pinned', value: PET_SELECTION_MODES.PINNED },
            ],
            settings.get_string.bind(settings),
            settings.set_string.bind(settings),
            value => `Custom (${value})`
        );

        const { badge: activePetBadge } = createStatusRow(
            'Current Form',
            'Pinned forms are selected from the Pet Collection inside the Token Breakdown panel.',
            petCompanionGroup
        );
        const refreshActivePetBadge = () => {
            try {
                const currentProvider = settings.get_string('provider');
                const selectionMode = settings.get_string('pet-selection-mode');
                const pinnedForm = settings.get_string('pet-pinned-form');
                const companion = TokenUsageManager.getActiveCompanion({
                    currentProvider,
                    selectionMode,
                    pinnedForm,
                });
                const parsedPinned = parsePetForm(pinnedForm);
                const isValidPin = selectionMode === PET_SELECTION_MODES.PINNED
                    && parsedPinned
                    && companion.id === pinnedForm;
                if (selectionMode === PET_SELECTION_MODES.PINNED && !isValidPin) {
                    settings.set_string('pet-selection-mode', PET_SELECTION_MODES.FOLLOW_PROVIDER);
                    return;
                }
                const label = isValidPin
                    ? companion.name
                    : `${getPetDefinition(currentProvider)?.name || companion.name} · Following`;
                setStatusBadge(activePetBadge, label, 'katab-prefs-status-detected');
            } catch (_e) {
                setStatusBadge(activePetBadge, 'Unavailable', 'katab-prefs-status-install');
            }
        };
        refreshActivePetBadge();
        settings.connect('changed::provider', refreshActivePetBadge);
        settings.connect('changed::pet-selection-mode', refreshActivePetBadge);
        settings.connect('changed::pet-pinned-form', refreshActivePetBadge);

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
            'Delete local token analytics, all pet XP, crossbreed unlocks, and Mixie progress. Chat history is not affected.',
            'Reset',
            () => {
                TokenUsageManager.reset();
                settings.set_string('pet-pinned-form', '');
                settings.set_string('pet-selection-mode', PET_SELECTION_MODES.FOLLOW_PROVIDER);
                refreshTokenUsageBadge();
                refreshActivePetBadge();
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

        // --- DeepSeek Image Support (Vision Model) ---
        // DeepSeek V4 models are text-only. When images are attached while
        // DeepSeek is the active provider, Katab routes them through a
        // separately-configured vision model (local Ollama or any
        // OpenAI-compatible endpoint).
        const deepseekVisionGroup = createPreferencesGroup({
            title: 'Image Support (Vision Model)',
            description: 'DeepSeek V4 models cannot see images. When you attach an image while DeepSeek is active, Katab analyzes it with the vision model below, then passes the analysis to DeepSeek which writes the reply. DeepSeek text models (flash/pro) cannot be used here.',
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
            deepseekVisionGroup
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
            deepseekVisionGroup
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
            'Pick Model\u2026',
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
                    btn.set_label('Loading\u2026');
                    btn.sensitive = false;
                }
                session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (s, result) => {
                    if (btn) {
                        btn.set_label('Pick Model\u2026');
                        btn.sensitive = true;
                    }
                    let models = [];
                    try {
                        const bytes = s.send_and_read_finish(result);
                        const body = JSON.parse(new TextDecoder('utf-8').decode(bytes.get_data() || new Uint8Array()));
                        models = Array.isArray(body?.models) ? body.models.map(m => m.name).filter(Boolean) : [];
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
                            secondary_text: 'Could not list models from the Ollama instance. Is it running and reachable at the configured URL?',
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
                            const selectedName = (typeof selectedStr === 'object' && selectedStr !== null) ? selectedStr.string : selectedStr;
                            if (selectedName && settings.get_string('deepseek-vision-model') !== selectedName) {
                                settings.set_string('deepseek-vision-model', selectedName);
                            }
                        }
                        dlg.destroy();
                    });
                    dialog.present();
                });
            },
            deepseekVisionGroup
        );

        // Vision model name (shared by both backends).
        const visionModelRow = createStringRow(
            'Vision Model',
            'A vision-capable model. For Ollama: llama3.2-vision, qwen2.5vl, llava, janus-pro, deepseek-vl2, minicpm-v. For OpenAI-compatible: any vision model. DeepSeek text models are rejected.',
            'deepseek-vision-model',
            deepseekVisionGroup
        );

        // Optional fallback model (same backend).
        const visionFallbackRow = createStringRow(
            'Vision Fallback Model',
            'Optional. Tried if the primary vision model is unavailable or times out. Uses the same backend.',
            'deepseek-vision-fallback-model',
            deepseekVisionGroup
        );

        // DeepSeek text-model guard notice.
        const visionGuardRow = createInstructionRow(
            'DeepSeek text models cannot see images',
            'The Vision Model is set to a DeepSeek V4 model, which cannot analyze images. Choose a vision-capable model instead.',
            deepseekVisionGroup
        );

        // OpenAI-compatible: URL + API key (only when backend=openai).
        const visionUrlRow = createStringRow(
            'Vision Base URL',
            'OpenAI-compatible endpoint root. Leave empty to fall back to the DeepSeek base URL (useful behind a compatible proxy).',
            'deepseek-vision-url',
            deepseekVisionGroup
        );
        const visionKeyRow = createStringRow(
            'Vision API Key',
            'Optional bearer token for the vision endpoint.',
            'deepseek-vision-api-key',
            deepseekVisionGroup,
            true
        );

        // Visibility: only show the rows relevant to the selected backend.
        const syncVisionVisibility = () => {
            const backend = settings.get_string('deepseek-vision-backend') || '';
            const enabled = backend !== '';
            const model = settings.get_string('deepseek-vision-model') || '';
            visionModelRow.visible = enabled;
            visionFallbackRow.visible = enabled;
            visionGuardRow.visible = enabled && model.toLowerCase().startsWith('deepseek-');
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
        const createToolIndexRow = (group, { title, subtitle, iconName, enabledKey, navPage, gicon }) => {
            const row = stylePreferenceRow(new Adw.ActionRow({
                title,
                subtitle,
                activatable: true,
            }), 'katab-prefs-tool-row');

            const iconImage = new Gtk.Image({
                valign: Gtk.Align.CENTER,
            });
            if (gicon) {
                iconImage.gicon = gicon;
            } else {
                iconImage.icon_name = iconName;
            }
            row.add_prefix(addCssClasses(iconImage, 'katab-prefs-tool-icon'));

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

            createInstructionRow(
                'Run SearxNG with Docker',
                'docker run -d --name searxng -p 8080:8080 searxng/searxng',
                setupGroup
            );
            createInstructionRow(
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

            createInstructionRow(
                'Run Crawl4AI with Docker',
                'docker run -d --name crawl4ai -p 11235:11235 \\\n  -e CRAWL4AI_API_TOKEN=your-secret-token \\\n  --shm-size=1g unclecode/crawl4ai:0.9.0',
                setupGroup
            );

            createInstructionRow(
                'Security Note',
                'Katab connects to Crawl4AI over HTTP by default. For remote deployments, place a reverse proxy (nginx / Caddy) with TLS in front, or use a VPN tunnel.',
                setupGroup
            );
        }

        // ── Knowledge Base (Local RAG) ───────────────────────────────────────
        const ragSubpage = createToolSubpage('Knowledge Base');
        {
            const detailPage = ragSubpage.detailPage;

            const noticeGroup = createPreferencesGroup({});
            detailPage.add(noticeGroup);
            const noticeRow = createInfoRow(
                'How the Knowledge Base works',
                'Your documents, conversations, and research results are chunked, embedded with Ollama\u2019s nomic-embed-text model, and stored in a local ChromaDB vector database. When you ask a question, Katab finds the most semantically similar chunks and feeds them as context. Everything runs locally \u2014 no data leaves your machine.\n\nPhase 3 adds hybrid BM25 keyword matching, cross-encoder reranking (bge-reranker-v2-m3), and automatic web search fallback when knowledge base results are low-quality. See the Setup section below for installation instructions.',
                noticeGroup
            );
            noticeRow.add_prefix(addCssClasses(new Gtk.Image({
                gicon: Gio.icon_new_for_string(`${extensionPath}/icons/katab-knowledge-symbolic.svg`),
                valign: Gtk.Align.CENTER,
            }), 'katab-prefs-tool-icon'));

            // ---- Setup (collapsible) ----
            const setupExpander = createExpanderRow({});
            setupExpander.add_prefix(addCssClasses(new Gtk.Label({
                label: 'Setup \u2014 Install & Run the RAG Service',
                xalign: 0,
                halign: Gtk.Align.START,
            }), 'katab-prefs-expander-title'));
            setupExpander.subtitle = 'The Python service must be running for the Knowledge Base to work.';
            noticeGroup.add(setupExpander);

            createInstructionRow('Installation', [
                '1. Create a virtual environment for the RAG service',
                '',
                '   cd ~/.local/share/katabai/rag-service',
                '   python3 -m venv .venv',
                '',
                '2. Install the Python dependencies inside the venv',
                '',
                '   .venv/bin/pip install chromadb ollama fastapi "uvicorn[standard]" rank-bm25',
                '',
                '   Or use the bundled requirements file:',
                '',
                '   .venv/bin/pip install -r requirements.txt',
                '',
                '   The rank-bm25 package enables hybrid keyword+semantic search',
                '   (optional but recommended — the service works without it).',
                '',
                '3. Pull the Ollama embedding model on your Ollama host',
                '   (Auto-pulled on first use if skipped)',
                '',
                '   ollama pull nomic-embed-text',
                '',
                '4. (Optional) Pull the reranker model for improved precision',
                '   Only needed if you enable Cross-Encoder Reranking in Advanced Retrieval.',
                '   Adds ~200ms per search. Skip this step if you don\'t need reranking.',
                '',
                '   ollama pull bge-reranker-v2-m3',
            ].join('\n'), setupExpander);

            createInstructionRow('Running the Service', [
                '5. Start the RAG service from a terminal',
                '',
                '   cd ~/.local/share/katabai/rag-service',
                '   .venv/bin/python3 server.py',
                '',
                '   Once started you will see:',
                '',
                '   Service URL:  http://127.0.0.1:11435',
                '   Data stored:  ~/.local/share/katabai/chroma/',
                '',
                '   At startup the service rebuilds BM25 keyword indices from',
                '   existing ChromaDB data and checks for the reranker model.',
                '   Keep this terminal open to keep the service alive.',
                '   Press Ctrl+C to stop it when done.',
            ].join('\n'), setupExpander);

            createInstructionRow('Auto-Start with systemd (Recommended)', [
                '6. Create a user systemd service so the RAG backend',
                '   starts automatically on login.',
                '',
                '   a) Create the service file:',
                '',
                '      mkdir -p ~/.config/systemd/user',
                '      nano ~/.config/systemd/user/katabai-rag.service',
                '',
                '   b) Paste this content into the file:',
                '',
                '[Unit]',
                'Description=Katabai RAG Service',
                'After=network.target',
                '',
                '[Service]',
                'Type=simple',
                'ExecStart=%h/.local/share/katabai/rag-service/.venv/bin/python3 %h/.local/share/katabai/rag-service/server.py',
                'WorkingDirectory=%h/.local/share/katabai/rag-service',
                'Restart=on-failure',
                'RestartSec=5',
                '',
                '[Install]',
                'WantedBy=default.target',
                '',
                '   c) Enable and start the service:',
                '',
                '      systemctl --user daemon-reload',
                '      systemctl --user enable katabai-rag.service',
                '      systemctl --user start katabai-rag.service',
                '',
                '   d) Verify everything is working:',
                '',
                '      systemctl --user status katabai-rag.service',
                '      curl http://127.0.0.1:11435/health',
                '',
                '   If curl returns {"status":"ok"} the service is ready.',
                '   If it fails, run the command below to see error details:',
                '',
                '      journalctl --user -u katabai-rag.service --no-pager -n 30',
            ].join('\n'), setupExpander);

            // ---- Connection ----
            const connectionGroup = createPreferencesGroup({
                title: 'Connection',
                description: 'Point Katab at your local RAG Python service.',
            });
            detailPage.add(connectionGroup);

            createBooleanRow(
                'Enable Knowledge Base',
                'Allow the /kb command, Knowledge footer button, and autonomous knowledge searching by supported models.',
                'rag-enabled',
                connectionGroup
            );

            createBooleanRow(
                'Enable Memory',
                'Master switch for automatic indexing. When enabled, Katab indexes documents, conversations, and research results (respecting the per-type toggles below). When disabled, no new content is indexed but existing knowledge remains searchable.',
                'rag-memory-enabled',
                connectionGroup
            );

            createStringRow(
                'RAG Service URL',
                'Base URL of your local Katabai RAG service, e.g. http://localhost:11435.',
                'rag-service-url',
                connectionGroup
            );

            createStringRow(
                'Ollama URL for Embeddings',
                'The Ollama instance used for generating text embeddings. Can be remote (e.g. http://192.168.1.100:11434) if Ollama runs on a separate AI PC.',
                'rag-ollama-url',
                connectionGroup
            );

            createStringRow(
                'Embedding Model',
                'Ollama model used for generating text embeddings. Must be pulled first with: ollama pull nomic-embed-text.',
                'rag-embedding-model',
                connectionGroup
            );

            const { row: ragConnStatusRow, badge: ragConnBadge } = createStatusRow(
                'Connection Status',
                'Run a health check to confirm the RAG service is reachable.',
                connectionGroup
            );
            setStatusBadge(ragConnBadge, 'Untested', null);

            const testButton = createButtonRow(
                'Test Connection',
                'Send a health check to verify the RAG service responds.',
                'Test',
                () => {
                    setStatusBadge(ragConnBadge, 'Testing', null);
                    ragConnStatusRow.subtitle = 'Contacting the RAG service\u2026';

                    const config = {
                        serviceUrl: settings.get_string('rag-service-url'),
                    };

                    // Simple HTTP GET health check via Soup
                    try {
                        const session = new Soup.Session();
                        session.timeout = 8;
                        const url = `${config.serviceUrl.replace(/\/+$/, '')}/health`;
                        const message = Soup.Message.new('GET', url);
                        message.request_headers.append('Accept', 'application/json');

                        session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (s, result) => {
                            try {
                                const bytes = s.send_and_read_finish(result);
                                const decoder = new TextDecoder('utf-8');
                                const body = JSON.parse(decoder.decode(bytes.get_data() || new Uint8Array()));
                                if (body?.ok) {
                                    const colCount = Object.keys(body.collections || {}).length;
                                    const limits = body?.limits || {};
                                    const rerankerOk = limits.reranker_available ? ' reranker✓' : '';
                                    const bm25Ok = limits.bm25_available ? ' BM25✓' : '';
                                    const features = `${rerankerOk}${bm25Ok}`.trim();
                                    setStatusBadge(ragConnBadge, 'Connected', 'katab-prefs-status-detected');
                                    ragConnStatusRow.subtitle = body.version
                                        ? `Reachable. v${body.version}, ${colCount} collection${colCount !== 1 ? 's' : ''}.${features ? ` Features: ${features}` : ''}`
                                        : `Reachable.${features ? ` Features: ${features}` : ''}`;
                                } else {
                                    setStatusBadge(ragConnBadge, 'Failed', 'katab-prefs-status-install');
                                    ragConnStatusRow.subtitle = 'Service returned an error.';
                                }
                            } catch (e) {
                                setStatusBadge(ragConnBadge, 'Failed', 'katab-prefs-status-install');
                                ragConnStatusRow.subtitle = e?.message || 'Connection test failed.';
                            }
                        });
                    } catch (e) {
                        setStatusBadge(ragConnBadge, 'Failed', 'katab-prefs-status-install');
                        ragConnStatusRow.subtitle = e?.message || 'Connection test failed.';
                    }
                },
                connectionGroup
            );

            // ---- Indexing ----
            const indexingGroup = createPreferencesGroup({
                title: 'Indexing',
                description: 'Control how text is chunked and what gets indexed.',
            });
            detailPage.add(indexingGroup);

            createIntRow(
                'Chunk Size',
                'Characters per text chunk. Larger chunks preserve context but reduce precision. (200–4000)',
                'rag-chunk-size',
                indexingGroup,
                200, 4000, 50
            );

            createIntRow(
                'Chunk Overlap',
                'Character overlap between chunks. Prevents information loss at boundaries. (0–500)',
                'rag-chunk-overlap',
                indexingGroup,
                0, 500, 10
            );

            createIntRow(
                'Result Count',
                'Number of top results to retrieve per query. (1–20)',
                'rag-top-k',
                indexingGroup,
                1, 20, 1
            );

            // ---- Storage Limits ----
            const limitsGroup = createPreferencesGroup({
                title: 'Storage Limits',
                description: 'Prevent the knowledge base from growing beyond your disk budget. Set to 0 to disable a cap.',
            });
            detailPage.add(limitsGroup);

            createIntRow(
                'Max Chunks Per Collection',
                'Hard cap on chunks in any single collection. 0 = unlimited. (0–100000)',
                'rag-max-chunks-per-collection',
                limitsGroup,
                0, 100000, 1000
            );

            createIntRow(
                'Max Total Storage (MB)',
                'Estimated maximum disk usage for the ChromaDB directory. 0 = unlimited. (0–10000)',
                'rag-max-total-size-mb',
                limitsGroup,
                0, 10000, 50
            );

            createBooleanRow(
                'Auto-Prune Oldest Chunks',
                'When a collection hits its size cap, automatically remove the oldest chunks to make room. When disabled, new indexing is rejected at the cap.',
                'rag-auto-prune',
                limitsGroup
            );

            createBooleanRow(
                'Index Document Attachments',
                'Automatically add attached documents (txt, md, pdf, docx) to the knowledge base.',
                'rag-index-documents',
                indexingGroup
            );

            createBooleanRow(
                'Index Conversations',
                'Automatically add past conversation turns to the knowledge base for cross-session retrieval.',
                'rag-index-conversations',
                indexingGroup
            );

            createBooleanRow(
                'Index Research Cache',
                'Automatically add web search and scraping results to the knowledge base.',
                'rag-index-research-cache',
                indexingGroup
            );

            // ---- Autonomous ----
            const autonomousGroup = createPreferencesGroup({
                title: 'Autonomous Tool Use',
                description: 'Let supported models call knowledge_search on their own when they think it would help.',
            });
            detailPage.add(autonomousGroup);

            createBooleanRow(
                'Allow Model-Triggered Knowledge Search',
                'Advertise the knowledge_search tool to capable models. When disabled, only the manual /kb command works.',
                'rag-autonomous-enabled',
                autonomousGroup
            );

            createBooleanRow(
                'Auto-Update Knowledge Base',
                'When enabled, the model can update the knowledge base without asking for confirmation each time. When disabled, you\'ll be asked to confirm each update.',
                'rag-auto-update-enabled',
                autonomousGroup
            );

            // ---- Advanced Retrieval (Phase 3) ----
            const advancedGroup = createPreferencesGroup({
                title: 'Advanced Retrieval',
                description: 'Fine-tune how the knowledge base finds and ranks results. These features require additional models and add latency, but significantly improve result quality.',
            });
            detailPage.add(advancedGroup);

            // -- Coverage Fallback --
            createBooleanRow(
                'Auto-Fallback to Web Search',
                'When knowledge base results are low-quality, automatically trigger a web search as a supplement. This is the reverse direction of the existing suppression for high-confidence KB results.',
                'rag-fallback-enabled',
                advancedGroup
            );

            const fallbackThresholds = [
                [0.35, 'Strict (only fallback when KB is very poor)'],
                [0.60, 'Moderate (recommended)'],
                [0.80, 'Aggressive (fallback frequently)'],
            ];
            const { row: fallbackThreshRow } = createDoubleRow(
                'Fallback Threshold',
                'Minimum best-result score (0.0–1.0) before auto-triggering web search.',
                'rag-fallback-threshold',
                advancedGroup,
                0.0, 1.0, 0.05, 2
            );

            // Update the threshold subtitle based on current value
            const updateFallbackSubtitle = () => {
                try {
                    const val = settings.get_double('rag-fallback-threshold');
                    let desc = '';
                    for (const [threshold, label] of fallbackThresholds) {
                        if (val < threshold) { desc = label; break; }
                    }
                    if (!desc) desc = fallbackThresholds[fallbackThresholds.length - 1][1];
                    fallbackThreshRow.subtitle = `Current: ${val.toFixed(2)} — ${desc}`;
                } catch (_) { /* settings may not be ready */ }
            };
            updateFallbackSubtitle();
            settings.connect('changed::rag-fallback-threshold', updateFallbackSubtitle);

            // -- Reranking --
            createBooleanRow(
                'Cross-Encoder Reranking',
                'Apply a cross-encoder model (bge-reranker-v2-m3 via Ollama) to re-rank top candidate chunks for improved precision. Requires ollama pull bge-reranker-v2-m3. Adds ~200ms latency per search.',
                'rag-rerank-enabled',
                advancedGroup
            );

            createStringRow(
                'Reranker Model',
                'Ollama model used for cross-encoder reranking. Must be pulled first.',
                'rag-rerank-model',
                advancedGroup
            );

            createIntRow(
                'Candidate Pool Multiplier',
                'How many times more candidates to fetch before reranking (rerank_k = k × this). Higher values improve recall at the cost of latency. (1–10)',
                'rag-rerank-candidate-multiplier',
                advancedGroup,
                1, 10, 1
            );

            // -- Hybrid BM25 --
            createBooleanRow(
                'Hybrid BM25 + Dense Retrieval',
                'Combine keyword matching (BM25) with semantic search (dense embeddings) for better recall. Enabled by default — the service falls back to dense-only if rank-bm25 is not installed.',
                'rag-hybrid-enabled',
                advancedGroup
            );

            // ---- Maintenance ----
            const maintenanceGroup = createPreferencesGroup({
                title: 'Maintenance',
                description: 'Export, rebuild, or clear the knowledge base.',
            });
            detailPage.add(maintenanceGroup);

            // Usage summary — refreshed when the page opens or on demand
            const { row: ragUsageRow, badge: ragUsageBadge } = createStatusRow(
                'Current Usage',
                'Click "Refresh" to check usage against your storage limits.',
                maintenanceGroup
            );
            setStatusBadge(ragUsageBadge, 'Unknown', null);

            const refreshUsage = () => {
                setStatusBadge(ragUsageBadge, 'Checking', null);
                ragUsageRow.subtitle = 'Querying the RAG service\u2026';

                const url = `${settings.get_string('rag-service-url').replace(/\/+$/, '')}/health`;
                try {
                    const session = new Soup.Session();
                    session.timeout = 8;
                    const message = Soup.Message.new('GET', url);
                    message.request_headers.append('Accept', 'application/json');

                    session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (s, result) => {
                        try {
                            const bytes = s.send_and_read_finish(result);
                            const decoder = new TextDecoder('utf-8');
                            const body = JSON.parse(decoder.decode(bytes.get_data() || new Uint8Array()));
                            const limits = body?.limits || {};
                            const totalChunks = limits.total_chunks || 0;
                            const estMb = limits.estimated_size_mb || 0;
                            const maxChunks = limits.max_chunks_per_collection || 0;
                            const maxMb = limits.max_total_size_mb || 0;

                            let pctText = '';
                            if (maxMb > 0 && estMb > 0) {
                                const pct = Math.round((estMb / maxMb) * 100);
                                pctText = ` (${pct}% of cap)`;
                            }

                            const colNames = Object.keys(body?.collections || {}).join(', ') || '(none)';

                            // Phase 3: feature availability
                            const rerankerOk = limits.reranker_available ? '✓rerank' : '';
                            const bm25Info = limits.bm25_collections > 0 ? `✓bm25(${limits.bm25_collections})` : '';
                            const features = [rerankerOk, bm25Info].filter(Boolean).join(' ');
                            const featureStr = features ? ` [${features}]` : '';

                            if (totalChunks === 0) {
                                setStatusBadge(ragUsageBadge, 'Empty', null);
                                ragUsageRow.subtitle = `Knowledge base is empty.${featureStr}`;
                            } else if (maxMb > 0 && estMb >= maxMb * 0.9) {
                                setStatusBadge(ragUsageBadge, 'Near Limit', 'katab-prefs-status-install');
                                ragUsageRow.subtitle = `${totalChunks} chunks, ~${estMb.toFixed(0)} MB${pctText} — ${colNames}${featureStr}`;
                            } else {
                                setStatusBadge(ragUsageBadge, 'Healthy', 'katab-prefs-status-detected');
                                ragUsageRow.subtitle = `${totalChunks} chunks, ~${estMb.toFixed(0)} MB${pctText} — ${colNames}${featureStr}`;
                            }
                        } catch (e) {
                            setStatusBadge(ragUsageBadge, 'Unavailable', 'katab-prefs-status-install');
                            ragUsageRow.subtitle = 'Cannot reach RAG service.';
                        }
                    });
                } catch (e) {
                    setStatusBadge(ragUsageBadge, 'Unavailable', 'katab-prefs-status-install');
                    ragUsageRow.subtitle = 'Cannot reach RAG service.';
                }
            };

            createButtonRow(
                'Refresh Usage',
                'Query the RAG service for current chunk counts and estimated disk usage.',
                'Refresh',
                refreshUsage,
                maintenanceGroup
            );

            // Auto-refresh on first open
            GLib.idle_add(GLib.PRIORITY_LOW, () => {
                if (settings.get_boolean('rag-enabled')) refreshUsage();
                return GLib.SOURCE_REMOVE;
            });

            // Status row shared by Clear and Export operations
            const { row: ragMaintStatusRow, badge: ragMaintBadge } = createStatusRow(
                'Operation Status',
                'Idle.',
                maintenanceGroup
            );
            setStatusBadge(ragMaintBadge, 'Idle', null);

            createButtonRow(
                'Export Knowledge Base',
                'Download all indexed data as a JSON file for backup or inspection.',
                'Export',
                () => {
                    setStatusBadge(ragMaintBadge, 'Running', null);
                    ragMaintStatusRow.subtitle = 'Fetching data from the RAG service\u2026';

                    const url = `${settings.get_string('rag-service-url').replace(/\/+$/, '')}/export`;
                    try {
                        const session = new Soup.Session();
                        session.timeout = 30;
                        const message = Soup.Message.new('GET', url);
                        message.request_headers.append('Accept', 'application/json');

                        session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (s, result) => {
                            try {
                                const bytes = s.send_and_read_finish(result);
                                const decoder = new TextDecoder('utf-8');
                                const body = JSON.parse(decoder.decode(bytes.get_data() || new Uint8Array()));
                                const collections = body?.collections || {};

                                let totalEntries = 0;
                                for (const entries of Object.values(collections)) {
                                    totalEntries += Array.isArray(entries) ? entries.length : 0;
                                }

                                if (totalEntries === 0) {
                                    setStatusBadge(ragMaintBadge, 'Empty', null);
                                    ragMaintStatusRow.subtitle = 'Knowledge base is empty — nothing to export.';
                                    return;
                                }

                                // Save to ~/Documents/katabai-rag-export-<date>.json
                                const now = GLib.DateTime.new_now_local();
                                const dateStr = now ? now.format('%Y-%m-%d') : 'unknown';
                                const filename = `katabai-rag-export-${dateStr}.json`;
                                const docsDir = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOCUMENTS);
                                const filePath = GLib.build_filenamev([docsDir, filename]);

                                const file = Gio.File.new_for_path(filePath);
                                const outStream = file.replace(null, false, Gio.FileCreateFlags.NONE, null);
                                const jsonStr = JSON.stringify(collections, null, 2);
                                outStream.write(jsonStr, null);
                                outStream.close(null);

                                const colNames = Object.keys(collections).join(', ');
                                setStatusBadge(ragMaintBadge, 'Done', 'katab-prefs-status-detected');
                                ragMaintStatusRow.subtitle = `Exported ${totalEntries} entries (${colNames}) to ${filePath}`;
                            } catch (e) {
                                setStatusBadge(ragMaintBadge, 'Failed', 'katab-prefs-status-install');
                                ragMaintStatusRow.subtitle = e?.message || 'Export failed — is the RAG service running?';
                            }
                        });
                    } catch (e) {
                        setStatusBadge(ragMaintBadge, 'Failed', 'katab-prefs-status-install');
                        ragMaintStatusRow.subtitle = e?.message || 'Export failed.';
                    }
                },
                maintenanceGroup
            );

            createButtonRow(
                'Re-index Knowledge Base',
                'Re-scan all documents, conversations, and research cache and rebuild the vector index from scratch.',
                'Re-index',
                () => {
                    const dialog = new Gtk.MessageDialog({
                        transient_for: window,
                        modal: true,
                        message_type: Gtk.MessageType.WARNING,
                        buttons: Gtk.ButtonsType.OK_CANCEL,
                        text: 'Re-index the entire knowledge base?',
                        secondary_text: 'This will clear all existing index state and re-process your documents, conversations, and research cache on the next chat message.',
                    });
                    dialog.connect('response', (dlg, responseId) => {
                        if (responseId === Gtk.ResponseType.OK) {
                            // Delete the sentinel file to force re-indexing
                            const path = GLib.build_filenamev([
                                GLib.get_home_dir(),
                                '.local', 'share', 'katabai', 'rag-index-state.json',
                            ]);
                            try {
                                const file = Gio.File.new_for_path(path);
                                if (file.query_exists(null)) file.delete(null);
                            } catch (_) { /* best effort */ }

                            setStatusBadge(ragMaintBadge, 'Done', 'katab-prefs-status-detected');
                            ragMaintStatusRow.subtitle = 'Index state cleared. Content will be re-indexed on the next chat message.';
                        }
                        dlg.destroy();
                    });
                    dialog.present();
                },
                maintenanceGroup
            );

            createButtonRow(
                'Clear Knowledge Base',
                'Permanently delete ALL indexed data from the vector database. This cannot be undone.',
                'Clear',
                () => {
                    const dialog = new Gtk.MessageDialog({
                        transient_for: window,
                        modal: true,
                        message_type: Gtk.MessageType.WARNING,
                        buttons: Gtk.ButtonsType.OK_CANCEL,
                        text: 'Delete the entire knowledge base?',
                        secondary_text: 'All indexed documents, conversations, and research cache will be permanently removed from the ChromaDB database. This cannot be undone.',
                    });
                    dialog.connect('response', (dlg, responseId) => {
                        if (responseId === Gtk.ResponseType.OK) {
                            setStatusBadge(ragMaintBadge, 'Running', null);
                            ragMaintStatusRow.subtitle = 'Clearing all collections\u2026';

                            const url = `${settings.get_string('rag-service-url').replace(/\/+$/, '')}/clear`;
                            try {
                                const session = new Soup.Session();
                                session.timeout = 15;
                                const message = Soup.Message.new('POST', url);
                                message.request_headers.append('Accept', 'application/json');

                                session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (s, result) => {
                                    try {
                                        const bytes = s.send_and_read_finish(result);
                                        const decoder = new TextDecoder('utf-8');
                                        const body = JSON.parse(decoder.decode(bytes.get_data() || new Uint8Array()));
                                        const dropped = body?.dropped || [];

                                        // Also clear the sentinel file
                                        const sentinelPath = GLib.build_filenamev([
                                            GLib.get_home_dir(),
                                            '.local', 'share', 'katabai', 'rag-index-state.json',
                                        ]);
                                        try {
                                            const f = Gio.File.new_for_path(sentinelPath);
                                            if (f.query_exists(null)) f.delete(null);
                                        } catch (_) { /* best effort */ }

                                        if (dropped.length > 0) {
                                            setStatusBadge(ragMaintBadge, 'Done', 'katab-prefs-status-detected');
                                            ragMaintStatusRow.subtitle = `Cleared ${dropped.length} collection(s): ${dropped.join(', ')}.`;
                                        } else {
                                            setStatusBadge(ragMaintBadge, 'Empty', null);
                                            ragMaintStatusRow.subtitle = 'Knowledge base was already empty.';
                                        }
                                    } catch (e) {
                                        setStatusBadge(ragMaintBadge, 'Failed', 'katab-prefs-status-install');
                                        ragMaintStatusRow.subtitle = e?.message || 'Clear failed — is the RAG service running?';
                                    }
                                });
                            } catch (e) {
                                setStatusBadge(ragMaintBadge, 'Failed', 'katab-prefs-status-install');
                                ragMaintStatusRow.subtitle = e?.message || 'Clear failed.';
                            }
                        }
                        dlg.destroy();
                    });
                    dialog.present();
                },
                maintenanceGroup
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

        createToolIndexRow(toolsIndexGroup, {
            title: 'Knowledge Base',
            subtitle: 'Semantically search across documents, conversations, and research using local RAG.',
            iconName: 'drive-harddisk-symbolic',
            gicon: Gio.icon_new_for_string(`${extensionPath}/icons/katab-knowledge-symbolic.svg`),
            enabledKey: 'rag-enabled',
            navPage: ragSubpage.navPage,
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
