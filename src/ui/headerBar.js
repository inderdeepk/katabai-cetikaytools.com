// headerBar.js — the chat window's header row: logo + title, the provider
// chip (engine switcher with health micro-label), the preset / DeepSeek
// model selectors, the Usage button with its pet avatar, the history button
// (hover preview + full-view open), and the window action buttons
// (new chat / settings / close).
//
// Pure builder: constructs the widget tree, wires every handler through the
// host bag, and returns the widget refs the dialog keeps updating live
// (provider status, model/preset labels, cache chip, pet avatar, history
// button anchor).  A function (not a class) because the header owns no
// state of its own — all live values stay on the dialog fields this returns.
//
// Shell-only module: imports gi://St + Clutter (excluded from the plain-gjs
// import smoke test, like src/pets/petSpriteActor.js).
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

/**
 * @param {Object} host — dialog surface:
 *   addToContentLayout(actor), extensionPath, getCurrentProvider(),
 *   createProviderIcon(provider, extensionPath, styleClass),
 *   getProviderLabel(provider),
 *   toggleProviderPicker(), togglePresetPicker(), toggleDeepseekModelPicker(),
 *   toggleUsagePanel(), recentChatsEnter(), recentChatsLeave(),
 *   hideRecentChatsPopup(), toggleHistoryView(),
 *   newChat(), closeDialog(), openPreferences()
 * @returns {Object} widget refs: cacheSavingsChip, cacheSavingsChipLabel,
 *   providerStatusBox, providerStatusIcon, providerStatusLabel,
 *   providerStatusText, balanceLabel, presetBtn, presetBtnLabel,
 *   deepseekModelBtn, deepseekModelBtnLabel, usageBtn, headerPetBox,
 *   headerPetSprite, headerPetFallback, historyBtn
 */
