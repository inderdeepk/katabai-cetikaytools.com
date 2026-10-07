import GLib from 'gi://GLib';
import { gettext as _, format } from '../../../shared/i18n.js';

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

    const subpage = createToolSubpage(_('Document Tool'));
    const detailPage = subpage.detailPage;

    const documentToolGroup = createPreferencesGroup({
        title: _('Document Tool'),
        description: _(
            'Optional local file support for chat. Documents are parsed locally, and images can be sent to Ollama vision models.',
        ),
    });
    detailPage.add(documentToolGroup);

    createBooleanRow(
        _('Enable Document Tool'),
        _('Show the chat attachment button and enable the /doc command for local files.'),
        'document-tool-enabled',
        documentToolGroup,
    );

    const documentUsageRow = createInfoRow(_('How it works'), '', documentToolGroup);
    const syncDocumentUsageRow = () => {
        documentUsageRow.subtitle = settings.get_boolean('document-tool-enabled')
            ? _(
                  'Use the attachment button in chat or type /doc with a quoted path. Katab extracts text from supported documents locally, and sends PNG/JPG images only to Ollama vision models.',
              )
            : _(
                  'Turn this on only if you want local file parsing. Normal chat does not depend on this tool.',
              );
    };
    settings.connect('changed::document-tool-enabled', syncDocumentUsageRow);
    syncDocumentUsageRow();

    const capabilityGroup = createPreferencesGroup({
        title: _('Detected Capabilities'),
        description: _(
            'Katab scans the local system at runtime. Text, Markdown, PNG/JPG, and EML support is built in; PDF parsing needs poppler-utils; DOCX conversion needs pandoc.',
        ),
    });
    detailPage.add(capabilityGroup);

    const textStatusRow = createStatusRow(
        _('Text and Markdown'),
        _('Plain text and Markdown are handled directly through native Gio file reads.'),
        capabilityGroup,
    );
    const imageStatusRow = createStatusRow(
        _('Images (PNG/JPG)'),
        _(
            'PNG and JPG attachments are base64-encoded locally and sent only to Ollama vision-capable models.',
        ),
        capabilityGroup,
    );
    const pdfStatusRow = createStatusRow(
        _('PDF Documents'),
        _('Install poppler-utils to expose pdftotext for fast PDF text extraction.'),
        capabilityGroup,
    );
    const docxStatusRow = createStatusRow(
        _('Word Documents (.docx)'),
        _('Install pandoc to convert DOCX files into plain text before sending them to the model.'),
        capabilityGroup,
    );
    const emlStatusRow = createStatusRow(
        _('Email Messages (.eml)'),
        _(
            "EML email files are parsed locally with Katab's built-in MIME reader \u2014 headers, body text, and attachment names are extracted without any external tool.",
        ),
        capabilityGroup,
    );

    const refreshDocumentToolStatus = () => {
        setStatusBadge(textStatusRow.badge, _('Built in'), 'katab-prefs-status-builtin');
        setStatusBadge(imageStatusRow.badge, _('Built in'), 'katab-prefs-status-builtin');
        setStatusBadge(emlStatusRow.badge, _('Built in'), 'katab-prefs-status-builtin');

        const pdfPath = GLib.find_program_in_path('pdftotext');
        if (pdfPath) {
            pdfStatusRow.row.subtitle = format(
                _('Detected pdftotext at {path}. PDF parsing is ready.'),
                { path: pdfPath },
            );
            setStatusBadge(pdfStatusRow.badge, _('Detected'), 'katab-prefs-status-detected');
        } else {
            pdfStatusRow.row.subtitle = _(
                'Install poppler-utils to expose pdftotext for fast PDF text extraction.',
            );
            setStatusBadge(pdfStatusRow.badge, _('Install'), 'katab-prefs-status-install');
        }

        const pandocPath = GLib.find_program_in_path('pandoc');
        if (pandocPath) {
            docxStatusRow.row.subtitle = format(
                _('Detected pandoc at {path}. DOCX parsing is ready.'),
                { path: pandocPath },
            );
            setStatusBadge(docxStatusRow.badge, _('Detected'), 'katab-prefs-status-detected');
        } else {
            docxStatusRow.row.subtitle = _(
                'Install pandoc to convert DOCX files into plain text before sending them to the model.',
            );
            setStatusBadge(docxStatusRow.badge, _('Install'), 'katab-prefs-status-install');
        }
    };

    createButtonRow(
        _('Refresh Detection'),
        _('Re-scan the local system after installing or removing parser packages.'),
        _('Refresh'),
        refreshDocumentToolStatus,
        capabilityGroup,
    );

    refreshDocumentToolStatus();

    return subpage;
}
