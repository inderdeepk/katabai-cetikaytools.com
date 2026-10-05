import Gtk from 'gi://Gtk';
import { WebSearchRuntime, readWebSearchConfig } from '../../../tools/webSearchTools.js';

// Web Search (SearxNG) settings section for the Tools page.
export function buildWebSearchSection(ctx) {
    const {
        settings,
        createToolSubpage,
        createPreferencesGroup,
        createBooleanRow,
        createInfoRow,
        createStringRow,
        createIntRow,
        createChoiceRow,
        bindChoiceRow,
        createStatusRow,
        setStatusBadge,
        createButtonRow,
        createInstructionRow,
        addCssClasses,
    } = ctx;

    const subpage = createToolSubpage('Web Search');
    const detailPage = subpage.detailPage;

    const noticeGroup = createPreferencesGroup({});
    detailPage.add(noticeGroup);
    const noticeRow = createInfoRow(
        'How web search works per provider',
        'When Unsloth Studio is the active provider, web search, Python, and terminal run on Unsloth\u2019s own servers. This local SearxNG-powered tool applies to the Ollama, OpenAI, Anthropic, and DeepSeek providers.',
        noticeGroup,
    );
    noticeRow.add_prefix(
        addCssClasses(
            new Gtk.Image({
                icon_name: 'dialog-information-symbolic',
                valign: Gtk.Align.CENTER,
            }),
            'katab-prefs-tool-icon',
        ),
    );

    const connectionGroup = createPreferencesGroup({
        title: 'Connection',
        description:
            'Katab queries your own self-hosted SearxNG instance over its JSON API. No third-party search keys are required.',
    });
    detailPage.add(connectionGroup);

    createBooleanRow(
        'Enable Web Search',
        'Allow the /search command and let supported models look things up on the web.',
        'web-search-enabled',
        connectionGroup,
    );

    createStringRow(
        'SearxNG Instance URL',
        'Base URL of your SearxNG instance, e.g. http://localhost:8080.',
        'web-search-url',
        connectionGroup,
    );

    const { row: connStatusRow, badge: connBadge } = createStatusRow(
        'Connection Status',
        'Run a test query to confirm the instance is reachable and JSON output is enabled.',
        connectionGroup,
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
            webSearchTestRuntime
                .testConnection(config)
                .then((result) => {
                    if (result.ok) {
                        setStatusBadge(connBadge, 'Connected', 'katab-prefs-status-detected');
                        connStatusRow.subtitle = `Reachable. Sample query returned ${result.resultCount} result(s).`;
                    } else {
                        setStatusBadge(connBadge, 'Failed', 'katab-prefs-status-install');
                        connStatusRow.subtitle = result.message;
                    }
                })
                .catch((error) => {
                    setStatusBadge(connBadge, 'Failed', 'katab-prefs-status-install');
                    connStatusRow.subtitle = error?.message || 'Connection test failed.';
                });
        },
        connectionGroup,
    );

    const behaviorGroup = createPreferencesGroup({
        title: 'Search Behavior',
        description: 'Tune how Katab queries SearxNG and how much content it returns to the model.',
    });
    detailPage.add(behaviorGroup);

    createIntRow(
        'Result Limit',
        'Maximum number of search results passed to the model per query (1\u201330).',
        'web-search-result-limit',
        behaviorGroup,
        1,
        30,
        1,
    );

    const timeRangeRow = createChoiceRow(
        'Time Range',
        'Restrict results to a recent time window.',
        behaviorGroup,
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
        settings.set_string.bind(settings),
    );

    const safesearchRow = createChoiceRow(
        'Safe Search',
        'Content filtering level forwarded to SearxNG.',
        behaviorGroup,
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
        (value) => `Level ${value}`,
    );

    const categoriesRow = createChoiceRow(
        'Category',
        'Primary SearxNG category to search within.',
        behaviorGroup,
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
        settings.set_string.bind(settings),
    );

    const languageRow = createChoiceRow('Language', 'Preferred result language.', behaviorGroup);
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
        (value) => `Custom (${value})`,
    );

    createStringRow(
        'Preferred Engines',
        'Optional comma-separated SearxNG engine names, e.g. google,bing,duckduckgo. Leave blank for the instance default.',
        'web-search-engines',
        behaviorGroup,
    );

    createStringRow(
        'API Key',
        'Optional value sent as the Authorization header if your instance is protected.',
        'web-search-api-key',
        behaviorGroup,
        true,
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
        advancedGroup,
    );

    createBooleanRow(
        'Multi-Query Expansion',
        'Generate a few related queries from your prompt and merge the results. Off by default for faster, cheaper searches.',
        'web-search-multiquery-enabled',
        advancedGroup,
    );

    createBooleanRow(
        'Autonomous Tool Use',
        'Advertise web search to supported models so they can decide when to look things up. With this off, only the manual /search command runs.',
        'web-search-autonomous-enabled',
        advancedGroup,
    );

    createBooleanRow(
        'Allow Local Addresses',
        'Permit fetching localhost and private LAN addresses when reading page content. Leave off unless you fully trust your network.',
        'web-search-allow-local-addresses',
        advancedGroup,
    );

    createIntRow(
        'Max Tool Iterations',
        'Rounds of sequential tool calls the model may trigger per message before being forced to answer. Higher values let the model keep browsing when it is on a close trail (1\u2013100).',
        'web-search-max-tool-iterations',
        advancedGroup,
        1,
        100,
        1,
    );

    const setupGroup = createPreferencesGroup({
        title: 'SearxNG Setup',
        description:
            'Katab does not bundle a search engine. Run your own SearxNG instance and enable its JSON API.',
    });
    detailPage.add(setupGroup);

    createInstructionRow(
        'Run SearxNG with Docker',
        'docker run -d --name searxng -p 8080:8080 searxng/searxng',
        setupGroup,
    );
    createInstructionRow(
        'Enable the JSON API',
        'In settings.yml add "json" to the search.formats list, then restart the container. Without it SearxNG returns HTTP 403 to API calls.',
        setupGroup,
    );

    return subpage;
}
