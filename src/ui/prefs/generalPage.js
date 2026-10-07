// General preferences page — provider selection cards, keyboard shortcut,
// token-usage ledger controls (range/retention/budget/export/reset), pet
// companion selection, notifications, and appearance settings.
import {
    formatTokenCount,
    TOKEN_USAGE_RANGES,
    TokenUsageManager,
} from '../../usage/tokenUsageManager.js';
import { getPetDefinition, parsePetForm, PET_SELECTION_MODES } from '../../pets/petCollection.js';
import { gettext as _, format } from '../../shared/i18n.js';

export function buildGeneralPage(ctx) {
    const {
        settings,
        window,
        createPreferencesPage,
        createPreferencesGroup,
        createProviderCardRow,
        createShortcutRow,
        createChoiceRow,
        bindChoiceRow,
        createBooleanRow,
        createDoubleRow,
        createIntRow,
        createStatusRow,
        setStatusBadge,
        createButtonRow,
    } = ctx;

    const page = createPreferencesPage({
        title: _('General'),
        icon_name: 'katab-logo',
    });
    window.add(page);

    // General Provider Selection
    const generalGroup = createPreferencesGroup({
        title: _('Active Provider'),
        description: _(
            'Choose which AI backend powers your conversations. Click a provider to switch; your settings for each are kept separately.',
        ),
    });
    page.add(generalGroup);

    const accessibilityGroup = createPreferencesGroup({
        title: _('Keyboard Shortcut'),
        description: _(
            'Set a global shortcut to open or hide the chat from anywhere on the desktop.',
        ),
    });
    page.add(accessibilityGroup);

    const tokenUsageGroup = createPreferencesGroup({
        title: _('AI Token Breakdown'),
        description: _(
            'Control the local-only usage ledger, companion celebrations, default range, retention, reset, and export.',
        ),
    });
    page.add(tokenUsageGroup);

    const petCompanionGroup = createPreferencesGroup({
        title: _('Pet Companion'),
        description: _(
            'Choose whether the visible companion follows the active provider or stays pinned to a form selected in the Pet Collection.',
        ),
    });
    page.add(petCompanionGroup);

    const notificationGroup = createPreferencesGroup({
        title: _('Notifications'),
        description: _(
            'Control desktop alerts and sounds for chat activity that happens while the window is closed.',
        ),
    });
    page.add(notificationGroup);

    const appearanceGroup = createPreferencesGroup({
        title: _('Appearance'),
        description: _(
            'Control how chat text is sized and how the glass dialog renders over your desktop.',
        ),
    });
    page.add(appearanceGroup);

    createProviderCardRow('ollama', generalGroup);
    createProviderCardRow('unsloth', generalGroup);
    createProviderCardRow('openai', generalGroup);
    createProviderCardRow('anthropic', generalGroup);
    createProviderCardRow('deepseek', generalGroup);
    createShortcutRow(
        _('Toggle Chat'),
        _(
            'Open or hide the current chat without cancelling active responses. Press to record a key combination; Backspace clears it.',
        ),
        'toggle-current-chat',
        accessibilityGroup,
    );

    const chatTextScaleRow = createChoiceRow(
        _('Chat Text Size'),
        _(
            'Comfortable is the recommended default for general readability. Compact fits more text on screen; Large is easier to read from a distance.',
        ),
        appearanceGroup,
    );
    bindChoiceRow(
        chatTextScaleRow,
        'chat-text-scale',
        [
            { label: _('Compact'), value: 'compact' },
            { label: _('Comfortable (Recommended)'), value: 'comfortable' },
            { label: _('Large'), value: 'large' },
        ],
        settings.get_string.bind(settings),
        settings.set_string.bind(settings),
        (value) => format(_('Custom ({value})'), { value }),
    );

    createBooleanRow(
        _('Glassy Translucent Dialog'),
        _(
            'Makes the chat dialog slightly see-through for the glass look. Turn this off for maximum text readability — the dialog then uses a more opaque surface.',
        ),
        'ui-glass-translucent',
        appearanceGroup,
    );

    createBooleanRow(
        _('Completion Sound'),
        _(
            'Play a short sound when a response finishes while the chat is closed. Uses a different tone when the request fails.',
        ),
        'completion-sound-enabled',
        notificationGroup,
    );

    createBooleanRow(
        _('Track Token Usage'),
        _(
            'Record local-only token totals for the Tokens panel. Existing data stays on disk when this is off.',
        ),
        'token-usage-enabled',
        tokenUsageGroup,
    );

    const tokenRangeRow = createChoiceRow(
        _('Default Range'),
        _('Initial range shown when opening the AI Token Breakdown panel or top-bar snapshot.'),
        tokenUsageGroup,
    );
    bindChoiceRow(
        tokenRangeRow,
        'token-usage-default-range',
        TOKEN_USAGE_RANGES.map((range) => ({ label: range.label, value: range.key })),
        settings.get_string.bind(settings),
        settings.set_string.bind(settings),
        (value) => format(_('Custom ({value})'), { value }),
    );

    const retentionRow = createChoiceRow(
        _('Retention'),
        _(
            'How long to keep daily token buckets before pruning. Forever keeps the local ledger until you reset it.',
        ),
        tokenUsageGroup,
    );
    bindChoiceRow(
        retentionRow,
        'token-usage-retention-days',
        [
            { label: _('Forever'), value: 0 },
            { label: _('90 days'), value: 90 },
            { label: _('1 year'), value: 365 },
        ],
        settings.get_int.bind(settings),
        settings.set_int.bind(settings),
        (value) => format(_('{value} days'), { value }),
    );

    createBooleanRow(
        _('Companion Celebrations'),
        _('Show in-chat messages for pet hatches and growth stages.'),
        'token-usage-celebrations-enabled',
        tokenUsageGroup,
    );

    createBooleanRow(
        _('Monthly Budget'),
        _(
            'Show a monthly spend budget card in the Token Breakdown panel and warn as spending approaches the limit.',
        ),
        'token-budget-enabled',
        tokenUsageGroup,
    );

    const budgetAmountRow = createDoubleRow(
        _('Monthly Budget Amount'),
        _('USD budget for a calendar month. Cost estimates use published model pricing.'),
        'token-budget-monthly-usd',
        tokenUsageGroup,
        1,
        10000,
        1,
    );

    const budgetWarningRow = createIntRow(
        _('Budget Warning Threshold'),
        _('Percentage of the monthly budget at which warnings start.'),
        'token-budget-warning-pct',
        tokenUsageGroup,
        10,
        100,
        5,
    );

    // Amount + threshold only matter while the budget switch is on.
    const syncBudgetVisibility = () => {
        const enabled = settings.get_boolean('token-budget-enabled');
        budgetAmountRow.visible = enabled;
        budgetWarningRow.visible = enabled;
    };
    syncBudgetVisibility();
    settings.connect('changed::token-budget-enabled', syncBudgetVisibility);

    createBooleanRow(
        _('Desktop Notifications'),
        _('Show a desktop notification when a response finishes while the chat is closed.'),
        'token-desktop-notifications-enabled',
        notificationGroup,
    );

    const petSelectionRow = createChoiceRow(
        _('Active Companion'),
        _(
            'Follow the provider selected for chat, or keep showing the form chosen from Token Breakdown → View Collection.',
        ),
        petCompanionGroup,
    );
    bindChoiceRow(
        petSelectionRow,
        'pet-selection-mode',
        [
            { label: _('Follow Current Provider'), value: PET_SELECTION_MODES.FOLLOW_PROVIDER },
            { label: _('Pinned'), value: PET_SELECTION_MODES.PINNED },
        ],
        settings.get_string.bind(settings),
        settings.set_string.bind(settings),
        (value) => format(_('Custom ({value})'), { value }),
    );

    const { badge: activePetBadge } = createStatusRow(
        _('Current Form'),
        _('Pinned forms are selected from the Pet Collection inside the Token Breakdown panel.'),
        petCompanionGroup,
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
            const isValidPin =
                selectionMode === PET_SELECTION_MODES.PINNED &&
                parsedPinned &&
                companion.id === pinnedForm;
            if (selectionMode === PET_SELECTION_MODES.PINNED && !isValidPin) {
                settings.set_string('pet-selection-mode', PET_SELECTION_MODES.FOLLOW_PROVIDER);
                return;
            }
            const label = isValidPin
                ? companion.name
                : format(_('{pet} · Following'), {
                      pet: getPetDefinition(currentProvider)?.name || companion.name,
                  });
            setStatusBadge(activePetBadge, label, 'katab-prefs-status-detected');
        } catch (_e) {
            setStatusBadge(activePetBadge, _('Unavailable'), 'katab-prefs-status-install');
        }
    };
    refreshActivePetBadge();
    settings.connect('changed::provider', refreshActivePetBadge);
    settings.connect('changed::pet-selection-mode', refreshActivePetBadge);
    settings.connect('changed::pet-pinned-form', refreshActivePetBadge);

    const { badge: tokenUsageBadge } = createStatusRow(
        _('Usage Ledger'),
        _('Private JSON ledger stored under ~/.local/share/katabai/token-usage.json.'),
        tokenUsageGroup,
    );
    const refreshTokenUsageBadge = () => {
        try {
            const summary = TokenUsageManager.getSummary('all');
            setStatusBadge(
                tokenUsageBadge,
                format(_('{count} tokens'), { count: formatTokenCount(summary.totalTokens) }),
                'katab-prefs-status-detected',
            );
        } catch (_e) {
            setStatusBadge(tokenUsageBadge, _('Unavailable'), 'katab-prefs-status-install');
        }
    };
    refreshTokenUsageBadge();

    createButtonRow(
        _('Export Usage JSON'),
        _(
            'Write a timestamped copy of the local ledger into your Documents folder (or home folder if Documents is unavailable).',
        ),
        _('Export'),
        () => {
            try {
                const path = TokenUsageManager.exportCopy();
                setStatusBadge(tokenUsageBadge, _('Exported'), 'katab-prefs-status-detected');
                log(`Katab: exported token usage ledger to ${path}`);
            } catch (e) {
                setStatusBadge(tokenUsageBadge, _('Export failed'), 'katab-prefs-status-install');
                log(`Katab: failed to export token usage ledger: ${e.message || e}`);
            }
        },
        tokenUsageGroup,
    );

    createButtonRow(
        _('Reset Usage Ledger'),
        _('Delete local token analytics and all pet XP. Chat history is not affected.'),
        _('Reset'),
        () => {
            TokenUsageManager.reset();
            settings.set_string('pet-pinned-form', '');
            settings.set_string('pet-selection-mode', PET_SELECTION_MODES.FOLLOW_PROVIDER);
            refreshTokenUsageBadge();
            refreshActivePetBadge();
        },
        tokenUsageGroup,
    );
}
