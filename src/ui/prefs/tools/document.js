import { gettext as _, format } from '../../../shared/i18n.js';
import {
    getDocumentToolCapabilities,
    invalidateDocumentToolCapabilities,
} from '../../../tools/documentTools.js';

// Document Tool settings section for the Tools page.
export function buildDocumentSection(ctx) {
    const {
        settings,
        watch,
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
                'Use the attachment button in chat or type /doc with a quoted path. Word, Excel, PowerPoint, OpenDocument, PDF, CSV, email, and image files are parsed locally before anything is sent to a provider.',
            )
            : _(
                'Turn this on only if you want local file parsing. Normal chat does not depend on this tool.',
            );
    };
    watch('changed::document-tool-enabled', syncDocumentUsageRow);
    syncDocumentUsageRow();

    const capabilityGroup = createPreferencesGroup({
        title: _('Detected Capabilities'),
        description: _(
            'Katab scans the local system at runtime. Text, CSV/TSV, Word, Excel, PowerPoint, OpenDocument, EML, and image support is built in; PDF parsing needs poppler-utils; legacy .doc/.xls/.ppt files need LibreOffice.',
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
    const csvStatusRow = createStatusRow(
        _('Spreadsheet Text (CSV/TSV)'),
        _(
            'CSV and TSV files are parsed into Markdown tables by built-in code, with automatic delimiter detection.',
        ),
        capabilityGroup,
    );
    const wordStatusRow = createStatusRow(
        _('Word and OpenDocument Text'),
        _(
            'DOCX, DOCM, ODT, and RTF files are read by the built-in Office reader \u2014 headings, lists, and tables are preserved.',
        ),
        capabilityGroup,
    );
    const spreadsheetStatusRow = createStatusRow(
        _('Excel and OpenDocument Spreadsheets'),
        _(
            'XLSX, XLSM, and ODS workbooks are read by the built-in Office reader; every sheet becomes a Markdown table.',
        ),
        capabilityGroup,
    );
    const presentationStatusRow = createStatusRow(
        _('PowerPoint and OpenDocument Presentations'),
        _(
            'PPTX, PPTM, PPSX, ODP, and ODG files are read by the built-in Office reader; slide text becomes a slide-by-slide outline.',
        ),
        capabilityGroup,
    );
    const pdfStatusRow = createStatusRow(
        _('PDF Documents'),
        _('Install poppler-utils to expose pdftotext for fast PDF text extraction.'),
        capabilityGroup,
    );
    const legacyStatusRow = createStatusRow(
        _('Legacy Office (.doc, .xls, .ppt)'),
        _(
            'Install LibreOffice to convert legacy binary Office files before Katab reads them.',
        ),
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
        // The Refresh button must always re-scan, even if detection ran a
        // moment ago while building the page.
        invalidateDocumentToolCapabilities();
        const capabilities = getDocumentToolCapabilities();

        setStatusBadge(textStatusRow.badge, _('Built in'), 'katab-prefs-status-builtin');
        setStatusBadge(imageStatusRow.badge, _('Built in'), 'katab-prefs-status-builtin');
        setStatusBadge(csvStatusRow.badge, _('Built in'), 'katab-prefs-status-builtin');
        setStatusBadge(wordStatusRow.badge, _('Built in'), 'katab-prefs-status-builtin');
        setStatusBadge(spreadsheetStatusRow.badge, _('Built in'), 'katab-prefs-status-builtin');
        setStatusBadge(presentationStatusRow.badge, _('Built in'), 'katab-prefs-status-builtin');
        setStatusBadge(emlStatusRow.badge, _('Built in'), 'katab-prefs-status-builtin');

        const applyHelperStatus = (statusRow, capability, detectedLabel, missingLabel) => {
            if (capability?.available) {
                statusRow.row.subtitle = format(detectedLabel, {
                    path: capability.commandPath || '',
                });
                setStatusBadge(statusRow.badge, _('Detected'), 'katab-prefs-status-detected');
            } else {
                statusRow.row.subtitle = missingLabel;
                setStatusBadge(statusRow.badge, _('Install'), 'katab-prefs-status-install');
            }
        };

        applyHelperStatus(
            pdfStatusRow,
            capabilities.pdf,
            _('Detected pdftotext at {path}. PDF parsing is ready.'),
            _('Install poppler-utils to expose pdftotext for fast PDF text extraction.'),
        );

        applyHelperStatus(
            legacyStatusRow,
            capabilities.legacy,
            _('Detected LibreOffice at {path}. Legacy .doc/.xls/.ppt attachments are ready.'),
            _(
                'Install LibreOffice to convert legacy binary Office files before Katab reads them.',
            ),
        );
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
