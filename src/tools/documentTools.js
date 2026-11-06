import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import {
    LEGACY_OFFICE_TARGETS,
    extractOfficeText,
    isLegacyOfficeExtension,
    isOfficeExtension,
    listOfficeExtensions,
} from './officeParsers.js';

export const DOCUMENT_TOOL_COMMAND = '/doc';
export const DOCUMENT_TOOL_NAME = 'document';
export const DOCUMENT_TOOL_ICON = 'text-x-generic-symbolic';
export const DOCUMENT_TOOL_MAX_CHARS = 24000;

const TEXT_EXTENSIONS = new Set(['md', 'markdown', 'txt']);
const IMAGE_MIME_TYPES = new Map([
    ['png', 'image/png'],
    ['jpg', 'image/jpeg'],
    ['jpeg', 'image/jpeg'],
]);
const IMAGE_EXTENSIONS = new Set(IMAGE_MIME_TYPES.keys());
const PDF_EXTENSION = 'pdf';
const EML_EXTENSION = 'eml';
const WORD_EXTENSIONS = new Set([
    ...listOfficeExtensions('word'),
    ...listOfficeExtensions('odf-text'),
    ...listOfficeExtensions('rtf'),
]);
const SPREADSHEET_EXTENSIONS = new Set([
    ...listOfficeExtensions('sheet'),
    ...listOfficeExtensions('odf-sheet'),
]);
const PRESENTATION_EXTENSIONS = new Set([
    ...listOfficeExtensions('slides'),
    ...listOfficeExtensions('odf-presentation'),
    ...listOfficeExtensions('odf-drawing'),
]);
const DELIMITED_EXTENSIONS = new Set(listOfficeExtensions('delimited'));
const LEGACY_OFFICE_EXTENSIONS = new Set(LEGACY_OFFICE_TARGETS.keys());

// Parsed documents (including full base64 image payloads, which can be
// several MB each) are cached per file so repeat sends don't re-parse.  The
// cache is LRU-capped because the runtime lives for the whole shell session —
// without a cap, every attachment ever parsed stayed resident forever.
const DOCUMENT_RUNTIME_CACHE_MAX_ENTRIES = 12;

const TOOL_STATUS = {
    BUILTIN: 'builtin',
    DETECTED: 'detected',
    INSTALL: 'install',
};

const CAPABILITY_META = {
    text: {
        kind: 'document',
        label: 'Text and Markdown',
        status: TOOL_STATUS.BUILTIN,
        parserName: 'Gio.File',
        installLabel: null,
        extensions: Array.from(TEXT_EXTENSIONS),
    },
    image: {
        kind: 'image',
        label: 'Images (PNG/JPG)',
        status: TOOL_STATUS.BUILTIN,
        parserName: 'Gio.File',
        installLabel: null,
        extensions: Array.from(IMAGE_EXTENSIONS),
    },
    csv: {
        kind: 'document',
        label: 'Spreadsheet Text (CSV/TSV)',
        status: TOOL_STATUS.BUILTIN,
        parserName: 'Katab table reader',
        installLabel: null,
        extensions: Array.from(DELIMITED_EXTENSIONS),
    },
    word: {
        kind: 'document',
        label: 'Word and OpenDocument Text',
        status: TOOL_STATUS.BUILTIN,
        parserName: 'Katab Office reader',
        installLabel: null,
        extensions: [...WORD_EXTENSIONS],
    },
    spreadsheet: {
        kind: 'document',
        label: 'Excel and OpenDocument Spreadsheets',
        status: TOOL_STATUS.BUILTIN,
        parserName: 'Katab Office reader',
        installLabel: null,
        extensions: [...SPREADSHEET_EXTENSIONS],
    },
    presentation: {
        kind: 'document',
        label: 'PowerPoint and OpenDocument Presentations',
        status: TOOL_STATUS.BUILTIN,
        parserName: 'Katab Office reader',
        installLabel: null,
        extensions: [...PRESENTATION_EXTENSIONS],
    },
    pdf: {
        kind: 'document',
        label: 'PDF Documents',
        command: 'pdftotext',
        parserName: 'pdftotext',
        installLabel: 'poppler-utils',
        extensions: [PDF_EXTENSION],
    },
    legacy: {
        kind: 'document',
        label: 'Legacy Office (.doc, .xls, .ppt)',
        command: 'soffice',
        parserName: 'LibreOffice + Katab Office reader',
        installLabel: 'libreoffice',
        extensions: Array.from(LEGACY_OFFICE_EXTENSIONS),
    },
    eml: {
        kind: 'document',
        label: 'Email Messages (.eml)',
        status: TOOL_STATUS.BUILTIN,
        parserName: 'Katab EML parser',
        installLabel: null,
        extensions: [EML_EXTENSION],
    },
};

export class DocumentToolError extends Error {
    constructor(message, { code = 'document-tool-error', installLabel = null } = {}) {
        super(message);
        this.name = 'DocumentToolError';
        this.code = code;
        this.installLabel = installLabel;
    }
}

export function findLibreOfficePath() {
    for (const command of ['soffice', 'libreoffice']) {
        const path = GLib.find_program_in_path(command);
        if (path) return path;
    }
    return null;
}

