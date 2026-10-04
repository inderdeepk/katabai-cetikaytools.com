// Simple provider pages (Unsloth / OpenAI / Anthropic) — connection and model
// settings built by the shared provider-page scaffolding.
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
    const unslothGroup = createPreferencesGroup({ title: 'Connection & Model' });
    createStringRow(
        'Base URL',
        'e.g. http://localhost:8888/v1 — the Unsloth Studio API root.',
        'unsloth-url',
        unslothGroup,
    );
    createStringRow(
        'API Key',
        'Leave blank for local instances running without authentication.',
        'unsloth-api-key',
        unslothGroup,
        true,
    );
    createStringRow(
        'Model',
        'The model identifier served by your Unsloth Studio instance.',
        'unsloth-model',
        unslothGroup,
    );
    createIntRow(
        'Context Window Size',
        'Maximum tokens per request. Match this to your loaded model capacity.',
        'unsloth-num-ctx',
        unslothGroup,
        1024,
        1048576,
        1024,
    );
    unslothPage.add(unslothGroup);

    const unslothToolsGroup = createPreferencesGroup({
        title: 'Tools',
        description:
            'Unsloth Studio runs web search, Python, and terminal as server-side tools on its own backend.',
    });
    unslothPage.add(unslothToolsGroup);
    createInfoRow(
        'Server-side tools',
        'When Unsloth is the active provider, tool calls are executed by Unsloth Studio, not by Katab. The local SearxNG Web Search tool on the Tools page applies to the Ollama, OpenAI, Anthropic, and DeepSeek providers instead.',
        unslothToolsGroup,
    );
    const openaiPage = createProviderPage('openai');
    const openaiGroup = createPreferencesGroup({ title: 'Connection & Model' });
    createStringRow(
        'Base URL',
        'e.g. https://api.openai.com/v1 — change only when using a proxy or compatible endpoint.',
        'openai-url',
        openaiGroup,
    );
    createStringRow(
        'API Key',
        'Your OpenAI secret key starting with sk-. Never share or commit this value.',
        'openai-api-key',
        openaiGroup,
        true,
    );
    createStringRow(
        'Model',
        'The model ID from your OpenAI account, such as gpt-4o or gpt-4o-mini.',
        'openai-model',
        openaiGroup,
    );
    openaiPage.add(openaiGroup);

    // --- Anthropic Settings ---
    const anthropicPage = createProviderPage('anthropic');
    const anthropicGroup = createPreferencesGroup({ title: 'Connection & Model' });
    createStringRow(
        'Base URL',
        'e.g. https://api.anthropic.com — change only when using a proxy.',
        'anthropic-url',
        anthropicGroup,
    );
    createStringRow(
        'API Key',
        'Your Anthropic key starting with sk-ant-. Never share or commit this value.',
        'anthropic-api-key',
        anthropicGroup,
        true,
    );
    createStringRow(
        'Model',
        'The Claude model ID from your account, such as claude-opus-4-5.',
        'anthropic-model',
        anthropicGroup,
    );
    anthropicPage.add(anthropicGroup);
}
