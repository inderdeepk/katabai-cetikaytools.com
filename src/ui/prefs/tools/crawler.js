import Gtk from 'gi://Gtk';
import { Crawl4AIRuntime, readCrawl4AIConfig } from '../../../tools/crawl4aiTools.js';
import { gettext as _, format } from '../../../shared/i18n.js';

// Web Scraper (Crawl4AI) settings section for the Tools page.
// NOTE: the four multi-step setup guides below intentionally stay in English —
// they are shell-command walk-throughs (docker/git/curl) whose body text is
// dominated by commands; only their titles are translatable.
export function buildCrawlerSection(ctx) {
    const {
        settings,
        createToolSubpage,
        createPreferencesGroup,
        createInfoRow,
        createExpanderRow,
        createInstructionRow,
        createBooleanRow,
        createStringRow,
        createIntRow,
        createDoubleRow,
        createMultilineStringRow,
        createChoiceRow,
        bindChoiceRow,
        createStatusRow,
        setStatusBadge,
        createButtonRow,
        addCssClasses,
    } = ctx;

    const subpage = createToolSubpage(_('Web Scraper'));
    const detailPage = subpage.detailPage;

    const noticeGroup = createPreferencesGroup({});
    detailPage.add(noticeGroup);
    const noticeRow = createInfoRow(
        _('How web scraping works'),
        _(
            'Crawl4AI is a high-performance, LLM-friendly web crawler that renders pages in a real browser (Chromium), executes JavaScript, and extracts clean Markdown. Katab uses it to deep-scrape page content after SearxNG discovers URLs. Deploy your own Crawl4AI v0.9.x Docker container on any machine with sufficient RAM for Chromium.',
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

    // ---- Setup (collapsible) ----
    const crawlSetupExpander = createExpanderRow({});
    crawlSetupExpander.add_prefix(
        addCssClasses(
            new Gtk.Label({
                label: _('Setup \u2014 Deploy Crawl4AI with Docker'),
                xalign: 0,
                halign: Gtk.Align.START,
            }),
            'katab-prefs-expander-title',
        ),
    );
    crawlSetupExpander.subtitle = _(
        'Crawl4AI must be running in Docker for Katab to deep-scrape web pages.',
    );
    noticeGroup.add(crawlSetupExpander);

    createInstructionRow(
        _('Docker Compose (Recommended)'),
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
        _('Minimal Setup (Single Container)'),
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
        _('API Token Authentication'),
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
        _('Security Notes'),
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
        title: _('Connection'),
        description: _('Point Katab at your self-hosted Crawl4AI Docker instance.'),
    });
    detailPage.add(connectionGroup);

    createBooleanRow(
        _('Enable Web Scraper'),
        _(
            'Allow the /crawl command and let supported models deep-scrape web pages through Crawl4AI.',
        ),
        'crawl4ai-enabled',
        connectionGroup,
    );

    createStringRow(
        _('Crawl4AI Instance URL'),
        _('Base URL of your Crawl4AI v0.9.x instance, e.g. http://localhost:11235.'),
        'crawl4ai-url',
        connectionGroup,
    );

    createStringRow(
        _('API Token'),
        _(
            'JWT Bearer token set via CRAWL4AI_API_TOKEN when deploying the container. Required only when the instance has security enabled.',
        ),
        'crawl4ai-api-token',
        connectionGroup,
        true,
    );

    const { row: crawlConnStatusRow, badge: crawlConnBadge } = createStatusRow(
        _('Connection Status'),
        _('Run a health check to confirm the instance is reachable.'),
        connectionGroup,
    );
    setStatusBadge(crawlConnBadge, _('Untested'), null);

    const crawlTestRuntime = new Crawl4AIRuntime({ timeoutSeconds: 12 });
    createButtonRow(
        _('Test Connection'),
        _('Send a health check to verify the Crawl4AI endpoint responds.'),
        _('Test'),
        () => {
            setStatusBadge(crawlConnBadge, _('Testing'), null);
            crawlConnStatusRow.subtitle = _('Contacting the Crawl4AI instance\u2026');
            const config = readCrawl4AIConfig(settings);
            crawlTestRuntime
                .testConnection(config)
                .then((result) => {
                    if (result.ok) {
                        setStatusBadge(
                            crawlConnBadge,
                            _('Connected'),
                            'katab-prefs-status-detected',
                        );
                        crawlConnStatusRow.subtitle = result.version
                            ? format(_('Reachable. Server: {version}'), { version: result.version })
                            : _('Reachable.');
                    } else {
                        setStatusBadge(crawlConnBadge, _('Failed'), 'katab-prefs-status-install');
                        crawlConnStatusRow.subtitle =
                            result.message || _('Connection test failed.');
                    }
                })
                .catch((error) => {
                    setStatusBadge(crawlConnBadge, _('Failed'), 'katab-prefs-status-install');
                    crawlConnStatusRow.subtitle = error?.message || _('Connection test failed.');
                });
        },
        connectionGroup,
    );

    // ---- Extraction ----
    const extractionGroup = createPreferencesGroup({
        title: _('Extraction'),
        description: _(
            'How Crawl4AI filters and formats page content before sending it to the model.',
        ),
    });
    detailPage.add(extractionGroup);

    const fitMarkdownRow = createChoiceRow(
        _('Content Filter'),
        _('Algorithm used to strip boilerplate and extract the core page content.'),
        extractionGroup,
    );
    bindChoiceRow(
        fitMarkdownRow,
        'crawl4ai-fit-markdown-mode',
        [
            { value: 'pruning', label: _('Pruning (Heuristic)') },
            { value: 'bm25', label: _('BM25 (Query-Focused)') },
        ],
        settings.get_string.bind(settings),
        settings.set_string.bind(settings),
    );

    const cacheRow = createChoiceRow(
        _('Cache Mode'),
        _('Controls Crawl4AI\u2019s internal cache behavior.'),
        extractionGroup,
    );
    bindChoiceRow(
        cacheRow,
        'crawl4ai-cache-mode',
        [
            { value: 'bypass', label: _('Bypass (Always Fresh)') },
            { value: 'enabled', label: _('Enabled (Faster Repeats)') },
            { value: 'read_only', label: _('Read-Only (No Network)') },
        ],
        settings.get_string.bind(settings),
        settings.set_string.bind(settings),
    );

    createIntRow(
        _('Minimum Word Count'),
        _('Pages with fewer words are discarded before Markdown generation (1\u2013200).'),
        'crawl4ai-word-count-threshold',
        extractionGroup,
        1,
        200,
        1,
    );

    createIntRow(
        _('Page Timeout'),
        _('Maximum seconds to wait for a page to render before giving up (10\u2013300).'),
        'crawl4ai-page-timeout',
        extractionGroup,
        10,
        300,
        5,
    );

    createIntRow(
        _('Maximum Output Characters'),
        _('Truncation cap on extracted Markdown fed to the model context (500\u2013100000).'),
        'crawl4ai-max-chars',
        extractionGroup,
        500,
        100000,
        500,
    );

    // ---- LLM Extraction (Optional) ----
    const llmGroup = createPreferencesGroup({
        title: _('LLM Extraction (Optional)'),
        description: _(
            'Configure server-side LLM extraction. The crawl tool returns raw Markdown by default and only uses these settings when the model explicitly asks for extraction (mode="extract"); the manual /crawl command follows the Extraction Mode setting below. Fully optional \u2014 raw Markdown never needs an LLM.',
        ),
    });
    detailPage.add(llmGroup);

    createInstructionRow(
        _('How to enable AI extraction'),
        _(
            'Models request extraction per crawl (mode="extract"); the Extraction Mode below decides its shape ' +
                '(Schema for structured JSON, Block for a freeform answer). ' +
                'The LLM Provider defaults to DeepSeek V4.1 Flash, and both modes ship with a sensible default ' +
                'output setup. Extraction runs through Crawl4AI\u2019s /llm endpoint (server-side), so the ' +
                'provider must be allowed on the container: set LLM_PROVIDER=<the same provider value> and the ' +
                'provider\u2019s API key (e.g. DEEPSEEK_API_KEY) in your .llm.env, then restart the container ' +
                '(docker compose down && docker compose up -d). Tweak the schema or instruction below for ' +
                'different fields. Katab never sees or stores your API key.',
        ),
        llmGroup,
    );

    const llmModeRow = createChoiceRow(
        _('Extraction Mode'),
        _(
            'How Crawl4AI should format page content when LLM extraction is requested. Markdown remains the default fallback.',
        ),
        llmGroup,
    );
    bindChoiceRow(
        llmModeRow,
        'crawl4ai-extraction-mode',
        [
            { value: 'markdown', label: _('Markdown Only (Default)') },
            { value: 'llm-schema', label: _('LLM Structured JSON (Schema)') },
            { value: 'llm-block', label: _('LLM Freeform Answer (Block)') },
        ],
        settings.get_string.bind(settings),
        settings.set_string.bind(settings),
    );

    const llmProviderRow = createStringRow(
        _('LLM Provider'),
        _(
            'LiteLLM model identifier. Defaults to DeepSeek V4.1 Flash (deepseek/deepseek-flash). Must match the provider allowed on your Crawl4AI server \u2014 set LLM_PROVIDER=&lt;same value&gt; and the provider API key (e.g. DEEPSEEK_API_KEY) in .llm.env, then restart the container. The API key never touches Katab.',
        ),
        'crawl4ai-llm-provider',
        llmGroup,
    );

    const llmInstructionRow = createMultilineStringRow(
        _('LLM Instruction'),
        _(
            'Freeform instruction for Block mode. A default summary instruction is prefilled \u2014 edit it to suit the page type.',
        ),
        'crawl4ai-llm-instruction',
        llmGroup,
        100,
    );

    const llmSchemaRow = createMultilineStringRow(
        _('LLM Schema (JSON)'),
        _(
            'JSON Schema object for Schema mode. A general-purpose schema is prefilled \u2014 edit it to match the fields you want.',
        ),
        'crawl4ai-llm-schema-json',
        llmGroup,
        140,
    );

    const validateSchemaRow = createButtonRow(
        _('Validate Schema'),
        _('Check that the JSON Schema text parses as valid JSON.'),
        _('Validate'),
        () => {
            const raw = settings.get_string('crawl4ai-llm-schema-json') || '';
            try {
                JSON.parse(raw);
                validateSchemaRow.subtitle = _('Schema is valid JSON.');
            } catch (error) {
                validateSchemaRow.subtitle = format(_('Invalid JSON: {error}'), {
                    error: error?.message || _('parse error'),
                });
            }
        },
        llmGroup,
    );

    createIntRow(
        _('Chunk Token Threshold'),
        _(
            'Maximum tokens per chunk when Crawl4AI splits large pages for LLM extraction (500\u201316000).',
        ),
        'crawl4ai-llm-chunk-token-threshold',
        llmGroup,
        500,
        16000,
        500,
    );

    createDoubleRow(
        _('Chunk Overlap Rate'),
        _(
            'Overlap between consecutive chunks (0.0\u20130.5) to preserve context across boundaries.',
        ),
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
        title: _('Advanced'),
        description: _('Anti-bot stealth, autonomous model use, and network address restrictions.'),
    });
    detailPage.add(advancedGroup);

    createBooleanRow(
        _('Stealth Mode'),
        _(
            'Mimic human mouse movements, scrolls, and timing to reduce CAPTCHA and bot-detection challenges. Slower but more reliable for protected sites.',
        ),
        'crawl4ai-simulate-user',
        advancedGroup,
    );

    createBooleanRow(
        _('Autonomous Tool Use'),
        _(
            'Advertise the crawl_url tool to supported models so they can decide when to deep-scrape a page. With this off, only the manual /crawl command runs.',
        ),
        'crawl4ai-autonomous-enabled',
        advancedGroup,
    );

    createBooleanRow(
        _('Follow Subpage Links in Research'),
        _(
            'During deep research, follow the most relevant links found on scraped pages (e.g. a docs index linking to the actual page). Lets research reach details that are one click away.',
        ),
        'crawl4ai-follow-links-enabled',
        advancedGroup,
    );

    createIntRow(
        _('Max Followed Links per Branch'),
        _(
            'How many relevance-scored subpage links a research branch may follow after its initial crawl (0\u201310).',
        ),
        'crawl4ai-max-follow-links',
        advancedGroup,
        0,
        10,
        1,
    );

    createBooleanRow(
        _('Allow Local Addresses'),
        _(
            'Permit scraping of private, loopback, and link-local addresses. Leave off unless you fully trust your network.',
        ),
        'crawl4ai-allow-local-addresses',
        advancedGroup,
    );

    createIntRow(
        _('Async Polling Interval'),
        _('Milliseconds between status checks when using async crawl jobs (500\u201310000).'),
        'crawl4ai-job-poll-ms',
        advancedGroup,
        500,
        10000,
        500,
    );

    return subpage;
}