// Detection runs a PATH scan per helper.  Attachment metadata and folder
// imports ask for it once per file, so a short cache keeps that cheap while
// still reacting to installs/removals almost immediately.
const CAPABILITY_CACHE_MS = 2000;
let capabilityCache = { builtAt: 0, value: null };

export function invalidateDocumentToolCapabilities() {
    capabilityCache = { builtAt: 0, value: null };
}

export function getDocumentToolCapabilities() {
    const nowMs = GLib.get_monotonic_time() / 1000;
    if (capabilityCache.value && nowMs - capabilityCache.builtAt < CAPABILITY_CACHE_MS) {
        return capabilityCache.value;
    }

    const pdfPath = GLib.find_program_in_path(CAPABILITY_META.pdf.command);
    const libreOfficePath = findLibreOfficePath();

    const capabilities = {
        text: {
            key: 'text',
            available: true,
            commandPath: null,
            ...CAPABILITY_META.text,
        },
        image: {
            key: 'image',
            available: true,
            commandPath: null,
            ...CAPABILITY_META.image,
        },
        eml: {
            key: 'eml',
            available: true,
            commandPath: null,
            ...CAPABILITY_META.eml,
        },
        csv: {
            key: 'csv',
            available: true,
            commandPath: null,
            ...CAPABILITY_META.csv,
        },
        word: {
            key: 'word',
            available: true,
            commandPath: null,
            ...CAPABILITY_META.word,
        },
        spreadsheet: {
            key: 'spreadsheet',
            available: true,
            commandPath: null,
            ...CAPABILITY_META.spreadsheet,
        },
        presentation: {
            key: 'presentation',
            available: true,
            commandPath: null,
            ...CAPABILITY_META.presentation,
        },
        pdf: {
            key: 'pdf',
            available: Boolean(pdfPath),
            commandPath: pdfPath || null,
            status: pdfPath ? TOOL_STATUS.DETECTED : TOOL_STATUS.INSTALL,
            ...CAPABILITY_META.pdf,
        },
        legacy: {
            key: 'legacy',
            available: Boolean(libreOfficePath),
            commandPath: libreOfficePath || null,
            status: libreOfficePath ? TOOL_STATUS.DETECTED : TOOL_STATUS.INSTALL,
            ...CAPABILITY_META.legacy,
        },
    };

    capabilityCache = { builtAt: nowMs, value: capabilities };
    return capabilities;
}

// Single human-readable list of everything the document tool can parse.  Used
// by the unsupported-format error, the /doc help line, and the knowledge-base
// import messages so the advertised formats never drift apart.
export function getSupportedFormatSummary() {
    return 'txt, md, markdown, pdf, docx, doc, odt, rtf, xlsx, xls, ods, csv, tsv, pptx, ppt, odp, eml, png, jpg, jpeg';
}

export function parseDocumentCommand(promptText) {
    const text = String(promptText || '');
    if (!text.startsWith(DOCUMENT_TOOL_COMMAND)) {
        return null;
    }

    // Word boundary: only '/doc' followed by whitespace (or the end of the
    // prompt) is the command.  '/docs …' or '/document …' are ordinary text
    // and must not open the file picker.
    const after = text.slice(DOCUMENT_TOOL_COMMAND.length);
    if (after && !/^\s/.test(after)) {
        return null;
    }

    let remainder = after.trim();
    if (!remainder) {
        return {
            isCommand: true,
            needsPicker: true,
            filePath: null,
            promptText: '',
        };
    }

    if (!remainder.startsWith('"')) {
        return {
            isCommand: true,
            needsPicker: true,
            filePath: null,
            promptText: remainder,
        };
    }

    let filePath = '';
    let escaped = false;
    let index = 1;

    while (index < remainder.length) {
        const ch = remainder[index];
        if (escaped) {
            filePath += ch;
            escaped = false;
            index++;
            continue;
        }

        if (ch === '\\') {
            escaped = true;
            index++;
            continue;
        }

        if (ch === '"') {
            index++;
            break;
        }

        filePath += ch;
        index++;
    }

    if (index > remainder.length || remainder[index - 1] !== '"') {
        throw new DocumentToolError(
            'Use /doc "path/to/file" so Katab can tell the document path apart from your prompt.',
            {
                code: 'invalid-command',
            },
        );
    }

    return {
        isCommand: true,
        needsPicker: filePath.trim() === '',
        filePath: filePath.trim() || null,
        promptText: remainder.slice(index).trim(),
    };
}

export function resolveDocumentPath(rawPath) {
    if (!rawPath) {
        return null;
    }

    const trimmed = rawPath.trim();
    if (!trimmed) {
        return null;
    }

    if (trimmed === '~') {
        return GLib.get_home_dir();
    }

    if (trimmed.startsWith('~/')) {
        return GLib.build_filenamev([GLib.get_home_dir(), trimmed.slice(2)]);
    }

    if (!GLib.path_is_absolute(trimmed)) {
        return null;
    }

    return GLib.canonicalize_filename(trimmed, null);
}

