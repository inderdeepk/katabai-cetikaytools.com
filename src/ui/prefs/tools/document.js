import GLib from 'gi://GLib';

// Document Tool settings section for the Tools page.
export function buildDocumentSection(ctx) {
    const {
        settings,
        createToolSubpage,
        createPreferencesGroup,
        createBooleanRow,
        createInfoRow,
        createStatusRow,
        setStatusBadge,
        createButtonRow,
    } = ctx;

    const subpage = createToolSubpage('Document Tool');
    const detailPage = subpage.detailPage;

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
        "EML email files are parsed locally with Katab's built-in MIME reader \u2014 headers, body text, and attachment names are extracted without any external tool.",
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

    return subpage;
}
