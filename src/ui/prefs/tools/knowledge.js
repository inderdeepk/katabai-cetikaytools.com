import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import Soup from 'gi://Soup?version=3.0';
import { gettext as _, ngettext, format } from '../../../shared/i18n.js';

// Knowledge Base (local RAG) settings section for the Tools page.
// NOTE: the multi-step Installation / Running / Auto-Start guides below
// intentionally stay in English — they are shell-command walk-throughs;
// only their titles are translatable.
export function buildKnowledgeSection(ctx) {
    const {
        settings,
        window,
        extensionPath,
        createToolSubpage,
        createPreferencesGroup,
        createInfoRow,
        createExpanderRow,
        createInstructionRow,
        createBooleanRow,
        createStringRow,
        createIntRow,
        createDoubleRow,
        createStatusRow,
        setStatusBadge,
        createButtonRow,
        addCssClasses,
    } = ctx;

    const subpage = createToolSubpage(_('Knowledge Base'));
    const detailPage = subpage.detailPage;

    const noticeGroup = createPreferencesGroup({});
    // (added to the page after the Service group — see the Service block)
    const noticeRow = createInfoRow(
        _('How the Knowledge Base works'),
        _(
            'Your documents, conversations, and research results are chunked, embedded with Ollama\u2019s nomic-embed-text model, and stored in a local ChromaDB vector database. When you ask a question, Katab finds the most semantically similar chunks and feeds them as context. Everything runs locally \u2014 no data leaves your machine.\n\nPhase 3 adds hybrid BM25 keyword matching, cross-encoder reranking (bge-reranker-v2-m3), and automatic web search fallback when knowledge base results are low-quality. Use the Service section above for one-click setup, or see the Setup section below for manual instructions.',
        ),
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
                label: _('Setup \u2014 Install & Run the RAG Service'),
                xalign: 0,
                halign: Gtk.Align.START,
            }),
            'katab-prefs-expander-title',
        ),
    );
    setupExpander.subtitle = _(
        'Prefer one-click? Use Set Up &amp; Start in the Service section above. The steps below are the manual alternative.',
    );
    noticeGroup.add(setupExpander);

    createInstructionRow(
        _('One-Click Setup (Recommended)'),
        _(
            'Use the Service section above to install and start the RAG service automatically.\n\nThe steps below are only needed for a manual or custom installation.',
        ),
        setupExpander,
    );

    createInstructionRow(
        _('Installation'),
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
        _('Running the Service'),
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
        _('Auto-Start with systemd (Recommended)'),
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
        title: _('Connection'),
        description: _('Point Katab at your local RAG Python service.'),
    });
    // (added to the page after the Service group — see the Service block)

    createBooleanRow(
        _('Enable Knowledge Base'),
        _(
            'Allow the /kb command, Knowledge footer button, and autonomous knowledge searching by supported models.',
        ),
        'rag-enabled',
        connectionGroup,
    );

    createBooleanRow(
        _('Enable Memory'),
        _(
            'Master switch for automatic indexing. When enabled, Katab indexes documents, conversations, and research results (respecting the per-type toggles below). When disabled, no new content is indexed but existing knowledge remains searchable.',
        ),
        'rag-memory-enabled',
        connectionGroup,
    );

    createStringRow(
        _('RAG Service URL'),
        _('Base URL of your local Katabai RAG service, e.g. http://localhost:11435.'),
        'rag-service-url',
        connectionGroup,
    );

    createStringRow(
        _('Ollama URL for Embeddings'),
        _(
            'The Ollama instance used for generating text embeddings. Can be remote (e.g. http://192.168.1.100:11434) if Ollama runs on a separate AI PC.',
        ),
        'rag-ollama-url',
        connectionGroup,
    );

    createStringRow(
        _('Embedding Model'),
        _(
            'Ollama model used for generating text embeddings. Must be pulled first with: ollama pull nomic-embed-text.',
        ),
        'rag-embedding-model',
        connectionGroup,
    );

    const { row: ragConnStatusRow, badge: ragConnBadge } = createStatusRow(
        _('Connection Status'),
        _('Run a health check to confirm the RAG service is reachable.'),
        connectionGroup,
    );
    setStatusBadge(ragConnBadge, _('Untested'), null);

    createButtonRow(
        _('Test Connection'),
        _('Send a health check to verify the RAG service responds.'),
        _('Test'),
        () => {
            setStatusBadge(ragConnBadge, _('Testing'), null);
            ragConnStatusRow.subtitle = _('Contacting the RAG service\u2026');

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

                session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (s, result) => {
                    try {
                        const bytes = s.send_and_read_finish(result);
                        const decoder = new TextDecoder('utf-8');
                        const body = JSON.parse(
                            decoder.decode(bytes.get_data() || new Uint8Array()),
                        );
                        if (body?.ok) {
                            const colCount = Object.keys(body.collections || {}).length;
                            const limits = body?.limits || {};
                            const rerankerOk = limits.reranker_available ? ' reranker✓' : '';
                            const bm25Ok = limits.bm25_available ? ' BM25✓' : '';
                            const features = `${rerankerOk}${bm25Ok}`.trim();
                            const featuresSuffix = features
                                ? ` ${format(_('Features: {features}'), { features })}`
                                : '';
                            const collectionsText = format(
                                ngettext('{count} collection', '{count} collections', colCount),
                                { count: colCount },
                            );
                            setStatusBadge(
                                ragConnBadge,
                                _('Connected'),
                                'katab-prefs-status-detected',
                            );
                            ragConnStatusRow.subtitle = body.version
                                ? format(_('Reachable. v{version}, {collections}.{features}'), {
                                      version: body.version,
                                      collections: collectionsText,
                                      features: featuresSuffix,
                                  })
                                : format(_('Reachable.{features}'), { features: featuresSuffix });
                        } else {
                            setStatusBadge(ragConnBadge, _('Failed'), 'katab-prefs-status-install');
                            ragConnStatusRow.subtitle = _('Service returned an error.');
                        }
                    } catch (e) {
                        setStatusBadge(ragConnBadge, _('Failed'), 'katab-prefs-status-install');
                        ragConnStatusRow.subtitle = e?.message || _('Connection test failed.');
                    }
                });
            } catch (e) {
                setStatusBadge(ragConnBadge, _('Failed'), 'katab-prefs-status-install');
                ragConnStatusRow.subtitle = e?.message || _('Connection test failed.');
            }
        },
        connectionGroup,
    );

    // ---- Service ----
    const RAG_SERVICE_UNIT = 'katabai-rag.service';
    const systemctlPath = GLib.find_program_in_path('systemctl') || 'systemctl';
    const python3Path = GLib.find_program_in_path('python3') || 'python3';
    const serviceDir = GLib.build_filenamev([GLib.get_user_data_dir(), 'katabai', 'rag-service']);
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
    const runSystemctl = (verb, onDone) => runSystemctlRaw([verb, RAG_SERVICE_UNIT], onDone);

    const serviceGroup = createPreferencesGroup({
        title: _('Service'),
        description: _(
            'Control the local RAG service (the systemd user unit katabai-rag.service). "Set Up &amp; Start" performs the default install \u2014 create the Python venv, install dependencies, write the unit file, and start the service \u2014 skipping any step already done and leaving an existing (custom) unit file untouched. Start, Restart, and Stop manage an already-installed unit.',
        ),
    });
    detailPage.add(serviceGroup);

    // The Service group is intentionally first on the page so the one-click
    // setup is immediately visible. The intro/Setup and Connection groups are
    // appended after it to keep configuration below the service controls.
    detailPage.add(noticeGroup);
    detailPage.add(connectionGroup);

    const { row: ragServiceStatusRow, badge: ragServiceBadge } = createStatusRow(
        _('Service Status'),
        _('Checking the systemd unit\u2026'),
        serviceGroup,
    );
    setStatusBadge(ragServiceBadge, _('Checking'), null);

    const showServiceError = (msg) => {
        setStatusBadge(ragServiceBadge, _('Failed'), 'katab-prefs-status-install');
        ragServiceStatusRow.subtitle = msg;
    };

    const serviceButtons = new Gtk.Box({
        orientation: Gtk.Orientation.HORIZONTAL,
        spacing: 6,
    });

    const setupBtn = addCssClasses(
        new Gtk.Button({
            label: _('Set Up & Start'),
            valign: Gtk.Align.CENTER,
        }),
        'katab-prefs-button',
        'suggested-action',
    );
    const startBtn = addCssClasses(
        new Gtk.Button({
            label: _('Start'),
            valign: Gtk.Align.CENTER,
        }),
        'katab-prefs-button',
    );
    const restartBtn = addCssClasses(
        new Gtk.Button({
            label: _('Restart'),
            valign: Gtk.Align.CENTER,
        }),
        'katab-prefs-button',
    );
    const stopBtn = addCssClasses(
        new Gtk.Button({
            label: _('Stop'),
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
        setStatusBadge(ragServiceBadge, _('Checking'), null);
        ragServiceStatusRow.subtitle = _('Checking the systemd unit\u2026');
        const venvReady = Gio.File.new_for_path(venvPython).query_exists(null);
        // `cat` succeeds only when the unit is installed anywhere in the
        // user's systemd search paths; `is-active` succeeds only while it runs.
        runSystemctl('cat', (catResult) => {
            const installed = catResult.success;
            runSystemctl('is-active', ({ success: active }) => {
                if (!installed) {
                    setStatusBadge(
                        ragServiceBadge,
                        _('Not installed'),
                        'katab-prefs-status-install',
                    );
                    ragServiceStatusRow.subtitle = venvReady
                        ? _(
                              'The Python environment is ready, but no katabai-rag.service unit file was found. Use "Set Up &amp; Start" to create it and launch the service.',
                          )
                        : _(
                              'No service is set up yet. Use "Set Up &amp; Start" to create the Python environment, install dependencies, write the unit file, and start the service (or follow the Setup section below for a manual install).',
                          );
                    updateServiceButtons(false, false);
                } else if (active) {
                    setStatusBadge(ragServiceBadge, _('Running'), 'katab-prefs-status-detected');
                    ragServiceStatusRow.subtitle = _('The katabai-rag.service unit is running.');
                    updateServiceButtons(true, true);
                } else {
                    setStatusBadge(ragServiceBadge, _('Stopped'), 'katab-prefs-status-install');
                    ragServiceStatusRow.subtitle = _(
                        'The service is installed but stopped. Use Start to launch it.',
                    );
                    updateServiceButtons(true, false);
                }
            });
        });
    };

    const runServiceAction = (verb, label) => {
        setStatusBadge(ragServiceBadge, _('Working'), null);
        ragServiceStatusRow.subtitle = label;
        runSystemctl(verb, (result) => {
            if (result.success) {
                // Give systemd a moment to settle, then re-check status.
                GLib.timeout_add(GLib.PRIORITY_DEFAULT, 600, () => {
                    refreshServiceStatus();
                    return GLib.SOURCE_REMOVE;
                });
            } else {
                showServiceError(
                    result.stderr?.trim() || format(_('systemctl {verb} failed.'), { verb }),
                );
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
        setStatusBadge(ragServiceBadge, _('Setting up'), null);
        ragServiceStatusRow.subtitle = _('Preparing the RAG service\u2026');

        const venvReady = Gio.File.new_for_path(venvPython).query_exists(null);

        const ensureVenv = (done) => {
            if (venvReady) {
                done();
                return;
            }
            ragServiceStatusRow.subtitle = _('Creating the Python virtual environment\u2026');
            runCommand([python3Path, '-m', 'venv', venvDir], (res) => {
                if (!res.success) {
                    showServiceError(
                        _(
                            'Could not create the Python venv. Install python3-venv and retry, or follow the Setup section below.',
                        ),
                    );
                    return;
                }
                done();
            });
        };

        const ensureDeps = (done) => {
            ragServiceStatusRow.subtitle = _('Checking Python dependencies\u2026');
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
                    ragServiceStatusRow.subtitle = _(
                        'Installing Python dependencies (this can take a minute)\u2026',
                    );
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
                                        _(
                                            'Dependency installation failed \u2014 install them manually from the Setup section below.',
                                        ),
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
                ragServiceStatusRow.subtitle = _('Writing the systemd unit file\u2026');
                try {
                    writeDefaultUnitFile();
                    done();
                } catch (e) {
                    showServiceError(e?.message || _('Failed to write the unit file.'));
                }
            });
        };

        const enableAndStart = (done) => {
            ragServiceStatusRow.subtitle = _('Enabling and starting the service\u2026');
            runSystemctlRaw(['daemon-reload'], (reload) => {
                if (!reload.success) {
                    showServiceError(reload.stderr?.trim() || _('systemctl daemon-reload failed.'));
                    return;
                }
                runSystemctl('enable', (enable) => {
                    if (!enable.success) {
                        showServiceError(enable.stderr?.trim() || _('systemctl enable failed.'));
                        return;
                    }
                    runSystemctl('start', (start) => {
                        if (!start.success) {
                            showServiceError(start.stderr?.trim() || _('systemctl start failed.'));
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
    startBtn.connect('clicked', () => runServiceAction('start', _('Starting the service\u2026')));
    restartBtn.connect('clicked', () =>
        runServiceAction('restart', _('Restarting the service\u2026')),
    );
    stopBtn.connect('clicked', () => runServiceAction('stop', _('Stopping the service\u2026')));

    createInfoRow(
        _('Service Controls'),
        _(
            'Set Up &amp; Start performs the default install (Python venv, dependencies, and unit file) and starts the service, adapting to what is already present. Start, Restart, and Stop manage the installed unit.',
        ),
        serviceGroup,
        serviceButtons,
    );

    GLib.idle_add(GLib.PRIORITY_LOW, () => {
        refreshServiceStatus();
        return GLib.SOURCE_REMOVE;
    });

    // ---- Indexing ----
    const indexingGroup = createPreferencesGroup({
        title: _('Indexing'),
        description: _('Control how text is chunked and what gets indexed.'),
    });
    detailPage.add(indexingGroup);

    createIntRow(
        _('Chunk Size'),
        _(
            'Characters per text chunk. Larger chunks preserve context but reduce precision. (200–4000)',
        ),
        'rag-chunk-size',
        indexingGroup,
        200,
        4000,
        50,
    );

    createIntRow(
        _('Chunk Overlap'),
        _('Character overlap between chunks. Prevents information loss at boundaries. (0–500)'),
        'rag-chunk-overlap',
        indexingGroup,
        0,
        500,
        10,
    );

    createIntRow(
        _('Result Count'),
        _('Number of top results to retrieve per query. (1–20)'),
        'rag-top-k',
        indexingGroup,
        1,
        20,
        1,
    );

    // ---- Storage Limits ----
    const limitsGroup = createPreferencesGroup({
        title: _('Storage Limits'),
        description: _(
            'Prevent the knowledge base from growing beyond your disk budget. Set to 0 to disable a cap. Changes apply immediately.',
        ),
    });
    detailPage.add(limitsGroup);

    createIntRow(
        _('Max Chunks Per Collection'),
        _('Hard cap on chunks in any single collection. 0 = unlimited. (0–100000)'),
        'rag-max-chunks-per-collection',
        limitsGroup,
        0,
        100000,
        1000,
    );

    createIntRow(
        _('Max Total Storage (MB)'),
        _('Estimated maximum disk usage for the ChromaDB directory. 0 = unlimited. (0–10000)'),
        'rag-max-total-size-mb',
        limitsGroup,
        0,
        10000,
        50,
    );

    createBooleanRow(
        _('Auto-Prune Oldest Chunks'),
        _(
            'When a collection hits its size cap, automatically remove the oldest chunks to make room. When disabled, new indexing is rejected at the cap.',
        ),
        'rag-auto-prune',
        limitsGroup,
    );

    createBooleanRow(
        _('Index Document Attachments'),
        _('Automatically add attached documents (txt, md, pdf, docx) to the knowledge base.'),
        'rag-index-documents',
        indexingGroup,
    );

    createBooleanRow(
        _('Index Conversations'),
        _(
            'Automatically add past conversation turns to the knowledge base for cross-session retrieval.',
        ),
        'rag-index-conversations',
        indexingGroup,
    );

    createBooleanRow(
        _('Index Research Cache'),
        _('Automatically add web search and scraping results to the knowledge base.'),
        'rag-index-research-cache',
        indexingGroup,
    );

    // ---- Autonomous ----
    const autonomousGroup = createPreferencesGroup({
        title: _('Autonomous Tool Use'),
        description: _(
            'Let supported models call knowledge_search on their own when they think it would help.',
        ),
    });
    detailPage.add(autonomousGroup);

    createBooleanRow(
        _('Allow Model-Triggered Knowledge Search'),
        _(
            'Advertise the knowledge_search tool to capable models. When disabled, only the manual /kb command works.',
        ),
        'rag-autonomous-enabled',
        autonomousGroup,
    );

    createBooleanRow(
        _('Auto-Update Knowledge Base'),
        _(
            "When enabled, the model can update the knowledge base without asking for confirmation each time. When disabled, you'll be asked to confirm each update.",
        ),
        'rag-auto-update-enabled',
        autonomousGroup,
    );

    // ---- Advanced Retrieval (Phase 3) ----
    const advancedGroup = createPreferencesGroup({
        title: _('Advanced Retrieval'),
        description: _(
            'Fine-tune how the knowledge base finds and ranks results. These features require additional models and add latency, but significantly improve result quality.',
        ),
    });
    detailPage.add(advancedGroup);

    // -- Coverage Fallback --
    createBooleanRow(
        _('Auto-Fallback to Web Search'),
        _(
            'When knowledge base results are low-quality, automatically trigger a web search as a supplement. This is the reverse direction of the existing suppression for high-confidence KB results.',
        ),
        'rag-fallback-enabled',
        advancedGroup,
    );

    const fallbackThresholds = [
        [0.35, _('Strict (only fallback when KB is very poor)')],
        [0.6, _('Moderate (recommended)')],
        [0.8, _('Aggressive (fallback frequently)')],
    ];
    const { row: fallbackThreshRow } = createDoubleRow(
        _('Fallback Threshold'),
        _('Minimum best-result score (0.0–1.0) before auto-triggering web search.'),
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
            fallbackThreshRow.subtitle = format(_('Current: {value} — {desc}'), {
                value: val.toFixed(2),
                desc,
            });
        } catch (_) {
            /* settings may not be ready */
        }
    };
    updateFallbackSubtitle();
    settings.connect('changed::rag-fallback-threshold', updateFallbackSubtitle);

    // -- Reranking --
    createBooleanRow(
        _('Reranking'),
        _(
            'Re-rank top candidate chunks with a local scoring model (bge-reranker-v2-m3 or similar) on your Ollama host. Chunks are scored in one batched call per 10 candidates. Requires the model to be pulled first.',
        ),
        'rag-rerank-enabled',
        advancedGroup,
    );

    createStringRow(
        _('Reranker Model'),
        _('Ollama model used for cross-encoder reranking. Must be pulled first.'),
        'rag-rerank-model',
        advancedGroup,
    );

    createIntRow(
        _('Candidate Pool Multiplier'),
        _(
            'How many times more candidates to fetch before reranking (rerank_k = k × this). Higher values improve recall at the cost of latency. (1–10)',
        ),
        'rag-rerank-candidate-multiplier',
        advancedGroup,
        1,
        10,
        1,
    );

    // -- Hybrid BM25 --
    createBooleanRow(
        _('Hybrid BM25 + Dense Retrieval'),
        _(
            'Combine keyword matching (BM25) with semantic search (dense embeddings) for better recall. Enabled by default — the service falls back to dense-only if rank-bm25 is not installed.',
        ),
        'rag-hybrid-enabled',
        advancedGroup,
    );

    // ---- Maintenance ----
    const maintenanceGroup = createPreferencesGroup({
        title: _('Maintenance'),
        description: _('Export, rebuild, or clear the knowledge base.'),
    });
    detailPage.add(maintenanceGroup);

    // Usage summary — refreshed when the page opens or on demand
    const { row: ragUsageRow, badge: ragUsageBadge } = createStatusRow(
        _('Current Usage'),
        _('Click "Refresh" to check usage against your storage limits.'),
        maintenanceGroup,
    );
    setStatusBadge(ragUsageBadge, _('Unknown'), null);

    const refreshUsage = () => {
        setStatusBadge(ragUsageBadge, _('Checking'), null);
        ragUsageRow.subtitle = _('Querying the RAG service\u2026');

        const url = `${settings.get_string('rag-service-url').replace(/\/+$/, '')}/health`;
        try {
            const session = new Soup.Session();
            session.timeout = 8;
            const message = Soup.Message.new('GET', url);
            message.request_headers.append('Accept', 'application/json');

            session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (s, result) => {
                try {
                    const bytes = s.send_and_read_finish(result);
                    const decoder = new TextDecoder('utf-8');
                    const body = JSON.parse(decoder.decode(bytes.get_data() || new Uint8Array()));
                    const limits = body?.limits || {};
                    const totalChunks = limits.total_chunks || 0;
                    const estMb = limits.estimated_size_mb || 0;
                    const maxMb = limits.max_total_size_mb || 0;

                    let pctText = '';
                    if (maxMb > 0 && estMb > 0) {
                        const pct = Math.round((estMb / maxMb) * 100);
                        pctText = format(_(' ({pct}% of cap)'), { pct });
                    }

                    const colNames = Object.keys(body?.collections || {}).join(', ') || _('(none)');

                    // Phase 3: feature availability
                    const rerankerOk = limits.reranker_available ? '✓rerank' : '';
                    const bm25Info =
                        limits.bm25_collections > 0 ? `✓bm25(${limits.bm25_collections})` : '';
                    const features = [rerankerOk, bm25Info].filter(Boolean).join(' ');
                    const featureStr = features ? ` [${features}]` : '';

                    const usageLine = format(
                        _('{chunks} chunks, ~{size} MB{cap} — {collections}{features}'),
                        {
                            chunks: totalChunks,
                            size: estMb.toFixed(0),
                            cap: pctText,
                            collections: colNames,
                            features: featureStr,
                        },
                    );

                    if (totalChunks === 0) {
                        setStatusBadge(ragUsageBadge, _('Empty'), null);
                        ragUsageRow.subtitle = format(_('Knowledge base is empty.{features}'), {
                            features: featureStr,
                        });
                    } else if (maxMb > 0 && estMb >= maxMb * 0.9) {
                        setStatusBadge(
                            ragUsageBadge,
                            _('Near Limit'),
                            'katab-prefs-status-install',
                        );
                        ragUsageRow.subtitle = usageLine;
                    } else {
                        setStatusBadge(ragUsageBadge, _('Healthy'), 'katab-prefs-status-detected');
                        ragUsageRow.subtitle = usageLine;
                    }
                } catch (e) {
                    setStatusBadge(ragUsageBadge, _('Unavailable'), 'katab-prefs-status-install');
                    ragUsageRow.subtitle = _('Cannot reach RAG service.');
                }
            });
        } catch (e) {
            setStatusBadge(ragUsageBadge, _('Unavailable'), 'katab-prefs-status-install');
            ragUsageRow.subtitle = _('Cannot reach RAG service.');
        }
    };

    createButtonRow(
        _('Refresh Usage'),
        _('Query the RAG service for current chunk counts and estimated disk usage.'),
        _('Refresh'),
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
        _('Operation Status'),
        _('Idle.'),
        maintenanceGroup,
    );
    setStatusBadge(ragMaintBadge, _('Idle'), null);

    createButtonRow(
        _('Export Knowledge Base'),
        _('Download all indexed data as a JSON file for backup or inspection.'),
        _('Export'),
        () => {
            setStatusBadge(ragMaintBadge, _('Running'), null);
            ragMaintStatusRow.subtitle = _('Fetching data from the RAG service\u2026');

            const url = `${settings.get_string('rag-service-url').replace(/\/+$/, '')}/export`;
            try {
                const session = new Soup.Session();
                session.timeout = 30;
                const message = Soup.Message.new('GET', url);
                message.request_headers.append('Accept', 'application/json');

                session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null, (s, result) => {
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
                            setStatusBadge(ragMaintBadge, _('Empty'), null);
                            ragMaintStatusRow.subtitle = _(
                                'Knowledge base is empty — nothing to export.',
                            );
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
                        const outStream = file.replace(null, false, Gio.FileCreateFlags.NONE, null);
                        const jsonStr = JSON.stringify(collections, null, 2);
                        outStream.write(jsonStr, null);
                        outStream.close(null);

                        const colNames = Object.keys(collections).join(', ');
                        setStatusBadge(ragMaintBadge, _('Done'), 'katab-prefs-status-detected');
                        ragMaintStatusRow.subtitle = format(
                            _('Exported {count} entries ({collections}) to {path}'),
                            { count: totalEntries, collections: colNames, path: filePath },
                        );
                    } catch (e) {
                        setStatusBadge(ragMaintBadge, _('Failed'), 'katab-prefs-status-install');
                        ragMaintStatusRow.subtitle =
                            e?.message || _('Export failed — is the RAG service running?');
                    }
                });
            } catch (e) {
                setStatusBadge(ragMaintBadge, _('Failed'), 'katab-prefs-status-install');
                ragMaintStatusRow.subtitle = e?.message || _('Export failed.');
            }
        },
        maintenanceGroup,
    );

    createButtonRow(
        _('Re-index Knowledge Base'),
        _(
            'Reset index tracking and rebuild from your saved conversations and the research cache. Documents are re-indexed as you use them.',
        ),
        _('Re-index'),
        () => {
            const dialog = new Gtk.MessageDialog({
                transient_for: window,
                modal: true,
                message_type: Gtk.MessageType.WARNING,
                buttons: Gtk.ButtonsType.OK_CANCEL,
                text: _('Re-index the entire knowledge base?'),
                secondary_text: _(
                    'This will clear all existing index state and re-process your documents, conversations, and research cache on the next chat message.',
                ),
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

                    setStatusBadge(ragMaintBadge, _('Done'), 'katab-prefs-status-detected');
                    ragMaintStatusRow.subtitle = _(
                        'Index state cleared — re-indexing will start now.',
                    );
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
            setStatusBadge(ragMaintBadge, _('Queued'), 'katab-prefs-status-detected');
            ragMaintStatusRow.subtitle = format(
                _('Queued {count} path(s) — the running extension will import them now.'),
                { count: paths.length },
            );
        } catch (e) {
            setStatusBadge(ragMaintBadge, _('Failed'), 'katab-prefs-status-install');
            ragMaintStatusRow.subtitle = e?.message || _('Could not queue the import.');
        }
    };

    createButtonRow(
        _('Import Files'),
        _(
            'Add files (txt, md, pdf, docx, eml) from disk to the knowledge base. Up to 50 files per import.',
        ),
        _('Select Files…'),
        () => {
            const dialog = new Gtk.FileDialog({
                title: _('Import files into the knowledge base'),
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
        _('Import Folder'),
        _('Import every supported file in a folder (and up to 3 levels of subfolders).'),
        _('Select Folder…'),
        () => {
            const dialog = new Gtk.FileDialog({
                title: _('Import a folder into the knowledge base'),
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
        _('Clear Knowledge Base'),
        _('Permanently delete ALL indexed data from the vector database. This cannot be undone.'),
        _('Clear'),
        () => {
            const dialog = new Gtk.MessageDialog({
                transient_for: window,
                modal: true,
                message_type: Gtk.MessageType.WARNING,
                buttons: Gtk.ButtonsType.OK_CANCEL,
                text: _('Delete the entire knowledge base?'),
                secondary_text: _(
                    'All indexed documents, conversations, and research cache will be permanently removed from the ChromaDB database. This cannot be undone.',
                ),
            });
            dialog.connect('response', (dlg, responseId) => {
                if (responseId === Gtk.ResponseType.OK) {
                    setStatusBadge(ragMaintBadge, _('Running'), null);
                    ragMaintStatusRow.subtitle = _('Clearing all collections\u2026');

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
                                        decoder.decode(bytes.get_data() || new Uint8Array()),
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
                                        settings.set_string('rag-maintenance-action', 'clear');
                                        settings.set_int(
                                            'rag-maintenance-generation',
                                            settings.get_int('rag-maintenance-generation') + 1,
                                        );
                                    } catch (_) {
                                        /* schema may be stale */
                                    }

                                    if (dropped.length > 0) {
                                        setStatusBadge(
                                            ragMaintBadge,
                                            _('Done'),
                                            'katab-prefs-status-detected',
                                        );
                                        ragMaintStatusRow.subtitle = format(
                                            ngettext(
                                                'Cleared {count} collection: {names}.',
                                                'Cleared {count} collections: {names}.',
                                                dropped.length,
                                            ),
                                            { count: dropped.length, names: dropped.join(', ') },
                                        );
                                    } else {
                                        setStatusBadge(ragMaintBadge, _('Empty'), null);
                                        ragMaintStatusRow.subtitle = _(
                                            'Knowledge base was already empty.',
                                        );
                                    }
                                } catch (e) {
                                    setStatusBadge(
                                        ragMaintBadge,
                                        _('Failed'),
                                        'katab-prefs-status-install',
                                    );
                                    ragMaintStatusRow.subtitle =
                                        e?.message ||
                                        _('Clear failed — is the RAG service running?');
                                }
                            },
                        );
                    } catch (e) {
                        setStatusBadge(ragMaintBadge, _('Failed'), 'katab-prefs-status-install');
                        ragMaintStatusRow.subtitle = e?.message || _('Clear failed.');
                    }
                }
                dlg.destroy();
            });
            dialog.present();
        },
        maintenanceGroup,
    );

    return subpage;
}