export function buildDocumentPromptBlock(document) {
    let lines = [
        `Attached document: ${document.displayName}`,
        `Source path: ${document.path}`,
        `Parser: ${document.parserName}`,
    ];

    if (document.truncated) {
        lines.push('Note: Katab truncated the extracted text to fit the current chat context.');
    }

    lines.push('');
    lines.push('Document text follows:');
    lines.push(String(document.text ?? ''));

    return lines.join('\n');
}

export function buildMissingDocumentPromptBlock(documentMeta) {
    const label = documentMeta?.displayName || documentMeta?.path || 'document';
    return `Previously attached document: ${label}. Reattach it to include its text in the current request.`;
}

export function buildMissingImagePromptBlock(documentMeta) {
    const label = documentMeta?.displayName || documentMeta?.path || 'image';
    return `Previously attached image: ${label}. Reattach it in the current session to include it in the current request.`;
}

// Used when deepseek-v4-pro (text-only) is the active provider — or when a
// Flash image's bytes are no longer cached — and the user attached images.
// The vision model's analysis replaces the raw image bytes, so the text model
// never sees the image itself, only this analysis block.
export function buildVisionAnalysisPromptBlock(analysisText, modelName) {
    const source = modelName || 'the configured vision model';
    const analysis = String(analysisText ?? '').trim();
    if (!analysis) {
        return '[Vision analysis unavailable — the attached image was not analyzed.]';
    }
    return [`[Vision analysis of the attached image(s), provided by ${source}]:`, analysis].join(
        '\n',
    );
}

export function getAttachmentInfoForPath(path) {
    return getAttachmentInfoForExtension(getFileExtension(path));
}

const ATTACHMENT_ICON_BY_CAPABILITY = {
    text: 'text-x-generic-symbolic',
    image: 'image-x-generic-symbolic',
    csv: 'x-office-spreadsheet-symbolic',
    spreadsheet: 'x-office-spreadsheet-symbolic',
    presentation: 'x-office-presentation-symbolic',
    word: 'x-office-document-symbolic',
    pdf: 'x-office-document-symbolic',
    legacy: 'x-office-document-symbolic',
    eml: 'mail-unread-symbolic',
};

/** Symbolic icon name for an attachment chip (Office files get their own). */
export function getDocumentIconName(attachmentMeta) {
    if (looksLikeImageAttachment(attachmentMeta)) return ATTACHMENT_ICON_BY_CAPABILITY.image;
    const info = getAttachmentInfoForPath(
        attachmentMeta?.path || attachmentMeta?.displayName || '',
    );
    return ATTACHMENT_ICON_BY_CAPABILITY[info.capability?.key] || DOCUMENT_TOOL_ICON;
}

// True when the path is a text document the document tool can actually parse
// right now (images and formats whose helper is missing are excluded).  The
// knowledge-base folder import uses this so the announced and accepted
// formats cannot drift apart.
export function isParsableDocumentPath(path) {
    const info = getAttachmentInfoForPath(path);
    return info.kind === 'document' && Boolean(info.capability?.available);
}

// True when the attachment metadata (or its file extension) describes an
// image.  Lives here (next to getAttachmentInfoForPath) so the dialog and the
// provider-payload shaping in src/providers/historyPayload.js share a single
// detector.
export function looksLikeImageAttachment(attachmentMeta) {
    if (!attachmentMeta) {
        return false;
    }

    if (attachmentMeta.kind === 'image') {
        return true;
    }

    if (
        typeof attachmentMeta.mimeType === 'string' &&
        attachmentMeta.mimeType.startsWith('image/')
    ) {
        return true;
    }

    const info = getAttachmentInfoForPath(attachmentMeta.path || attachmentMeta.displayName || '');
    return info.kind === 'image';
}

function getFileExtension(path) {
    const filename = GLib.path_get_basename(path);
    const lastDot = filename.lastIndexOf('.');
    if (lastDot < 0) {
        return '';
    }

    return filename.slice(lastDot + 1).toLowerCase();
}

const CAPABILITY_KEY_BY_EXTENSION = new Map();
for (const [key, meta] of Object.entries(CAPABILITY_META)) {
    for (const extension of meta.extensions) {
        CAPABILITY_KEY_BY_EXTENSION.set(extension, key);
    }
}

function getCapabilityForExtension(extension) {
    const key = CAPABILITY_KEY_BY_EXTENSION.get(extension);
    if (!key) return null;
    return getDocumentToolCapabilities()[key] || null;
}

function getAttachmentInfoForExtension(extension) {
    const capability = getCapabilityForExtension(extension);
    if (!capability) {
        return {
            capability: null,
            extension,
            kind: null,
            mimeType: null,
        };
    }

    return {
        capability,
        extension,
        kind: capability.kind,
        mimeType: IMAGE_MIME_TYPES.get(extension) || null,
    };
}

