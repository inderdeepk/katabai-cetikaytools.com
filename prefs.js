import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import Soup from 'gi://Soup?version=3.0';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import { WebSearchRuntime, readWebSearchConfig } from './src/tools/webSearchTools.js';
import { Crawl4AIRuntime, readCrawl4AIConfig } from './src/tools/crawl4aiTools.js';
import { createPrefsContext } from './src/ui/prefs/widgets.js';
import { buildGeneralPage } from './src/ui/prefs/generalPage.js';
import { buildOllamaPage } from './src/ui/prefs/ollamaPage.js';
import { buildDeepSeekPage } from './src/ui/prefs/deepseekPage.js';
import { buildSimpleProviderPages } from './src/ui/prefs/providerPages.js';

export default class KatabPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        window.search_enabled = true;
        window.add_css_class('katab-prefs-window');
        window.default_width = 740;
        window.default_height = 660;

        const settings = this.getSettings('org.gnome.shell.extensions.katabai');
        const extensionPath = this.path;
        const iconDirectory = `${extensionPath}/icons`;

        const display = window.get_display();
        if (display) {
            const iconTheme = Gtk.IconTheme.get_for_display(display);
            try {
                const searchPaths = iconTheme.get_search_path();
                if (!searchPaths.includes(iconDirectory)) {
                    iconTheme.add_search_path(iconDirectory);
                }
            } catch (_e) {
                iconTheme.add_search_path(iconDirectory);
            }

            if (!this._prefsCssLoaded) {
                const cssProvider = new Gtk.CssProvider();
                cssProvider.load_from_path(`${extensionPath}/prefs.css`);
                Gtk.StyleContext.add_provider_for_display(
                    display,
                    cssProvider,
                    Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION,
                );
                this._prefsCssLoaded = true;
            }

            const applyPrefsTheme = () => {
                try {
                    const styleManager = Adw.StyleManager.get_default();
                    const isDark = styleManager.get_dark();
                    window.remove_css_class('katab-prefs-theme-dark');
                    window.remove_css_class('katab-prefs-theme-light');
                    window.add_css_class(
                        isDark ? 'katab-prefs-theme-dark' : 'katab-prefs-theme-light',
                    );
                } catch (_e) {
                    window.add_css_class('katab-prefs-theme-dark');
                }
            };
            applyPrefsTheme();
            try {
                const styleManager = Adw.StyleManager.get_default();
                const themeHandlerId = styleManager.connect('notify::dark', applyPrefsTheme);
                window.connect('destroy', () => styleManager.disconnect(themeHandlerId));
            } catch (_e) {
                /* StyleManager unavailable */
            }
        }

        // Shared widget factories (page/group/row builders, badges, shortcut
        // capture, tool subpage scaffolding) live in src/ui/prefs/widgets.js.
        // Destructured below so call sites keep their existing names;
        // ctx.watch() is preferred for new GSettings handlers so
        // window-destroy cleanup is automatic.
        const ctx = createPrefsContext({ settings, window, extensionPath });
        const {
            addCssClasses,
            createPreferencesPage,
            createPreferencesGroup,
            createExpanderRow,
            createChoiceRow,
            bindChoiceRow,
            createStringRow,
            createMultilineStringRow,
            createIntRow,
            createDoubleRow,
            createBooleanRow,
            createInfoRow,
            createInstructionRow,
            createButtonRow,
            createStatusRow,
            setStatusBadge,
            createToolSubpage,
            createToolIndexRow,
        } = ctx;
        window.connect('destroy', () => ctx.dispose());

        buildGeneralPage(ctx);

        buildOllamaPage(ctx);

        buildDeepSeekPage(ctx);

        buildSimpleProviderPages(ctx);

        // --- Tools Settings ---
        const toolsPage = createPreferencesPage({
            title: 'Tools',
            icon_name: 'applications-utilities-symbolic',
        });
        window.add(toolsPage);

        const toolsIndexGroup = createPreferencesGroup({
            title: 'Available Tools',
            description:
                'Optional capabilities Katab can offer the model. Select a tool to open its dedicated settings. Normal chat does not depend on any of these.',
        });
        toolsPage.add(toolsIndexGroup);

        // ----- Document tool detail subpage -----
        const documentSubpage = createToolSubpage('Document Tool');
        {
            const detailPage = documentSubpage.detailPage;

            const documentToolGroup = createPreferencesGroup({
                title: 'Document Tool',
                description:
                    'Optional local file support for chat. Documents are parsed locally, and images can be sent to Ollama vision models.',
            });
            detailPage.add(documentToolGroup);

            createBooleanRow(
                'Enable Document Tool',
                'Show the chat attachment button and enable the /doc command for local files.',
                'document-tool-enabled',
                documentToolGroup,
            );

            const documentUsageRow = createInfoRow('How it works', '', documentToolGroup);
            const syncDocumentUsageRow = () => {
                documentUsageRow.subtitle = settings.get_boolean('document-tool-enabled')
                    ? 'Use the attachment button in chat or type /doc with a quoted path. Katab extracts text from supported documents locally, and sends PNG/JPG images only to Ollama vision models.'
                    : 'Turn this on only if you want local file parsing. Normal chat does not depend on this tool.';
            };
            settings.connect('changed::document-tool-enabled', syncDocumentUsageRow);
            syncDocumentUsageRow();

            const capabilityGroup = createPreferencesGroup({
                title: 'Detected Capabilities',
                description:
                    'Katab scans the local system at runtime. Text, Markdown, PNG/JPG, and EML support is built in; PDF parsing needs poppler-utils; DOCX conversion needs pandoc.',
            });
            detailPage.add(capabilityGroup);

            const textStatusRow = createStatusRow(
                'Text and Markdown',
                'Plain text and Markdown are handled directly through native Gio file reads.',
                capabilityGroup,
            );
            const imageStatusRow = createStatusRow(
                'Images (PNG/JPG)',
                'PNG and JPG attachments are base64-encoded locally and sent only to Ollama vision-capable models.',
                capabilityGroup,
            );
            const pdfStatusRow = createStatusRow(
                'PDF Documents',
                'Install poppler-utils to expose pdftotext for fast PDF text extraction.',
                capabilityGroup,
            );
            const docxStatusRow = createStatusRow(
                'Word Documents (.docx)',
                'Install pandoc to convert DOCX files into plain text before sending them to the model.',
                capabilityGroup,
            );
            const emlStatusRow = createStatusRow(
                'Email Messages (.eml)',
                "EML email files are parsed locally with Katab's built-in MIME reader — headers, body text, and attachment names are extracted without any external tool.",
                capabilityGroup,
            );

            const refreshDocumentToolStatus = () => {
                setStatusBadge(textStatusRow.badge, 'Built in', 'katab-prefs-status-builtin');
                setStatusBadge(imageStatusRow.badge, 'Built in', 'katab-prefs-status-builtin');
                setStatusBadge(emlStatusRow.badge, 'Built in', 'katab-prefs-status-builtin');

                const pdfPath = GLib.find_program_in_path('pdftotext');
                if (pdfPath) {
                    pdfStatusRow.row.subtitle = `Detected pdftotext at ${pdfPath}. PDF parsing is ready.`;
                    setStatusBadge(pdfStatusRow.badge, 'Detected', 'katab-prefs-status-detected');
                } else {
                    pdfStatusRow.row.subtitle =
                        'Install poppler-utils to expose pdftotext for fast PDF text extraction.';
                    setStatusBadge(pdfStatusRow.badge, 'Install', 'katab-prefs-status-install');
                }

                const pandocPath = GLib.find_program_in_path('pandoc');
                if (pandocPath) {
                    docxStatusRow.row.subtitle = `Detected pandoc at ${pandocPath}. DOCX parsing is ready.`;
                    setStatusBadge(docxStatusRow.badge, 'Detected', 'katab-prefs-status-detected');
                } else {
                    docxStatusRow.row.subtitle =
                        'Install pandoc to convert DOCX files into plain text before sending them to the model.';
                    setStatusBadge(docxStatusRow.badge, 'Install', 'katab-prefs-status-install');
                }
            };

            createButtonRow(
                'Refresh Detection',
                'Re-scan the local system after installing or removing parser packages.',
                'Refresh',
                refreshDocumentToolStatus,
                capabilityGroup,
            );

            refreshDocumentToolStatus();
        }

        // ----- Web search tool detail subpage -----
        const webSearchSubpage = createToolSubpage('Web Search');
        {
            const detailPage = webSearchSubpage.detailPage;

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
                                setStatusBadge(
                                    connBadge,
                                    'Connected',
                                    'katab-prefs-status-detected',
                                );
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
                description:
                    'Tune how Katab queries SearxNG and how much content it returns to the model.',
            });
            detailPage.add(behaviorGroup);

            createIntRow(
                'Result Limit',
                'Maximum number of search results passed to the model per query (1\u201320).',
                'web-search-result-limit',
                behaviorGroup,
                1,
                20,
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

            const languageRow = createChoiceRow(
                'Language',
                'Preferred result language.',
                behaviorGroup,
            );
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
                'Rounds of sequential tool calls the model may trigger per message before being forced to answer. Raise if the model needs more search/read steps.',
                'web-search-max-tool-iterations',
                advancedGroup,
                1,
                50,
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
        }

        // ----- Web Scraper tool detail subpage (Crawl4AI) -----
        const crawl4aiSubpage = createToolSubpage('Web Scraper');
        {
            const detailPage = crawl4aiSubpage.detailPage;

            const noticeGroup = createPreferencesGroup({});
            detailPage.add(noticeGroup);
            const noticeRow = createInfoRow(
                'How web scraping works',
                'Crawl4AI is a high-performance, LLM-friendly web crawler that renders pages in a real browser (Chromium), executes JavaScript, and extracts clean Markdown. Katab uses it to deep-scrape page content after SearxNG discovers URLs. Deploy your own Crawl4AI v0.9.x Docker container on any machine with sufficient RAM for Chromium.',
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

            // ---- Setup (collapsible) ----
            const crawlSetupExpander = createExpanderRow({});
            crawlSetupExpander.add_prefix(
                addCssClasses(
                    new Gtk.Label({
                        label: 'Setup \u2014 Deploy Crawl4AI with Docker',
                        xalign: 0,
                        halign: Gtk.Align.START,
                    }),
                    'katab-prefs-expander-title',
                ),
            );
            crawlSetupExpander.subtitle =
                'Crawl4AI must be running in Docker for Katab to deep-scrape web pages.';
            noticeGroup.add(crawlSetupExpander);

            createInstructionRow(
                'Docker Compose (Recommended)',
                [
                    'The official docker-compose.yml is the simplest way to deploy Crawl4AI.',
                    '',
                    '1. Clone the repository',
                    '',
                    '   git clone https://github.com/unclecode/crawl4ai.git',
                    '   cd crawl4ai',
                    '',
                    '2. Create the environment file with all required variables',
                    '',
                    '   cp deploy/docker/.llm.env.example .llm.env',
                    '   nano .llm.env',
                    '',
                    '   Add these lines (the compose file reads from .llm.env):',
                    '',
                    '   # Required — Crawl4AI API authentication token',
                    '   # Generate one with: openssl rand -hex 32',
                    '   CRAWL4AI_API_TOKEN=your-secret-token-here',
                    '',
                    '   # Recommended — prevents issued tokens from',
                    '   # being invalidated on container restart',
                    '   SECRET_KEY=another-strong-random-string',
                    '',
                    '   # Optional — Redis password for the internal cache',
                    '   # (auto-generated if left unset)',
                    '   REDIS_PASSWORD=your-redis-password',
                    '',
                    '   # Optional — LLM provider for AI extraction',
                    '   # Katab defaults to DeepSeek V4.1 Flash, so set the',
                    '   # provider and its key here (the compose file reads',
                    '   # all variables from .llm.env):',
                    '   LLM_PROVIDER=deepseek/deepseek-flash',
                    '   DEEPSEEK_API_KEY=sk-...',
                    '   # Other providers work too — change LLM_PROVIDER and',
                    "   # add that provider's key, e.g. OPENAI_API_KEY,",
                    '   # ANTHROPIC_API_KEY, etc.',
                    '',
                    '   The docker-compose.yml reads ALL environment',
                    '   variables from .llm.env via the env_file directive.',
                    '   Enter the same CRAWL4AI_API_TOKEN value in the',
                    '   API Token field in the Connection section below.',
                    '',
                    '3. Fix a known docker-compose.yml conflict (if needed)',
                    '',
                    '   The official docker-compose.yml may define pids_limit',
                    '   in two places, causing a Compose error:',
                    '',
                    '   "can\'t set distinct values on pids_limit and',
                    '    deploy.resources.limits.pids"',
                    '',
                    '   Fix: open docker-compose.yml and remove the line',
                    '   "pids_limit: 512" from the x-base-config section.',
                    '   (The deploy.resources.limits.pids setting is sufficient.)',
                    '',
                    '   The "version is obsolete" warning is harmless',
                    '   and can be ignored.',
                    '',
                    '4. Start Crawl4AI',
                    '',
                    '   docker compose up -d',
                    '',
                    '   The server will be available at http://localhost:11235.',
                    '',
                    "5. Verify it's running",
                    '',
                    '   curl http://localhost:11235/health',
                    '',
                    '   Check the logs to confirm the token was picked up:',
                    '',
                    '   docker compose logs',
                    '',
                    '   (Compose names the container after the folder you',
                    '   cloned into, e.g. crawl4ai-crawl4ai-1 here. Using',
                    '   "docker compose logs" works no matter the name. To',
                    '   target a container directly, list them first with:',
                    '   docker ps)',
                    '',
                    '   Look for: "CRAWL4AI_API_TOKEN is set"',
                    '   If you see "CRAWL4AI_API_TOKEN is not set"',
                    '   double-check your .llm.env file.',
                    '',
                    '   You can also visit http://localhost:11235/playground',
                    '   for an interactive testing interface.',
                    '',
                    '6. Stop when done',
                    '',
                    '   docker compose down',
                ].join('\n'),
                crawlSetupExpander,
            );

            createInstructionRow(
                'Minimal Setup (Single Container)',
                [
                    'If you prefer not to clone the repository, you can run',
                    'the official Docker image directly:',
                    '',
                    '   docker run -d \\',
                    '     --name crawl4ai \\',
                    '     -p 11235:11235 \\',
                    '     -e CRAWL4AI_API_TOKEN=your-secret-token \\',
                    '     -e SECRET_KEY=another-strong-random-string \\',
                    '     --shm-size=1g \\',
                    '     unclecode/crawl4ai:latest',
                    '',
                    'Generate secure tokens with: openssl rand -hex 32',
                    'The --shm-size=1g flag is required for Chromium to work.',
                    'Plan for at least 4 GB RAM dedicated to this container,',
                    'especially when crawling JavaScript-heavy pages.',
                    '',
                    'Check logs to confirm the token was picked up:',
                    '',
                    '   docker logs crawl4ai',
                    '',
                    'Look for: "CRAWL4AI_API_TOKEN is set"',
                ].join('\n'),
                crawlSetupExpander,
            );

            createInstructionRow(
                'API Token Authentication',
                [
                    'Crawl4AI v0.9.x requires an API token for all requests.',
                    '',
                    'For Docker Compose: add CRAWL4AI_API_TOKEN to the',
                    '.llm.env file — the compose file reads all variables',
                    'from there via the env_file directive.',
                    '',
                    'For single-container: pass it with -e as shown above.',
                    '',
                    'Generate a secure token:',
                    '',
                    '   openssl rand -hex 32',
                    '',
                    'Enter the same token in the API Token field in the',
                    'Connection section below. Katab sends it as a Bearer',
                    'token in the Authorization header.',
                    '',
                    'If your instance was started without a token, Crawl4AI',
                    'auto-generates an ephemeral one and prints it in the logs.',
                    'Leave the API Token field empty for unauthenticated instances',
                    '(older versions or local dev mode).',
                ].join('\n'),
                crawlSetupExpander,
            );

            createInstructionRow(
                'Security Notes',
                [
                    'The Docker Compose setup is security-hardened:',
                    '\u2022 Runs as non-root user (appuser)',
                    '\u2022 Drops all Linux capabilities',
                    '\u2022 Read-only root filesystem',
                    '\u2022 No privilege escalation',
                    '\u2022 PID limit of 512',
                    '\u2022 Health check with auto-restart',
                    '',
                    'Katab connects to Crawl4AI over HTTP by default.',
                    'For remote deployments, place a reverse proxy',
                    '(nginx / Caddy) with TLS in front, or use a VPN tunnel.',
                ].join('\n'),
                crawlSetupExpander,
            );

            // ---- Connection ----
            const connectionGroup = createPreferencesGroup({
                title: 'Connection',
                description: 'Point Katab at your self-hosted Crawl4AI Docker instance.',
            });
            detailPage.add(connectionGroup);

            createBooleanRow(
                'Enable Web Scraper',
                'Allow the /crawl command and let supported models deep-scrape web pages through Crawl4AI.',
                'crawl4ai-enabled',
                connectionGroup,
            );

            createStringRow(
                'Crawl4AI Instance URL',
                'Base URL of your Crawl4AI v0.9.x instance, e.g. http://localhost:11235.',
                'crawl4ai-url',
                connectionGroup,
            );

            createStringRow(
                'API Token',
                'JWT Bearer token set via CRAWL4AI_API_TOKEN when deploying the container. Required only when the instance has security enabled.',
                'crawl4ai-api-token',
                connectionGroup,
                true,
            );

            const { row: crawlConnStatusRow, badge: crawlConnBadge } = createStatusRow(
                'Connection Status',
                'Run a health check to confirm the instance is reachable.',
                connectionGroup,
            );
            setStatusBadge(crawlConnBadge, 'Untested', null);

            const crawlTestRuntime = new Crawl4AIRuntime({ timeoutSeconds: 12 });
            createButtonRow(
                'Test Connection',
                'Send a health check to verify the Crawl4AI endpoint responds.',
                'Test',
                () => {
                    setStatusBadge(crawlConnBadge, 'Testing', null);
                    crawlConnStatusRow.subtitle = 'Contacting the Crawl4AI instance\u2026';
                    const config = readCrawl4AIConfig(settings);
                    crawlTestRuntime
                        .testConnection(config)
                        .then((result) => {
                            if (result.ok) {
                                setStatusBadge(
                                    crawlConnBadge,
                                    'Connected',
                                    'katab-prefs-status-detected',
                                );
                                crawlConnStatusRow.subtitle = result.version
                                    ? `Reachable. Server: ${result.version}`
                                    : 'Reachable.';
                            } else {
                                setStatusBadge(
                                    crawlConnBadge,
                                    'Failed',
                                    'katab-prefs-status-install',
                                );
                                crawlConnStatusRow.subtitle =
                                    result.message || 'Connection test failed.';
                            }
                        })
                        .catch((error) => {
                            setStatusBadge(crawlConnBadge, 'Failed', 'katab-prefs-status-install');
                            crawlConnStatusRow.subtitle =
                                error?.message || 'Connection test failed.';
                        });
                },
                connectionGroup,
            );

            // ---- Extraction ----
            const extractionGroup = createPreferencesGroup({
                title: 'Extraction',
                description:
                    'How Crawl4AI filters and formats page content before sending it to the model.',
            });
            detailPage.add(extractionGroup);

            const fitMarkdownRow = createChoiceRow(
                'Content Filter',
                'Algorithm used to strip boilerplate and extract the core page content.',
                extractionGroup,
            );
            bindChoiceRow(
                fitMarkdownRow,
                'crawl4ai-fit-markdown-mode',
                [
                    { value: 'pruning', label: 'Pruning (Heuristic)' },
                    { value: 'bm25', label: 'BM25 (Query-Focused)' },
                ],
                settings.get_string.bind(settings),
                settings.set_string.bind(settings),
            );

            const cacheRow = createChoiceRow(
                'Cache Mode',
                'Controls Crawl4AI\u2019s internal cache behavior.',
                extractionGroup,
            );
            bindChoiceRow(
                cacheRow,
                'crawl4ai-cache-mode',
                [
                    { value: 'bypass', label: 'Bypass (Always Fresh)' },
                    { value: 'enabled', label: 'Enabled (Faster Repeats)' },
                    { value: 'read_only', label: 'Read-Only (No Network)' },
                ],
                settings.get_string.bind(settings),
                settings.set_string.bind(settings),
            );

            createIntRow(
                'Minimum Word Count',
                'Pages with fewer words are discarded before Markdown generation (1\u2013200).',
                'crawl4ai-word-count-threshold',
                extractionGroup,
                1,
                200,
                1,
            );

            createIntRow(
                'Page Timeout',
                'Maximum seconds to wait for a page to render before giving up (10\u2013300).',
                'crawl4ai-page-timeout',
                extractionGroup,
                10,
                300,
                5,
            );

            createIntRow(
                'Maximum Output Characters',
                'Truncation cap on extracted Markdown fed to the model context (500\u2013100000).',
                'crawl4ai-max-chars',
                extractionGroup,
                500,
                100000,
                500,
            );

            // ---- LLM Extraction (Optional) ----
            const llmGroup = createPreferencesGroup({
                title: 'LLM Extraction (Optional)',
                description:
                    'Ask an LLM running on your Crawl4AI server to extract structured JSON or a freeform answer instead of raw Markdown. Fully optional \u2014 the default Markdown pipeline is unchanged.',
            });
            detailPage.add(llmGroup);

            createInstructionRow(
                'How to enable AI extraction',
                'Pick an Extraction Mode below (Schema for structured JSON, Block for a freeform answer). ' +
                    'The LLM Provider defaults to DeepSeek V4.1 Flash, and both modes ship with a sensible default ' +
                    'output setup. Extraction runs through Crawl4AI\u2019s /llm endpoint (server-side), so the ' +
                    'provider must be allowed on the container: set LLM_PROVIDER=<the same provider value> and the ' +
                    'provider\u2019s API key (e.g. DEEPSEEK_API_KEY) in your .llm.env, then restart the container ' +
                    '(docker compose down && docker compose up -d). Tweak the schema or instruction below for ' +
                    'different fields. Katab never sees or stores your API key.',
                llmGroup,
            );

            const llmModeRow = createChoiceRow(
                'Extraction Mode',
                'How Crawl4AI should format page content.',
                llmGroup,
            );
            bindChoiceRow(
                llmModeRow,
                'crawl4ai-extraction-mode',
                [
                    { value: 'markdown', label: 'Markdown Only (Default)' },
                    { value: 'llm-schema', label: 'LLM Structured JSON (Schema)' },
                    { value: 'llm-block', label: 'LLM Freeform Answer (Block)' },
                ],
                settings.get_string.bind(settings),
                settings.set_string.bind(settings),
            );

            const llmProviderRow = createStringRow(
                'LLM Provider',
                'LiteLLM model identifier. Defaults to DeepSeek V4.1 Flash (deepseek/deepseek-flash). Must match the provider allowed on your Crawl4AI server — set LLM_PROVIDER=<same value> and the provider API key (e.g. DEEPSEEK_API_KEY) in .llm.env, then restart the container. The API key never touches Katab.',
                'crawl4ai-llm-provider',
                llmGroup,
            );

            const llmInstructionRow = createMultilineStringRow(
                'LLM Instruction',
                'Freeform instruction for Block mode. A default summary instruction is prefilled \u2014 edit it to suit the page type.',
                'crawl4ai-llm-instruction',
                llmGroup,
                100,
            );

            const llmSchemaRow = createMultilineStringRow(
                'LLM Schema (JSON)',
                'JSON Schema object for Schema mode. A general-purpose schema is prefilled \u2014 edit it to match the fields you want.',
                'crawl4ai-llm-schema-json',
                llmGroup,
                140,
            );

            const validateSchemaRow = createButtonRow(
                'Validate Schema',
                'Check that the JSON Schema text parses as valid JSON.',
                'Validate',
                () => {
                    const raw = settings.get_string('crawl4ai-llm-schema-json') || '';
                    try {
                        JSON.parse(raw);
                        validateSchemaRow.subtitle = 'Schema is valid JSON.';
                    } catch (error) {
                        validateSchemaRow.subtitle = `Invalid JSON: ${error?.message || 'parse error'}`;
                    }
                },
                llmGroup,
            );

            createIntRow(
                'Chunk Token Threshold',
                'Maximum tokens per chunk when Crawl4AI splits large pages for LLM extraction (500\u201316000).',
                'crawl4ai-llm-chunk-token-threshold',
                llmGroup,
                500,
                16000,
                500,
            );

            createDoubleRow(
                'Chunk Overlap Rate',
                'Overlap between consecutive chunks (0.0\u20130.5) to preserve context across boundaries.',
                'crawl4ai-llm-overlap-rate',
                llmGroup,
                0.0,
                0.5,
                0.05,
                2,
            );

            // Visibility: only show LLM rows when an LLM mode is selected.
            const syncLLMVisibility = () => {
                const mode = settings.get_string('crawl4ai-extraction-mode') || 'markdown';
                const llmActive = mode === 'llm-schema' || mode === 'llm-block';
                llmProviderRow.visible = llmActive;
                llmInstructionRow.visible = mode === 'llm-block';
                llmSchemaRow.visible = mode === 'llm-schema';
                validateSchemaRow.visible = mode === 'llm-schema';
            };
            syncLLMVisibility();
            settings.connect('changed::crawl4ai-extraction-mode', syncLLMVisibility);

            // ---- Advanced ----
            const advancedGroup = createPreferencesGroup({
                title: 'Advanced',
                description:
                    'Anti-bot stealth, autonomous model use, and network address restrictions.',
            });
            detailPage.add(advancedGroup);

            createBooleanRow(
                'Stealth Mode',
                'Mimic human mouse movements, scrolls, and timing to reduce CAPTCHA and bot-detection challenges. Slower but more reliable for protected sites.',
                'crawl4ai-simulate-user',
                advancedGroup,
            );

            createBooleanRow(
                'Autonomous Tool Use',
                'Advertise the crawl_url tool to supported models so they can decide when to deep-scrape a page. With this off, only the manual /crawl command runs.',
                'crawl4ai-autonomous-enabled',
                advancedGroup,
            );

            createBooleanRow(
                'Allow Local Addresses',
                'Permit scraping of private, loopback, and link-local addresses. Leave off unless you fully trust your network.',
                'crawl4ai-allow-local-addresses',
                advancedGroup,
            );

            createIntRow(
                'Async Polling Interval',
                'Milliseconds between status checks when using async crawl jobs (500\u201310000).',
                'crawl4ai-job-poll-ms',
                advancedGroup,
                500,
                10000,
                500,
            );
        }

        // ── Knowledge Base (Local RAG) ───────────────────────────────────────
        const ragSubpage = createToolSubpage('Knowledge Base');
        {
            const detailPage = ragSubpage.detailPage;

            const noticeGroup = createPreferencesGroup({});
            // (added to the page after the Service group — see the Service block)
            const noticeRow = createInfoRow(
                'How the Knowledge Base works',
                'Your documents, conversations, and research results are chunked, embedded with Ollama\u2019s nomic-embed-text model, and stored in a local ChromaDB vector database. When you ask a question, Katab finds the most semantically similar chunks and feeds them as context. Everything runs locally \u2014 no data leaves your machine.\n\nPhase 3 adds hybrid BM25 keyword matching, cross-encoder reranking (bge-reranker-v2-m3), and automatic web search fallback when knowledge base results are low-quality. Use the Service section above for one-click setup, or see the Setup section below for manual instructions.',
                noticeGroup,
            );
            noticeRow.add_prefix(
                addCssClasses(
                    new Gtk.Image({
                        gicon: Gio.icon_new_for_string(
                            `${extensionPath}/icons/katab-knowledge-symbolic.svg`,
                        ),
                        valign: Gtk.Align.CENTER,
                    }),
                    'katab-prefs-tool-icon',
                ),
            );

            // ---- Setup (collapsible) ----
            const setupExpander = createExpanderRow({});
            setupExpander.add_prefix(
                addCssClasses(
                    new Gtk.Label({
                        label: 'Setup \u2014 Install & Run the RAG Service',
                        xalign: 0,
                        halign: Gtk.Align.START,
                    }),
                    'katab-prefs-expander-title',
                ),
            );
            setupExpander.subtitle =
                'Prefer one-click? Use Set Up & Start in the Service section above. The steps below are the manual alternative.';
            noticeGroup.add(setupExpander);

            createInstructionRow(
                'One-Click Setup (Recommended)',
                [
                    'Use the Service section above to install and start the RAG service automatically.',
                    '',
                    'The steps below are only needed for a manual or custom installation.',
                ].join('\n'),
                setupExpander,
            );

            createInstructionRow(
                'Installation',
                [
                    '1. Create a virtual environment for the RAG service',
                    '',
                    '   cd ~/.local/share/katabai/rag-service',
                    '   python3 -m venv .venv',
                    '',
                    '2. Install the Python dependencies inside the venv',
                    '',
                    '   .venv/bin/pip install chromadb ollama fastapi "uvicorn[standard]" rank-bm25',
                    '',
                    '   Or use the bundled requirements file:',
                    '',
                    '   .venv/bin/pip install -r requirements.txt',
                    '',
                    '   The rank-bm25 package enables hybrid keyword+semantic search',
                    '   (optional but recommended — the service works without it).',
                    '',
                    '3. Pull the Ollama embedding model on your Ollama host',
                    '   (Auto-pulled on first use if skipped)',
                    '',
                    '   ollama pull nomic-embed-text',
                    '',
                    '4. (Optional) Pull the reranker model for improved precision',
                    '   Only needed if you enable Cross-Encoder Reranking in Advanced Retrieval.',
                    "   Adds ~200ms per search. Skip this step if you don't need reranking.",
                    '',
                    '   ollama pull bge-reranker-v2-m3',
                ].join('\n'),
                setupExpander,
            );

            createInstructionRow(
                'Running the Service',
                [
                    '5. Start the RAG service from a terminal',
                    '',
                    '   cd ~/.local/share/katabai/rag-service',
                    '   .venv/bin/python3 server.py',
                    '',
                    '   Once started you will see:',
                    '',
                    '   Service URL:  http://127.0.0.1:11435',
                    '   Data stored:  ~/.local/share/katabai/chroma/',
                    '',
                    '   At startup the service rebuilds BM25 keyword indices from',
                    '   existing ChromaDB data and checks for the reranker model.',
                    '   Keep this terminal open to keep the service alive.',
                    '   Press Ctrl+C to stop it when done.',
                ].join('\n'),
                setupExpander,
            );

            createInstructionRow(
                'Auto-Start with systemd (Recommended)',
                [
                    '6. Create a user systemd service so the RAG backend',
                    '   starts automatically on login.',
                    '',
                    '   a) Create the service file:',
                    '',
                    '      mkdir -p ~/.config/systemd/user',
                    '      nano ~/.config/systemd/user/katabai-rag.service',
                    '',
                    '   b) Paste this content into the file:',
                    '',
                    '[Unit]',
                    'Description=Katabai RAG Service',
                    'After=network.target',
                    '',
                    '[Service]',
                    'Type=simple',
                    'ExecStart=%h/.local/share/katabai/rag-service/.venv/bin/python3 %h/.local/share/katabai/rag-service/server.py',
                    'WorkingDirectory=%h/.local/share/katabai/rag-service',
                    'Restart=on-failure',
                    'RestartSec=5',
                    '',
                    '[Install]',
                    'WantedBy=default.target',
                    '',
                    '   c) Enable and start the service:',
                    '',
                    '      systemctl --user daemon-reload',
                    '      systemctl --user enable katabai-rag.service',
                    '      systemctl --user start katabai-rag.service',
                    '',
                    '   d) Verify everything is working:',
                    '',
                    '      systemctl --user status katabai-rag.service',
                    '      curl http://127.0.0.1:11435/health',
                    '',
                    '   If curl returns {"status":"ok"} the service is ready.',
                    '   If it fails, run the command below to see error details:',
                    '',
                    '      journalctl --user -u katabai-rag.service --no-pager -n 30',
                ].join('\n'),
                setupExpander,
            );

            // ---- Connection ----
            const connectionGroup = createPreferencesGroup({
                title: 'Connection',
                description: 'Point Katab at your local RAG Python service.',
            });
            // (added to the page after the Service group — see the Service block)

            createBooleanRow(
                'Enable Knowledge Base',
                'Allow the /kb command, Knowledge footer button, and autonomous knowledge searching by supported models.',
                'rag-enabled',
                connectionGroup,
            );

            createBooleanRow(
                'Enable Memory',
                'Master switch for automatic indexing. When enabled, Katab indexes documents, conversations, and research results (respecting the per-type toggles below). When disabled, no new content is indexed but existing knowledge remains searchable.',
                'rag-memory-enabled',
                connectionGroup,
            );

            createStringRow(
                'RAG Service URL',
                'Base URL of your local Katabai RAG service, e.g. http://localhost:11435.',
                'rag-service-url',
                connectionGroup,
            );

            createStringRow(
                'Ollama URL for Embeddings',
                'The Ollama instance used for generating text embeddings. Can be remote (e.g. http://192.168.1.100:11434) if Ollama runs on a separate AI PC.',
                'rag-ollama-url',
                connectionGroup,
            );

            createStringRow(
                'Embedding Model',
                'Ollama model used for generating text embeddings. Must be pulled first with: ollama pull nomic-embed-text.',
                'rag-embedding-model',
                connectionGroup,
            );

            const { row: ragConnStatusRow, badge: ragConnBadge } = createStatusRow(
                'Connection Status',
                'Run a health check to confirm the RAG service is reachable.',
                connectionGroup,
            );
            setStatusBadge(ragConnBadge, 'Untested', null);

            createButtonRow(
                'Test Connection',
                'Send a health check to verify the RAG service responds.',
                'Test',
                () => {
                    setStatusBadge(ragConnBadge, 'Testing', null);
                    ragConnStatusRow.subtitle = 'Contacting the RAG service\u2026';

                    const config = {
                        serviceUrl: settings.get_string('rag-service-url'),
                    };

                    // Simple HTTP GET health check via Soup
                    try {
                        const session = new Soup.Session();
                        session.timeout = 8;
                        const url = `${config.serviceUrl.replace(/\/+$/, '')}/health`;
                        const message = Soup.Message.new('GET', url);
                        message.request_headers.append('Accept', 'application/json');

                        session.send_and_read_async(
                            message,
                            GLib.PRIORITY_DEFAULT,
                            null,
                            (s, result) => {
                                try {
                                    const bytes = s.send_and_read_finish(result);
                                    const decoder = new TextDecoder('utf-8');
                                    const body = JSON.parse(
                                        decoder.decode(bytes.get_data() || new Uint8Array()),
                                    );
                                    if (body?.ok) {
                                        const colCount = Object.keys(body.collections || {}).length;
                                        const limits = body?.limits || {};
                                        const rerankerOk = limits.reranker_available
                                            ? ' reranker✓'
                                            : '';
                                        const bm25Ok = limits.bm25_available ? ' BM25✓' : '';
                                        const features = `${rerankerOk}${bm25Ok}`.trim();
                                        setStatusBadge(
                                            ragConnBadge,
                                            'Connected',
                                            'katab-prefs-status-detected',
                                        );
                                        ragConnStatusRow.subtitle = body.version
                                            ? `Reachable. v${body.version}, ${colCount} collection${colCount !== 1 ? 's' : ''}.${features ? ` Features: ${features}` : ''}`
                                            : `Reachable.${features ? ` Features: ${features}` : ''}`;
                                    } else {
                                        setStatusBadge(
                                            ragConnBadge,
                                            'Failed',
                                            'katab-prefs-status-install',
                                        );
                                        ragConnStatusRow.subtitle = 'Service returned an error.';
                                    }
                                } catch (e) {
                                    setStatusBadge(
                                        ragConnBadge,
                                        'Failed',
                                        'katab-prefs-status-install',
                                    );
                                    ragConnStatusRow.subtitle =
                                        e?.message || 'Connection test failed.';
                                }
                            },
                        );
                    } catch (e) {
                        setStatusBadge(ragConnBadge, 'Failed', 'katab-prefs-status-install');
                        ragConnStatusRow.subtitle = e?.message || 'Connection test failed.';
                    }
                },
                connectionGroup,
            );

            // ---- Service ----
            const RAG_SERVICE_UNIT = 'katabai-rag.service';
            const systemctlPath = GLib.find_program_in_path('systemctl') || 'systemctl';
            const python3Path = GLib.find_program_in_path('python3') || 'python3';
            const serviceDir = GLib.build_filenamev([
                GLib.get_user_data_dir(),
                'katabai',
                'rag-service',
            ]);
            const venvDir = GLib.build_filenamev([serviceDir, '.venv']);
            const venvPython = GLib.build_filenamev([venvDir, 'bin', 'python3']);

            // Runs an arbitrary command and reports success + output.
            const runCommand = (argv, onDone) => {
                let proc;
                try {
                    proc = Gio.Subprocess.new(
                        argv,
                        Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
                    );
                } catch (e) {
                    onDone({ success: false, stdout: '', stderr: e?.message || String(e) });
                    return;
                }
                proc.communicate_utf8_async(null, null, (source, result) => {
                    try {
                        const [, stdout, stderr] = source.communicate_utf8_finish(result);
                        // IMPORTANT: the first tuple element of communicate_utf8_finish
                        // only means "communication completed" — it is true even when
                        // the process exits non-zero. Use get_successful() for the
                        // actual exit status (e.g. `systemctl is-active` exits 3 when
                        // a unit is stopped).
                        onDone({
                            success: source.get_successful(),
                            stdout: stdout || '',
                            stderr: stderr || '',
                        });
                    } catch (e) {
                        onDone({ success: false, stdout: '', stderr: e?.message || String(e) });
                    }
                });
            };

            // Runs `systemctl --user <args...>`.
            const runSystemctlRaw = (args, onDone) =>
                runCommand([systemctlPath, '--user', ...args], onDone);

            // Runs a verb against the katabai-rag.service unit.
            const runSystemctl = (verb, onDone) =>
                runSystemctlRaw([verb, RAG_SERVICE_UNIT], onDone);

            const serviceGroup = createPreferencesGroup({
                title: 'Service',
                description:
                    'Control the local RAG service (the systemd user unit katabai-rag.service). "Set Up & Start" performs the default install \u2014 create the Python venv, install dependencies, write the unit file, and start the service \u2014 skipping any step already done and leaving an existing (custom) unit file untouched. Start, Restart, and Stop manage an already-installed unit.',
            });
            detailPage.add(serviceGroup);

            // The Service group is intentionally first on the page so the one-click
            // setup is immediately visible. The intro/Setup and Connection groups are
            // appended after it to keep configuration below the service controls.
            detailPage.add(noticeGroup);
            detailPage.add(connectionGroup);

            const { row: ragServiceStatusRow, badge: ragServiceBadge } = createStatusRow(
                'Service Status',
                'Checking the systemd unit\u2026',
                serviceGroup,
            );
            setStatusBadge(ragServiceBadge, 'Checking', null);

            const showServiceError = (msg) => {
                setStatusBadge(ragServiceBadge, 'Failed', 'katab-prefs-status-install');
                ragServiceStatusRow.subtitle = msg;
            };

            const serviceButtons = new Gtk.Box({
                orientation: Gtk.Orientation.HORIZONTAL,
                spacing: 6,
            });

            const setupBtn = addCssClasses(
                new Gtk.Button({
                    label: 'Set Up & Start',
                    valign: Gtk.Align.CENTER,
                }),
                'katab-prefs-button',
                'suggested-action',
            );
            const startBtn = addCssClasses(
                new Gtk.Button({
                    label: 'Start',
                    valign: Gtk.Align.CENTER,
                }),
                'katab-prefs-button',
            );
            const restartBtn = addCssClasses(
                new Gtk.Button({
                    label: 'Restart',
                    valign: Gtk.Align.CENTER,
                }),
                'katab-prefs-button',
            );
            const stopBtn = addCssClasses(
                new Gtk.Button({
                    label: 'Stop',
                    valign: Gtk.Align.CENTER,
                }),
                'katab-prefs-button',
                'destructive-action',
            );

            for (const btn of [setupBtn, startBtn, restartBtn, stopBtn]) {
                serviceButtons.append(btn);
            }

            const updateServiceButtons = (installed, active) => {
                setupBtn.visible = !installed;
                setupBtn.sensitive = !installed;
                startBtn.visible = installed;
                restartBtn.visible = installed;
                stopBtn.visible = installed;
                startBtn.sensitive = installed && !active;
                restartBtn.sensitive = installed;
                stopBtn.sensitive = installed && active;
            };

            const refreshServiceStatus = () => {
                setStatusBadge(ragServiceBadge, 'Checking', null);
                ragServiceStatusRow.subtitle = 'Checking the systemd unit\u2026';
                const venvReady = Gio.File.new_for_path(venvPython).query_exists(null);
                // `cat` succeeds only when the unit is installed anywhere in the
                // user's systemd search paths; `is-active` succeeds only while it runs.
                runSystemctl('cat', (catResult) => {
                    const installed = catResult.success;
                    runSystemctl('is-active', ({ success: active }) => {
                        if (!installed) {
                            setStatusBadge(
                                ragServiceBadge,
                                'Not installed',
                                'katab-prefs-status-install',
                            );
                            ragServiceStatusRow.subtitle = venvReady
                                ? 'The Python environment is ready, but no katabai-rag.service unit file was found. Use "Set Up & Start" to create it and launch the service.'
                                : 'No service is set up yet. Use "Set Up & Start" to create the Python environment, install dependencies, write the unit file, and start the service (or follow the Setup section below for a manual install).';
                            updateServiceButtons(false, false);
                        } else if (active) {
                            setStatusBadge(
                                ragServiceBadge,
                                'Running',
                                'katab-prefs-status-detected',
                            );
                            ragServiceStatusRow.subtitle =
                                'The katabai-rag.service unit is running.';
                            updateServiceButtons(true, true);
                        } else {
                            setStatusBadge(
                                ragServiceBadge,
                                'Stopped',
                                'katab-prefs-status-install',
                            );
                            ragServiceStatusRow.subtitle =
                                'The service is installed but stopped. Use Start to launch it.';
                            updateServiceButtons(true, false);
                        }
                    });
                });
            };

            const runServiceAction = (verb, label) => {
                setStatusBadge(ragServiceBadge, 'Working', null);
                ragServiceStatusRow.subtitle = label;
                runSystemctl(verb, (result) => {
                    if (result.success) {
                        // Give systemd a moment to settle, then re-check status.
                        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 600, () => {
                            refreshServiceStatus();
                            return GLib.SOURCE_REMOVE;
                        });
                    } else {
                        showServiceError(result.stderr?.trim() || `systemctl ${verb} failed.`);
                    }
                });
            };

            const writeDefaultUnitFile = () => {
                const unitContent = [
                    '[Unit]',
                    'Description=Katabai RAG Service',
                    'After=network.target',
                    '',
                    '[Service]',
                    'Type=simple',
                    'ExecStart=%h/.local/share/katabai/rag-service/.venv/bin/python3 %h/.local/share/katabai/rag-service/server.py',
                    'WorkingDirectory=%h/.local/share/katabai/rag-service',
                    'Restart=on-failure',
                    'RestartSec=5',
                    '',
                    '[Install]',
                    'WantedBy=default.target',
                    '',
                ].join('\n');

                const unitDir = Gio.File.new_for_path(
                    GLib.build_filenamev([GLib.get_user_config_dir(), 'systemd', 'user']),
                );
                if (!unitDir.query_exists(null)) {
                    unitDir.make_directory_with_parents(null);
                }
                const unitFile = unitDir.get_child(RAG_SERVICE_UNIT);
                if (unitFile.query_exists(null)) {
                    return; // already exists — never overwrite a (possibly custom) unit
                }
                unitFile.replace_contents(
                    unitContent,
                    null,
                    false,
                    Gio.FileCreateFlags.REPLACE_DESTINATION,
                    null,
                );
            };

            // Adaptive default setup: only run the missing steps, and never
            // touch an existing unit file (which may be a custom install).
            const autoSetupService = () => {
                setStatusBadge(ragServiceBadge, 'Setting up', null);
                ragServiceStatusRow.subtitle = 'Preparing the RAG service\u2026';

                const venvReady = Gio.File.new_for_path(venvPython).query_exists(null);

                const ensureVenv = (done) => {
                    if (venvReady) {
                        done();
                        return;
                    }
                    ragServiceStatusRow.subtitle = 'Creating the Python virtual environment\u2026';
                    runCommand([python3Path, '-m', 'venv', venvDir], (res) => {
                        if (!res.success) {
                            showServiceError(
                                'Could not create the Python venv. Install python3-venv and retry, or follow the Setup section below.',
                            );
                            return;
                        }
                        done();
                    });
                };

                const ensureDeps = (done) => {
                    ragServiceStatusRow.subtitle = 'Checking Python dependencies\u2026';
                    runCommand(
                        [
                            venvPython,
                            '-c',
                            'import chromadb, ollama, uvicorn, fastapi, pydantic, rank_bm25',
                        ],
                        (check) => {
                            if (check.success) {
                                done();
                                return;
                            }
                            ragServiceStatusRow.subtitle =
                                'Installing Python dependencies (this can take a minute)\u2026';
                            runCommand(
                                [
                                    venvPython,
                                    '-m',
                                    'pip',
                                    'install',
                                    'chromadb',
                                    'ollama',
                                    'fastapi',
                                    'uvicorn[standard]',
                                    'rank-bm25',
                                ],
                                (install) => {
                                    if (!install.success) {
                                        showServiceError(
                                            install.stderr?.trim() ||
                                                'Dependency installation failed \u2014 install them manually from the Setup section below.',
                                        );
                                        return;
                                    }
                                    done();
                                },
                            );
                        },
                    );
                };

                const ensureUnit = (done) => {
                    // Only write a unit when none exists (custom installs are respected).
                    runSystemctl('cat', (cat) => {
                        if (cat.success) {
                            done();
                            return;
                        }
                        ragServiceStatusRow.subtitle = 'Writing the systemd unit file\u2026';
                        try {
                            writeDefaultUnitFile();
                            done();
                        } catch (e) {
                            showServiceError(e?.message || 'Failed to write the unit file.');
                        }
                    });
                };

                const enableAndStart = (done) => {
                    ragServiceStatusRow.subtitle = 'Enabling and starting the service\u2026';
                    runSystemctlRaw(['daemon-reload'], (reload) => {
                        if (!reload.success) {
                            showServiceError(
                                reload.stderr?.trim() || 'systemctl daemon-reload failed.',
                            );
                            return;
                        }
                        runSystemctl('enable', (enable) => {
                            if (!enable.success) {
                                showServiceError(
                                    enable.stderr?.trim() || 'systemctl enable failed.',
                                );
                                return;
                            }
                            runSystemctl('start', (start) => {
                                if (!start.success) {
                                    showServiceError(
                                        start.stderr?.trim() || 'systemctl start failed.',
                                    );
                                    return;
                                }
                                done();
                            });
                        });
                    });
                };

                ensureVenv(() =>
                    ensureDeps(() =>
                        ensureUnit(() =>
                            enableAndStart(() => {
                                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 600, () => {
                                    refreshServiceStatus();
                                    return GLib.SOURCE_REMOVE;
                                });
                            }),
                        ),
                    ),
                );
            };

            setupBtn.connect('clicked', autoSetupService);
            startBtn.connect('clicked', () =>
                runServiceAction('start', 'Starting the service\u2026'),
            );
            restartBtn.connect('clicked', () =>
                runServiceAction('restart', 'Restarting the service\u2026'),
            );
            stopBtn.connect('clicked', () =>
                runServiceAction('stop', 'Stopping the service\u2026'),
            );

            createInfoRow(
                'Service Controls',
                'Set Up & Start performs the default install (Python venv, dependencies, and unit file) and starts the service, adapting to what is already present. Start, Restart, and Stop manage the installed unit.',
                serviceGroup,
                serviceButtons,
            );

            GLib.idle_add(GLib.PRIORITY_LOW, () => {
                refreshServiceStatus();
                return GLib.SOURCE_REMOVE;
            });

            // ---- Indexing ----
            const indexingGroup = createPreferencesGroup({
                title: 'Indexing',
                description: 'Control how text is chunked and what gets indexed.',
            });
            detailPage.add(indexingGroup);

            createIntRow(
                'Chunk Size',
                'Characters per text chunk. Larger chunks preserve context but reduce precision. (200–4000)',
                'rag-chunk-size',
                indexingGroup,
                200,
                4000,
                50,
            );

            createIntRow(
                'Chunk Overlap',
                'Character overlap between chunks. Prevents information loss at boundaries. (0–500)',
                'rag-chunk-overlap',
                indexingGroup,
                0,
                500,
                10,
            );

            createIntRow(
                'Result Count',
                'Number of top results to retrieve per query. (1–20)',
                'rag-top-k',
                indexingGroup,
                1,
                20,
                1,
            );

            // ---- Storage Limits ----
            const limitsGroup = createPreferencesGroup({
                title: 'Storage Limits',
                description:
                    'Prevent the knowledge base from growing beyond your disk budget. Set to 0 to disable a cap.',
            });
            detailPage.add(limitsGroup);

            createIntRow(
                'Max Chunks Per Collection',
                'Hard cap on chunks in any single collection. 0 = unlimited. (0–100000)',
                'rag-max-chunks-per-collection',
                limitsGroup,
                0,
                100000,
                1000,
            );

            createIntRow(
                'Max Total Storage (MB)',
                'Estimated maximum disk usage for the ChromaDB directory. 0 = unlimited. (0–10000)',
                'rag-max-total-size-mb',
                limitsGroup,
                0,
                10000,
                50,
            );

            createBooleanRow(
                'Auto-Prune Oldest Chunks',
                'When a collection hits its size cap, automatically remove the oldest chunks to make room. When disabled, new indexing is rejected at the cap.',
                'rag-auto-prune',
                limitsGroup,
            );

            createBooleanRow(
                'Index Document Attachments',
                'Automatically add attached documents (txt, md, pdf, docx) to the knowledge base.',
                'rag-index-documents',
                indexingGroup,
            );

            createBooleanRow(
                'Index Conversations',
                'Automatically add past conversation turns to the knowledge base for cross-session retrieval.',
                'rag-index-conversations',
                indexingGroup,
            );

            createBooleanRow(
                'Index Research Cache',
                'Automatically add web search and scraping results to the knowledge base.',
                'rag-index-research-cache',
                indexingGroup,
            );

            // ---- Autonomous ----
            const autonomousGroup = createPreferencesGroup({
                title: 'Autonomous Tool Use',
                description:
                    'Let supported models call knowledge_search on their own when they think it would help.',
            });
            detailPage.add(autonomousGroup);

            createBooleanRow(
                'Allow Model-Triggered Knowledge Search',
                'Advertise the knowledge_search tool to capable models. When disabled, only the manual /kb command works.',
                'rag-autonomous-enabled',
                autonomousGroup,
            );

            createBooleanRow(
                'Auto-Update Knowledge Base',
                "When enabled, the model can update the knowledge base without asking for confirmation each time. When disabled, you'll be asked to confirm each update.",
                'rag-auto-update-enabled',
                autonomousGroup,
            );

            // ---- Advanced Retrieval (Phase 3) ----
            const advancedGroup = createPreferencesGroup({
                title: 'Advanced Retrieval',
                description:
                    'Fine-tune how the knowledge base finds and ranks results. These features require additional models and add latency, but significantly improve result quality.',
            });
            detailPage.add(advancedGroup);

            // -- Coverage Fallback --
            createBooleanRow(
                'Auto-Fallback to Web Search',
                'When knowledge base results are low-quality, automatically trigger a web search as a supplement. This is the reverse direction of the existing suppression for high-confidence KB results.',
                'rag-fallback-enabled',
                advancedGroup,
            );

            const fallbackThresholds = [
                [0.35, 'Strict (only fallback when KB is very poor)'],
                [0.6, 'Moderate (recommended)'],
                [0.8, 'Aggressive (fallback frequently)'],
            ];
            const { row: fallbackThreshRow } = createDoubleRow(
                'Fallback Threshold',
                'Minimum best-result score (0.0–1.0) before auto-triggering web search.',
                'rag-fallback-threshold',
                advancedGroup,
                0.0,
                1.0,
                0.05,
                2,
            );

            // Update the threshold subtitle based on current value
            const updateFallbackSubtitle = () => {
                try {
                    const val = settings.get_double('rag-fallback-threshold');
                    let desc = '';
                    for (const [threshold, label] of fallbackThresholds) {
                        if (val < threshold) {
                            desc = label;
                            break;
                        }
                    }
                    if (!desc) desc = fallbackThresholds[fallbackThresholds.length - 1][1];
                    fallbackThreshRow.subtitle = `Current: ${val.toFixed(2)} — ${desc}`;
                } catch (_) {
                    /* settings may not be ready */
                }
            };
            updateFallbackSubtitle();
            settings.connect('changed::rag-fallback-threshold', updateFallbackSubtitle);

            // -- Reranking --
            createBooleanRow(
                'Reranking',
                'Re-rank top candidate chunks with a local scoring model (bge-reranker-v2-m3 or similar) on your Ollama host. Chunks are scored in one batched call per 10 candidates. Requires the model to be pulled first.',
                'rag-rerank-enabled',
                advancedGroup,
            );

            createStringRow(
                'Reranker Model',
                'Ollama model used for cross-encoder reranking. Must be pulled first.',
                'rag-rerank-model',
                advancedGroup,
            );

            createIntRow(
                'Candidate Pool Multiplier',
                'How many times more candidates to fetch before reranking (rerank_k = k × this). Higher values improve recall at the cost of latency. (1–10)',
                'rag-rerank-candidate-multiplier',
                advancedGroup,
                1,
                10,
                1,
            );

            // -- Hybrid BM25 --
            createBooleanRow(
                'Hybrid BM25 + Dense Retrieval',
                'Combine keyword matching (BM25) with semantic search (dense embeddings) for better recall. Enabled by default — the service falls back to dense-only if rank-bm25 is not installed.',
                'rag-hybrid-enabled',
                advancedGroup,
            );

            // ---- Maintenance ----
            const maintenanceGroup = createPreferencesGroup({
                title: 'Maintenance',
                description: 'Export, rebuild, or clear the knowledge base.',
            });
            detailPage.add(maintenanceGroup);

            // Usage summary — refreshed when the page opens or on demand
            const { row: ragUsageRow, badge: ragUsageBadge } = createStatusRow(
                'Current Usage',
                'Click "Refresh" to check usage against your storage limits.',
                maintenanceGroup,
            );
            setStatusBadge(ragUsageBadge, 'Unknown', null);

            const refreshUsage = () => {
                setStatusBadge(ragUsageBadge, 'Checking', null);
                ragUsageRow.subtitle = 'Querying the RAG service\u2026';

                const url = `${settings.get_string('rag-service-url').replace(/\/+$/, '')}/health`;
                try {
                    const session = new Soup.Session();
                    session.timeout = 8;
                    const message = Soup.Message.new('GET', url);
                    message.request_headers.append('Accept', 'application/json');

                    session.send_and_read_async(
                        message,
                        GLib.PRIORITY_DEFAULT,
                        null,
                        (s, result) => {
                            try {
                                const bytes = s.send_and_read_finish(result);
                                const decoder = new TextDecoder('utf-8');
                                const body = JSON.parse(
                                    decoder.decode(bytes.get_data() || new Uint8Array()),
                                );
                                const limits = body?.limits || {};
                                const totalChunks = limits.total_chunks || 0;
                                const estMb = limits.estimated_size_mb || 0;
                                const maxMb = limits.max_total_size_mb || 0;

                                let pctText = '';
                                if (maxMb > 0 && estMb > 0) {
                                    const pct = Math.round((estMb / maxMb) * 100);
                                    pctText = ` (${pct}% of cap)`;
                                }

                                const colNames =
                                    Object.keys(body?.collections || {}).join(', ') || '(none)';

                                // Phase 3: feature availability
                                const rerankerOk = limits.reranker_available ? '✓rerank' : '';
                                const bm25Info =
                                    limits.bm25_collections > 0
                                        ? `✓bm25(${limits.bm25_collections})`
                                        : '';
                                const features = [rerankerOk, bm25Info].filter(Boolean).join(' ');
                                const featureStr = features ? ` [${features}]` : '';

                                if (totalChunks === 0) {
                                    setStatusBadge(ragUsageBadge, 'Empty', null);
                                    ragUsageRow.subtitle = `Knowledge base is empty.${featureStr}`;
                                } else if (maxMb > 0 && estMb >= maxMb * 0.9) {
                                    setStatusBadge(
                                        ragUsageBadge,
                                        'Near Limit',
                                        'katab-prefs-status-install',
                                    );
                                    ragUsageRow.subtitle = `${totalChunks} chunks, ~${estMb.toFixed(0)} MB${pctText} — ${colNames}${featureStr}`;
                                } else {
                                    setStatusBadge(
                                        ragUsageBadge,
                                        'Healthy',
                                        'katab-prefs-status-detected',
                                    );
                                    ragUsageRow.subtitle = `${totalChunks} chunks, ~${estMb.toFixed(0)} MB${pctText} — ${colNames}${featureStr}`;
                                }
                            } catch (e) {
                                setStatusBadge(
                                    ragUsageBadge,
                                    'Unavailable',
                                    'katab-prefs-status-install',
                                );
                                ragUsageRow.subtitle = 'Cannot reach RAG service.';
                            }
                        },
                    );
                } catch (e) {
                    setStatusBadge(ragUsageBadge, 'Unavailable', 'katab-prefs-status-install');
                    ragUsageRow.subtitle = 'Cannot reach RAG service.';
                }
            };

            createButtonRow(
                'Refresh Usage',
                'Query the RAG service for current chunk counts and estimated disk usage.',
                'Refresh',
                refreshUsage,
                maintenanceGroup,
            );

            // Auto-refresh on first open
            GLib.idle_add(GLib.PRIORITY_LOW, () => {
                if (settings.get_boolean('rag-enabled')) refreshUsage();
                return GLib.SOURCE_REMOVE;
            });

            // Status row shared by Clear and Export operations
            const { row: ragMaintStatusRow, badge: ragMaintBadge } = createStatusRow(
                'Operation Status',
                'Idle.',
                maintenanceGroup,
            );
            setStatusBadge(ragMaintBadge, 'Idle', null);

            createButtonRow(
                'Export Knowledge Base',
                'Download all indexed data as a JSON file for backup or inspection.',
                'Export',
                () => {
                    setStatusBadge(ragMaintBadge, 'Running', null);
                    ragMaintStatusRow.subtitle = 'Fetching data from the RAG service\u2026';

                    const url = `${settings.get_string('rag-service-url').replace(/\/+$/, '')}/export`;
                    try {
                        const session = new Soup.Session();
                        session.timeout = 30;
                        const message = Soup.Message.new('GET', url);
                        message.request_headers.append('Accept', 'application/json');

                        session.send_and_read_async(
                            message,
                            GLib.PRIORITY_DEFAULT,
                            null,
                            (s, result) => {
                                try {
                                    const bytes = s.send_and_read_finish(result);
                                    const decoder = new TextDecoder('utf-8');
                                    const body = JSON.parse(
                                        decoder.decode(bytes.get_data() || new Uint8Array()),
                                    );
                                    const collections = body?.collections || {};

                                    let totalEntries = 0;
                                    for (const entries of Object.values(collections)) {
                                        totalEntries += Array.isArray(entries) ? entries.length : 0;
                                    }

                                    if (totalEntries === 0) {
                                        setStatusBadge(ragMaintBadge, 'Empty', null);
                                        ragMaintStatusRow.subtitle =
                                            'Knowledge base is empty — nothing to export.';
                                        return;
                                    }

                                    // Save to ~/Documents/katabai-rag-export-<date>.json
                                    const now = GLib.DateTime.new_now_local();
                                    const dateStr = now ? now.format('%Y-%m-%d') : 'unknown';
                                    const filename = `katabai-rag-export-${dateStr}.json`;
                                    const docsDir = GLib.get_user_special_dir(
                                        GLib.UserDirectory.DIRECTORY_DOCUMENTS,
                                    );
                                    const filePath = GLib.build_filenamev([docsDir, filename]);

                                    const file = Gio.File.new_for_path(filePath);
                                    const outStream = file.replace(
                                        null,
                                        false,
                                        Gio.FileCreateFlags.NONE,
                                        null,
                                    );
                                    const jsonStr = JSON.stringify(collections, null, 2);
                                    outStream.write(jsonStr, null);
                                    outStream.close(null);

                                    const colNames = Object.keys(collections).join(', ');
                                    setStatusBadge(
                                        ragMaintBadge,
                                        'Done',
                                        'katab-prefs-status-detected',
                                    );
                                    ragMaintStatusRow.subtitle = `Exported ${totalEntries} entries (${colNames}) to ${filePath}`;
                                } catch (e) {
                                    setStatusBadge(
                                        ragMaintBadge,
                                        'Failed',
                                        'katab-prefs-status-install',
                                    );
                                    ragMaintStatusRow.subtitle =
                                        e?.message || 'Export failed — is the RAG service running?';
                                }
                            },
                        );
                    } catch (e) {
                        setStatusBadge(ragMaintBadge, 'Failed', 'katab-prefs-status-install');
                        ragMaintStatusRow.subtitle = e?.message || 'Export failed.';
                    }
                },
                maintenanceGroup,
            );

            createButtonRow(
                'Re-index Knowledge Base',
                'Reset index tracking and rebuild from your saved conversations and the research cache. Documents are re-indexed as you use them.',
                'Re-index',
                () => {
                    const dialog = new Gtk.MessageDialog({
                        transient_for: window,
                        modal: true,
                        message_type: Gtk.MessageType.WARNING,
                        buttons: Gtk.ButtonsType.OK_CANCEL,
                        text: 'Re-index the entire knowledge base?',
                        secondary_text:
                            'This will clear all existing index state and re-process your documents, conversations, and research cache on the next chat message.',
                    });
                    dialog.connect('response', (dlg, responseId) => {
                        if (responseId === Gtk.ResponseType.OK) {
                            // Delete the sentinel file to force re-indexing
                            const path = GLib.build_filenamev([
                                GLib.get_home_dir(),
                                '.local',
                                'share',
                                'katabai',
                                'rag-index-state.json',
                            ]);
                            try {
                                const file = Gio.File.new_for_path(path);
                                if (file.query_exists(null)) file.delete(null);
                            } catch (_) {
                                /* best effort */
                            }
                            // Signal the running extension to reset its in-memory
                            // index tracking immediately (otherwise the next
                            // debounced sentinel save resurrects the stale data
                            // and the re-index never happens without a reload).
                            try {
                                settings.set_string('rag-maintenance-action', 'reindex');
                                settings.set_int(
                                    'rag-maintenance-generation',
                                    settings.get_int('rag-maintenance-generation') + 1,
                                );
                            } catch (_) {
                                /* schema may be stale */
                            }

                            setStatusBadge(ragMaintBadge, 'Done', 'katab-prefs-status-detected');
                            ragMaintStatusRow.subtitle =
                                'Index state cleared — re-indexing will start now.';
                        }
                        dlg.destroy();
                    });
                    dialog.present();
                },
                maintenanceGroup,
            );

            // ── Manual imports (processed by the running extension) ──────
            // The prefs process cannot index directly (no document runtime or
            // RAG session); selected paths are handed to the extension through
            // a queue file plus the maintenance generation signal.
            const queueKbImport = (paths) => {
                try {
                    const queuePath = GLib.build_filenamev([
                        GLib.get_user_data_dir(),
                        'katabai',
                        'rag-import-queue.json',
                    ]);
                    GLib.file_set_contents(queuePath, JSON.stringify({ paths, ts: Date.now() }));
                    // Action first so the extension sees the right intent when
                    // the generation change arrives.
                    settings.set_string('rag-maintenance-action', 'import');
                    settings.set_int(
                        'rag-maintenance-generation',
                        settings.get_int('rag-maintenance-generation') + 1,
                    );
                    setStatusBadge(ragMaintBadge, 'Queued', 'katab-prefs-status-detected');
                    ragMaintStatusRow.subtitle = `Queued ${paths.length} path(s) — the running extension will import them now.`;
                } catch (e) {
                    setStatusBadge(ragMaintBadge, 'Failed', 'katab-prefs-status-install');
                    ragMaintStatusRow.subtitle = e?.message || 'Could not queue the import.';
                }
            };

            createButtonRow(
                'Import Files',
                'Add files (txt, md, pdf, docx, eml) from disk to the knowledge base. Up to 50 files per import.',
                'Select Files…',
                () => {
                    const dialog = new Gtk.FileDialog({
                        title: 'Import files into the knowledge base',
                    });
                    dialog.open_multiple(window, null, (dlg, result) => {
                        try {
                            const model = dlg.open_multiple_finish(result);
                            const paths = [];
                            const n = model.get_n_items();
                            for (let i = 0; i < n; i++) {
                                const f = model.get_item(i);
                                const p = f?.get_path?.();
                                if (p) paths.push(p);
                            }
                            if (paths.length > 0) queueKbImport(paths);
                        } catch (_) {
                            /* cancelled */
                        }
                    });
                },
                maintenanceGroup,
            );

            createButtonRow(
                'Import Folder',
                'Import every supported file in a folder (and up to 3 levels of subfolders).',
                'Select Folder…',
                () => {
                    const dialog = new Gtk.FileDialog({
                        title: 'Import a folder into the knowledge base',
                    });
                    dialog.select_folder(window, null, (dlg, result) => {
                        try {
                            const f = dlg.select_folder_finish(result);
                            const p = f?.get_path?.();
                            if (p) queueKbImport([p]);
                        } catch (_) {
                            /* cancelled */
                        }
                    });
                },
                maintenanceGroup,
            );

            createButtonRow(
                'Clear Knowledge Base',
                'Permanently delete ALL indexed data from the vector database. This cannot be undone.',
                'Clear',
                () => {
                    const dialog = new Gtk.MessageDialog({
                        transient_for: window,
                        modal: true,
                        message_type: Gtk.MessageType.WARNING,
                        buttons: Gtk.ButtonsType.OK_CANCEL,
                        text: 'Delete the entire knowledge base?',
                        secondary_text:
                            'All indexed documents, conversations, and research cache will be permanently removed from the ChromaDB database. This cannot be undone.',
                    });
                    dialog.connect('response', (dlg, responseId) => {
                        if (responseId === Gtk.ResponseType.OK) {
                            setStatusBadge(ragMaintBadge, 'Running', null);
                            ragMaintStatusRow.subtitle = 'Clearing all collections\u2026';

                            const url = `${settings.get_string('rag-service-url').replace(/\/+$/, '')}/clear`;
                            try {
                                const session = new Soup.Session();
                                session.timeout = 15;
                                const message = Soup.Message.new('POST', url);
                                message.request_headers.append('Accept', 'application/json');

                                session.send_and_read_async(
                                    message,
                                    GLib.PRIORITY_DEFAULT,
                                    null,
                                    (s, result) => {
                                        try {
                                            const bytes = s.send_and_read_finish(result);
                                            const decoder = new TextDecoder('utf-8');
                                            const body = JSON.parse(
                                                decoder.decode(
                                                    bytes.get_data() || new Uint8Array(),
                                                ),
                                            );
                                            const dropped = body?.dropped || [];

                                            // Also clear the sentinel file
                                            const sentinelPath = GLib.build_filenamev([
                                                GLib.get_home_dir(),
                                                '.local',
                                                'share',
                                                'katabai',
                                                'rag-index-state.json',
                                            ]);
                                            try {
                                                const f = Gio.File.new_for_path(sentinelPath);
                                                if (f.query_exists(null)) f.delete(null);
                                            } catch (_) {
                                                /* best effort */
                                            }
                                            // Tell the running extension to drop its
                                            // in-memory sentinel too (it would otherwise
                                            // rewrite stale ids to disk on the next save).
                                            try {
                                                settings.set_string(
                                                    'rag-maintenance-action',
                                                    'clear',
                                                );
                                                settings.set_int(
                                                    'rag-maintenance-generation',
                                                    settings.get_int('rag-maintenance-generation') +
                                                        1,
                                                );
                                            } catch (_) {
                                                /* schema may be stale */
                                            }

                                            if (dropped.length > 0) {
                                                setStatusBadge(
                                                    ragMaintBadge,
                                                    'Done',
                                                    'katab-prefs-status-detected',
                                                );
                                                ragMaintStatusRow.subtitle = `Cleared ${dropped.length} collection(s): ${dropped.join(', ')}.`;
                                            } else {
                                                setStatusBadge(ragMaintBadge, 'Empty', null);
                                                ragMaintStatusRow.subtitle =
                                                    'Knowledge base was already empty.';
                                            }
                                        } catch (e) {
                                            setStatusBadge(
                                                ragMaintBadge,
                                                'Failed',
                                                'katab-prefs-status-install',
                                            );
                                            ragMaintStatusRow.subtitle =
                                                e?.message ||
                                                'Clear failed — is the RAG service running?';
                                        }
                                    },
                                );
                            } catch (e) {
                                setStatusBadge(
                                    ragMaintBadge,
                                    'Failed',
                                    'katab-prefs-status-install',
                                );
                                ragMaintStatusRow.subtitle = e?.message || 'Clear failed.';
                            }
                        }
                        dlg.destroy();
                    });
                    dialog.present();
                },
                maintenanceGroup,
            );
        }

        // ----- Deep Research detail subpage -----
        const deepResearchSubpage = createToolSubpage('Deep Research');
        {
            const detailPage = deepResearchSubpage.detailPage;

            const drIntroGroup = createPreferencesGroup({
                title: 'Deep Research',
                description:
                    'Deep Research runs a multi-phase pipeline (plan → branches → gap analysis → refinement → two-pass synthesis). Enable Web Search or Web Scraper to use it, then start a run from the chat footer Research button or the /research command.',
            });

            const drDepthRow = createChoiceRow(
                'Research Depth',
                'Standard keeps the current pipeline. Deep adds automatic quality retries and more gap queries. Max raises the quality bar and synthesis context budget further — more tokens and longer runs.',
                drIntroGroup,
            );
            bindChoiceRow(
                drDepthRow,
                'deep-research-depth',
                [
                    { label: 'Standard (Recommended)', value: 'standard' },
                    { label: 'Deep', value: 'deep' },
                    { label: 'Max', value: 'max' },
                ],
                settings.get_string.bind(settings),
                settings.set_string.bind(settings),
                (value) => `Custom (${value})`,
            );

            const drModelsGroup = createPreferencesGroup({
                title: 'Model Overrides',
                description:
                    'Optional per-role model overrides — leave empty to use the active provider model. Compression runs on every scraped page (high volume); synthesis covers planning, critique, gap analysis, outline, and the final report.',
            });

            createStringRow(
                'Compression Model',
                'Cheap/fast model for high-volume page compression. Leave empty for the active model.',
                'deep-research-compression-model',
                drModelsGroup,
            );

            createStringRow(
                'Synthesis Model',
                'Stronger model for planning and the final report. Leave empty for the active model.',
                'deep-research-synthesis-model',
                drModelsGroup,
            );

            detailPage.add(drIntroGroup);
            detailPage.add(drModelsGroup);
        }

        // Tool index rows (order defines display order on the Tools page).
        createToolIndexRow(toolsIndexGroup, {
            title: 'Document Tool',
            subtitle: 'Attach and parse local files, and send images to Ollama vision models.',
            iconName: 'text-x-generic-symbolic',
            enabledKey: 'document-tool-enabled',
            navPage: documentSubpage.navPage,
        });

        createToolIndexRow(toolsIndexGroup, {
            title: 'Web Search',
            subtitle: 'Look things up on the web through your self-hosted SearxNG instance.',
            iconName: 'system-search-symbolic',
            enabledKey: 'web-search-enabled',
            navPage: webSearchSubpage.navPage,
        });

        createToolIndexRow(toolsIndexGroup, {
            title: 'Web Scraper',
            subtitle:
                'Deep-scrape web pages into clean Markdown through your self-hosted Crawl4AI instance.',
            iconName: 'document-open-symbolic',
            enabledKey: 'crawl4ai-enabled',
            navPage: crawl4aiSubpage.navPage,
        });

        createToolIndexRow(toolsIndexGroup, {
            title: 'Knowledge Base',
            subtitle:
                'Semantically search across documents, conversations, and research using local RAG.',
            iconName: 'drive-harddisk-symbolic',
            gicon: Gio.icon_new_for_string(`${extensionPath}/icons/katab-knowledge-symbolic.svg`),
            enabledKey: 'rag-enabled',
            navPage: ragSubpage.navPage,
        });

        createToolIndexRow(toolsIndexGroup, {
            title: 'Deep Research',
            subtitle:
                'Multi-phase research reports: plan, search, gap analysis, refinement, and two-pass synthesis.',
            iconName: 'content-loading-symbolic',
            navPage: deepResearchSubpage.navPage,
        });
    }
}
