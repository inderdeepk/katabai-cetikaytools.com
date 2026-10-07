import Gtk from 'gi://Gtk';
import { WebSearchRuntime, readWebSearchConfig } from '../../../tools/webSearchTools.js';
import { gettext as _, format } from '../../../shared/i18n.js';

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

    const subpage = createToolSubpage(_('Web Search'));
    const detailPage = subpage.detailPage;

    const noticeGroup = createPreferencesGroup({});
    detailPage.add(noticeGroup);
    const noticeRow = createInfoRow(
        _('How web search works per provider'),
        _(
            'When Unsloth Studio is the active provider, web search, Python, and terminal run on Unsloth\u2019s own servers. This local SearxNG-powered tool applies to the Ollama, OpenAI, Anthropic, and DeepSeek providers.',
        ),
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
        title: _('Connection'),
        description: _(
            'Katab queries your own self-hosted SearxNG instance over its JSON API. No third-party search keys are required.',
        ),
    });
    detailPage.add(connectionGroup);

    createBooleanRow(
        _('Enable Web Search'),
        _('Allow the /search command and let supported models look things up on the web.'),
        'web-search-enabled',
        connectionGroup,
    );

    createStringRow(
        _('SearxNG Instance URL'),
        _('Base URL of your SearxNG instance, e.g. http://localhost:8080.'),
        'web-search-url',
        connectionGroup,
    );

    const { row: connStatusRow, badge: connBadge } = createStatusRow(
        _('Connection Status'),
        _('Run a test query to confirm the instance is reachable and JSON output is enabled.'),
        connectionGroup,
    );
    setStatusBadge(connBadge, _('Untested'), null);

    const webSearchTestRuntime = new WebSearchRuntime({ timeoutSeconds: 12 });
    createButtonRow(
        _('Test Connection'),
        _('Send a sample query to verify the SearxNG endpoint responds with JSON results.'),
        _('Test'),
        () => {
            setStatusBadge(connBadge, _('Testing'), null);
            connStatusRow.subtitle = _('Contacting the SearxNG instance\u2026');
            const config = readWebSearchConfig(settings);
            webSearchTestRuntime
                .testConnection(config)
                .then((result) => {
                    if (result.ok) {
                        setStatusBadge(connBadge, _('Connected'), 'katab-prefs-status-detected');
                        connStatusRow.subtitle = format(
                            _('Reachable. Sample query returned {count} result(s).'),
                            { count: result.resultCount },
                        );
                    } else {
                        setStatusBadge(connBadge, _('Failed'), 'katab-prefs-status-install');
                        connStatusRow.subtitle = result.message;
                    }
                })
                .catch((error) => {
                    setStatusBadge(connBadge, _('Failed'), 'katab-prefs-status-install');
                    connStatusRow.subtitle = error?.message || _('Connection test failed.');
                });
        },
        connectionGroup,
    );

    const behaviorGroup = createPreferencesGroup({
        title: _('Search Behavior'),
        description: _(
            'Tune how Katab queries SearxNG and how much content it returns to the model.',
        ),
    });
    detailPage.add(behaviorGroup);

    createIntRow(
        _('Result Limit'),
        _('Maximum number of search results passed to the model per query (1\u201330).'),
        'web-search-result-limit',
        behaviorGroup,
        1,
        30,
        1,
    );

    const timeRangeRow = createChoiceRow(
        _('Time Range'),
        _('Restrict results to a recent time window.'),
        behaviorGroup,
    );
    bindChoiceRow(
        timeRangeRow,
        'web-search-time-range',
        [
            { value: '', label: _('Any time') },
            { value: 'day', label: _('Past day') },
            { value: 'week', label: _('Past week') },
            { value: 'month', label: _('Past month') },
            { value: 'year', label: _('Past year') },
        ],
        settings.get_string.bind(settings),
        settings.set_string.bind(settings),
    );

    const safesearchRow = createChoiceRow(
        _('Safe Search'),
        _('Content filtering level forwarded to SearxNG.'),
        behaviorGroup,
    );
    bindChoiceRow(
        safesearchRow,
        'web-search-safesearch',
        [
            { value: 0, label: _('Off') },
            { value: 1, label: _('Moderate') },
            { value: 2, label: _('Strict') },
        ],
        settings.get_int.bind(settings),
        settings.set_int.bind(settings),
        (value) => format(_('Level {value}'), { value }),
    );

    const categoriesRow = createChoiceRow(
        _('Category'),
        _('Primary SearxNG category to search within.'),
        behaviorGroup,
    );
    bindChoiceRow(
        categoriesRow,
        'web-search-categories',
        [
            { value: 'general', label: _('General') },
            { value: 'news', label: _('News') },
            { value: 'science', label: _('Science') },
            { value: 'it', label: _('IT') },
            { value: 'files', label: _('Files') },
            { value: 'social media', label: _('Social Media') },
        ],
        settings.get_string.bind(settings),
        settings.set_string.bind(settings),
    );

    const languageRow = createChoiceRow(
        _('Language'),
        _('Preferred result language.'),
        behaviorGroup,
    );
    bindChoiceRow(
        languageRow,
        'web-search-language',
        [
            { value: '', label: _('Any language') },
            { value: 'en', label: _('English') },
            { value: 'es', label: _('Spanish') },
            { value: 'fr', label: _('French') },
            { value: 'de', label: _('German') },
            { value: 'it', label: _('Italian') },
            { value: 'pt', label: _('Portuguese') },
            { value: 'ru', label: _('Russian') },
            { value: 'zh', label: _('Chinese') },
            { value: 'ja', label: _('Japanese') },
        ],
        settings.get_string.bind(settings),
        settings.set_string.bind(settings),
        (value) => format(_('Custom ({value})'), { value }),
    );

    createStringRow(
        _('Preferred Engines'),
        _(
            'Optional comma-separated SearxNG engine names, e.g. google,bing,duckduckgo. Leave blank for the instance default.',
        ),
        'web-search-engines',
        behaviorGroup,
    );

    createStringRow(
        _('API Key'),
        _('Optional value sent as the Authorization header if your instance is protected.'),
        'web-search-api-key',
        behaviorGroup,
        true,
    );

    const advancedGroup = createPreferencesGroup({
        title: _('Advanced'),
        description: _('Page reading, multi-query expansion, and autonomous tool use.'),
    });
    detailPage.add(advancedGroup);

    createBooleanRow(
        _('Read Page Content'),
        _(
            'Let the model open a result link and extract the readable text of that page (HTML and PDF).',
        ),
        'web-search-fetch-page-enabled',
        advancedGroup,
    );

    createBooleanRow(
        _('Multi-Query Expansion'),
        _(
            'Generate a few related queries from your prompt and merge the results. Off by default for faster, cheaper searches.',
        ),
        'web-search-multiquery-enabled',
        advancedGroup,
    );

    createBooleanRow(
        _('Autonomous Tool Use'),
        _(
            'Advertise web search to supported models so they can decide when to look things up. With this off, only the manual /search command runs.',
        ),
        'web-search-autonomous-enabled',
        advancedGroup,
    );

    createBooleanRow(
        _('Allow Local Addresses'),
        _(
            'Permit fetching localhost and private LAN addresses when reading page content. Leave off unless you fully trust your network.',
        ),
        'web-search-allow-local-addresses',
        advancedGroup,
    );

    createIntRow(
        _('Max Tool Iterations'),
        _(
            'Rounds of sequential tool calls the model may trigger per message before being forced to answer. Higher values let the model keep browsing when it is on a close trail (1\u2013100).',
        ),
        'web-search-max-tool-iterations',
        advancedGroup,
        1,
        100,
        1,
    );

    const setupGroup = createPreferencesGroup({
        title: _('SearxNG Setup'),
        description: _(
            'Katab does not bundle a search engine. Run your own SearxNG instance and enable its JSON API.',
        ),
    });
    detailPage.add(setupGroup);

    createInstructionRow(
        _('Run SearxNG with Docker'),
        'docker run -d --name searxng -p 8080:8080 searxng/searxng',
        setupGroup,
    );
    createInstructionRow(
        _('Enable the JSON API'),
        _(
            'In settings.yml add "json" to the search.formats list, then restart the container. Without it SearxNG returns HTTP 403 to API calls.',
        ),
        setupGroup,
    );

    return subpage;
}
