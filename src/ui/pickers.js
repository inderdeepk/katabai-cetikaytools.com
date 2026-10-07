// Katab AI — picker panels: Ollama presets, provider (engine) picker, and the
// DeepSeek model picker. All three replace the chat scroll like the history
// view; this module owns their actors, list boxes, refresh/select logic and
// the shared shell + selection-row builders (also used by the usage panel and
// the history editor).
//
// Extracted from extension.js (analysis item #4). The dialog keeps thin
// wrappers (`_buildPresetPicker`, `_buildProviderPicker`,
// `_buildDeepseekModelPicker`, `_buildPickerShell`, `_togglePresetPicker`,
// `_toggleProviderPicker`, `_toggleDeepseekModelPicker`, `_refreshProviderPicker`,
// `_updateDeepseekModelButton`) plus the three actor fields for its visibility
// checks; every dialog dependency flows through the host bag.
//
// NOTE (a11y): use `Atk.Role` for accessibility roles — on GNOME 46
// `Clutter.AccessibleRole` does not exist (mutter 47+ API) and referencing it
// throws at widget construction.
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import Atk from 'gi://Atk';

import { DEEPSEEK_MODELS, PROVIDER_LABELS } from '../providers/catalog.js';
import { loadPresets, deletePreset } from '../usage/presetManager.js';
import { gettext as _ } from '../shared/i18n.js';

/**
 * Owns the three picker panels (presets / providers / DeepSeek models).
 *
 * Host bag contract:
 *   settings, showChatView(), openAuxPanel(panel), applyPreset(preset),
 *   addSystemMessage(text), updatePresetButton(), getCurrentProvider(),
 *   createProviderIcon(provider, extensionPath, styleClass),
 *   getProviderStatusText(status), syncProviderAccentClasses(actor, provider),
 *   syncProviderStatusClasses(actor, status), getProviderHealthStates(),
 *   refreshProviderHealth(), getDeepseekModelButton(),
 *   getDeepseekModelButtonLabel()
 */
export class Pickers {
    constructor(host) {
        this._host = host;

        this._presetPicker = null;
        this._presetListBox = null;
        this._providerPicker = null;
        this._providerListBox = null;
        this._deepseekModelPicker = null;
        this._deepseekListBox = null;
    }

    // ── Shared picker shell (provider + DeepSeek model dropdowns) ─────────────
    buildShell(titleText) {
        const picker = new St.BoxLayout({
            vertical: true,
            style_class: 'katab-preset-picker',
            x_expand: true,
            y_expand: true,
            visible: false,
        });

        const pickerHeader = new St.BoxLayout({
            vertical: false,
            style_class: 'katab-preset-picker-header',
        });
        picker.add_child(pickerHeader);

        const pickerTitle = new St.Label({
            text: titleText,
            style_class: 'katab-preset-picker-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        pickerHeader.add_child(pickerTitle);

        const closePickerBtn = new St.Button({
            child: new St.Icon({
                icon_name: 'window-close-symbolic',
                style_class: 'katab-preset-picker-close-icon',
            }),
            style_class: 'katab-preset-picker-close-btn',
            can_focus: true,
            accessible_name: 'Close picker',
        });
        pickerHeader.add_child(closePickerBtn);

        const pickerScroll = new St.ScrollView({
            style_class: 'katab-preset-picker-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            x_expand: true,
            y_expand: true,
        });
        picker.add_child(pickerScroll);

        const listBox = new St.BoxLayout({
            vertical: true,
            style_class: 'katab-preset-list',
            x_expand: true,
        });
        pickerScroll.add_child(listBox);

        return { picker, listBox, closePickerBtn, pickerTitle };
    }

    _createSelectionRow({ icon, title, meta, isActive, accentProvider, status, onActivate }) {
        const row = new St.BoxLayout({
            style_class: isActive
                ? 'katab-preset-row katab-selection-row katab-preset-row-active'
                : 'katab-preset-row katab-selection-row',
            vertical: false,
            x_expand: true,
            reactive: true,
            can_focus: true,
            track_hover: true,
            accessible_name: title,
            accessible_role: Atk.Role.PUSH_BUTTON,
        });

        // Active rows carry the provider's brand accent as a micro-detail
        // (thin left bar + tinted badge) instead of a full colored surface.
        if (isActive && accentProvider) {
            this._host.syncProviderAccentClasses(row, accentProvider);
        }

        if (icon) {
            row.add_child(icon);
        }

        const textCol = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'katab-selection-row-text',
        });

        textCol.add_child(
            new St.Label({
                text: title,
                style_class: 'katab-preset-row-name',
            }),
        );

        if (meta) {
            const metaLabel = new St.Label({
                text: meta,
                style_class: 'katab-preset-row-meta',
            });
            metaLabel.clutter_text.line_wrap = true;
            metaLabel.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
            metaLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            textCol.add_child(metaLabel);
        }
        row.add_child(textCol);

        // Small per-row health text (e.g. "Online") for the engine picker.
        if (status && status.text) {
            const statusLabel = new St.Label({
                text: status.text,
                style_class: 'katab-selection-row-status',
                y_align: Clutter.ActorAlign.CENTER,
            });
            if (status.status) {
                this._host.syncProviderStatusClasses(statusLabel, status.status);
            }
            row.add_child(statusLabel);
        }

        if (isActive) {
            row.add_child(
                new St.Label({
                    text: 'Active',
                    style_class: 'katab-selection-row-badge',
                    y_align: Clutter.ActorAlign.CENTER,
                }),
            );
        }

        row.connect('button-press-event', () => {
            onActivate();
            return Clutter.EVENT_STOP;
        });

        return row;
    }