function normalizeDocumentText(text) {
    return (
        text
            .replace(/\r\n?/g, '\n')
            // Embedded NUL bytes are stripped deliberately — they break Pango
            // markup and JSON round-trips.
            // eslint-disable-next-line no-control-regex
            .replace(/\u0000/g, '')
            .replace(/[ \t]+\n/g, '\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim()
    );
}

function truncateDocumentText(text, maxChars) {
    if (text.length <= maxChars) {
        return {
            text,
            truncated: false,
            originalCharCount: text.length,
        };
    }

    return {
        text: `${text.slice(0, maxChars).trimEnd()}\n\n[Document truncated by Katab to stay within the current chat context.]`,
        truncated: true,
        originalCharCount: text.length,
    };
}

function queryFileInfoAsync(file, cancellable = null) {
    return new Promise((resolve, reject) => {
        file.query_info_async(
            'standard::display-name,standard::size,standard::type,time::modified',
            Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT,
            cancellable,
            (source, result) => {
                try {
                    resolve(source.query_info_finish(result));
                } catch (error) {
                    reject(error);
                }
            },
        );
    });
}

function loadBinaryContentsAsync(file, cancellable = null) {
    return new Promise((resolve, reject) => {
        file.load_contents_async(cancellable, (source, result) => {
            try {
                const [ok, contents] = source.load_contents_finish(result);
                if (!ok) {
                    throw new DocumentToolError('Katab could not read this file.', {
                        code: 'read-failed',
                    });
                }

                resolve(contents);
            } catch (error) {
                reject(error);
            }
        });
    });
}

async function loadContentsAsync(file, cancellable = null) {
    const contents = await loadBinaryContentsAsync(file, cancellable);
    return new TextDecoder('utf-8').decode(contents);
}

function runCommandAsync(argv, cancellable = null, installLabel = null, options = {}) {
    const { timeoutSeconds = 0 } = options;
    return new Promise((resolve, reject) => {
        let subprocess;
        try {
            subprocess = Gio.Subprocess.new(
                argv,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
            );
        } catch (_error) {
            reject(
                new DocumentToolError(
                    `Katab could not start ${argv[0]}. Install ${installLabel || argv[0]} and try again.`,
                    {
                        code: 'spawn-failed',
                        installLabel,
                    },
                ),
            );
            return;
        }

        // LibreOffice can hang on a damaged file; the timeout keeps the chat
        // request from waiting forever.
        let timedOut = false;
        let timeoutId = 0;
        const clearTimeoutSource = () => {
            if (!timeoutId) return;
            GLib.source_remove(timeoutId);
            timeoutId = 0;
        };
        if (timeoutSeconds > 0) {
            timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, timeoutSeconds, () => {
                timeoutId = 0;
                timedOut = true;
                try {
                    subprocess.force_exit();
                } catch (_e) {
                    /* already gone */
                }
                return GLib.SOURCE_REMOVE;
            });
        }

        const timeoutError = () =>
            new DocumentToolError(
                `${argv[0]} did not finish within ${timeoutSeconds} seconds. The file may be too large or damaged.`,
                { code: 'command-timeout', installLabel },
            );

        subprocess.communicate_utf8_async(null, cancellable, (source, result) => {
            clearTimeoutSource();
            try {
                const [, stdout, stderr] = source.communicate_utf8_finish(result);
                if (timedOut) throw timeoutError();
                if (!source.get_successful()) {
                    throw new DocumentToolError(
                        stderr?.trim() || `${argv[0]} returned a non-zero exit status.`,
                        {
                            code: 'command-failed',
                            installLabel,
                        },
                    );
                }

                resolve(stdout || '');
            } catch (error) {
                // Cancelling the request must not leave the helper (e.g.
                // pdftotext/LibreOffice) running to completion.
                try {
                    subprocess.force_exit();
                } catch (_e) {}
                reject(timedOut && !(error instanceof DocumentToolError) ? timeoutError() : error);
            }
        });
    });
}

function runOfficeParser(bytes, extension, displayName) {
    try {
        return extractOfficeText(bytes, extension);
    } catch (error) {
        throw new DocumentToolError(`Katab could not read ${displayName}: ${error.message}`, {
            code: error.code || 'office-parse-failed',
        });
    }
}

function findConvertedOfficeFile(directoryPath, extension) {
    let children;
    try {
        children = Gio.File.new_for_path(directoryPath).enumerate_children(
            'standard::name,standard::type',
            Gio.FileQueryInfoFlags.NONE,
            null,
        );
    } catch (_e) {
        return null;
    }

    const suffix = `.${extension}`.toLowerCase();
    let converted = null;
    let info;
    try {
        while ((info = children.next_file(null)) !== null) {
            const name = info.get_name();
            if (
                info.get_file_type() === Gio.FileType.REGULAR &&
                name.toLowerCase().endsWith(suffix)
            ) {
                converted = GLib.build_filenamev([directoryPath, name]);
                break;
            }
        }
    } catch (_e) {
        converted = null;
    } finally {
        try {
            children.close(null);
        } catch (_e) {}
    }
    return converted;
}

function removeDirectoryRecursively(path) {
    try {
        const directory = Gio.File.new_for_path(path);
        const children = directory.enumerate_children(
            'standard::name,standard::type',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
            null,
        );
        let info;
        while ((info = children.next_file(null)) !== null) {
            const childPath = GLib.build_filenamev([path, info.get_name()]);
            if (info.get_file_type() === Gio.FileType.DIRECTORY) {
                removeDirectoryRecursively(childPath);
            } else {
                try {
                    Gio.File.new_for_path(childPath).delete(null);
                } catch (_e) {}
            }
        }
        children.close(null);
        directory.delete(null);
    } catch (_e) {
        // Best effort — a leftover temp folder is harmless.
    }
}

