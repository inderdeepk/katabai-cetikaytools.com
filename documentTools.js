import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

export const DOCUMENT_TOOL_COMMAND = '/doc';
export const DOCUMENT_TOOL_NAME = 'document';
export const DOCUMENT_TOOL_ICON = 'text-x-generic-symbolic';
export const DOCUMENT_TOOL_MAX_CHARS = 24000;

const TEXT_EXTENSIONS = new Set(['md', 'markdown', 'txt']);
const PDF_EXTENSION = 'pdf';
const DOCX_EXTENSION = 'docx';

const TOOL_STATUS = {
    BUILTIN: 'builtin',
    DETECTED: 'detected',
    INSTALL: 'install',
};

const CAPABILITY_META = {
    text: {
        label: 'Text and Markdown',
        status: TOOL_STATUS.BUILTIN,
        parserName: 'Gio.File',
        installLabel: null,
        extensions: Array.from(TEXT_EXTENSIONS),
    },
    pdf: {
        label: 'PDF Documents',
        command: 'pdftotext',
        parserName: 'pdftotext',
        installLabel: 'poppler-utils',
        extensions: [PDF_EXTENSION],
    },
    docx: {
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

function getFileExtension(path) {
    const filename = GLib.path_get_basename(path);
    const lastDot = filename.lastIndexOf('.');
    if (lastDot < 0) {
        return '';
    }

    return filename.slice(lastDot + 1).toLowerCase();
}

function getCapabilityForExtension(extension) {
    if (TEXT_EXTENSIONS.has(extension)) {
        return getDocumentToolCapabilities().text;
    }

    if (extension === PDF_EXTENSION) {
        return getDocumentToolCapabilities().pdf;
    }

    if (extension === DOCX_EXTENSION) {
        return getDocumentToolCapabilities().docx;
    }

    return null;
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

function loadContentsAsync(file, cancellable = null) {
    return new Promise((resolve, reject) => {
        file.load_contents_async(cancellable, (source, result) => {
            try {
                const [ok, contents] = source.load_contents_finish(result);
                if (!ok) {
                    throw new DocumentToolError('Katab could not read this text file.', {
                        code: 'read-failed',
                    });
                }

                resolve(new TextDecoder('utf-8').decode(contents));
            } catch (error) {
                reject(error);
            }
        });
    });
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
            throw new DocumentToolError('Use an absolute path, a ~/path, or the picker when attaching a document.', {
                code: 'invalid-path',
            });
        }

        const file = Gio.File.new_for_path(resolvedPath);
        if (!file.is_native()) {
            throw new DocumentToolError('Katab only supports local native files for document parsing right now.', {
                code: 'non-native-file',
            });
        }

        const info = await queryFileInfoAsync(file, cancellable);
        if (info.get_file_type() !== Gio.FileType.REGULAR) {
            throw new DocumentToolError('Katab can only attach regular files, not folders or special paths.', {
                code: 'not-regular-file',
            });
        }

        const displayName = info.get_display_name() || GLib.path_get_basename(resolvedPath);
        const extension = getFileExtension(resolvedPath);
        const capability = getCapabilityForExtension(extension);
        if (!capability) {
            throw new DocumentToolError('Unsupported document format. Use .txt, .md, .pdf, or .docx.', {
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