export function buildHeaderBar(host) {
    const widgets = {};

    let headerBox = new St.BoxLayout({
        vertical: false,
        style_class: 'katab-header-box',
    });
    host.addToContentLayout(headerBox);

    let titleWrapper = new St.BoxLayout({
        style_class: 'katab-title-wrapper',
        y_align: Clutter.ActorAlign.CENTER,
    });
    headerBox.add_child(titleWrapper);

    let logoGicon = Gio.icon_new_for_string(`${host.extensionPath}/icons/katab-logo.svg`);
    let logoIcon = new St.Icon({
        gicon: logoGicon,
        style_class: 'katab-logo-icon',
        y_align: Clutter.ActorAlign.CENTER,
    });
    titleWrapper.add_child(logoIcon);

    let titleLabel = new St.Label({
        text: 'Katab AI',
        style_class: 'katab-title-label',
        y_align: Clutter.ActorAlign.CENTER,
    });
    titleWrapper.add_child(titleLabel);

    // Flexible gap — the title stays left, all controls cluster on the right.
    let headerSpacer = new St.Widget({
        x_expand: true,
    });
    headerBox.add_child(headerSpacer);

    // Subtle running total of prompt-cache savings for the current chat.
    // Only shown for DeepSeek once at least a little has been saved.
    widgets.cacheSavingsChip = new St.BoxLayout({
        style_class: 'katab-cache-session-chip',
        y_align: Clutter.ActorAlign.CENTER,
        visible: false,
    });
    widgets.cacheSavingsChip.add_child(
        new St.Icon({
            icon_name: 'emblem-ok-symbolic',
            style_class: 'katab-cache-session-chip-icon',
            y_align: Clutter.ActorAlign.CENTER,
        }),
    );
    widgets.cacheSavingsChipLabel = new St.Label({
        text: '',
        style_class: 'katab-cache-session-chip-label',
        y_align: Clutter.ActorAlign.CENTER,
    });
    widgets.cacheSavingsChip.add_child(widgets.cacheSavingsChipLabel);
    headerBox.add_child(widgets.cacheSavingsChip);

    // Provider chip doubles as an engine switcher — clicking it opens the
    // provider picker so the active engine can be changed from the chat window.
    widgets.providerStatusBox = new St.BoxLayout({
        style_class: 'katab-header-chip katab-provider-status-box',
        y_align: Clutter.ActorAlign.CENTER,
        reactive: true,
        can_focus: true,
        track_hover: true,
        accessible_name: 'Switch AI Provider',
    });
    widgets.providerStatusBox.connect('button-press-event', () => {
        host.toggleProviderPicker();
        return Clutter.EVENT_STOP;
    });

    widgets.providerStatusIcon = host.createProviderIcon(
        host.getCurrentProvider(),
        host.extensionPath,
        'katab-provider-badge-icon katab-provider-status-icon',
    );
    widgets.providerStatusBox.add_child(widgets.providerStatusIcon);

    widgets.providerStatusLabel = new St.Label({
        text: host.getProviderLabel(host.getCurrentProvider()),
        style_class: 'katab-provider-status-label',
        y_align: Clutter.ActorAlign.CENTER,
    });
    widgets.providerStatusBox.add_child(widgets.providerStatusLabel);

    // Health is its own micro-label (e.g. "Online") separated from the
    // provider name — the chip surface itself stays part of the neutral
    // glass theme and only this text carries the status color.
    widgets.providerStatusBox.add_child(
        new St.Label({
            text: '·',
            style_class: 'katab-provider-status-sep',
            y_align: Clutter.ActorAlign.CENTER,
        }),
    );

    widgets.providerStatusText = new St.Label({
        text: '',
        style_class: 'katab-provider-status-text',
        y_align: Clutter.ActorAlign.CENTER,
    });
    widgets.providerStatusBox.add_child(widgets.providerStatusText);

    // DeepSeek balance badge — compact currency + total shown next to the
    // provider name when balance data is available.
    widgets.balanceLabel = new St.Label({
        text: '',
        style_class: 'katab-provider-balance-label',
        y_align: Clutter.ActorAlign.CENTER,
        visible: false,
    });
    widgets.providerStatusBox.add_child(widgets.balanceLabel);

    widgets.providerStatusBox.add_child(
        new St.Label({
            text: '▾',
            style_class: 'katab-provider-status-arrow',
            y_align: Clutter.ActorAlign.CENTER,
        }),
    );
    headerBox.add_child(widgets.providerStatusBox);

    // Preset selector button — visible only when Ollama is the active provider
    widgets.presetBtn = new St.BoxLayout({
        style_class: 'katab-header-chip katab-preset-btn',
        reactive: true,
        can_focus: true,
        track_hover: true,
        vertical: false,
        y_align: Clutter.ActorAlign.CENTER,
        accessible_name: 'Load Preset',
    });
    widgets.presetBtn.connect('button-press-event', () => {
        host.togglePresetPicker();
        return Clutter.EVENT_STOP;
    });
    widgets.presetBtnLabel = new St.Label({
        text: 'Presets',
        style_class: 'katab-preset-btn-label',
        y_align: Clutter.ActorAlign.CENTER,
    });
    widgets.presetBtn.add_child(widgets.presetBtnLabel);
    widgets.presetBtn.add_child(
        new St.Label({
            text: '▾',
            style_class: 'katab-preset-btn-arrow',
            y_align: Clutter.ActorAlign.CENTER,
        }),
    );
    headerBox.add_child(widgets.presetBtn);

    // DeepSeek model selector — visible only when DeepSeek is the active provider
    widgets.deepseekModelBtn = new St.BoxLayout({
        style_class: 'katab-header-chip katab-preset-btn katab-deepseek-model-btn',
        reactive: true,
        can_focus: true,
        track_hover: true,
        vertical: false,
        visible: false,
        y_align: Clutter.ActorAlign.CENTER,
        accessible_name: 'Switch Model',
    });
    widgets.deepseekModelBtn.connect('button-press-event', () => {
        host.toggleDeepseekModelPicker();
        return Clutter.EVENT_STOP;
    });
    widgets.deepseekModelBtnLabel = new St.Label({
        text: 'Model',
        style_class: 'katab-preset-btn-label',
        y_align: Clutter.ActorAlign.CENTER,
    });
    widgets.deepseekModelBtn.add_child(widgets.deepseekModelBtnLabel);
    widgets.deepseekModelBtn.add_child(
        new St.Label({
            text: '▾',
            style_class: 'katab-preset-btn-arrow',
            y_align: Clutter.ActorAlign.CENTER,
        }),
    );
    headerBox.add_child(widgets.deepseekModelBtn);

    // AI Token Breakdown — header button opening the usage panel. Sits after
    // the provider/model chips, right before the window actions.
    widgets.usageBtn = new St.BoxLayout({
        style_class: 'katab-usage-btn',
        reactive: true,
        can_focus: true,
        track_hover: true,
        vertical: false,
        y_align: Clutter.ActorAlign.CENTER,
        accessible_name: 'Token Usage & Analytics',
    });
    widgets.usageBtn.connect('button-press-event', () => {
        host.toggleUsagePanel();
        return Clutter.EVENT_STOP;
    });

    // Circular pet avatar — pet sprite with fallback face
    widgets.headerPetBox = new St.Widget({
        style_class: 'katab-usage-btn-pet-box',
        layout_manager: new Clutter.BinLayout(),
        y_align: Clutter.ActorAlign.CENTER,
        x_align: Clutter.ActorAlign.CENTER,
    });
    widgets.headerPetSprite = null;
    widgets.headerPetFallback = new St.Label({
        text: '─ ‿ ─',
        style_class: 'katab-usage-btn-pet-fallback',
        y_align: Clutter.ActorAlign.CENTER,
        x_align: Clutter.ActorAlign.CENTER,
    });
    widgets.headerPetBox.add_child(widgets.headerPetFallback);
    widgets.usageBtn.add_child(widgets.headerPetBox);

    widgets.usageBtn.add_child(
        new St.Label({
            text: 'Usage',
            style_class: 'katab-usage-btn-label',
            y_align: Clutter.ActorAlign.CENTER,
        }),
    );
    headerBox.add_child(widgets.usageBtn);

    // History button — hover shows last 5 conversations dropdown,
    // click opens the full history view.  Single button replaces the
    // old split history-icon + hidden dropdown toggle.
    widgets.historyBtn = new St.BoxLayout({
        style_class: 'katab-history-dropdown-btn',
        reactive: true,
        can_focus: true,
        track_hover: true,
        vertical: false,
        y_align: Clutter.ActorAlign.CENTER,
    });
    widgets.historyBtn.add_child(
        new St.Icon({
            icon_name: 'document-open-recent-symbolic',
            style_class: 'katab-history-icon',
            y_align: Clutter.ActorAlign.CENTER,
        }),
    );
    widgets.historyBtn.add_child(
        new St.Label({
            text: '▾',
            style_class: 'katab-history-dropdown-arrow',
            y_align: Clutter.ActorAlign.CENTER,
        }),
    );

    // Hover: show recent chats preview after 250 ms
    widgets.historyBtn.connect('enter-event', () => {
        host.recentChatsEnter();
        return Clutter.EVENT_PROPAGATE;
    });
    widgets.historyBtn.connect('leave-event', () => {
        host.recentChatsLeave();
        return Clutter.EVENT_PROPAGATE;
    });

    // Click: open full history view
    widgets.historyBtn.connect('button-press-event', () => {
        host.hideRecentChatsPopup();
        host.toggleHistoryView();
        return Clutter.EVENT_STOP;
    });

    headerBox.add_child(widgets.historyBtn);

    let newChatBtn = new St.Button({
        child: new St.Icon({
            icon_name: 'document-new-symbolic',
            style_class: 'katab-new-chat-icon',
        }),
        style_class: 'katab-new-chat-btn',
        can_focus: true,
        reactive: true,
        accessible_name: 'New Chat',
    });
    newChatBtn.connect('clicked', () => host.newChat());
    headerBox.add_child(newChatBtn);

    let settingsBtn = new St.Button({
        child: new St.Icon({
            icon_name: 'emblem-system-symbolic',
            style_class: 'katab-settings-icon',
        }),
        style_class: 'katab-settings-btn',
        can_focus: true,
        accessible_name: 'Extension Settings',
    });
    headerBox.add_child(settingsBtn);

    settingsBtn.connect('clicked', () => {
        host.openPreferences();
    });

    let closeBtn = new St.Button({
        child: new St.Icon({
            icon_name: 'window-close-symbolic',
            style_class: 'katab-close-icon',
        }),
        style_class: 'katab-close-btn',
        can_focus: true,
        accessible_name: 'Close Chat',
    });
    closeBtn.connect('clicked', () => host.closeDialog());
    headerBox.add_child(closeBtn);

    log('[Katab:ui] Header bar built (usage right of model chip)');

    return widgets;
}
