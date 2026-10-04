// catalog.js — Single source of truth for provider identity and branding,
// shared by the shell extension (extension.js) and the preferences window
// (prefs.js).  Adding a provider starts here.

export const PROVIDER_META = {
    ollama: { label: 'Ollama', iconFile: 'ollama.svg' },
    deepseek: { label: 'DeepSeek', iconFile: 'deepseek.svg' },
    unsloth: { label: 'Unsloth Studio', iconFile: 'unsloth.png' },
    openai: { label: 'OpenAI', iconFile: 'openai.svg' },
    anthropic: { label: 'Anthropic', iconFile: 'claude.svg' },
};

/** Selectable DeepSeek model variants surfaced in the chat header dropdown. */
export const DEEPSEEK_MODELS = [
    {
        id: 'deepseek-flash',
        label: 'Flash (V4.1)',
        description:
            'Fast, efficient model for everyday tasks and quick replies. Supports image input.',
    },
    {
        id: 'deepseek-v4-pro',
        label: 'Pro',
        description: 'Stronger reasoning for complex, multi-step problems.',
    },
    {
        id: 'deepseek-v4-flash',
        label: 'Flash (legacy)',
        description: 'Retired alias — served by the V4.1 Flash model and billed at Flash rates.',
    },
];

export const PROVIDER_LABELS = Object.fromEntries(
    Object.entries(PROVIDER_META).map(([provider, meta]) => [provider, meta.label]),
);

export const PROVIDER_ICON_STYLE_CLASSES = Object.keys(PROVIDER_META).map(
    (provider) => `katab-provider-icon-${provider}`,
);

// Per-provider brand accents (mirrors the usage-panel fill colors) applied as
// micro-accents on selection rows — a thin left bar + tinted badge — never as
// full-surface color, so pickers stay part of the neutral glass theme.
export const PROVIDER_ACCENT_CLASSES = Object.keys(PROVIDER_META).map(
    (provider) => `katab-accent-${provider}`,
);

// Preferences-facing provider details (page titles + descriptive copy), built
// on PROVIDER_META so labels/icons stay in one place.  NOTE: the preferences
// window has historically used a longer "Anthropic Claude" label — kept as a
// deliberate override so this consolidation does not change UI copy.
export const PROVIDER_DETAILS = {
    ollama: {
        ...PROVIDER_META.ollama,
        pageTitle: 'Ollama',
        description:
            'Run local models with a fast desktop-native workflow and deep tuning controls.',
    },
    deepseek: {
        ...PROVIDER_META.deepseek,
        pageTitle: 'DeepSeek',
        description:
            'Access DeepSeek V4 models with a 1M token context window and advanced reasoning. Requires a funded prepaid account.',
    },
    unsloth: {
        ...PROVIDER_META.unsloth,
        pageTitle: 'Unsloth',
        description:
            'Connect to optimized local Unsloth Studio endpoints for heavier or longer-context jobs.',
    },
    openai: {
        ...PROVIDER_META.openai,
        pageTitle: 'OpenAI',
        description:
            'Use hosted OpenAI models when you want broad capability and reliable cloud access.',
    },
    anthropic: {
        ...PROVIDER_META.anthropic,
        label: 'Anthropic Claude',
        pageTitle: 'Claude',
        description:
            'Use Claude models through Anthropic for careful reasoning, writing, and long-context work.',
    },
};
