// usagePanel.js — "AI Token Breakdown" panel (Overview / Collection / Spending).
//
// Owns the panel's actor tree, navigation state (active tab, sub-view, pet
// detail form, range key) and the floating range dropdown. The dialog keeps
// only a thin wrapper surface (`_buildUsagePanel`, `_refreshUsagePanel`,
// `_toggleUsagePanel`, `_openUsagePanel`, `_closeUsageRangeDropdown`) and the
// root-actor field for visibility checks; everything the panel needs from the
// dialog flows through the host bag passed to the constructor.
//
// Shell-only module: imports gi://St + Clutter (excluded from the plain-gjs
// import smoke test, like src/pets/petSpriteActor.js).
import GLib from 'gi://GLib';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import { PetSpriteActor } from '../pets/petSpriteActor.js';
import {
    buildCompanionState,
    buildUsageMilestones,
    estimateSummaryCost,
    formatCost,
    formatTokenCount,
    TOKEN_USAGE_RANGES,
    TokenUsageManager,
} from '../usage/tokenUsageManager.js';
import {
    parsePetForm,
    PET_PROVIDERS,
    PET_SELECTION_MODES,
    providerFormId,
} from '../pets/petCollection.js';

export class UsagePanel {
    /**
     * @param {Object} host — dialog surface:
     *   settings, extensionPath,
     *   buildPickerShell(titleText) => {pickers, listBox, closePickerBtn, pickerTitle},
     *   showChatView(), openAuxPanel(panel),
     *   getCurrentProvider(), getPetSelection(), switchToLocalDraft(),
     *   createProviderIcon(provider, extensionPath, styleClass),
     *   getProviderLabel(provider)
     */
    constructor(host) {
        this._host = host;
        this._settings = host.settings;
        this._extPath = host.extensionPath;

        this._tab = 'overview';
        this._view = 'overview';
        this._detailFormId = null;
        this._rangeKey = null;
        this._rangeDropdown = null;
        this._rangeDropdownOpen = false;
        this._rangeDropdownCaptureId = 0;
        this._providerModelTab = 'provider';
        this._companionSprite = null;

        const { picker, listBox, closePickerBtn, pickerTitle } =
            this._host.buildPickerShell('AI Token Breakdown');
        picker.add_style_class_name('katab-usage-panel');
        this._listBox = listBox;
        this._title = pickerTitle;
        closePickerBtn.connect('clicked', () => this._host.showChatView());
        this.panel = picker;
    }

    get rangeDropdown() {
        return this._rangeDropdown;
    }

    destroy() {
        this.closeRangeDropdown();
    }

    toggle() {
        if (!this.panel) return;
        if (this.panel.visible) {
            this._host.showChatView();
            return;
        }
        this.open();
    }

    open() {
        if (!this.panel) return;
        this._tab = 'overview';
        this._view = 'overview';
        this._detailFormId = null;
        this.refresh();
        this._host.openAuxPanel(this.panel);
    }

    /** Animate the companion sprite (celebrate / tip) when it is on screen. */
    showCompanionPose(pose, durationMs) {
        this._companionSprite?.showPose(pose, durationMs);
    }

    resetRangeToDefault() {
        this._rangeKey = this.defaultRange();
    }

    defaultRange() {
        try {
            const saved = this._settings.get_string('token-usage-default-range');
            if (this._isValidRange(saved)) {
                return saved;
            }
        } catch (_e) {
            /* fallback below */
        }
        return 'month';
    }

    _isValidRange(rangeKey) {
        return TOKEN_USAGE_RANGES.some((range) => range.key === rangeKey);
    }

    refresh() {
        if (!this._listBox) return;
        this.closeRangeDropdown();
        this._listBox.destroy_all_children();

        // ── Tab bar (always visible) ──────────────────────────────────
        this._listBox.add_child(this._buildTabBar());

        // ── Collection tab ────────────────────────────────────────────
        if (this._tab === 'collection') {
            if (this._view === 'detail' && this._detailFormId) {
                this._renderPetDetail(this._detailFormId);
            } else {
                this._renderCollection();
            }
            return;
        }

        // ── Spending tab ──────────────────────────────────────────────
        if (this._tab === 'spending') {
            this._renderSpending();
            return;
        }

        // ── Overview tab ──────────────────────────────────────────────
        this._setTitle('AI Token Breakdown');

        if (!this._rangeKey || !this._isValidRange(this._rangeKey)) {
            this._rangeKey = this.defaultRange();
        }

        let summary;
        let allSummary;
        try {
            allSummary = TokenUsageManager.getSummary('all');
            summary =
                this._rangeKey === 'all'
                    ? allSummary
                    : TokenUsageManager.getSummary(this._rangeKey);
        } catch (e) {
            this._listBox.add_child(
                new St.Label({
                    text: `Could not load usage data: ${e.message || e}`,
                    style_class: 'katab-usage-privacy-note',
                }),
            );
            return;
        }

        const box = this._listBox;
        const trackingEnabled = this._settings.get_boolean('token-usage-enabled');
        if (!trackingEnabled) {
            box.add_child(this._buildPausedCard());
        }

        // Empty state — tracking starts with the first recorded reply.
        if (allSummary.totalTokens === 0) {
            const emptyCard = this._createCard(null);
            emptyCard.add_child(
                new St.Label({
                    text: 'No tokens tracked yet',
                    style_class: 'katab-usage-hero-value',
                }),
            );
            const emptyHint = new St.Label({
                text: trackingEnabled
                    ? 'Tracking starts with your next reply. Old chats are not scanned or backfilled, and the ledger stays on this computer.'
                    : 'Tracking is paused. Turn it back on in Settings > General > AI Token Breakdown when you want the companion to start counting again.',
                style_class: 'katab-usage-note',
            });
            emptyHint.clutter_text.line_wrap = true;
            emptyHint.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
            emptyCard.add_child(emptyHint);
            box.add_child(emptyCard);
            box.add_child(this._buildPrivacyNote());
            return;
        }

        box.add_child(this._buildRangeDropdown());
        box.add_child(this._buildActivityCard(summary));
        if (summary.providers.length > 0 && summary.models.length > 0) {
            box.add_child(this._buildProviderModelCard(summary));
        }
        box.add_child(this._buildTipRow(summary));
        box.add_child(this._buildPrivacyNote());
    }