// ── .eml email parsing (pure JS, no external tool) ─────────────────────
// EML files are RFC 5322 messages with MIME structure (RFC 2045-2049):
// a header block followed by a body that may be a single part or a
// multipart container.  Katab decodes headers (RFC 2047 encoded-words),
// body transfer encodings (base64 / quoted-printable), prefers the
// text/plain branch of multipart/alternative, converts HTML-only bodies
// to text, and lists attachment names/sizes — all without spawning a
// helper process.

function parseContentType(headerValue) {
    const value = String(headerValue ?? '').trim();
    const semi = value.indexOf(';');
    const type = (semi < 0 ? value : value.slice(0, semi)).trim().toLowerCase();
    const params = {};
    if (semi >= 0) {
        const paramRe = /([a-zA-Z0-9*_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;\s]+))/g;
        let match;
        while ((match = paramRe.exec(value.slice(semi + 1))) !== null) {
            const key = match[1].toLowerCase().replace(/\*$/, '');
            params[key] = match[2] !== undefined ? match[2] : match[3];
        }
    }
    return { type, params };
}

function parseEmailHeaders(rawHeaderBlock) {
    const headers = {};
    let currentName = null;
    const lines = String(rawHeaderBlock ?? '').split(/\r?\n/);
    for (const line of lines) {
        if (/^[ \t]/.test(line)) {
            // Folded continuation of the previous header.
            if (currentName && headers[currentName] !== undefined) {
                headers[currentName] += ' ' + line.trim();
            }
            continue;
        }
        const colon = line.indexOf(':');
        if (colon <= 0) continue;
        const name = line.slice(0, colon).trim().toLowerCase();
        const value = line.slice(colon + 1).trim();
        headers[name] = headers[name] !== undefined ? `${headers[name]}, ${value}` : value;
        currentName = name;
    }
    return headers;
}

// Interprets a "binary string" (each char code is one byte, 0-255) using
// the given charset — the only correct way to decode quoted-printable
// byte sequences like =C3=A9 into actual UTF-8 text.
function decodeBytesAsText(binaryString, charset = 'utf-8') {
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i) & 0xff;
    }
    try {
        return new TextDecoder(charset).decode(bytes);
    } catch (_e) {
        return binaryString;
    }
}

function decodeQuotedPrintable(text, charset = 'utf-8', underscoreIsSpace = false) {
    const binary = String(text ?? '')
        .replace(/=\r?\n/g, '') // soft line breaks
        .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    const withSpaces = underscoreIsSpace ? binary.replace(/_/g, ' ') : binary;
    return decodeBytesAsText(withSpaces, charset);
}

function decodeBase64Body(text, charset = 'utf-8') {
    try {
        const bytes = GLib.base64_decode(String(text ?? '').replace(/\s+/g, ''));
        return new TextDecoder(charset).decode(bytes);
    } catch (_e) {
        return '';
    }
}

function decodeHeaderValue(value) {
    // RFC 2047 encoded-words, e.g. =?UTF-8?B?...?= or =?UTF-8?Q?...?=
    const encodedWordRe = /=\?([^?\s]+)\?([bBqQ])\?([^?]*)\?=/g;
    return String(value ?? '').replace(encodedWordRe, (match, charset, encoding, payload) => {
        try {
            if (encoding.toLowerCase() === 'b') {
                return decodeBase64Body(payload, charset);
            }
            return decodeQuotedPrintable(payload, charset, true).trim();
        } catch (_e) {
            return match;
        }
    });
}

function decodeHeaderFilename(value) {
    // RFC 2231 extended parameter: charset''percent-encoded
    const starMatch = /^(?:[^']*)''(.+)$/.exec(String(value ?? ''));
    if (starMatch) {
        try {
            return decodeURIComponent(starMatch[1]);
        } catch (_e) {
            return starMatch[1];
        }
    }
    return decodeHeaderValue(value);
}

function htmlToText(html) {
    let text = String(html ?? '');
    text = text.replace(
        /<\/(p|div|h[1-6]|li|tr|table|thead|tbody|ul|ol|blockquote|section|article|header|footer)[^>]*>/gi,
        '\n',
    );
    text = text.replace(/<(br|hr)[^>]*\/?>/gi, '\n');
    text = text.replace(/<[^>]+>/g, '');
    return text
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/&apos;/gi, "'")
        .replace(/&#(\d+);/g, (_, n) => {
            try {
                return String.fromCodePoint(parseInt(n, 10));
            } catch (_e) {
                return '';
            }
        })
        .replace(/&[a-zA-Z]+;/g, '');
}

function splitByBoundary(body, boundary) {
    const delim = '--' + boundary;
    const lines = String(body ?? '').split('\n');
    const parts = [];
    let current = [];
    let inPart = false;
    for (const line of lines) {
        const stripped = line.replace(/[ \t]+$/, '');
        if (stripped === delim) {
            if (inPart) parts.push(current.join('\n'));
            current = [];
            inPart = true;
            continue;
        }
        if (stripped === delim + '--') {
            if (inPart) parts.push(current.join('\n'));
            current = [];
            inPart = false;
            break;
        }
        if (inPart) current.push(line);
    }
    return parts;
}

