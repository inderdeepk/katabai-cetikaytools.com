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
            throw new DocumentToolError('Unsupported file format. Use .txt, .md, .pdf, .docx, .png, .jpg, or .jpeg.', {
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