    // ── Tab bar ──────────────────────────────────────────────────────────────

    _buildTabBar() {
        const bar = new St.BoxLayout({
            vertical: false,
            x_expand: true,
            style_class: 'katab-usage-tab-bar',
        });

        const tabs = [
            { key: 'overview', label: 'Overview' },
            { key: 'collection', label: 'Collection' },
            { key: 'spending', label: 'Spending' },
        ];

        for (const tab of tabs) {
            const active = tab.key === this._tab;
            const btn = new St.Button({
                label: tab.label,
                style_class: active
                    ? 'katab-usage-tab-btn katab-usage-tab-btn-active'
                    : 'katab-usage-tab-btn',
                can_focus: true,
                reactive: true,
                x_expand: true,
            });
            btn.connect('clicked', () => {
                if (tab.key === 'collection') {
                    this._showCollection();
                } else if (tab.key === 'spending') {
                    this._showSpending();
                } else {
                    this._showOverview();
                }
            });
            bar.add_child(btn);
        }
        return bar;
    }

    _setTitle(title) {
        if (this._title) this._title.set_text(title);
    }

    _showOverview() {
        this._tab = 'overview';
        this._view = 'overview';
        this._detailFormId = null;
        this.refresh();
    }

    _showCollection() {
        this._tab = 'collection';
        this._view = 'collection';
        this._detailFormId = null;
        this.refresh();
    }

    _showSpending() {
        this._tab = 'spending';
        this._view = 'overview';
        this._detailFormId = null;
        this.refresh();
    }

    _showPetDetail(formId) {
        this._view = 'detail';
        this._detailFormId = formId;
        this.refresh();
    }

    _followCurrentProviderPet() {
        this._settings.set_string('pet-pinned-form', '');
        this._settings.set_string('pet-selection-mode', PET_SELECTION_MODES.FOLLOW_PROVIDER);
        this._showCollection();
    }

    _pinPetForm(formId) {
        this._settings.set_string('pet-pinned-form', formId);
        this._settings.set_string('pet-selection-mode', PET_SELECTION_MODES.PINNED);
        this._showOverview();
    }

    _buildBackRow(label, onBack) {
        const row = new St.BoxLayout({
            vertical: false,
            x_expand: true,
            style_class: 'katab-usage-subview-header',
        });
        const backButton = new St.Button({
            child: new St.Icon({ icon_name: 'go-previous-symbolic' }),
            style_class: 'katab-usage-back-btn',
            can_focus: true,
            accessible_name: 'Back',
        });
        backButton.connect('clicked', onBack);
        row.add_child(backButton);
        row.add_child(
            new St.Label({
                text: label,
                style_class: 'katab-usage-subview-title',
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            }),
        );
        return row;
    }