// Parses one MIME part. `raw` may begin with its own header block (when
// `hasOwnHeaders` is true, i.e. a sub-part split from a multipart
// container); otherwise `raw` is a plain body and `inheritedHeaders`
// supplies things like the top-level Content-Transfer-Encoding. Returns
// an array of segment descriptors:
//   { type: 'text', content }
//   { type: 'html', content }
//   { type: 'attachment', filename, mimeType, size }
//   { type: 'alternative', children }
function parseMimePart(
    raw,
    fallbackContentType,
    { hasOwnHeaders = false, inheritedHeaders = {} } = {},
) {
    const partHeaders = { ...inheritedHeaders };
    let partBody;
    if (hasOwnHeaders) {
        const rawText = String(raw ?? '');
        const headerEnd = rawText.search(/\n\n/);
        if (headerEnd < 0) {
            partBody = rawText;
        } else {
            Object.assign(partHeaders, parseEmailHeaders(rawText.slice(0, headerEnd)));
            partBody = rawText.slice(headerEnd + 2);
        }
    } else {
        partBody = String(raw ?? '');
    }

    const contentTypeHeader = partHeaders['content-type'] || fallbackContentType || 'text/plain';
    const { type, params } = parseContentType(contentTypeHeader);

    if (type.startsWith('multipart/')) {
        const boundary = params.boundary;
        if (!boundary) return [];
        const children = [];
        for (const sub of splitByBoundary(partBody, boundary)) {
            children.push(...parseMimePart(sub, null, { hasOwnHeaders: true }));
        }
        if (type === 'multipart/alternative') {
            return [{ type: 'alternative', children }];
        }
        return children;
    }

    const cte = (partHeaders['content-transfer-encoding'] || '7bit').toLowerCase().trim();
    const charset = params.charset || 'utf-8';

    if (type === 'text/plain') {
        return [{ type: 'text', content: decodePartBody(partBody, cte, charset) }];
    }

    if (type === 'text/html') {
        return [{ type: 'html', content: decodePartBody(partBody, cte, charset) }];
    }

    // Anything else is an attachment (or an inline resource we list).
    const disposition = parseContentType(partHeaders['content-disposition'] || '');
    const filename = decodeHeaderFilename(disposition.params.filename || params.name || '');
    return [
        {
            type: 'attachment',
            filename,
            mimeType: type || null,
            size: estimatePartSize(partBody, cte),
        },
    ];
}

function decodePartBody(partBody, cte, charset) {
    if (cte === 'base64') {
        return decodeBase64Body(partBody, charset);
    }
    if (cte === 'quoted-printable') {
        return decodeQuotedPrintable(partBody, charset, false);
    }
    return String(partBody ?? '');
}

function estimatePartSize(partBody, cte) {
    const body = String(partBody ?? '');
    if (cte === 'base64') {
        const compact = body.replace(/\s+/g, '');
        return Math.max(
            0,
            Math.floor((compact.length * 3) / 4) -
                (compact.endsWith('==') ? 2 : compact.endsWith('=') ? 1 : 0),
        );
    }
    if (cte === 'quoted-printable') {
        return body.replace(/=\r?\n/g, '').replace(/=([0-9A-Fa-f]{2})/g, 'X').length;
    }
    return body.length;
}

function flattenEmlSegments(segments, out = { textParts: [], attachments: [], hasHtml: false }) {
    for (const seg of segments) {
        if (seg.type === 'text') {
            out.textParts.push(seg.content);
        } else if (seg.type === 'html') {
            out.hasHtml = true;
            out.textParts.push(htmlToText(seg.content));
        } else if (seg.type === 'attachment') {
            out.attachments.push(seg);
        } else if (seg.type === 'alternative') {
            // Prefer the text/plain branch; fall back to the HTML branch.
            const plain = seg.children.find((s) => s.type === 'text');
            const chosen = plain || seg.children.find((s) => s.type === 'html');
            if (chosen) {
                flattenEmlSegments([chosen], out);
            } else {
                flattenEmlSegments(seg.children, out);
            }
        }
    }
    return out;
}

// Parses an .eml file's text into a structured, model-friendly summary.
export function parseEmlText(text) {
    const normalized = String(text ?? '').replace(/\r\n/g, '\n');
    const headerEnd = normalized.search(/\n\n/);
    let headers;
    let rawBody;
    if (headerEnd < 0) {
        headers = parseEmailHeaders(normalized);
        rawBody = '';
    } else {
        headers = parseEmailHeaders(normalized.slice(0, headerEnd));
        rawBody = normalized.slice(headerEnd + 2);
    }

    const contentType = headers['content-type'] || 'text/plain';
    // A single-part message carries its own Content-Transfer-Encoding at the
    // top level (e.g. a base64 or quoted-printable body) — inherit it.
    const segments = parseMimePart(rawBody, contentType, {
        inheritedHeaders: {
            'content-transfer-encoding': headers['content-transfer-encoding'],
        },
    });
    const { textParts, attachments, hasHtml } = flattenEmlSegments(segments);

    const body = textParts
        .join('\n')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

    return {
        headers,
        subject: decodeHeaderValue(headers.subject || ''),
        from: decodeHeaderValue(headers.from || ''),
        to: decodeHeaderValue(headers.to || ''),
        date: headers.date || '',
        body,
        hasHtml,
        attachments,
    };
}

