import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

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
const DOCX_EXTENSION = 'docx';
const EML_EXTENSION = 'eml';

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
    pdf: {
        kind: 'document',
        label: 'PDF Documents',
        command: 'pdftotext',
        parserName: 'pdftotext',
        installLabel: 'poppler-utils',
        extensions: [PDF_EXTENSION],
    },
    docx: {
        kind: 'document',
        label: 'Word Documents (.docx)',
        command: 'pandoc',
        parserName: 'pandoc',
        installLabel: 'pandoc',
        extensions: [DOCX_EXTENSION],
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

export function getDocumentToolCapabilities() {
    const pdfPath = GLib.find_program_in_path(CAPABILITY_META.pdf.command);
    const pandocPath = GLib.find_program_in_path(CAPABILITY_META.docx.command);

    return {
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
        pdf: {
            key: 'pdf',
            available: Boolean(pdfPath),
            commandPath: pdfPath || null,
            status: pdfPath ? TOOL_STATUS.DETECTED : TOOL_STATUS.INSTALL,
            ...CAPABILITY_META.pdf,
        },
        docx: {
            key: 'docx',
            available: Boolean(pandocPath),
            commandPath: pandocPath || null,
            status: pandocPath ? TOOL_STATUS.DETECTED : TOOL_STATUS.INSTALL,
            ...CAPABILITY_META.docx,
        },
        eml: {
            key: 'eml',
            available: true,
            commandPath: null,
            ...CAPABILITY_META.eml,
        },
    };
}

export function parseDocumentCommand(promptText) {
    if (!promptText || !promptText.startsWith(DOCUMENT_TOOL_COMMAND)) {
        return null;
    }

    let remainder = promptText.slice(DOCUMENT_TOOL_COMMAND.length).trim();
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
        throw new DocumentToolError('Use /doc "path/to/file" so Katab can tell the document path apart from your prompt.', {
            code: 'invalid-command',
        });
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
    lines.push(document.text);

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

// Used when DeepSeek (a text-only model) is the active provider and the user
// attached images.  The vision model's analysis replaces the raw image bytes —
// DeepSeek never sees the image itself, only this analysis block.
export function buildVisionAnalysisPromptBlock(analysisText, modelName) {
    const source = modelName || 'the configured vision model';
    const analysis = String(analysisText ?? '').trim();
    if (!analysis) {
        return '[Vision analysis unavailable — the attached image was not analyzed.]';
    }
    return [
        `[Vision analysis of the attached image(s), provided by ${source}]:`,
        analysis,
    ].join('\n');
}

export function getAttachmentInfoForPath(path) {
    return getAttachmentInfoForExtension(getFileExtension(path));
}

function getFileExtension(path) {
    const filename = GLib.path_get_basename(path);
    const lastDot = filename.lastIndexOf('.');
    if (lastDot < 0) {
        return '';
    }

    return filename.slice(lastDot + 1).toLowerCase();
}

function getCapabilityForExtension(extension) {
    const capabilities = getDocumentToolCapabilities();

    if (TEXT_EXTENSIONS.has(extension)) {
        return capabilities.text;
    }

    if (IMAGE_EXTENSIONS.has(extension)) {
        return capabilities.image;
    }

    if (extension === PDF_EXTENSION) {
        return capabilities.pdf;
    }

    if (extension === DOCX_EXTENSION) {
        return capabilities.docx;
    }

    if (extension === EML_EXTENSION) {
        return capabilities.eml;
    }

    return null;
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
    return text
        .replace(/\r\n?/g, '\n')
        .replace(/\u0000/g, '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
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
            }
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

function runCommandAsync(argv, cancellable = null, installLabel = null) {
    return new Promise((resolve, reject) => {
        let subprocess;
        try {
            subprocess = Gio.Subprocess.new(
                argv,
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE
            );
        } catch (_error) {
            reject(new DocumentToolError(`Katab could not start ${argv[0]}. Install ${installLabel || argv[0]} and try again.`, {
                code: 'spawn-failed',
                installLabel,
            }));
            return;
        }

        subprocess.communicate_utf8_async(null, cancellable, (source, result) => {
            try {
                const [, stdout, stderr] = source.communicate_utf8_finish(result);
                if (!source.get_successful()) {
                    throw new DocumentToolError(stderr?.trim() || `${argv[0]} returned a non-zero exit status.`, {
                        code: 'command-failed',
                        installLabel,
                    });
                }

                resolve(stdout || '');
            } catch (error) {
                // Cancelling the request must not leave the helper (e.g.
                // pdftotext/pandoc) running to completion.
                try { subprocess.force_exit(); } catch (_e) { }
                reject(error);
            }
        });
    });
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
    text = text.replace(/<\/(p|div|h[1-6]|li|tr|table|thead|tbody|ul|ol|blockquote|section|article|header|footer)[^>]*>/gi, '\n');
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
            try { return String.fromCodePoint(parseInt(n, 10)); } catch (_e) { return ''; }
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
function parseMimePart(raw, fallbackContentType, { hasOwnHeaders = false, inheritedHeaders = {} } = {}) {
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
    return [{
        type: 'attachment',
        filename,
        mimeType: type || null,
        size: estimatePartSize(partBody, cte),
    }];
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
        return Math.max(0, Math.floor((compact.length * 3) / 4) - (compact.endsWith('==') ? 2 : compact.endsWith('=') ? 1 : 0));
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
            const plain = seg.children.find(s => s.type === 'text');
            const chosen = plain || seg.children.find(s => s.type === 'html');
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
        ['Reply-To', parsed.headers['reply-to'] ? decodeHeaderValue(parsed.headers['reply-to']) : ''],
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
            .map(a => {
                const size = a.size ? ` (${a.size} bytes)` : '';
                return `${a.filename || a.mimeType || 'file'}${size}`;
            })
            .join(', ');
        lines.push('');
        lines.push(`[Attachments: ${list}]`);
    }

    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
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

    getCapabilities() {
        return getDocumentToolCapabilities();
    }

    async parseDocument(rawPath, cancellable = null) {
        const resolvedPath = resolveDocumentPath(rawPath);
        if (!resolvedPath) {
            throw new DocumentToolError('Use an absolute path, a ~/path, or the picker when attaching a file.', {
                code: 'invalid-path',
            });
        }

        const file = Gio.File.new_for_path(resolvedPath);
        if (!file.is_native()) {
            throw new DocumentToolError('Katab only supports local native files for attachments right now.', {
                code: 'non-native-file',
            });
        }

        let info;
        try {
            info = await queryFileInfoAsync(file, cancellable);
        } catch (e) {
            if (e.matches(Gio.io_error_quark(), Gio.IOErrorEnum.NOT_FOUND)) {
                throw new DocumentToolError(
                    `The file "${resolvedPath}" no longer exists. It may have been moved, deleted, or the clipboard image could not be saved. Try pasting the image again.`,
                    { code: 'file-not-found' }
                );
            }
            throw new DocumentToolError(
                `Could not read "${resolvedPath}": ${e.message || 'unknown error'}`,
                { code: 'file-read-error' }
            );
        }
        if (info.get_file_type() !== Gio.FileType.REGULAR) {
            throw new DocumentToolError('Katab can only attach regular files, not folders or special paths.', {
                code: 'not-regular-file',
            });
        }

        const displayName = info.get_display_name() || GLib.path_get_basename(resolvedPath);
        const attachmentInfo = getAttachmentInfoForPath(resolvedPath);
        const { capability, extension, kind, mimeType } = attachmentInfo;
        if (!capability) {
            throw new DocumentToolError('Unsupported file format. Use .txt, .md, .pdf, .docx, .png, .jpg, .jpeg, or .eml.', {
                code: 'unsupported-format',
            });
        }

        if (!capability.available) {
            throw new DocumentToolError(`Install ${capability.installLabel} to parse ${displayName}.`, {
                code: 'missing-tool',
                installLabel: capability.installLabel,
            });
        }

        const cacheKey = this._buildCacheKey(resolvedPath, info);
        const cached = this._cache.get(cacheKey);
        if (cached) {
            return cached;
        }

        if (kind === 'image') {
            const contents = await loadBinaryContentsAsync(file, cancellable);
            if (!contents || contents.length === 0) {
                throw new DocumentToolError(`Katab could not read any image data from ${displayName}.`, {
                    code: 'empty-image',
                });
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

            this._cache.set(cacheKey, result);
            return result;
        }

        let extractedText = '';
        if (TEXT_EXTENSIONS.has(extension)) {
            extractedText = await loadContentsAsync(file, cancellable);
        } else if (extension === PDF_EXTENSION) {
            extractedText = await runCommandAsync([
                capability.command,
                '-layout',
                resolvedPath,
                '-',
            ], cancellable, capability.installLabel);
        } else if (extension === DOCX_EXTENSION) {
            extractedText = await runCommandAsync([
                capability.command,
                '-f',
                'docx',
                '-t',
                'plain',
                '--wrap=none',
                resolvedPath,
            ], cancellable, capability.installLabel);
        } else if (extension === EML_EXTENSION) {
            // EML parsing is pure JS — no external helper needed.
            const rawBytes = await loadBinaryContentsAsync(file, cancellable);
            extractedText = formatEmlDocument(parseEmlText(decodeEmlBytes(rawBytes)));
        }

        const normalizedText = normalizeDocumentText(extractedText);
        if (!normalizedText) {
            throw new DocumentToolError(`Katab could not extract any readable text from ${displayName}.`, {
                code: 'empty-document',
                installLabel: capability.installLabel,
            });
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

        this._cache.set(cacheKey, result);
        return result;
    }

    _buildCacheKey(path, info) {
        const modifiedAt = info.get_modification_date_time()?.to_unix() ?? 0;
        return `${path}:${info.get_size()}:${modifiedAt}`;
    }
}