    _renderCollection() {
        this._setTitle('Your Companions');
        const box = this._listBox;
        const collection = TokenUsageManager.getCollectionState();
        const selection = this._host.getPetSelection();

        // Companion hero card (moved from Overview tab)
        let allSummary;
        try {
            allSummary = TokenUsageManager.getSummary('all');
        } catch (_e) {
            allSummary = TokenUsageManager.getSummary('all');
        }
        box.add_child(this._buildCompanionCard(allSummary, allSummary, true));

        const followButton = new St.Button({
            label: `Follow ${this._host.getProviderLabel(this._host.getCurrentProvider())}`,
            style_class:
                selection.selectionMode === PET_SELECTION_MODES.FOLLOW_PROVIDER
                    ? 'katab-usage-follow-btn katab-usage-follow-btn-active'
                    : 'katab-usage-follow-btn',
            can_focus: true,
            x_expand: true,
        });
        followButton.connect('clicked', () => this._followCurrentProviderPet());
        box.add_child(followButton);

        const entries = PET_PROVIDERS.map((provider) => {
            const pet = collection.pets[provider];
            return {
                formId: providerFormId(provider),
                companion: { id: providerFormId(provider), ...pet },
                status: `${pet.stageLabel} · ${formatTokenCount(pet.xp)} XP`,
                locked: false,
            };
        });

        const grid = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style_class: 'katab-pet-collection-grid',
        });
        for (let index = 0; index < entries.length; index += 2) {
            const row = new St.BoxLayout({
                vertical: false,
                x_expand: true,
                style_class: 'katab-pet-collection-row',
            });
            for (const entry of entries.slice(index, index + 2)) {
                row.add_child(this._buildPetCollectionItem(entry, selection.companion.id));
            }
            if (entries.slice(index, index + 2).length === 1) {
                row.add_child(new St.Widget({ x_expand: true }));
            }
            grid.add_child(row);
        }
        box.add_child(grid);

        // Milestones (moved from Overview to Collection)
        allSummary = TokenUsageManager.getSummary('all');
        box.add_child(this._buildMilestoneCard(allSummary));
    }

    _buildPetCollectionItem(entry, activeFormId) {
        const isActive = entry.formId === activeFormId;
        const button = new St.Button({
            style_class: `katab-pet-collection-item${isActive ? ' katab-pet-collection-item-active' : ''}${entry.locked ? ' katab-pet-collection-item-locked' : ''}`,
            can_focus: !entry.locked,
            reactive: !entry.locked,
            x_expand: true,
            accessible_name: entry.companion?.name || 'Pet companion',
        });
        const content = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'katab-pet-collection-item-content',
        });
        const sprite = new PetSpriteActor(this._extPath, {
            slotSize: 100,
            animate: false,
            fallbackText: entry.locked ? '·' : '?',
        });
        sprite.setCompanion(entry.companion);
        content.add_child(sprite);
        content.add_child(
            new St.Label({
                text: entry.companion.name,
                style_class: 'katab-pet-collection-name',
                x_align: Clutter.ActorAlign.CENTER,
            }),
        );
        content.add_child(
            new St.Label({
                text: entry.status,
                style_class: 'katab-pet-collection-status',
                x_align: Clutter.ActorAlign.CENTER,
            }),
        );
        if (isActive) {
            content.add_child(
                new St.Label({
                    text: 'Active',
                    style_class: 'katab-pet-collection-active-label',
                    x_align: Clutter.ActorAlign.CENTER,
                }),
            );
        }
        button.set_child(content);
        if (!entry.locked) button.connect('clicked', () => this._showPetDetail(entry.formId));
        return button;
    }

    _renderPetDetail(formId) {
        const form = parsePetForm(formId);
        if (!form) {
            this._showCollection();
            return;
        }

        const companion = TokenUsageManager.getActiveCompanion({
            currentProvider: this._host.getCurrentProvider(),
            selectionMode: PET_SELECTION_MODES.PINNED,
            pinnedForm: formId,
        });
        if (companion.id !== formId) {
            this._showCollection();
            return;
        }

        this._setTitle(companion.name);
        const box = this._listBox;
        const collection = TokenUsageManager.getCollectionState();
        const selection = this._host.getPetSelection();
        box.add_child(this._buildBackRow(companion.stageLabel, () => this._showCollection()));

        const preview = new St.BoxLayout({
            vertical: false,
            x_expand: true,
            style_class: 'katab-usage-card katab-pet-detail-preview',
        });
        const sprite = new PetSpriteActor(this._extPath, {
            slotSize: 128,
            animate: true,
        });
        sprite.setCompanion(companion);
        preview.add_child(sprite);

        const info = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'katab-pet-detail-info',
        });
        info.add_child(
            new St.Label({ text: companion.name, style_class: 'katab-pet-detail-name' }),
        );
        info.add_child(
            new St.Label({
                text: `${companion.stageLabel} · ${formatTokenCount(companion.xp)} XP`,
                style_class: 'katab-pet-detail-stage',
            }),
        );

        const progressTrack = new St.Widget({
            style_class: 'katab-pet-detail-progress-track',
            width: 260,
            height: 7,
        });
        if (companion.progress > 0) {
            progressTrack.add_child(
                new St.Widget({
                    style_class: 'katab-pet-detail-progress-fill',
                    width: Math.max(3, Math.round(companion.progress * 260)),
                    height: 7,
                }),
            );
        }
        info.add_child(progressTrack);

        const basePet = form.baseProvider ? collection.pets[form.baseProvider] : null;
        if (basePet) {
            info.add_child(
                new St.Label({
                    text: `${basePet.replyCount} replies · ${basePet.lastFedAt ? `Last fed ${this._formatDate(basePet.lastFedAt)}` : 'Not fed yet'}`,
                    style_class: 'katab-pet-detail-meta',
                }),
            );
        }

        const isActive =
            selection.selectionMode === PET_SELECTION_MODES.PINNED &&
            selection.companion.id === formId;
        const makeActiveButton = new St.Button({
            label: isActive ? 'Current Companion' : 'Make Companion',
            style_class: isActive
                ? 'katab-usage-action-btn katab-usage-action-btn-active'
                : 'katab-usage-action-btn',
            can_focus: !isActive,
            reactive: !isActive,
        });
        if (!isActive) makeActiveButton.connect('clicked', () => this._pinPetForm(formId));
        info.add_child(makeActiveButton);
        preview.add_child(info);
        box.add_child(preview);
    }

    _createCard(titleText = null) {
        const card = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style_class: 'katab-usage-card',
        });
        if (titleText) {
            card.add_child(
                new St.Label({
                    text: titleText,
                    style_class: 'katab-usage-card-title',
                }),
            );
        }
        return card;
    }

    _buildPausedCard() {
        const card = this._createCard('Tracking Paused');
        const label = new St.Label({
            text: 'Token analytics are disabled. Existing local data remains here, but new replies will not be counted until you turn tracking back on.',
            style_class: 'katab-usage-note',
        });
        label.clutter_text.line_wrap = true;
        label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        card.add_child(label);
        return card;
    }

    _buildRangeDropdown() {
        // Clean up any stale dropdown first
        this.closeRangeDropdown();

        const activeRange =
            TOKEN_USAGE_RANGES.find((r) => r.key === this._rangeKey) || TOKEN_USAGE_RANGES[2]; // default month
        const chip = new St.Button({
            label: `${activeRange.label} ▾`,
            style_class: 'katab-usage-range-chip',
            can_focus: true,
            reactive: true,
        });
        chip.connect('clicked', () => {
            if (this._rangeDropdownOpen) {
                this.closeRangeDropdown();
            } else {
                this._openRangeDropdown(chip);
            }
        });
        return chip;
    }

    _openRangeDropdown(anchor) {
        this.closeRangeDropdown();

        const dropdown = new St.BoxLayout({
            vertical: true,
            style_class: 'katab-usage-range-dropdown',
            reactive: true,
        });
        this._rangeDropdown = dropdown;
        this._rangeDropdownOpen = true;

        for (const range of TOKEN_USAGE_RANGES) {
            const active = range.key === this._rangeKey;
            const row = new St.Button({
                style_class: active
                    ? 'katab-usage-range-dropdown-item katab-usage-range-dropdown-item-active'
                    : 'katab-usage-range-dropdown-item',
                can_focus: true,
                reactive: true,
                accessible_name: range.label,
            });
            const content = new St.BoxLayout({
                vertical: false,
                x_expand: true,
                style_class: 'katab-usage-range-dropdown-content',
            });
            content.add_child(
                new St.Label({
                    text: range.label,
                    style_class: 'katab-usage-range-dropdown-label',
                    x_expand: true,
                }),
            );
            if (active) {
                content.add_child(
                    new St.Icon({
                        icon_name: 'object-select-symbolic',
                        style_class: 'katab-usage-range-dropdown-check',
                    }),
                );
            }
            row.set_child(content);
            row.connect('clicked', () => {
                this._rangeKey = range.key;
                this.closeRangeDropdown();
                this.refresh();
            });
            dropdown.add_child(row);
        }

        // Position the dropdown relative to the anchor in the parent list box
        if (this._listBox) {
            this._listBox.insert_child_above(dropdown, anchor);
        }

        // Close when clicking outside
        const captureId = global.stage.connect('captured-event', (_actor, event) => {
            if (!this._rangeDropdownOpen) return Clutter.EVENT_PROPAGATE;
            if (event.type() === Clutter.EventType.BUTTON_PRESS) {
                const target = event.get_source();
                if (target && !this._isDescendantOf(target, this._rangeDropdown)) {
                    this.closeRangeDropdown();
                }
            }
            return Clutter.EVENT_PROPAGATE;
        });
        this._rangeDropdownCaptureId = captureId;
    }

    closeRangeDropdown() {
        if (this._rangeDropdownCaptureId) {
            global.stage.disconnect(this._rangeDropdownCaptureId);
            this._rangeDropdownCaptureId = 0;
        }
        if (this._rangeDropdown) {
            try {
                this._rangeDropdown.destroy();
            } catch (_e) {
                /* disposed */
            }
            this._rangeDropdown = null;
        }
        this._rangeDropdownOpen = false;
    }

    _isDescendantOf(actor, ancestor) {
        let current = actor;
        while (current) {
            if (current === ancestor) return true;
            current = current.get_parent();
        }
        return false;
    }

    // The active provider pet grows from permanent per-provider collection XP.
    // Recent range data only supplies mood and local/cloud flavor text.
    _buildCompanionCard(allSummary, recentSummary = null, inCollection = false) {
        const moodState = buildCompanionState(allSummary, recentSummary || allSummary);
        const selection = this._host.getPetSelection();
        const companion = selection.companion;

        const card = new St.BoxLayout({
            vertical: false,
            x_expand: true,
            style_class: inCollection
                ? 'katab-usage-card katab-usage-companion-card katab-usage-companion-card-collection'
                : 'katab-usage-card katab-usage-companion-card',
        });

        const body = new St.BoxLayout({
            vertical: true,
            style_class: `katab-usage-companion-body katab-usage-companion-body-${companion.stageKey} katab-usage-companion-provider-${companion.baseProvider || 'mixie'}${moodState.recentLocalShare >= 0.5 ? ' katab-usage-companion-local' : ''}`,
            y_align: Clutter.ActorAlign.CENTER,
        });
        const sprite = new PetSpriteActor(this._extPath, {
            slotSize: 112,
            animate: true,
            fallbackText: moodState.face,
        });
        sprite.setCompanion({ ...companion, fallbackText: moodState.face });
        this._companionSprite = sprite;
        sprite.connect('destroy', () => {
            if (this._companionSprite === sprite) this._companionSprite = null;
        });
        body.add_child(sprite);
        card.add_child(body);

        const textCol = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'katab-usage-companion-text',
        });
        textCol.add_child(
            new St.Label({
                text: `${companion.name} · ${companion.stageLabel}`,
                style_class: 'katab-usage-companion-name',
            }),
        );
        textCol.add_child(
            new St.Label({
                text: moodState.mood,
                style_class: 'katab-usage-companion-mood',
            }),
        );
        const remainingXp =
            companion.nextStageXp === null
                ? null
                : Math.max(0, companion.nextStageXp - companion.xp);
        textCol.add_child(
            new St.Label({
                text:
                    remainingXp === null
                        ? `${formatTokenCount(companion.xp)} XP · Maximum stage`
                        : `${formatTokenCount(companion.xp)} XP · ${formatTokenCount(remainingXp)} to ${companion.nextStageLabel}`,
                style_class: 'katab-usage-companion-progress',
            }),
        );
        const flavor = new St.Label({
            text: moodState.flavorText,
            style_class: 'katab-usage-companion-flavor',
        });
        flavor.clutter_text.line_wrap = true;
        flavor.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        textCol.add_child(flavor);

        if (!inCollection) {
            const collectionButton = new St.Button({
                label:
                    selection.selectionMode === PET_SELECTION_MODES.PINNED
                        ? 'View Collection · Pinned'
                        : 'View Collection',
                style_class: 'katab-usage-collection-btn',
                can_focus: true,
                x_align: Clutter.ActorAlign.START,
            });
            collectionButton.connect('clicked', () => this._showCollection());
            textCol.add_child(collectionButton);
        }
        card.add_child(textCol);

        if (
            companion.baseProvider ||
            companion.accentProvider ||
            moodState.recentLocalShare >= 0.5
        ) {
            const badgeCol = new St.BoxLayout({
                vertical: true,
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'katab-usage-companion-badges',
            });
            if (companion.baseProvider) {
                badgeCol.add_child(
                    this._host.createProviderIcon(
                        companion.baseProvider,
                        this._extPath,
                        'katab-usage-companion-provider-icon',
                    ),
                );
            }
            if (companion.accentProvider) {
                badgeCol.add_child(
                    this._host.createProviderIcon(
                        companion.accentProvider,
                        this._extPath,
                        'katab-usage-companion-secondary-icon',
                    ),
                );
            }
            if (moodState.recentLocalShare >= 0.5) {
                badgeCol.add_child(
                    new St.Icon({
                        icon_name: 'user-home-symbolic',
                        style_class: 'katab-usage-companion-home-icon',
                    }),
                );
            }
            card.add_child(badgeCol);
        }

        return card;
    }

    _buildActivityCard(summary) {
        const card = this._createCard(summary.label);

        // ═══ TOP: Hero ═══
        const topRow = new St.BoxLayout({
            vertical: false,
            x_expand: true,
            style_class: 'katab-usage-activity-top',
        });

        const heroCol = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style_class: 'katab-usage-activity-hero',
        });
        heroCol.add_child(
            new St.Label({
                text: `${formatTokenCount(summary.totalTokens)} tokens`,
                style_class: 'katab-usage-hero-value',
            }),
        );
        heroCol.add_child(
            new St.Label({
                text: summary.label || 'Selected range',
                style_class: 'katab-usage-hero-range',
            }),
        );

        let detailText = `${formatTokenCount(summary.promptTokens)} prompt · ${formatTokenCount(summary.completionTokens)} reply`;
        if (summary.cachedHitTokens > 0) {
            detailText += ` · ${formatTokenCount(summary.cachedHitTokens)} cached`;
        }
        heroCol.add_child(
            new St.Label({
                text: detailText,
                style_class: 'katab-usage-note',
            }),
        );

        const exPct = Math.round(summary.exactShare * 100);
        heroCol.add_child(
            new St.Label({
                text: `${exPct}% measured · since ${this._formatDate(summary.trackingStartedAt)}`,
                style_class: 'katab-usage-meta',
            }),
        );
        topRow.add_child(heroCol);
        card.add_child(topRow);

        // ═══ Sleek ratio bar — labels flanking outside ═══
        const localPct = Math.round(summary.localShare * 100);
        const remotePct = 100 - localPct;
        const localW = summary.localShare > 0 ? Math.round(summary.localShare * 230) : 0;
        const remoteW = 230 - localW;
        const barHeight = 12;

        const barWrap = new St.BoxLayout({
            vertical: false,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'katab-usage-ratio-row',
        });
        barWrap.add_child(
            new St.Label({ text: `${localPct}% local`, style_class: 'katab-usage-ratio-label' }),
        );
        const bar = new St.BoxLayout({ vertical: false, style_class: 'katab-usage-ratio-bar' });
        if (localW > 0)
            bar.add_child(
                new St.Widget({
                    style_class: 'katab-usage-ratio-seg katab-usage-local-fill',
                    width: Math.max(2, localW),
                    height: barHeight,
                }),
            );
        if (remoteW > 0)
            bar.add_child(
                new St.Widget({
                    style_class: 'katab-usage-ratio-seg katab-usage-remote-fill',
                    width: Math.max(2, remoteW),
                    height: barHeight,
                }),
            );
        barWrap.add_child(bar);
        barWrap.add_child(
            new St.Label({ text: `${remotePct}% cloud`, style_class: 'katab-usage-ratio-label' }),
        );
        card.add_child(barWrap);

        // One-click switch to a local draft (kept from the legacy local card,
        // which was removed as dead code). Only useful off Ollama.
        if (this._host.getCurrentProvider() !== 'ollama') {
            const localAction = new St.Button({
                label: 'Try Next Draft Locally',
                style_class: 'katab-usage-action-btn',
                can_focus: true,
                reactive: true,
            });
            localAction.connect('clicked', () => this._host.switchToLocalDraft());
            card.add_child(localAction);
        }

        // ═══ Trend stats — each one a clear, human-readable sentence ═══
        const trendCol = new St.BoxLayout({
            vertical: true,
            x_expand: true,
            style_class: 'katab-usage-activity-trends',
        });

        const _trendLine = (cls, text) => {
            const lbl = new St.Label({
                text,
                style_class: `katab-usage-trend-line ${cls}`,
            });
            lbl.clutter_text.line_wrap = true;
            lbl.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
            return lbl;
        };

        // Today vs daily average
        if (summary.todayVsAverage !== null) {
            const p = Math.round(summary.todayVsAverage * 100);
            if (Math.abs(summary.todayVsAverage) < 0.03) {
                trendCol.add_child(
                    _trendLine('katab-usage-trend-flat', 'Today on par with your daily average'),
                );
            } else if (p > 0) {
                trendCol.add_child(
                    _trendLine('katab-usage-trend-up', `Today ${p}% above your daily average`),
                );
            } else {
                trendCol.add_child(
                    _trendLine(
                        'katab-usage-trend-down',
                        `Today ${Math.abs(p)}% below your daily average`,
                    ),
                );
            }
        } else {
            trendCol.add_child(
                _trendLine('katab-usage-trend-flat', 'Today: no tokens recorded yet'),
            );
        }

        // Token trend vs previous range
        if (summary.tokenTrend !== null) {
            const p = Math.round(summary.tokenTrend * 100);
            const rangeLabel = (summary.label || 'this range').toLowerCase();
            if (Math.abs(summary.tokenTrend) < 0.03) {
                trendCol.add_child(
                    _trendLine(
                        'katab-usage-trend-flat',
                        `About the same as previous ${rangeLabel}`,
                    ),
                );
            } else if (p > 0) {
                trendCol.add_child(
                    _trendLine(
                        'katab-usage-trend-up',
                        `${p}% more tokens than previous ${rangeLabel}`,
                    ),
                );
            } else {
                trendCol.add_child(
                    _trendLine(
                        'katab-usage-trend-down',
                        `${Math.abs(p)}% fewer tokens than previous ${rangeLabel}`,
                    ),
                );
            }
        }

        // Local streak
        if (summary.localStreakDays >= 3) {
            trendCol.add_child(
                _trendLine(
                    'katab-usage-trend-up',
                    `${summary.localStreakDays} straight days using local models`,
                ),
            );
        } else if (summary.localStreakDays > 0) {
            trendCol.add_child(
                _trendLine(
                    'katab-usage-trend-up',
                    `${summary.localStreakDays} day local streak — keep going`,
                ),
            );
        } else {
            trendCol.add_child(
                _trendLine('katab-usage-trend-flat', 'No local streak yet — try Ollama'),
            );
        }

        card.add_child(trendCol);

        // ═══ Divider ═══
        card.add_child(
            new St.Widget({
                style_class: 'katab-usage-activity-divider',
                height: 1,
                x_expand: true,
            }),
        );

        // ═══ 14-day bar chart (bars + labels in same columns = perfect alignment) ═══
        const max = Math.max(...summary.timeline.map((d) => d.total), 1);
        const todayKey = GLib.DateTime.new_now_local().format('%Y-%m-%d');
        const BAR_H = 40;

        const chartRow = new St.BoxLayout({
            vertical: false,
            x_expand: true,
            style_class: 'katab-usage-activity-chart',
        });

        for (const day of summary.timeline) {
            const isToday = day.dayKey === todayKey;
            const h = day.total > 0 ? Math.max(3, Math.round((day.total / max) * BAR_H)) : 2;

            const col = new St.BoxLayout({
                vertical: true,
                x_expand: true,
                x_align: Clutter.ActorAlign.CENTER,
                style_class: 'katab-usage-activity-col',
            });

            // Bar — anchored to bottom of the column
            col.add_child(
                new St.Widget({
                    style_class: isToday
                        ? 'katab-usage-activity-bar katab-usage-activity-bar-today'
                        : day.total > 0
                          ? 'katab-usage-activity-bar'
                          : 'katab-usage-activity-bar katab-usage-activity-bar-empty',
                    width: 12,
                    height: h,
                    y_align: Clutter.ActorAlign.END,
                }),
            );

            // Label — directly below its bar
            col.add_child(
                new St.Label({
                    text: (day.weekday || '·').charAt(0),
                    style_class: isToday
                        ? 'katab-usage-activity-label katab-usage-activity-label-today'
                        : 'katab-usage-activity-label',
                    x_align: Clutter.ActorAlign.CENTER,
                }),
            );

            chartRow.add_child(col);
        }

        card.add_child(chartRow);

        // ═══ Stats footer ═══
        const statsRow = new St.BoxLayout({
            vertical: false,
            x_expand: true,
            style_class: 'katab-usage-activity-stats',
        });
        statsRow.add_child(
            new St.Label({
                text: `${summary.activeDays} active ${summary.activeDays === 1 ? 'day' : 'days'} · ${summary.events} ${summary.events === 1 ? 'reply' : 'replies'}`,
                style_class: 'katab-usage-meta',
                x_expand: true,
            }),
        );
        if (summary.mostActiveDay) {
            statsRow.add_child(
                new St.Label({
                    text: `Most active: ${this._formatDay(summary.mostActiveDay.dayKey)}`,
                    style_class: 'katab-usage-meta',
                }),
            );
        }
        card.add_child(statsRow);

        return card;
    }

    _buildProviderModelCard(summary) {
        const card = this._createCard(null);

        // Mini subtabs
        const subtabBar = new St.BoxLayout({
            vertical: false,
            style_class: 'katab-usage-subtab-bar',
        });
        const providerTab = new St.Button({
            label: 'By Provider',
            style_class:
                this._providerModelTab === 'provider'
                    ? 'katab-usage-subtab-btn katab-usage-subtab-btn-active'
                    : 'katab-usage-subtab-btn',
            can_focus: true,
            reactive: true,
        });
        const modelTab = new St.Button({
            label: 'By Model',
            style_class:
                this._providerModelTab === 'model'
                    ? 'katab-usage-subtab-btn katab-usage-subtab-btn-active'
                    : 'katab-usage-subtab-btn',
            can_focus: true,
            reactive: true,
        });
        providerTab.connect('clicked', () => {
            this._providerModelTab = 'provider';
            this.refresh();
        });
        modelTab.connect('clicked', () => {
            this._providerModelTab = 'model';
            this.refresh();
        });
        subtabBar.add_child(providerTab);
        subtabBar.add_child(modelTab);
        card.add_child(subtabBar);

        if (this._providerModelTab === 'provider') {
            // Clean stacked ratio bar — labels are in the provider rows below
            const bar = new St.BoxLayout({
                vertical: false,
                style_class: 'katab-usage-ratio-bar',
            });
            for (const entry of summary.providers) {
                if (entry.share <= 0) continue;
                bar.add_child(
                    new St.Widget({
                        style_class: `katab-usage-ratio-seg katab-usage-fill-${entry.provider}`,
                        width: Math.max(4, Math.round(entry.share * 230)),
                        height: 12,
                    }),
                );
            }
            card.add_child(bar);

            for (const entry of summary.providers) {
                const row = new St.BoxLayout({
                    vertical: false,
                    x_expand: true,
                    style_class: 'katab-usage-provider-row katab-usage-provider-row-compact',
                });
                row.add_child(
                    this._host.createProviderIcon(
                        entry.provider,
                        this._extPath,
                        'katab-usage-provider-row-icon katab-usage-provider-row-icon-sm',
                    ),
                );
                row.add_child(
                    new St.Label({
                        text: this._host.getProviderLabel(entry.provider),
                        style_class: 'katab-usage-provider-name',
                        x_expand: true,
                        y_align: Clutter.ActorAlign.CENTER,
                    }),
                );
                row.add_child(
                    new St.Label({
                        text: `${entry.estimated > 0 ? '~' : ''}${formatTokenCount(entry.total)} · ${Math.round(entry.share * 100)}%`,
                        style_class: 'katab-usage-provider-value',
                        y_align: Clutter.ActorAlign.CENTER,
                    }),
                );
                card.add_child(row);
            }
        } else {
            // Model tab
            for (const entry of summary.models) {
                const row = new St.BoxLayout({
                    vertical: false,
                    x_expand: true,
                    style_class: 'katab-usage-model-row katab-usage-model-row-compact',
                });
                const nameLabel = new St.Label({
                    text: entry.model,
                    style_class: 'katab-usage-model-name',
                    x_expand: true,
                    y_align: Clutter.ActorAlign.CENTER,
                });
                nameLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
                nameLabel.clutter_text.single_line_mode = true;
                row.add_child(nameLabel);
                row.add_child(
                    new St.Label({
                        text: `${entry.estimated > 0 ? '~' : ''}${formatTokenCount(entry.total)} · ${Math.round(entry.share * 100)}%`,
                        style_class: 'katab-usage-provider-value',
                        y_align: Clutter.ActorAlign.CENTER,
                    }),
                );
                card.add_child(row);
            }
        }

        return card;
    }

    _buildMilestoneCard(allSummary) {
        const card = this._createCard('Milestones');
        const row = new St.BoxLayout({
            vertical: false,
            style_class: 'katab-usage-milestone-row',
        });
        for (const milestone of buildUsageMilestones(allSummary)) {
            row.add_child(
                new St.Label({
                    text: milestone.label,
                    style_class: milestone.achieved
                        ? 'katab-usage-milestone katab-usage-milestone-achieved'
                        : 'katab-usage-milestone',
                }),
            );
        }
        card.add_child(row);
        return card;
    }

    _formatDay(dayKey) {
        try {
            const parts = String(dayKey).split('-').map(Number);
            const dt = GLib.DateTime.new_local(parts[0], parts[1], parts[2], 0, 0, 0);
            return `${dt.format('%b')} ${dt.get_day_of_month()}`;
        } catch (_e) {
            return dayKey || 'Unknown day';
        }
    }

    _buildPrivacyNote() {
        const note = new St.Label({
            text: 'All usage data stays on this computer — nothing is uploaded anywhere.',
            style_class: 'katab-usage-privacy-note',
        });
        note.clutter_text.line_wrap = true;
        note.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        return note;
    }

    // ── Context-aware tip row (Overview) ─────────────────────────────────

    _buildTipRow(summary) {
        const tips = [];
        const budgetEnabled = this._settings.get_boolean('token-budget-enabled');

        if (budgetEnabled) {
            const budgetUsd = this._settings.get_double('token-budget-monthly-usd');
            const warningPct = this._settings.get_int('token-budget-warning-pct') / 100;
            const monthSummary =
                this._rangeKey === 'month' ? summary : TokenUsageManager.getSummary('month');
            if (monthSummary.totalTokens > 0) {
                try {
                    const costData = estimateSummaryCost(monthSummary);
                    const budgetUsed = costData.total / budgetUsd;
                    if (budgetUsed >= warningPct) {
                        tips.push(
                            `💰 You've used ${Math.round(budgetUsed * 100)}% of your $${budgetUsd.toFixed(2)} monthly budget — check the Spending tab.`,
                        );
                    }
                } catch (_e) {
                    /* pricing unavailable */
                }
            }
        }

        if (summary.localShare >= 0.75) {
            tips.push('🏠 100% self-hosted champion — your data never leaves your machine.');
        } else if (summary.localShare >= 0.4) {
            tips.push('⚖️ Great balance! Each local token is one you fully own.');
        } else if (summary.localShare > 0) {
            tips.push('🌱 Local share is growing! Try Ollama for even more private replies.');
        } else {
            tips.push(
                '💡 Try a local Ollama model for private, offline replies that cost nothing.',
            );
        }

        if (summary.activeDays >= 7) {
            tips.push(`🔥 ${summary.activeDays} active days — you're on a roll!`);
        }

        if (tips.length === 0) return null;

        // Pick one tip to show (rotate if multiple)
        const idx = Math.floor(Date.now() / (3600 * 1000)) % tips.length;
        const tip = tips[idx];

        const row = new St.BoxLayout({
            vertical: false,
            x_expand: true,
            style_class: 'katab-usage-tip-row',
        });
        row.add_child(
            new St.Label({
                text: tip,
                style_class: 'katab-usage-tip-text',
                x_expand: true,
            }),
        );
        return row;
    }

    // ── Spending tab ─────────────────────────────────────────────────────

    _renderSpending() {
        this._setTitle('Token Spending');
        const box = this._listBox;

        if (!this._rangeKey || !this._isValidRange(this._rangeKey)) {
            this._rangeKey = this.defaultRange();
        }
        box.add_child(this._buildRangeDropdown());

        let summary;
        try {
            summary =
                this._rangeKey === 'all'
                    ? TokenUsageManager.getSummary('all')
                    : TokenUsageManager.getSummary(this._rangeKey);
        } catch (e) {
            box.add_child(
                new St.Label({
                    text: `Could not load usage data: ${e.message || e}`,
                    style_class: 'katab-usage-privacy-note',
                }),
            );
            return;
        }

        if (summary.totalTokens === 0) {
            const emptyCard = this._createCard(null);
            emptyCard.add_child(
                new St.Label({
                    text: 'No spending yet',
                    style_class: 'katab-usage-hero-value',
                }),
            );
            emptyCard.add_child(
                new St.Label({
                    text: 'Send some messages and cost estimates will appear here.',
                    style_class: 'katab-usage-note',
                }),
            );
            box.add_child(emptyCard);
            box.add_child(this._buildPrivacyNote());
            return;
        }

        let costData;
        try {
            costData = estimateSummaryCost(summary);
        } catch (_e) {
            costData = { total: 0, perProvider: {}, perModel: [], localSavings: 0 };
        }

        // Cost hero
        const heroCard = this._createCard('Estimated Cost');
        heroCard.add_child(
            new St.Label({
                text: formatCost(costData.total),
                style_class: 'katab-usage-cost-hero',
            }),
        );
        heroCard.add_child(
            new St.Label({
                text: `${summary.events} ${summary.events === 1 ? 'reply' : 'replies'} in ${summary.label.toLowerCase()}`,
                style_class: 'katab-usage-note',
            }),
        );
        heroCard.add_child(
            new St.Label({
                text: 'Estimated from published model pricing — actual costs may vary.',
                style_class: 'katab-usage-meta',
            }),
        );
        box.add_child(heroCard);

        // Budget progress (if enabled)
        const budgetEnabled = this._settings.get_boolean('token-budget-enabled');
        if (budgetEnabled) {
            const budgetUsd = this._settings.get_double('token-budget-monthly-usd');
            const warningPct = this._settings.get_int('token-budget-warning-pct') / 100;
            const monthSummary =
                this._rangeKey === 'month' ? summary : TokenUsageManager.getSummary('month');
            let monthCost = costData.total;
            if (this._rangeKey !== 'month') {
                try {
                    monthCost = estimateSummaryCost(monthSummary).total;
                } catch (_e) {
                    /* ok */
                }
            }
            const budgetUsed = budgetUsd > 0 ? monthCost / budgetUsd : 0;
            const budgetPct = Math.round(Math.min(budgetUsed, 1) * 100);

            const budgetCard = this._createCard('Monthly Budget');
            // We'll use nested widgets
            const budgetTrack = new St.BoxLayout({
                vertical: false,
                x_expand: true,
            });
            const fillWidth = Math.round(Math.min(budgetUsed, 1) * 320);
            const fillClass =
                budgetUsed >= 0.9
                    ? 'katab-usage-budget-fill-danger'
                    : budgetUsed >= warningPct
                      ? 'katab-usage-budget-fill-warn'
                      : 'katab-usage-budget-fill';
            if (fillWidth > 0) {
                budgetTrack.add_child(
                    new St.Widget({
                        style_class: `katab-usage-budget-fill ${fillClass}`,
                        width: fillWidth,
                        height: 12,
                    }),
                );
            }
            const remainWidth = 320 - fillWidth;
            if (remainWidth > 0) {
                budgetTrack.add_child(
                    new St.Widget({
                        style_class: 'katab-usage-budget-remain',
                        width: remainWidth,
                        height: 12,
                    }),
                );
            }
            budgetCard.add_child(budgetTrack);
            budgetCard.add_child(
                new St.Label({
                    text: `${budgetPct}% of $${budgetUsd.toFixed(2)} monthly budget · ${formatCost(monthCost)} used`,
                    style_class: 'katab-usage-note',
                }),
            );
            budgetCard.add_child(
                new St.Label({
                    text: `Warning at ${this._settings.get_int('token-budget-warning-pct')}%`,
                    style_class: 'katab-usage-meta',
                }),
            );
            box.add_child(budgetCard);
        }

        // Per-provider cost breakdown
        if (summary.providers.length > 0) {
            const providerCard = this._createCard('By Provider');
            for (const entry of summary.providers) {
                const providerCost = costData.perProvider[entry.provider]?.cost || 0;
                const row = new St.BoxLayout({
                    vertical: false,
                    x_expand: true,
                    style_class: 'katab-usage-provider-row',
                });
                row.add_child(
                    this._host.createProviderIcon(
                        entry.provider,
                        this._extPath,
                        'katab-usage-provider-row-icon',
                    ),
                );
                const nameCol = new St.BoxLayout({
                    vertical: true,
                    x_expand: true,
                    y_align: Clutter.ActorAlign.CENTER,
                });
                nameCol.add_child(
                    new St.Label({
                        text: this._host.getProviderLabel(entry.provider),
                        style_class: 'katab-usage-provider-name',
                    }),
                );
                nameCol.add_child(
                    new St.Label({
                        text: `${formatTokenCount(entry.total)} · ${entry.events} ${entry.events === 1 ? 'reply' : 'replies'}`,
                        style_class: 'katab-usage-provider-meta',
                    }),
                );
                row.add_child(nameCol);
                row.add_child(
                    new St.Label({
                        text: formatCost(providerCost),
                        style_class: 'katab-usage-cost-value',
                        y_align: Clutter.ActorAlign.CENTER,
                    }),
                );
                providerCard.add_child(row);
            }
            box.add_child(providerCard);
        }

        // Per-model cost breakdown
        if (costData.perModel.length > 0) {
            const modelCard = this._createCard('By Model');
            for (const entry of costData.perModel.slice(0, 8)) {
                const row = new St.BoxLayout({
                    vertical: false,
                    x_expand: true,
                    style_class: 'katab-usage-model-row',
                });
                const nameLabel = new St.Label({
                    text: entry.model,
                    style_class: 'katab-usage-model-name',
                    x_expand: true,
                    y_align: Clutter.ActorAlign.CENTER,
                });
                nameLabel.clutter_text.ellipsize = Pango.EllipsizeMode.END;
                nameLabel.clutter_text.single_line_mode = true;
                row.add_child(nameLabel);
                row.add_child(
                    new St.Label({
                        text: formatCost(entry.cost),
                        style_class: 'katab-usage-cost-value',
                        y_align: Clutter.ActorAlign.CENTER,
                    }),
                );
                modelCard.add_child(row);
            }
            box.add_child(modelCard);
        }

        // Savings card
        if (costData.localSavings > 0.01) {
            const savingsCard = this._createCard('Local Savings');
            savingsCard.add_child(
                new St.Label({
                    text: `~${formatCost(costData.localSavings)} saved by using local models`,
                    style_class: 'katab-usage-nudge',
                }),
            );
            savingsCard.add_child(
                new St.Label({
                    text: `${formatTokenCount(summary.localTokens)} local tokens × estimated cloud equivalent cost`,
                    style_class: 'katab-usage-meta',
                }),
            );
            box.add_child(savingsCard);
        }

        box.add_child(this._buildTipRow(summary));
        box.add_child(this._buildPrivacyNote());
    }

    _formatDate(unixSeconds) {
        if (!unixSeconds) {
            return 'today';
        }
        try {
            const dt = GLib.DateTime.new_from_unix_local(unixSeconds);
            return `${dt.format('%b')} ${dt.get_day_of_month()}, ${dt.get_year()}`;
        } catch (_e) {
            return 'recently';
        }
    }
}
