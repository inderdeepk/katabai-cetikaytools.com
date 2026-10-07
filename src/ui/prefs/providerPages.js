// Simple provider pages (Unsloth / OpenAI / Anthropic) — connection and model
// settings built by the shared provider-page scaffolding.
import { gettext as _ } from '../../shared/i18n.js';

export function buildSimpleProviderPages(ctx) {
    const {
        createProviderPage,
        createPreferencesGroup,
        createStringRow,
        createIntRow,
        createInfoRow,
    } = ctx;

    // --- Unsloth Settings ---
    const unslothPage = createProviderPage('unsloth');
    const unslothGroup = createPreferencesGroup({ title: _('Connection &amp; Model') });
    createStringRow(
        _('Base URL'),
        _('e.g. http://localhost:8888/v1 — the Unsloth Studio API root.'),
        'unsloth-url',
        unslothGroup,
    );
    createStringRow(
        _('API Key'),
        _('Leave blank for local instances running without authentication.'),
        'unsloth-api-key',
        unslothGroup,
        true,
    );
    createStringRow(
        _('Model'),
        _('The model identifier served by your Unsloth Studio instance.'),
        'unsloth-model',
        unslothGroup,
    );
    createIntRow(
        _('Context Window Size'),
        _('Maximum tokens per request. Match this to your loaded model capacity.'),
        'unsloth-num-ctx',
        unslothGroup,
        1024,
        1048576,
        1024,
    );
    unslothPage.add(unslothGroup);

    const unslothToolsGroup = createPreferencesGroup({
        title: _('Tools'),
        description: _(
            'Unsloth Studio runs web search, Python, and terminal as server-side tools on its own backend.',
        ),
    });
    unslothPage.add(unslothToolsGroup);
    createInfoRow(
        _('Server-side tools'),
        _(
            'When Unsloth is the active provider, tool calls are executed by Unsloth Studio, not by Katab. The local SearxNG Web Search tool on the Tools page applies to the Ollama, OpenAI, Anthropic, and DeepSeek providers instead.',
        ),
        unslothToolsGroup,
    );
    const openaiPage = createProviderPage('openai');
    const openaiGroup = createPreferencesGroup({ title: _('Connection &amp; Model') });
    createStringRow(
        _('Base URL'),
        _(
            'e.g. https://api.openai.com/v1 — change only when using a proxy or compatible endpoint.',
        ),
        'openai-url',
        openaiGroup,
    );
    createStringRow(
        _('API Key'),
        _('Your OpenAI secret key starting with sk-. Never share or commit this value.'),
        'openai-api-key',
        openaiGroup,
        true,
    );
    createStringRow(
        _('Model'),
        _('The model ID from your OpenAI account, such as gpt-4o or gpt-4o-mini.'),
        'openai-model',
        openaiGroup,
    );
    openaiPage.add(openaiGroup);

    // --- Anthropic Settings ---
    const anthropicPage = createProviderPage('anthropic');
    const anthropicGroup = createPreferencesGroup({ title: _('Connection &amp; Model') });
    createStringRow(
        _('Base URL'),
        _('e.g. https://api.anthropic.com — change only when using a proxy.'),
        'anthropic-url',
        anthropicGroup,
    );
    createStringRow(
        _('API Key'),
        _('Your Anthropic key starting with sk-ant-. Never share or commit this value.'),
        'anthropic-api-key',
        anthropicGroup,
        true,
    );
    createStringRow(
        _('Model'),
        _('The Claude model ID from your account, such as claude-opus-4-5.'),
        'anthropic-model',
        anthropicGroup,
    );
    anthropicPage.add(anthropicGroup);
}