// Renders the parsed email as a readable text block (headers + body +
// attachment names) that is then sent to the model like any other text.
export function formatEmlDocument(parsed) {
    const lines = [];
    const headerFields = [
        ['Subject', parsed.subject],
        ['From', parsed.from],
        ['To', parsed.to],
        ['Date', parsed.date],
        ['Cc', parsed.headers.cc ? decodeHeaderValue(parsed.headers.cc) : ''],
        [
            'Reply-To',
            parsed.headers['reply-to'] ? decodeHeaderValue(parsed.headers['reply-to']) : '',
        ],
    ];
    let wroteHeader = false;
    for (const [label, value] of headerFields) {
        if (value) {
            lines.push(`${label}: ${value}`);
            wroteHeader = true;
        }
    }
    if (wroteHeader) lines.push('');

    if (parsed.body) {
        lines.push(parsed.body);
    } else {
        lines.push('[No readable text body in this email.]');
    }

    if (parsed.attachments.length > 0) {
        const list = parsed.attachments
            .map((a) => {
                const size = a.size ? ` (${a.size} bytes)` : '';
                return `${a.filename || a.mimeType || 'file'}${size}`;
            })
            .join(', ');
        lines.push('');
        lines.push(`[Attachments: ${list}]`);
    }

    return lines
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

// EML files are usually UTF-8, but some older ones use a legacy charset.
// Falling back to Latin-1 avoids a flood of replacement characters when
// UTF-8 decoding fails on such files.
function decodeEmlBytes(bytes) {
    const utf8 = new TextDecoder('utf-8').decode(bytes);
    if (!utf8.includes('\uFFFD')) {
        return utf8;
    }
    try {
        return new TextDecoder('iso-8859-1').decode(bytes);
    } catch (_e) {
        return utf8;
    }
}

export class DocumentToolRuntime {
    constructor({ maxChars = DOCUMENT_TOOL_MAX_CHARS } = {}) {
        this._maxChars = maxChars;
        this._cache = new Map();
    }

    // Drop every cached parse. Called when the session attachment cache is
    // cleared (new chat / conversation load / document tool disabled) so large
    // image payloads are not retained after they can no longer be sent.
    clearCache() {
        this._cache.clear();
    }

    _cacheStore(key, value) {
        // Refresh insertion order on re-set, then evict the oldest entries.
        this._cache.delete(key);
        this._cache.set(key, value);
        while (this._cache.size > DOCUMENT_RUNTIME_CACHE_MAX_ENTRIES) {
            const oldest = this._cache.keys().next().value;
            this._cache.delete(oldest);
        }
    }

    async parseDocument(rawPath, cancellable = null) {
        const resolvedPath = resolveDocumentPath(rawPath);
        if (!resolvedPath) {
            throw new DocumentToolError(
                'Use an absolute path, a ~/path, or the picker when attaching a file.',
                {
                    code: 'invalid-path',
                },
            );
        }

        const file = Gio.File.new_for_path(resolvedPath);
        if (!file.is_native()) {
            throw new DocumentToolError(
                'Katab only supports local native files for attachments right now.',
                {
                    code: 'non-native-file',
                },
            );
        }

        let info;
        try {
            info = await queryFileInfoAsync(file, cancellable);
        } catch (e) {
            if (e.matches(Gio.io_error_quark(), Gio.IOErrorEnum.NOT_FOUND)) {
                throw new DocumentToolError(
                    `The file "${resolvedPath}" no longer exists. It may have been moved, deleted, or the clipboard image could not be saved. Try pasting the image again.`,
                    { code: 'file-not-found' },
                );
            }
            throw new DocumentToolError(
                `Could not read "${resolvedPath}": ${e.message || 'unknown error'}`,
                { code: 'file-read-error' },
            );
        }
        if (info.get_file_type() !== Gio.FileType.REGULAR) {
            throw new DocumentToolError(
                'Katab can only attach regular files, not folders or special paths.',
                {
                    code: 'not-regular-file',
                },
            );
        }

        const displayName = info.get_display_name() || GLib.path_get_basename(resolvedPath);
        const attachmentInfo = getAttachmentInfoForPath(resolvedPath);
        const { capability, extension, kind, mimeType } = attachmentInfo;
        if (!capability) {
            throw new DocumentToolError(
                `Unsupported file format. Katab can read ${getSupportedFormatSummary()}.`,
                {
                    code: 'unsupported-format',
                },
            );
        }

        if (!capability.available) {
            throw new DocumentToolError(
                `Install ${capability.installLabel} to parse ${displayName}.`,
                {
                    code: 'missing-tool',
                    installLabel: capability.installLabel,
                },
            );
        }

        const cacheKey = this._buildCacheKey(resolvedPath, info);
        const cached = this._cache.get(cacheKey);
        if (cached) {
            // LRU touch so frequently re-attached files survive eviction.
            this._cacheStore(cacheKey, cached);
            return cached;
        }

        if (kind === 'image') {
            const contents = await loadBinaryContentsAsync(file, cancellable);
            if (!contents || contents.length === 0) {
                throw new DocumentToolError(
                    `Katab could not read any image data from ${displayName}.`,
                    {
                        code: 'empty-image',
                    },
                );
            }

            const result = {
                id: `doc_${GLib.uuid_string_random()}`,
                kind,
                displayName,
                extension,
                mimeType,
                path: resolvedPath,
                parserName: capability.parserName,
                installLabel: capability.installLabel,
                commandPath: capability.commandPath,
                base64Data: GLib.base64_encode(contents),
                byteSize: info.get_size(),
                cachedAt: Math.floor(Date.now() / 1000),
            };

            this._cacheStore(cacheKey, result);
            return result;
        }

        let extractedText = '';
        if (TEXT_EXTENSIONS.has(extension)) {
            extractedText = await loadContentsAsync(file, cancellable);
        } else if (extension === PDF_EXTENSION) {
            extractedText = await runCommandAsync(
                [capability.command, '-layout', resolvedPath, '-'],
                cancellable,
                capability.installLabel,
            );
        } else if (extension === EML_EXTENSION) {
            // EML parsing is pure JS — no external helper needed.
            const rawBytes = await loadBinaryContentsAsync(file, cancellable);
            extractedText = formatEmlDocument(parseEmlText(decodeEmlBytes(rawBytes)));
        } else if (isLegacyOfficeExtension(extension)) {
            extractedText = await this._convertLegacyOfficeDocument(
                resolvedPath,
                extension,
                capability,
                cancellable,
            );
        } else if (isOfficeExtension(extension)) {
            const rawBytes = await loadBinaryContentsAsync(file, cancellable);
            extractedText = runOfficeParser(rawBytes, extension, displayName);
        }

        const normalizedText = normalizeDocumentText(extractedText);
        if (!normalizedText) {
            throw new DocumentToolError(
                `Katab could not extract any readable text from ${displayName}.`,
                {
                    code: 'empty-document',
                    installLabel: capability.installLabel,
                },
            );
        }

        const truncated = truncateDocumentText(normalizedText, this._maxChars);
        const result = {
            id: `doc_${GLib.uuid_string_random()}`,
            kind,
            displayName,
            extension,
            path: resolvedPath,
            parserName: capability.parserName,
            installLabel: capability.installLabel,
            commandPath: capability.commandPath,
            text: truncated.text,
            truncated: truncated.truncated,
            originalCharCount: truncated.originalCharCount,
            cachedAt: Math.floor(Date.now() / 1000),
        };

        this._cacheStore(cacheKey, result);
        return result;
    }

    // Legacy binary Office files (.doc/.xls/.ppt) are OLE compound documents
    // that only LibreOffice can decode reliably.  Converting them to OOXML in
    // a throwaway profile keeps the output identical to the native readers and
    // avoids fighting a LibreOffice instance the user already has open.
    async _convertLegacyOfficeDocument(resolvedPath, extension, capability, cancellable) {
        const targetExtension = LEGACY_OFFICE_TARGETS.get(extension);
        const displayName = GLib.path_get_basename(resolvedPath);
        if (!targetExtension) {
            throw new DocumentToolError(`Katab does not know how to convert .${extension} files.`, {
                code: 'unsupported-format',
            });
        }

        const tempDir = GLib.dir_make_tmp('katab-office-XXXXXX');
        if (!tempDir) {
            throw new DocumentToolError(
                `Katab could not create a temporary folder to convert ${displayName}.`,
                { code: 'temp-dir-failed' },
            );
        }

        try {
            const profileUri = Gio.File.new_for_path(
                GLib.build_filenamev([tempDir, 'profile']),
            ).get_uri();
            await runCommandAsync(
                [
                    capability.commandPath || capability.command,
                    '--headless',
                    '--norestore',
                    '--nolockcheck',
                    '--nodefault',
                    '--nofirststartwizard',
                    `-env:UserInstallation=${profileUri}`,
                    '--convert-to',
                    targetExtension,
                    '--outdir',
                    tempDir,
                    resolvedPath,
                ],
                cancellable,
                capability.installLabel,
                { timeoutSeconds: 120 },
            );

            const convertedPath = findConvertedOfficeFile(tempDir, targetExtension);
            if (!convertedPath) {
                throw new DocumentToolError(
                    `LibreOffice could not convert ${displayName}. The file may be damaged or password-protected.`,
                    {
                        code: 'conversion-failed',
                        installLabel: capability.installLabel,
                    },
                );
            }

            const bytes = await loadBinaryContentsAsync(
                Gio.File.new_for_path(convertedPath),
                cancellable,
            );
            return runOfficeParser(bytes, targetExtension, displayName);
        } finally {
            removeDirectoryRecursively(tempDir);
        }
    }

    _buildCacheKey(path, info) {
        const modifiedAt = info.get_modification_date_time()?.to_unix() ?? 0;
        return `${path}:${info.get_size()}:${modifiedAt}`;
    }
}