    // ── Preset picker ─────────────────────────────────────────────────────────
    buildPresetPicker() {
        const picker = new St.BoxLayout({
            vertical: true,
            style_class: 'katab-preset-picker',
            x_expand: true,
            y_expand: true,
            visible: false,
        });

        // ── Header ────────────────────────────────────────────────────────────
        const pickerHeader = new St.BoxLayout({
            vertical: false,
            style_class: 'katab-preset-picker-header',
        });
        picker.add_child(pickerHeader);

        const pickerTitle = new St.Label({
            text: _('Ollama Presets'),
            style_class: 'katab-preset-picker-title',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        pickerHeader.add_child(pickerTitle);

        const closePickerBtn = new St.Button({
            child: new St.Icon({
                icon_name: 'window-close-symbolic',
                style_class: 'katab-preset-picker-close-icon',
            }),
            style_class: 'katab-preset-picker-close-btn',
            can_focus: true,
            accessible_name: 'Close preset list',
        });
        closePickerBtn.connect('clicked', () => this.togglePresetPicker());
        pickerHeader.add_child(closePickerBtn);

        // ── Preset list ────────────────────────────────────────────────────────
        const pickerScroll = new St.ScrollView({
            style_class: 'katab-preset-picker-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            x_expand: true,
            y_expand: true,
        });
        picker.add_child(pickerScroll);

        this._presetListBox = new St.BoxLayout({
            vertical: true,
            style_class: 'katab-preset-list',
            x_expand: true,
        });
        pickerScroll.add_child(this._presetListBox);

        this._presetPicker = picker;
        return picker;
    }

    togglePresetPicker() {
        if (!this._presetPicker) return;

        if (this._presetPicker.visible) {
            this._host.showChatView();
            return;
        }

        this.refreshPresetPicker();
        this._host.openAuxPanel(this._presetPicker);
    }

    refreshPresetPicker() {
        if (!this._presetListBox) return;

        // Destroy all current rows
        let child = this._presetListBox.get_first_child();
        while (child) {
            const next = child.get_next_sibling();
            this._presetListBox.remove_child(child);
            child.destroy();
            child = next;
        }

        const presets = loadPresets();
        const activePresetId = this._host.settings.get_string('ollama-active-preset');

        if (presets.length === 0) {
            const emptyLabel = new St.Label({
                text: 'No presets saved yet.\nCreate presets in the Preferences → Ollama page.',
                style_class: 'katab-preset-empty-label',
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.CENTER,
                x_expand: true,
            });
            emptyLabel.clutter_text.line_wrap = true;
            emptyLabel.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
            emptyLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            this._presetListBox.add_child(emptyLabel);
            return;
        }

        for (const preset of presets) {
            const isActive = preset.id === activePresetId;

            const row = new St.BoxLayout({
                style_class: isActive
                    ? 'katab-preset-row katab-preset-row-active katab-accent-ollama'
                    : 'katab-preset-row',
                vertical: false,
                x_expand: true,
            });

            const infoBox = new St.BoxLayout({
                vertical: true,
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            });
            row.add_child(infoBox);

            const nameLabel = new St.Label({
                text: preset.name || 'Unnamed Preset',
                style_class: 'katab-preset-row-name',
            });
            infoBox.add_child(nameLabel);

            const model = preset['model'] || '';
            const ctx = preset['num-ctx'] ? `${preset['num-ctx']} ctx` : '';
            const temp =
                preset['temperature'] !== undefined
                    ? `temp ${Number(preset['temperature']).toFixed(2)}`
                    : '';
            const meta = [model, ctx, temp].filter(Boolean).join('  ·  ');
            if (meta) {
                const metaLabel = new St.Label({
                    text: meta,
                    style_class: 'katab-preset-row-meta',
                });
                infoBox.add_child(metaLabel);
            }

            const btnBox = new St.BoxLayout({
                vertical: false,
                y_align: Clutter.ActorAlign.CENTER,
            });
            row.add_child(btnBox);

            const loadBtn = new St.Button({
                label: isActive ? '✓ Active' : 'Load',
                style_class: isActive
                    ? 'katab-preset-load-btn katab-preset-load-btn-active'
                    : 'katab-preset-load-btn',
                can_focus: !isActive,
                reactive: !isActive,
                y_align: Clutter.ActorAlign.CENTER,
            });
            if (!isActive) {
                loadBtn.connect('clicked', () => {
                    this._host.applyPreset(preset);
                    const modelName = preset['model'] || 'unchanged model';
                    this._host.addSystemMessage(`Loaded preset "${preset.name}" (${modelName}).`);
                    this.togglePresetPicker();
                });
            }
            btnBox.add_child(loadBtn);

            const deleteBtn = new St.Button({
                child: new St.Icon({
                    icon_name: 'edit-delete-symbolic',
                    style_class: 'katab-preset-delete-icon',
                }),
                style_class: 'katab-preset-delete-btn',
                can_focus: true,
                y_align: Clutter.ActorAlign.CENTER,
                accessible_name: `Delete preset "${preset.name}"`,
            });
            deleteBtn.connect('clicked', () => {
                deletePreset(preset.id);
                if (isActive) {
                    this._host.settings.set_string('ollama-active-preset', '');
                    this._host.updatePresetButton();
                }
                this.refreshPresetPicker();
            });
            btnBox.add_child(deleteBtn);

            this._presetListBox.add_child(row);
        }
    }

    // ── Provider (engine) picker ─────────────────────────────────────────────
    buildProviderPicker() {
        const { picker, listBox, closePickerBtn } = this.buildShell(_('Choose Engine'));
        this._providerListBox = listBox;
        closePickerBtn.connect('clicked', () => this._host.showChatView());
        this._providerPicker = picker;
        return picker;
    }

    toggleProviderPicker() {
        if (!this._providerPicker) return;
        if (this._providerPicker.visible) {
            this._host.showChatView();
            return;
        }
        // Probe every provider before rendering so the picker rows show fresh
        // health text instead of the last polled snapshot.
        this._host.refreshProviderHealth();
        this.refreshProviderPicker();
        this._host.openAuxPanel(this._providerPicker);
    }

    refreshProviderPicker() {
        if (!this._providerListBox) return;
        this._providerListBox.destroy_all_children();

        const states = this._host.getProviderHealthStates();

        for (const [key, label] of Object.entries(PROVIDER_LABELS)) {
            const icon = this._host.createProviderIcon(
                key,
                this._host.extensionPath,
                'katab-provider-badge-icon katab-selection-row-icon',
            );
            const state = states[key];
            const row = this._createSelectionRow({
                icon,
                title: label,
                meta: this._getProviderModelSummary(key),
                isActive: key === this._host.getCurrentProvider(),
                accentProvider: key,
                status: state
                    ? { text: this._host.getProviderStatusText(state.status), status: state.status }
                    : null,
                onActivate: () => this._selectProvider(key),
            });
            this._providerListBox.add_child(row);
        }
    }

    _getProviderModelSummary(provider) {
        const model = this._host.settings.get_string(`${provider}-model`) || '';
        if (provider === 'deepseek') {
            const meta = DEEPSEEK_MODELS.find((m) => m.id === model);
            if (meta) return `${meta.label} model`;
        }
        return model || 'No model set';
    }

    _selectProvider(provider) {
        if (provider !== this._host.getCurrentProvider()) {
            this._host.settings.set_string('provider', provider);
        }
        this._host.showChatView();
    }

    // ── DeepSeek model picker (Flash / Pro) ──────────────────────────────────
    buildDeepseekModelPicker() {
        const { picker, listBox, closePickerBtn } = this.buildShell(_('DeepSeek Model'));
        this._deepseekListBox = listBox;
        closePickerBtn.connect('clicked', () => this._host.showChatView());
        this._deepseekModelPicker = picker;
        return picker;
    }

    toggleDeepseekModelPicker() {
        if (!this._deepseekModelPicker) return;
        if (this._deepseekModelPicker.visible) {
            this._host.showChatView();
            return;
        }
        this.refreshDeepseekModelPicker();
        this._host.openAuxPanel(this._deepseekModelPicker);
    }

    refreshDeepseekModelPicker() {
        if (!this._deepseekListBox) return;
        this._deepseekListBox.destroy_all_children();

        const activeModel = this._host.settings.get_string('deepseek-model') || '';
        for (const model of DEEPSEEK_MODELS) {
            const row = this._createSelectionRow({
                icon: null,
                title: model.label,
                meta: model.description,
                isActive: model.id === activeModel,
                accentProvider: 'deepseek',
                onActivate: () => this._selectDeepseekModel(model.id),
            });
            this._deepseekListBox.add_child(row);
        }
    }

    _selectDeepseekModel(modelId) {
        if (this._host.settings.get_string('deepseek-model') !== modelId) {
            this._host.settings.set_string('deepseek-model', modelId);
        }
        this.updateDeepseekModelButton();
        this._host.showChatView();
    }

    updateDeepseekModelButton() {
        const btn = this._host.getDeepseekModelButton();
        if (!btn) return;
        const isDeepseek = this._host.getCurrentProvider() === 'deepseek';
        btn.visible = isDeepseek;
        if (!isDeepseek) return;

        const model = this._host.settings.get_string('deepseek-model') || '';
        const meta = DEEPSEEK_MODELS.find((m) => m.id === model);
        this._host.getDeepseekModelButtonLabel().set_text(meta ? meta.label : model || 'Model');
    }
}
