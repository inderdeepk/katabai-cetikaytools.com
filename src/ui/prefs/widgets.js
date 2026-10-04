// Shared GTK4/libadwaita widget factories for the Katab preferences window.
//
// The preferences UI was historically one 4,000+ line method on
// KatabPreferences.  This module hosts the reusable pieces — page/group/row
// factories, status badges, provider cards, choice/string/spin/switch row
// builders, the keyboard-shortcut capture controller, and the tool subpage
// scaffolding — behind a single context factory.
//
// `createPrefsContext({ settings, window, extensionPath })` returns the helpers
// as closures bound to those objects, so call sites keep their existing shape
// (destructure the names, call them exactly as before).  `ctx.watch(key, cb)`
// records a GSettings handler for destruction-time cleanup via `ctx.dispose()`;
// new code should prefer it over raw `settings.connect(...)`.
import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import { PROVIDER_DETAILS } from '../../providers/catalog.js';

export function createPrefsContext({ settings, window, extensionPath }) {
    const providerDetails = PROVIDER_DETAILS;

    const disposers = [];
    const watch = (key, callback) => {
        const id = settings.connect(key, callback);
        disposers.push(() => {
            try {
                settings.disconnect(id);
            } catch (_e) {
                /* already gone */
            }
        });
        return id;
    };
    const dispose = () => {
        for (const fn of disposers) fn();
        disposers.length = 0;
    };

    const addCssClasses = (widget, ...cssClasses) => {
        for (const cssClass of cssClasses) {
            if (cssClass) {
                widget.add_css_class(cssClass);
            }
        }

        return widget;
    };

    const createPreferencesPage = (params) =>
        addCssClasses(new Adw.PreferencesPage(params), 'katab-prefs-page');

    const createPreferencesGroup = (params) =>
        addCssClasses(new Adw.PreferencesGroup(params), 'katab-prefs-group');

    const stylePreferenceRow = (row, ...cssClasses) =>
        addCssClasses(row, 'katab-prefs-row', ...cssClasses);

    const createExpanderRow = (params) =>
        stylePreferenceRow(new Adw.ExpanderRow(params), 'katab-prefs-expander');

    const ollamaSettingTypes = {
        format: 'string',
        'frequency-penalty': 'double',
        'min-p': 'double',
        mirostat: 'int',
        'mirostat-eta': 'double',
        'mirostat-tau': 'double',
        'presence-penalty': 'double',
        raw: 'boolean',
        'repeat-penalty': 'double',
        temperature: 'double',
        'tfs-z': 'double',
        think: 'boolean',
        'top-k': 'int',
        'top-p': 'double',
    };

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

    const syncRowWithSetting = (
        key,
        row,
        property,
        getter,
        setter,
        signal,
        normalize = (value) => value,
    ) => {
        let syncing = false;

        const syncFromSettings = () => {
            const nextValue = getter(key);
            if (row[property] === nextValue) return;

            syncing = true;
            row[property] = nextValue;
            syncing = false;
        };

        syncFromSettings();
        settings.connect(`changed::${key}`, syncFromSettings);

        row.connect(signal, () => {
            if (syncing) return;

            const nextValue = normalize(row[property]);
            if (getter(key) === nextValue) return;

            setter(key, nextValue);
        });

        return row;
    };

    const formatShortcutValue = (shortcuts) => {
        const labels = (shortcuts || [])
            .map((shortcut) => {
                const [, keyval, modifierMask] = Gtk.accelerator_parse(shortcut);
                return Gtk.accelerator_get_label(keyval, modifierMask);
            })
            .filter(Boolean);

        return labels.join(' / ') || 'Disabled';
    };

    const isShortcutKeyvalForbidden = (keyval) => {
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
            shortcutCaptureState.button.set_label(
                formatShortcutValue(settings.get_strv('toggle-current-chat')),
            );
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

        if (
            !isShortcutBindingValid({ mask, keycode, keyval }) ||
            !Gtk.accelerator_valid(keyval, mask)
        ) {
            return Gdk.EVENT_STOP;
        }

        const shortcut = Gtk.accelerator_name_with_keycode(null, keyval, keycode, mask);
        settings.set_strv('toggle-current-chat', [shortcut]);
        stopShortcutCapture();
        return Gdk.EVENT_STOP;
    });

    const getOllamaValue = (suffix) => {
        const type = ollamaSettingTypes[suffix];
        if (!type) throw new Error(`Unknown Ollama setting: ${suffix}`);

        return settings[`get_${type}`](`ollama-${suffix}`);
    };

    const setOllamaValue = (suffix, value) => {
        const type = ollamaSettingTypes[suffix];
        if (!type) throw new Error(`Unknown Ollama setting: ${suffix}`);

        settings[`set_${type}`](`ollama-${suffix}`, value);
    };

    const valuesEqual = (left, right) => {
        if (typeof left === 'number' && typeof right === 'number') {
            return Math.abs(left - right) < 0.000001;
        }

        return left === right;
    };

    const createChoiceRow = (title, subtitle, group) => {
        const row = stylePreferenceRow(
            new Adw.ComboRow({
                title,
                ...(subtitle && { subtitle }),
            }),
            'katab-prefs-choice-row',
        );

        addPreferenceRow(group, row);
        return row;
    };

    const createProviderImage = (provider, pixelSize = 26) => {
        const iconFile = providerDetails[provider]?.iconFile;
        if (!iconFile) {
            return addCssClasses(
                new Gtk.Image({
                    icon_name: 'applications-science-symbolic',
                    pixel_size: pixelSize,
                    valign: Gtk.Align.CENTER,
                }),
                'katab-prefs-provider-image',
            );
        }

        return addCssClasses(
            new Gtk.Image({
                gicon: Gio.icon_new_for_string(`${extensionPath}/icons/${iconFile}`),
                pixel_size: pixelSize,
                valign: Gtk.Align.CENTER,
            }),
            'katab-prefs-provider-image',
        );
    };

    const getProviderThemeIconName = (provider) => {
        const iconFile = providerDetails[provider]?.iconFile;
        if (!iconFile) {
            return 'applications-science-symbolic';
        }

        return iconFile.replace(/\.[^.]+$/, '');
    };

    const createProviderActiveBadge = () => {
        const badge = addCssClasses(
            new Gtk.Box({
                orientation: Gtk.Orientation.HORIZONTAL,
                spacing: 6,
                valign: Gtk.Align.CENTER,
            }),
            'katab-prefs-provider-badge',
        );

        const checkIcon = addCssClasses(
            new Gtk.Image({
                icon_name: 'object-select-symbolic',
                valign: Gtk.Align.CENTER,
            }),
            'katab-prefs-provider-badge-icon',
        );
        const badgeLabel = addCssClasses(
            new Gtk.Label({
                label: 'Active',
                valign: Gtk.Align.CENTER,
            }),
            'katab-prefs-provider-badge-label',
        );
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

    const createStatusBadge = (label = 'Checking') =>
        addCssClasses(
            new Gtk.Label({
                label,
                valign: Gtk.Align.CENTER,
                xalign: 0.5,
            }),
            'katab-prefs-status-badge',
        );

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
        const row = stylePreferenceRow(
            new Adw.ActionRow({
                title,
                ...(subtitle && { subtitle }),
                activatable: false,
            }),
            'katab-prefs-info-row',
        );

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

        const row = stylePreferenceRow(
            new Adw.PreferencesRow({
                child: body,
                activatable: false,
            }),
            'katab-prefs-instruction-row',
        );

        addPreferenceRow(group, row);
        return row;
    };

    const createButtonRow = (title, subtitle, buttonLabel, callback, group) => {
        const button = addCssClasses(
            new Gtk.Button({
                label: buttonLabel,
                valign: Gtk.Align.CENTER,
            }),
            'katab-prefs-button',
        );
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
        const row = stylePreferenceRow(
            new Adw.ActionRow({
                title: detail.label,
                subtitle: subtitle || detail.description,
                activatable: true,
            }),
            'katab-prefs-provider-row',
        );

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

    const bindChoiceRow = (
        row,
        key,
        choices,
        getter,
        setter,
        formatUnknown = (value) => `Custom (${value})`,
    ) => {
        let syncing = false;

        const syncFromSettings = () => {
            const currentValue = getter(key);
            const values = choices.map((choice) => choice.value);
            const labels = choices.map((choice) => choice.label);

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
            if (syncing) return;

            const nextValue = row._choiceValues?.[row.selected];
            if (nextValue === undefined || getter(key) === nextValue) return;

            setter(key, nextValue);
        });

        return row;
    };

    // Helper to create string input rows binding to GSettings
    const createStringRow = (title, subtitle, key, group, isPassword = false) => {
        const row = stylePreferenceRow(
            new Adw.ActionRow({
                title,
                ...(subtitle && { subtitle }),
            }),
            'katab-prefs-input-row',
        );

        const entry = addCssClasses(
            new Gtk.Entry({
                hexpand: true,
                valign: Gtk.Align.CENTER,
                visibility: !isPassword,
                input_purpose: isPassword ? Gtk.InputPurpose.PASSWORD : Gtk.InputPurpose.FREE_FORM,
                width_chars: 24,
            }),
            'katab-prefs-entry',
        );

        row.add_suffix(entry);
        row.activatable_widget = entry;

        addPreferenceRow(group, row);
        syncRowWithSetting(
            key,
            entry,
            'text',
            settings.get_string.bind(settings),
            settings.set_string.bind(settings),
            'notify::text',
        );
        return row;
    };

    const getTextBufferContents = (buffer) => {
        const [startIter, endIter] = buffer.get_bounds();
        return buffer.get_text(startIter, endIter, false);
    };

    const createMultilineStringRow = (title, subtitle, key, group, minHeight = 140) => {
        const row = stylePreferenceRow(
            new Adw.PreferencesRow(),
            'katab-prefs-input-row',
            'katab-prefs-multiline-row',
        );

        const box = addCssClasses(
            new Gtk.Box({
                orientation: Gtk.Orientation.VERTICAL,
                spacing: 10,
                margin_top: 12,
                margin_bottom: 12,
                margin_start: 12,
                margin_end: 12,
                hexpand: true,
            }),
            'katab-prefs-multiline-box',
        );

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
            const subtitleLabel = addCssClasses(
                new Gtk.Label({
                    label: subtitle,
                    xalign: 0,
                    wrap: true,
                    halign: Gtk.Align.START,
                    hexpand: true,
                }),
                'dim-label',
                'caption',
            );
            box.append(subtitleLabel);
        }

        const scroller = addCssClasses(
            new Gtk.ScrolledWindow({
                hexpand: true,
                min_content_height: minHeight,
                propagate_natural_height: true,
                hscrollbar_policy: Gtk.PolicyType.NEVER,
                vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
            }),
            'katab-prefs-textarea',
        );

        const textView = addCssClasses(
            new Gtk.TextView({
                wrap_mode: Gtk.WrapMode.WORD_CHAR,
                accepts_tab: true,
                monospace: false,
                top_margin: 10,
                bottom_margin: 10,
                left_margin: 10,
                right_margin: 10,
                hexpand: true,
                vexpand: true,
            }),
            'katab-prefs-textview',
        );
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
        const row = stylePreferenceRow(
            new Adw.SpinRow({
                title,
                ...(subtitle && { subtitle }),
                adjustment: new Gtk.Adjustment({
                    lower: min,
                    upper: max,
                    step_increment: step,
                    page_increment: Math.max(step, step * 4),
                }),
                numeric: true,
            }),
            'katab-prefs-spin-row',
        );

        addPreferenceRow(group, row);
        return syncRowWithSetting(
            key,
            row,
            'value',
            settings.get_int.bind(settings),
            settings.set_int.bind(settings),
            'notify::value',
            (value) => Math.round(value),
        );
    };

    const createDoubleRow = (title, subtitle, key, group, min, max, step, digits = 2) => {
        const row = stylePreferenceRow(
            new Adw.SpinRow({
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
            }),
            'katab-prefs-spin-row',
        );

        addPreferenceRow(group, row);
        return syncRowWithSetting(
            key,
            row,
            'value',
            settings.get_double.bind(settings),
            settings.set_double.bind(settings),
            'notify::value',
        );
    };

    const createBooleanRow = (title, subtitle, key, group) => {
        const row = stylePreferenceRow(
            new Adw.SwitchRow({
                title,
                ...(subtitle && { subtitle }),
            }),
            'katab-prefs-switch-row',
        );

        addPreferenceRow(group, row);
        return syncRowWithSetting(
            key,
            row,
            'active',
            settings.get_boolean.bind(settings),
            settings.set_boolean.bind(settings),
            'notify::active',
        );
    };

    const createShortcutRow = (title, subtitle, key, group) => {
        const row = stylePreferenceRow(
            new Adw.ActionRow({
                title,
                ...(subtitle && { subtitle }),
            }),
            'katab-prefs-shortcut-row',
        );

        const buttonBox = addCssClasses(
            new Gtk.Box({
                orientation: Gtk.Orientation.HORIZONTAL,
                spacing: 6,
                valign: Gtk.Align.CENTER,
            }),
            'katab-prefs-button-box',
        );

        const shortcutButton = addCssClasses(
            new Gtk.Button({
                label: formatShortcutValue(settings.get_strv(key)),
                valign: Gtk.Align.CENTER,
            }),
            'katab-prefs-button',
            'katab-prefs-shortcut-button',
        );
        shortcutButton.connect('clicked', () => {
            shortcutCaptureState.active = true;
            shortcutCaptureState.button = shortcutButton;
            shortcutButton.set_label('Press shortcut...');
        });
        buttonBox.append(shortcutButton);

        const clearButton = addCssClasses(
            new Gtk.Button({
                icon_name: 'edit-clear-symbolic',
                valign: Gtk.Align.CENTER,
                tooltip_text: 'Clear shortcut',
            }),
            'katab-prefs-button',
            'katab-prefs-clear-button',
        );
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

    // Build an empty detail subpage: a PreferencesPage wrapped in a NavigationPage.
    const createToolSubpage = (subpageTitle) => {
        const detailPage = createPreferencesPage({ title: subpageTitle });
        const backGroup = createPreferencesGroup({});
        const backButton = addCssClasses(
            new Gtk.Button({
                icon_name: 'go-previous-symbolic',
                valign: Gtk.Align.CENTER,
                tooltip_text: 'Back to Tools',
            }),
            'katab-prefs-button',
            'katab-prefs-tool-back-button',
        );
        const backRow = stylePreferenceRow(
            new Adw.ActionRow({
                title: 'Back to Tools',
                subtitle: subpageTitle,
                activatable: true,
            }),
            'katab-prefs-tool-back-row',
        );
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
    const createToolIndexRow = (
        group,
        { title, subtitle, iconName, enabledKey, navPage, gicon },
    ) => {
        const row = stylePreferenceRow(
            new Adw.ActionRow({
                title,
                subtitle,
                activatable: true,
            }),
            'katab-prefs-tool-row',
        );

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
            const toggle = addCssClasses(
                new Gtk.Switch({
                    valign: Gtk.Align.CENTER,
                }),
                'katab-prefs-tool-switch',
            );
            settings.bind(enabledKey, toggle, 'active', Gio.SettingsBindFlags.DEFAULT);
            row.add_suffix(toggle);
        }

        row.add_suffix(
            addCssClasses(
                new Gtk.Image({
                    icon_name: 'go-next-symbolic',
                    valign: Gtk.Align.CENTER,
                }),
                'katab-prefs-tool-chevron',
            ),
        );

        row.connect('activated', () => {
            window.push_subpage(navPage);
        });

        addPreferenceRow(group, row);
        return row;
    };

    return {
        settings,
        window,
        extensionPath,
        watch,
        dispose,
        addCssClasses,
        createPreferencesPage,
        createPreferencesGroup,
        stylePreferenceRow,
        createExpanderRow,
        ollamaSettingTypes,
        addPreferenceRow,
        setStringList,
        syncRowWithSetting,
        formatShortcutValue,
        isShortcutKeyvalForbidden,
        isShortcutBindingValid,
        shortcutCaptureState,
        stopShortcutCapture,
        getOllamaValue,
        setOllamaValue,
        valuesEqual,
        toolStatusClasses,
        createChoiceRow,
        createProviderImage,
        getProviderThemeIconName,
        createProviderActiveBadge,
        createStatusBadge,
        setStatusBadge,
        createInfoRow,
        createInstructionRow,
        createButtonRow,
        createStatusRow,
        createProviderCardRow,
        createProviderPage,
        bindChoiceRow,
        createStringRow,
        getTextBufferContents,
        createMultilineStringRow,
        createIntRow,
        createDoubleRow,
        createBooleanRow,
        createShortcutRow,
        createToolSubpage,
        createToolIndexRow,
    };
}
