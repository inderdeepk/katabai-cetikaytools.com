// officeParsers.js — Native text extraction for Microsoft Office,
// OpenDocument, CSV/TSV and RTF files.
//
// DOCX/XLSX/PPTX (OOXML) and ODT/ODS/ODP/ODG (ODF) documents are ZIP
// containers holding XML.  Katab reads the ZIP central directory itself and
// inflates entries with Gio.ZlibDecompressor (raw deflate), so Word, Excel and
// PowerPoint attachments work without pandoc, libreoffice, or unzip.
//
// Legacy binary formats (.doc/.xls/.ppt) are not ZIP containers — the document
// tool converts those with LibreOffice first (see LEGACY_OFFICE_TARGETS).
//
// Everything here is synchronous: the caller already has the raw bytes and the
// extraction is pure CPU work, so it runs inline on the request that parses the
// attachment.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

export class OfficeParseError extends Error {
    constructor(message, { code = 'office-parse-error' } = {}) {
        super(message);
        this.name = 'OfficeParseError';
        this.code = code;
    }
}

// ── Format registry ────────────────────────────────────────────────────────

const FAMILY_BY_EXTENSION = new Map([
    // WordprocessingML
    ['docx', 'word'],
    ['docm', 'word'],
    ['dotx', 'word'],
    ['dotm', 'word'],
    // SpreadsheetML
    ['xlsx', 'sheet'],
    ['xlsm', 'sheet'],
    ['xltx', 'sheet'],
    ['xltm', 'sheet'],
    // PresentationML
    ['pptx', 'slides'],
    ['pptm', 'slides'],
    ['ppsx', 'slides'],
    ['ppsm', 'slides'],
    ['potx', 'slides'],
    ['potm', 'slides'],
    // OpenDocument text (zipped and flat XML variants)
    ['odt', 'odf-text'],
    ['ott', 'odf-text'],
    ['fodt', 'odf-text'],
    // OpenDocument spreadsheet
    ['ods', 'odf-sheet'],
    ['ots', 'odf-sheet'],
    ['fods', 'odf-sheet'],
    // OpenDocument presentation
    ['odp', 'odf-presentation'],
    ['otp', 'odf-presentation'],
    ['fodp', 'odf-presentation'],
    // OpenDocument drawing
    ['odg', 'odf-drawing'],
    ['otg', 'odf-drawing'],
    ['fodg', 'odf-drawing'],
    // Plain-text tables
    ['csv', 'delimited'],
    ['tsv', 'delimited'],
    ['tab', 'delimited'],
    // Rich Text Format
    ['rtf', 'rtf'],
]);

const FLAT_ODF_EXTENSIONS = new Set(['fodt', 'fods', 'fodp', 'fodg']);

// Legacy binary containers that need LibreOffice to be converted to OOXML
// before the native readers can take over.
export const LEGACY_OFFICE_TARGETS = new Map([
    ['doc', 'docx'],
    ['dot', 'docx'],
    ['xls', 'xlsx'],
    ['xlt', 'xlsx'],
    ['ppt', 'pptx'],
    ['pps', 'pptx'],
    ['pot', 'pptx'],
]);

export const OFFICE_EXTENSIONS = [...FAMILY_BY_EXTENSION.keys()];

export function isOfficeExtension(extension) {
    return FAMILY_BY_EXTENSION.has(String(extension || '').toLowerCase());
}

export function isLegacyOfficeExtension(extension) {
    return LEGACY_OFFICE_TARGETS.has(String(extension || '').toLowerCase());
}

export function getOfficeFamily(extension) {
    return FAMILY_BY_EXTENSION.get(String(extension || '').toLowerCase()) || null;
}

export function listOfficeExtensions(family) {
    const extensions = [];
    for (const [extension, value] of FAMILY_BY_EXTENSION) {
        if (value === family) extensions.push(extension);
    }
    return extensions;
}

// ── Limits ─────────────────────────────────────────────────────────────────
// Attachments are truncated to a chat-sized budget later; these limits only
// stop pathological files (zip bombs, million-row sheets) from burning CPU or
// memory before that truncation ever runs.

const ZIP_MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const ZIP_MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const TABLE_MAX_ROWS = 3000;
const TABLE_MAX_COLUMNS = 100;
const TABLE_MAX_CELLS = 20000;
// DocumentToolRuntime truncates attachments to DOCUMENT_TOOL_MAX_CHARS (24k)
// before they reach a provider, so parsing beyond this budget only burns CPU.
const MAX_EXTRACTED_CHARS = 200_000;

// ── ZIP container reader ───────────────────────────────────────────────────

const ZIP_LOCAL_SIGNATURE = 0x04034b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_EOCD_SIGNATURE = 0x06054b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;

const COMPRESSION_STORED = 0;
const COMPRESSION_DEFLATE = 8;

function readUint64(view, offset) {
    const low = view.getUint32(offset, true);
    const high = view.getUint32(offset + 4, true);
    return high * 0x100000000 + low;
}

function inflateRaw(compressed) {
    const decompressor = new Gio.ZlibDecompressor({ format: Gio.ZlibCompressorFormat.RAW });
    const memory = Gio.MemoryInputStream.new_from_bytes(new GLib.Bytes(compressed));
    const stream = new Gio.ConverterInputStream({ base_stream: memory, converter: decompressor });
    const chunks = [];
    let total = 0;
    try {
        while (true) {
            const chunk = stream.read_bytes(256 * 1024, null);
            const data = chunk.toArray();
            if (data.length === 0) break;
            total += data.length;
            if (total > ZIP_MAX_ENTRY_BYTES) {
                throw new OfficeParseError(
                    'An entry inside this Office file is too large to read.',
                    {
                        code: 'entry-too-large',
                    },
                );
            }
            chunks.push(data);
        }
    } finally {
        try {
            stream.close(null);
        } catch (_e) {
            /* already closed */
        }
    }

    const out = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.length;
    }
    return out;
}

/** Minimal read-only ZIP reader (enough for OOXML/ODF containers). */
export class OfficeZipArchive {
    constructor(bytes) {
        this._bytes = bytes;
        this._view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        this._entries = new Map();
        this._inflatedBytes = 0;
        this._readCentralDirectory();
    }

    static looksLikeZip(bytes) {
        return (
            bytes &&
            bytes.length >= 4 &&
            bytes[0] === 0x50 &&
            bytes[1] === 0x4b &&
            (bytes[2] === 0x03 || bytes[2] === 0x05)
        );
    }

    has(name) {
        return this._entries.has(name);
    }

    names() {
        return [...this._entries.keys()];
    }

    readBytes(name) {
        const entry = this._entries.get(name);
        if (!entry) return null;
        try {
            const data = this._inflateEntry(entry);
            this._inflatedBytes += data.length;
            if (this._inflatedBytes > ZIP_MAX_TOTAL_BYTES) {
                throw new OfficeParseError(
                    'This Office file expands to more data than Katab can read safely.',
                    { code: 'archive-too-large' },
                );
            }
            return data;
        } catch (error) {
            if (error instanceof OfficeParseError) throw error;
            throw new OfficeParseError(
                `Katab could not read "${name}" inside this Office file: ${error.message}`,
                { code: 'entry-read-failed' },
            );
        }
    }

    readText(name) {
        const bytes = this.readBytes(name);
        if (!bytes) return null;
        return decodeTextBytes(bytes);
    }

    _readCentralDirectory() {
        const view = this._view;
        const length = view.byteLength;
        if (length < 22) {
            throw new OfficeParseError('This file is not a valid Office (ZIP) container.', {
                code: 'invalid-container',
            });
        }

        let eocd = -1;
        const scanFloor = Math.max(0, length - 22 - 0xffff);
        for (let i = length - 22; i >= scanFloor; i--) {
            if (view.getUint32(i, true) === ZIP_EOCD_SIGNATURE) {
                eocd = i;
                break;
            }
        }
        if (eocd < 0) {
            throw new OfficeParseError('This file is not a valid Office (ZIP) container.', {
                code: 'invalid-container',
            });
        }

        let entryCount = view.getUint16(eocd + 10, true);
        let directoryOffset = view.getUint32(eocd + 16, true);

        if (entryCount === 0xffff || directoryOffset === 0xffffffff) {
            const locatorOffset = eocd - 20;
            if (
                locatorOffset >= 0 &&
                view.getUint32(locatorOffset, true) === ZIP64_LOCATOR_SIGNATURE
            ) {
                const zip64Offset = readUint64(view, locatorOffset + 8);
                if (
                    zip64Offset + 56 <= length &&
                    view.getUint32(zip64Offset, true) === ZIP64_EOCD_SIGNATURE
                ) {
                    entryCount = readUint64(view, zip64Offset + 32);
                    directoryOffset = readUint64(view, zip64Offset + 48);
                }
            }
        }

        let offset = directoryOffset;
        for (let index = 0; index < entryCount; index++) {
            if (offset + 46 > length) break;
            if (view.getUint32(offset, true) !== ZIP_CENTRAL_SIGNATURE) break;

            const flags = view.getUint16(offset + 8, true);
            const method = view.getUint16(offset + 10, true);
            let compressedSize = view.getUint32(offset + 20, true);
            let uncompressedSize = view.getUint32(offset + 24, true);
            const nameLength = view.getUint16(offset + 28, true);
            const extraLength = view.getUint16(offset + 30, true);
            const commentLength = view.getUint16(offset + 32, true);
            let localOffset = view.getUint32(offset + 42, true);

            const nameStart = offset + 46;
            const name = new TextDecoder('utf-8').decode(
                this._bytes.subarray(nameStart, nameStart + nameLength),
            );

            const extraStart = nameStart + nameLength;
            if (
                compressedSize === 0xffffffff ||
                uncompressedSize === 0xffffffff ||
                localOffset === 0xffffffff
            ) {
                const zip64 = this._readZip64Extra(extraStart, extraLength, {
                    needsUncompressed: uncompressedSize === 0xffffffff,
                    needsCompressed: compressedSize === 0xffffffff,
                    needsOffset: localOffset === 0xffffffff,
                });
                if (zip64.uncompressedSize !== null) uncompressedSize = zip64.uncompressedSize;
                if (zip64.compressedSize !== null) compressedSize = zip64.compressedSize;
                if (zip64.localOffset !== null) localOffset = zip64.localOffset;
            }

            if (name && !name.endsWith('/')) {
                this._entries.set(name, {
                    name,
                    method,
                    compressedSize,
                    uncompressedSize,
                    localOffset,
                    encrypted: (flags & 0x1) !== 0,
                });
            }

            offset = extraStart + extraLength + commentLength;
        }

        if (this._entries.size === 0) {
            throw new OfficeParseError('This Office file has no readable parts.', {
                code: 'empty-container',
            });
        }
    }

    _readZip64Extra(extraStart, extraLength, needs) {
        const result = { uncompressedSize: null, compressedSize: null, localOffset: null };
        let cursor = extraStart;
        const end = extraStart + extraLength;
        while (cursor + 4 <= end) {
            const id = this._view.getUint16(cursor, true);
            const size = this._view.getUint16(cursor + 2, true);
            const dataStart = cursor + 4;
            if (id === 0x0001) {
                let field = dataStart;
                const fieldEnd = dataStart + size;
                if (needs.needsUncompressed && field + 8 <= fieldEnd) {
                    result.uncompressedSize = readUint64(this._view, field);
                    field += 8;
                }
                if (needs.needsCompressed && field + 8 <= fieldEnd) {
                    result.compressedSize = readUint64(this._view, field);
                    field += 8;
                }
                if (needs.needsOffset && field + 8 <= fieldEnd) {
                    result.localOffset = readUint64(this._view, field);
                }
                return result;
            }
            cursor = dataStart + size;
        }
        return result;
    }

    _inflateEntry(entry) {
        if (entry.encrypted) {
            throw new OfficeParseError(
                'Password-protected Office files are not supported. Remove the password and attach the file again.',
                { code: 'encrypted-document' },
            );
        }

        const view = this._view;
        const localOffset = entry.localOffset;
        if (localOffset + 30 > this._bytes.length) {
            throw new OfficeParseError('This Office file is truncated or damaged.', {
                code: 'truncated-container',
            });
        }
        if (view.getUint32(localOffset, true) !== ZIP_LOCAL_SIGNATURE) {
            throw new OfficeParseError('This Office file is truncated or damaged.', {
                code: 'truncated-container',
            });
        }

        const nameLength = view.getUint16(localOffset + 26, true);
        const extraLength = view.getUint16(localOffset + 28, true);
        const dataStart = localOffset + 30 + nameLength + extraLength;
        const dataEnd = dataStart + entry.compressedSize;
        if (dataEnd > this._bytes.length) {
            throw new OfficeParseError('This Office file is truncated or damaged.', {
                code: 'truncated-container',
            });
        }

        const raw = this._bytes.subarray(dataStart, dataEnd);
        if (entry.compressedSize === 0) return new Uint8Array(0);
        if (entry.method === COMPRESSION_STORED) return raw;
        if (entry.method === COMPRESSION_DEFLATE) return inflateRaw(raw);

        throw new OfficeParseError(
            `Unsupported compression (${entry.method}) inside this Office file.`,
            { code: 'unsupported-compression' },
        );
    }
}

// ── XML helpers ────────────────────────────────────────────────────────────

const XML_TAG_RE = /<(\/?)([A-Za-z_][\w.:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
const XML_ATTR_RE = /([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const XML_ENTITY_RE = /&(#x[0-9a-fA-F]+|#\d+|[A-Za-z][A-Za-z0-9]*);/g;

const NAMED_XML_ENTITIES = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: '\u00a0',
};

export function decodeXmlEntities(text) {
    const value = String(text ?? '');
    if (!value.includes('&')) return value;
    return value.replace(XML_ENTITY_RE, (match, body) => {
        if (body[0] === '#') {
            const hex = body[1] === 'x' || body[1] === 'X';
            const codePoint = hex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
            if (!Number.isFinite(codePoint)) return match;
            try {
                return String.fromCodePoint(codePoint);
            } catch (_e) {
                return match;
            }
        }
        return NAMED_XML_ENTITIES[body] ?? match;
    });
}

function escapeXmlText(text) {
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function prepareXml(xml) {
    return String(xml ?? '')
        .replace(/<\?[\s\S]*?\?>/g, '')
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_match, content) => escapeXmlText(content));
}

function parseXmlAttributes(rawAttributes) {
    const attrs = {};
    XML_ATTR_RE.lastIndex = 0;
    let match;
    while ((match = XML_ATTR_RE.exec(rawAttributes)) !== null) {
        attrs[match[1]] = decodeXmlEntities(match[2] ?? match[3] ?? '');
    }
    return attrs;
}

/** Yields `{ type: 'open' | 'close' | 'text' }` tokens for an XML document. */
function* tokenizeXml(xml) {
    const source = prepareXml(xml);
    XML_TAG_RE.lastIndex = 0;
    let index = 0;
    let match;
    while ((match = XML_TAG_RE.exec(source)) !== null) {
        if (match.index > index) {
            yield { type: 'text', value: source.slice(index, match.index) };
        }
        index = XML_TAG_RE.lastIndex;
        const [, closing, name, rawAttributes, selfClosing] = match;
        if (closing) {
            yield { type: 'close', name };
        } else {
            yield {
                type: 'open',
                name,
                attrs: parseXmlAttributes(rawAttributes),
                selfClosing: Boolean(selfClosing),
            };
        }
    }
    if (index < source.length) {
        yield { type: 'text', value: source.slice(index) };
    }
}

// ── Shared text/table helpers ──────────────────────────────────────────────

function normalizeInline(text) {
    return String(text ?? '')
        .replace(/\r\n?/g, '\n')
        .replace(/[ \t\u00a0]+/g, ' ')
        .split('\n')
        .map((line) => line.trim())
        .join('\n')
        .replace(/\n{2,}/g, '\n')
        .trim();
}

/**
 * Block collector with a character budget.  `push()` becomes a no-op once the
 * budget is reached and `exhausted` lets the extractors stop tokenizing.
 */
function createBlockWriter(blocks) {
    let characters = 0;
    let exhausted = false;

    return {
        push(text) {
            if (exhausted) return;
            const value = String(text ?? '').trim();
            if (!value) return;
            characters += value.length;
            blocks.push(value);
            blocks.push('');
            if (characters >= MAX_EXTRACTED_CHARS) {
                exhausted = true;
                blocks.push('[...document truncated by Katab...]');
                blocks.push('');
            }
        },
        get exhausted() {
            return exhausted;
        },
    };
}

function normalizeTableCell(value) {
    return String(value ?? '')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/\\/g, '\\\\')
        .replace(/\|/g, '\\|');
}

/** Renders rows of cell strings as a Markdown table. */
function renderMarkdownTable(rows) {
    const cleaned = [];
    for (const row of rows || []) {
        const cells = (row || []).map(normalizeTableCell);
        if (cells.some((cell) => cell !== '')) cleaned.push(cells);
    }
    if (!cleaned.length) return '';

    // Trailing empty cells are common in ODF (LibreOffice writes filler runs
    // such as table:number-columns-repeated="256") and must not widen the
    // table — one filler row would otherwise add ~100 empty columns and eat
    // the attachment's character budget.
    let columns = 0;
    for (const row of cleaned) {
        for (let index = row.length - 1; index >= columns; index--) {
            if (row[index] !== '') {
                columns = index + 1;
                break;
            }
        }
    }
    if (columns === 0) return '';

    const lines = [];
    const header = cleaned[0];
    const headerCells = [];
    for (let i = 0; i < columns; i++) headerCells.push(header[i] ?? '');
    lines.push(`| ${headerCells.join(' | ')} |`);
    lines.push(`| ${headerCells.map(() => '---').join(' | ')} |`);
    for (let i = 1; i < cleaned.length; i++) {
        const cells = [];
        for (let column = 0; column < columns; column++) cells.push(cleaned[i][column] ?? '');
        lines.push(`| ${cells.join(' | ')} |`);
    }
    return lines.join('\n');
}

function decodeAnsiBytes(bytes, codepage) {
    const labels = {
        65001: 'utf-8',
        1250: 'windows-1250',
        1251: 'windows-1251',
        1252: 'windows-1252',
        1253: 'windows-1253',
        1254: 'windows-1254',
        1255: 'windows-1255',
        1256: 'windows-1256',
        1257: 'windows-1257',
        1258: 'windows-1258',
        874: 'windows-874',
        932: 'shift_jis',
        936: 'gbk',
        949: 'euc-kr',
        950: 'big5',
        20866: 'koi8-r',
        21866: 'koi8-u',
        10000: 'macintosh',
    };
    const data = Uint8Array.from(bytes);
    try {
        return new TextDecoder(labels[codepage] || 'windows-1252').decode(data);
    } catch (_e) {
        return new TextDecoder('windows-1252').decode(data);
    }
}

export function decodeTextBytes(bytes) {
    if (!bytes || bytes.length === 0) return '';
    if (bytes.length >= 2) {
        if (bytes[0] === 0xff && bytes[1] === 0xfe) {
            return new TextDecoder('utf-16le').decode(bytes.subarray(2));
        }
        if (bytes[0] === 0xfe && bytes[1] === 0xff) {
            return new TextDecoder('utf-16be').decode(bytes.subarray(2));
        }
    }
    return new TextDecoder('utf-8').decode(bytes).replace(/^\uFEFF/, '');
}

function byNumericSuffix(a, b) {
    const first = Number((/(\d+)\.[^./]+$/.exec(a) || [])[1] || 0);
    const second = Number((/(\d+)\.[^./]+$/.exec(b) || [])[1] || 0);
    return first - second;
}

function readRelationships(xml) {
    const relationships = new Map();
    for (const token of tokenizeXml(xml)) {
        if (token.type !== 'open' || token.name !== 'Relationship') continue;
        const id = token.attrs.Id || token.attrs.id;
        const target = token.attrs.Target || token.attrs.target;
        if (id && target) relationships.set(id, target);
    }
    return relationships;
}

function resolvePartPath(target, baseDirectory) {
    let value = String(target || '').replace(/^\/+/, '');
    if (!value) return '';
    if (!value.startsWith(baseDirectory)) value = `${baseDirectory}${value}`;

    // OOXML relationship targets may climb out of the part's folder
    // (e.g. "../slides/slide1.xml"); collapse those segments so the ZIP lookup
    // sees the real entry name.
    const segments = [];
    for (const segment of value.split('/')) {
        if (segment === '..') segments.pop();
        else if (segment !== '' && segment !== '.') segments.push(segment);
    }
    return segments.join('/');
}

// ── DOCX (WordprocessingML) ────────────────────────────────────────────────

function wordXmlToText(xml) {
    const blocks = [];
    const writer = createBlockWriter(blocks);
    // Word nests paragraphs when a run contains a text box
    // (w:p → w:pict/w:txbxContent/w:p).  A single "current paragraph" slot
    // silently dropped the text before/after the drawing, so paragraph state
    // lives on a stack and nested paragraphs flush their own text.
    const paragraphs = [];
    let capturing = false;
    let table = null;
    let tableDepth = 0;
    let pendingList = [];

    const currentParagraph = () => (paragraphs.length ? paragraphs[paragraphs.length - 1] : null);

    const flushList = () => {
        if (!pendingList.length) return;
        writer.push(pendingList.join('\n'));
        pendingList = [];
    };

    const flushParagraph = (paragraph) => {
        if (!paragraph) return;
        const text = normalizeInline(paragraph.parts.join(''));
        const { heading, list } = paragraph;
        if (!text) return;

        if (table && tableDepth === 1 && table.cell) {
            table.cell.push(text);
            return;
        }

        // Consecutive list items stay in one tight Markdown list instead of
        // becoming one paragraph each.
        if (list && heading === 0) {
            pendingList.push(`- ${text}`);
            return;
        }

        flushList();
        const prefix = heading > 0 ? `${'#'.repeat(Math.min(heading, 6))} ` : '';
        writer.push(`${prefix}${text}`);
    };

    for (const token of tokenizeXml(xml)) {
        if (writer.exhausted) break;
        if (token.type === 'text') {
            const paragraph = currentParagraph();
            if (capturing && paragraph) paragraph.parts.push(decodeXmlEntities(token.value));
            continue;
        }

        if (token.type === 'open') {
            switch (token.name) {
                case 'w:tbl':
                    tableDepth += 1;
                    if (tableDepth === 1) {
                        // Emit a preceding list before the table starts so the
                        // document order is preserved.
                        flushList();
                        table = { rows: [], row: null, cell: null, truncated: false };
                    }
                    break;
                case 'w:tr':
                    if (tableDepth === 1 && table) table.row = [];
                    break;
                case 'w:tc':
                    if (tableDepth === 1 && table) table.cell = [];
                    break;
                case 'w:p':
                    paragraphs.push({ parts: [], heading: 0, list: false });
                    break;
                case 'w:pStyle': {
                    const paragraph = currentParagraph();
                    const style = token.attrs['w:val'] || '';
                    const headingMatch = /^heading\s*(\d+)$/i.exec(style);
                    if (headingMatch && paragraph) paragraph.heading = Number(headingMatch[1]);
                    else if (/^title$/i.test(style) && paragraph) paragraph.heading = 1;
                    break;
                }
                case 'w:outlineLvl': {
                    const paragraph = currentParagraph();
                    const level = Number(token.attrs['w:val']);
                    if (paragraph && Number.isFinite(level)) {
                        paragraph.heading = Math.max(paragraph.heading, level + 1);
                    }
                    break;
                }
                case 'w:numPr': {
                    const paragraph = currentParagraph();
                    if (paragraph) paragraph.list = true;
                    break;
                }
                case 'w:t':
                    capturing = !token.selfClosing;
                    break;
                case 'w:tab': {
                    const paragraph = currentParagraph();
                    if (paragraph) paragraph.parts.push('\t');
                    break;
                }
                case 'w:br':
                case 'w:cr': {
                    const paragraph = currentParagraph();
                    if (paragraph) paragraph.parts.push('\n');
                    break;
                }
                case 'w:noBreakHyphen': {
                    const paragraph = currentParagraph();
                    if (paragraph) paragraph.parts.push('-');
                    break;
                }
                default:
                    break;
            }
            continue;
        }

        switch (token.name) {
            case 'w:t':
                capturing = false;
                break;
            case 'w:p':
                flushParagraph(paragraphs.pop());
                break;
            case 'w:tc':
                if (tableDepth === 1 && table && table.row) {
                    if (table.row.length < TABLE_MAX_COLUMNS) {
                        table.row.push((table.cell || []).join(' '));
                    } else {
                        table.truncated = true;
                    }
                    table.cell = null;
                }
                break;
            case 'w:tr':
                if (tableDepth === 1 && table && table.row) {
                    if (table.rows.length < TABLE_MAX_ROWS) {
                        table.rows.push(table.row);
                    } else {
                        table.truncated = true;
                    }
                    table.row = null;
                }
                break;
            case 'w:tbl':
                tableDepth = Math.max(0, tableDepth - 1);
                if (tableDepth === 0 && table) {
                    flushList();
                    writer.push(renderMarkdownTable(table.rows));
                    if (table.truncated) writer.push('[...table truncated by Katab...]');
                    table = null;
                }
                break;
            default:
                break;
        }
    }

    while (paragraphs.length) flushParagraph(paragraphs.pop());
    flushList();
    return blocks.join('\n').trim();
}

function extractDocxText(zip) {
    const xml = zip.readText('word/document.xml');
    if (!xml) {
        throw new OfficeParseError('This Word document has no document.xml part.', {
            code: 'invalid-word-document',
        });
    }

    const blocks = [wordXmlToText(xml)];
    for (const part of ['word/footnotes.xml', 'word/endnotes.xml']) {
        const notesXml = zip.readText(part);
        if (!notesXml) continue;
        const notes = wordXmlToText(notesXml);
        if (notes) blocks.push(notes);
    }
    return blocks.filter(Boolean).join('\n\n').trim();
}

// ── XLSX (SpreadsheetML) ───────────────────────────────────────────────────

const BUILTIN_DATE_FORMAT_IDS = new Set([
    14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 45, 46, 47, 50, 51,
    52, 53, 54, 55, 56, 57, 58,
]);

function isDateFormatCode(formatCode, formatId) {
    if (Number.isFinite(formatId) && BUILTIN_DATE_FORMAT_IDS.has(formatId)) return true;
    if (!formatCode) return false;
    const stripped = String(formatCode)
        .replace(/"[^"]*"/g, '')
        .replace(/\[[^\]]*\]/g, '')
        .replace(/\\./g, '');
    return /[ymdhs]/i.test(stripped);
}

function parseWorkbookStyles(xml) {
    const isDateStyle = [];
    if (!xml) return isDateStyle;

    const customFormats = new Map();
    let insideCellXfs = false;

    for (const token of tokenizeXml(xml)) {
        if (token.type === 'open') {
            if (token.name === 'numFmt') {
                const id = Number(token.attrs.numFmtId);
                if (Number.isFinite(id)) customFormats.set(id, token.attrs.formatCode || '');
            } else if (token.name === 'cellXfs') {
                insideCellXfs = true;
            } else if (token.name === 'xf' && insideCellXfs) {
                const formatId = Number(token.attrs.numFmtId) || 0;
                isDateStyle.push(isDateFormatCode(customFormats.get(formatId), formatId));
            }
        } else if (token.type === 'close' && token.name === 'cellXfs') {
            insideCellXfs = false;
        }
    }
    return isDateStyle;
}

function parseSharedStrings(xml) {
    const strings = [];
    if (!xml) return strings;

    let current = null;
    let capturing = false;
    let phoneticDepth = 0;
    let characters = 0;

    for (const token of tokenizeXml(xml)) {
        if (characters >= MAX_EXTRACTED_CHARS || strings.length >= TABLE_MAX_CELLS) break;
        if (token.type === 'open') {
            if (token.name === 'si') current = [];
            else if (token.name === 'rPh') phoneticDepth += 1;
            else if (token.name === 't') capturing = !token.selfClosing && phoneticDepth === 0;
        } else if (token.type === 'close') {
            if (token.name === 'si') {
                const value = (current || []).join('');
                characters += value.length;
                strings.push(value);
                current = null;
            } else if (token.name === 'rPh') {
                phoneticDepth = Math.max(0, phoneticDepth - 1);
            } else if (token.name === 't') {
                capturing = false;
            }
        } else if (token.type === 'text' && capturing && current) {
            current.push(decodeXmlEntities(token.value));
        }
    }
    return strings;
}

function listWorksheets(zip) {
    const workbookXml = zip.readText('xl/workbook.xml') || '';
    const relationships = readRelationships(zip.readText('xl/_rels/workbook.xml.rels') || '');
    const sheets = [];

    for (const token of tokenizeXml(workbookXml)) {
        if (token.type !== 'open' || token.name !== 'sheet') continue;
        const name = token.attrs.name || `Sheet ${sheets.length + 1}`;
        const relId = token.attrs['r:id'] || token.attrs['relationships:id'] || '';
        let path = resolvePartPath(relationships.get(relId), 'xl/');
        if (!path || !zip.has(path)) {
            const guess = `xl/worksheets/sheet${sheets.length + 1}.xml`;
            path = zip.has(guess) ? guess : '';
        }
        sheets.push({ name, path });
    }

    if (!sheets.length) {
        zip.names()
            .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
            .sort(byNumericSuffix)
            .forEach((path, index) => sheets.push({ name: `Sheet ${index + 1}`, path }));
    }

    if (!sheets.length) {
        throw new OfficeParseError('This Excel workbook has no worksheets.', {
            code: 'invalid-workbook',
        });
    }
    return sheets;
}

function columnIndexFromReference(reference) {
    const match = /^([A-Za-z]+)/.exec(String(reference || ''));
    if (!match) return -1;
    let index = 0;
    for (const character of match[1].toUpperCase()) {
        index = index * 26 + (character.charCodeAt(0) - 64);
    }
    return index - 1;
}

function padNumber(value) {
    return String(value).padStart(2, '0');
}

function formatExcelDate(serial, date1904) {
    const dayMs = 86400000;
    let baseUtc;
    if (date1904) {
        baseUtc = Date.UTC(1904, 0, 1);
    } else {
        // Excel repeats 1900-02-29, so the modern epoch starts at serial 61.
        baseUtc = serial >= 61 ? Date.UTC(1899, 11, 30) : Date.UTC(1899, 11, 31);
    }
    const date = new Date(baseUtc + Math.round(serial * dayMs));
    if (Number.isNaN(date.getTime())) return String(serial);

    const datePart = `${date.getUTCFullYear()}-${padNumber(date.getUTCMonth() + 1)}-${padNumber(date.getUTCDate())}`;
    const timePart = `${padNumber(date.getUTCHours())}:${padNumber(date.getUTCMinutes())}`;

    if (serial >= 1) {
        return Math.abs(serial - Math.floor(serial)) > 1e-9 ? `${datePart} ${timePart}` : datePart;
    }
    return serial === 0 ? datePart : timePart;
}

function formatExcelNumber(value) {
    const rounded = Number(value.toPrecision(12));
    return String(Object.is(rounded, -0) ? 0 : rounded);
}

function resolveCellText(cell, sharedStrings, isDateStyle, date1904) {
    const rawValue = cell.value.join('');
    const rawInline = cell.inline.join('');
    const trimmedValue = rawValue.trim();

    switch (cell.type) {
        case 's': {
            if (!trimmedValue) return '';
            const index = Number(trimmedValue);
            return Number.isInteger(index) ? (sharedStrings[index] ?? '') : '';
        }
        case 'inlineStr':
            return rawInline;
        case 'str':
            return rawValue;
        case 'b':
            return trimmedValue === '1' ? 'TRUE' : 'FALSE';
        case 'e':
        case 'd':
            return rawValue;
        default: {
            if (!trimmedValue) return rawInline;
            const numeric = Number(trimmedValue);
            if (!Number.isFinite(numeric)) return rawValue;
            if (isDateStyle[cell.style]) return formatExcelDate(numeric, date1904);
            return formatExcelNumber(numeric);
        }
    }
}

function sheetXmlToRows(xml, options) {
    const { sharedStrings, isDateStyle, date1904 } = options;
    const rows = [];
    let row = null;
    let cell = null;
    let capture = null;
    let cellCount = 0;
    let truncated = false;

    const finishCell = () => {
        if (!cell) return;
        if (row) {
            row.cells.push({
                column: cell.column >= 0 ? cell.column : row.cells.length,
                text: resolveCellText(cell, sharedStrings, isDateStyle, date1904),
            });
            cellCount += 1;
            if (cellCount >= TABLE_MAX_CELLS) truncated = true;
        }
        cell = null;
    };

    for (const token of tokenizeXml(xml)) {
        if (truncated) break;
        if (token.type === 'open') {
            if (token.name === 'row') {
                row = { cells: [] };
            } else if (token.name === 'c') {
                cell = {
                    column: columnIndexFromReference(token.attrs.r),
                    type: token.attrs.t || 'n',
                    style: Number(token.attrs.s) || 0,
                    value: [],
                    inline: [],
                };
            } else if (token.name === 'v') {
                capture = token.selfClosing ? null : 'value';
            } else if (token.name === 't') {
                capture = token.selfClosing ? null : 'inline';
            }
            continue;
        }

        if (token.type === 'close') {
            if (token.name === 'v' || token.name === 't') {
                capture = null;
            } else if (token.name === 'c') {
                finishCell();
            } else if (token.name === 'row') {
                finishCell();
                if (row) rows.push(row);
                row = null;
                if (rows.length >= TABLE_MAX_ROWS) truncated = true;
            }
            continue;
        }

        if (capture && cell) {
            const target = capture === 'value' ? cell.value : cell.inline;
            target.push(decodeXmlEntities(token.value));
        }
    }

    return { rows, truncated };
}

function matrixToMarkdown(rows) {
    const prepared = [];
    let maxColumn = 0;
    let cellCount = 0;
    let truncated = false;

    for (const row of rows) {
        if (prepared.length >= TABLE_MAX_ROWS || cellCount >= TABLE_MAX_CELLS) {
            truncated = true;
            break;
        }

        const cells = [];
        let hasContent = false;
        for (const cell of row.cells) {
            if (cell.column >= TABLE_MAX_COLUMNS) continue;
            cellCount += 1;
            if (cell.text !== '') {
                cells[cell.column] = cell.text;
                hasContent = true;
                maxColumn = Math.max(maxColumn, cell.column);
            }
        }
        if (hasContent) prepared.push(cells);
    }

    if (!prepared.length) return { text: '', truncated };

    const tableRows = prepared.map((cells) => {
        const out = [];
        for (let column = 0; column <= maxColumn; column++) out.push(cells[column] ?? '');
        return out;
    });

    return { text: renderMarkdownTable(tableRows), truncated };
}

function extractXlsxText(zip) {
    const workbookXml = zip.readText('xl/workbook.xml');
    if (!workbookXml) {
        throw new OfficeParseError('This Excel workbook has no workbook.xml part.', {
            code: 'invalid-workbook',
        });
    }

    const date1904 = /date1904\s*=\s*"(?:1|true)"/i.test(workbookXml);
    const sharedStrings = parseSharedStrings(zip.readText('xl/sharedStrings.xml'));
    const isDateStyle = parseWorkbookStyles(zip.readText('xl/styles.xml'));

    const blocks = [];
    const writer = createBlockWriter(blocks);
    for (const sheet of listWorksheets(zip)) {
        if (writer.exhausted) break;
        writer.push(`## Sheet: ${sheet.name}`);
        const xml = sheet.path ? zip.readText(sheet.path) : null;
        if (!xml) {
            writer.push('(empty sheet)');
            continue;
        }
        const parsed = sheetXmlToRows(xml, { sharedStrings, isDateStyle, date1904 });
        const { text, truncated } = matrixToMarkdown(parsed.rows);
        writer.push(text || '(empty sheet)');
        if (parsed.truncated || truncated) writer.push('[...sheet truncated by Katab...]');
    }
    return blocks.join('\n').trim();
}

// ── PPTX (PresentationML) ──────────────────────────────────────────────────

function listSlides(zip) {
    const presentationXml = zip.readText('ppt/presentation.xml') || '';
    const relationships = readRelationships(zip.readText('ppt/_rels/presentation.xml.rels') || '');
    const slides = [];

    for (const token of tokenizeXml(presentationXml)) {
        if (token.type !== 'open' || token.name !== 'sldId') continue;
        const relId = token.attrs['r:id'] || token.attrs['relationships:id'] || '';
        const path = resolvePartPath(relationships.get(relId), 'ppt/');
        if (path && zip.has(path)) slides.push(path);
    }

    if (!slides.length) {
        slides.push(
            ...zip
                .names()
                .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
                .sort(byNumericSuffix),
        );
    }
    return slides;
}

function slideXmlToText(xml) {
    const lines = [];
    let paragraph = [];
    let capturing = false;
    let fieldDepth = 0;
    let table = null;
    let tableDepth = 0;

    const flushParagraph = () => {
        if (!paragraph.length) return;
        const text = normalizeInline(paragraph.join(''));
        paragraph = [];
        if (!text) return;
        if (table && tableDepth === 1 && table.cell) {
            table.cell.push(text);
            return;
        }
        for (const line of text.split('\n')) {
            const trimmed = line.trim();
            if (trimmed) lines.push(trimmed);
        }
    };

    for (const token of tokenizeXml(xml)) {
        if (token.type === 'text') {
            if (capturing && fieldDepth === 0) paragraph.push(decodeXmlEntities(token.value));
            continue;
        }

        if (token.type === 'open') {
            switch (token.name) {
                case 'a:t':
                    capturing = !token.selfClosing;
                    break;
                case 'a:fld':
                    fieldDepth += 1;
                    break;
                case 'a:br':
                    paragraph.push('\n');
                    break;
                case 'a:tab':
                    paragraph.push('\t');
                    break;
                case 'a:tbl':
                    tableDepth += 1;
                    if (tableDepth === 1) {
                        table = { rows: [], row: null, cell: null, truncated: false };
                    }
                    break;
                case 'a:tr':
                    if (tableDepth === 1 && table) table.row = [];
                    break;
                case 'a:tc':
                    if (tableDepth === 1 && table) table.cell = [];
                    break;
                default:
                    break;
            }
            continue;
        }

        switch (token.name) {
            case 'a:t':
                capturing = false;
                break;
            case 'a:fld':
                fieldDepth = Math.max(0, fieldDepth - 1);
                break;
            case 'a:p':
                flushParagraph();
                break;
            case 'a:tc':
                if (tableDepth === 1 && table && table.row) {
                    if (table.row.length < TABLE_MAX_COLUMNS) {
                        table.row.push((table.cell || []).join(' '));
                    } else {
                        table.truncated = true;
                    }
                    table.cell = null;
                }
                break;
            case 'a:tr':
                if (tableDepth === 1 && table && table.row) {
                    if (table.rows.length < TABLE_MAX_ROWS) {
                        table.rows.push(table.row);
                    } else {
                        table.truncated = true;
                    }
                    table.row = null;
                }
                break;
            case 'a:tbl':
                tableDepth = Math.max(0, tableDepth - 1);
                if (tableDepth === 0 && table) {
                    const rendered = renderMarkdownTable(table.rows);
                    if (rendered) lines.push(rendered);
                    if (table.truncated) lines.push('[...table truncated by Katab...]');
                    table = null;
                }
                break;
            default:
                break;
        }
    }

    flushParagraph();
    return lines.join('\n').trim();
}

function extractPptxText(zip) {
    const slides = listSlides(zip);
    if (!slides.length) {
        throw new OfficeParseError('This PowerPoint deck has no slides.', {
            code: 'invalid-presentation',
        });
    }

    const blocks = [];
    const writer = createBlockWriter(blocks);
    slides.forEach((path, index) => {
        if (writer.exhausted) return;
        writer.push(`## Slide ${index + 1}`);
        const xml = zip.readText(path);
        writer.push((xml && slideXmlToText(xml)) || '(no text on this slide)');
    });
    return blocks.join('\n').trim();
}

// ── ODF (OpenDocument) ─────────────────────────────────────────────────────

const ODF_SKIP_ELEMENTS = new Set([
    'office:automatic-styles',
    'office:styles',
    'office:master-styles',
    'office:font-face-decls',
    'office:scripts',
    'office:meta',
    'office:settings',
    'office:annotation',
    'office:annotation-end',
    'office:binary-data',
    'draw:object',
    'draw:object-ole',
    'svg:desc',
]);

function odfXmlToText(xml, kind) {
    const blocks = [];
    const writer = createBlockWriter(blocks);
    const skipStack = [];
    // A draw:text-box inside text:p can contain its own text:p (the ODF form of
    // a Word text box), so paragraph state lives on a stack — a single slot
    // dropped the text around the frame.
    const paragraphs = [];
    let table = null;
    let tableDepth = 0;
    let listDepth = 0;
    let sectionCount = 0;
    let pendingList = [];

    const appendBlock = (text, heading = 0) => {
        const value = String(text ?? '').trim();
        if (!value) return;
        const prefix = heading > 0 ? `${'#'.repeat(Math.min(heading, 6))} ` : '';
        writer.push(`${prefix}${value}`);
    };

    const flushList = () => {
        if (!pendingList.length) return;
        writer.push(pendingList.join('\n'));
        pendingList = [];
    };

    const finishRow = () => {
        if (!table || !table.row) return;
        // Empty filler rows (table:number-rows-repeated) carry no text and are
        // dropped by the Markdown renderer anyway — skip materializing them.
        if (!table.row.some((cell) => cell !== '')) {
            table.row = null;
            table.rowRepeats = 1;
            return;
        }
        for (let i = 0; i < table.rowRepeats; i++) {
            if (table.rows.length >= TABLE_MAX_ROWS) {
                table.truncated = true;
                break;
            }
            table.rows.push([...table.row]);
        }
        table.row = null;
        table.rowRepeats = 1;
    };

    const finishCell = (text) => {
        if (!table || !table.row) return;
        const room = Math.max(0, TABLE_MAX_COLUMNS - table.row.length);
        const repeats = Math.min(table.cellRepeats, room);
        for (let i = 0; i < repeats; i++) table.row.push(text);
        if (table.cellRepeats > repeats) table.truncated = true;
        table.cell = null;
        table.cellRepeats = 1;
    };

    const currentParagraph = () => (paragraphs.length ? paragraphs[paragraphs.length - 1] : null);

    const closeParagraph = (paragraph) => {
        if (!paragraph) return;
        const text = normalizeInline(paragraph.parts.join(''));
        const heading = paragraph.heading;
        if (!text) return;
        if (table && tableDepth === 1 && table.cell) {
            table.cell.push(text);
            return;
        }
        if (listDepth > 0 && heading === 0) {
            pendingList.push(`- ${text}`);
            return;
        }
        flushList();
        appendBlock(text, heading);
    };

    const closeTable = () => {
        if (!table) return;
        flushList();
        const rendered = renderMarkdownTable(table.rows);
        const { name, truncated } = table;
        table = null;
        if (kind === 'sheet') {
            writer.push(`## Sheet: ${name}`);
            writer.push(rendered || '(empty sheet)');
        } else if (rendered) {
            writer.push(rendered);
        }
        if (truncated) writer.push('[...table truncated by Katab...]');
    };

    for (const token of tokenizeXml(xml)) {
        if (writer.exhausted) break;
        if (token.type === 'text') {
            const paragraph = currentParagraph();
            if (!skipStack.length && paragraph)
                paragraph.parts.push(decodeXmlEntities(token.value));
            continue;
        }

        if (token.type === 'open') {
            if (ODF_SKIP_ELEMENTS.has(token.name)) {
                // A self-closing style/script block never emits its close tag,
                // so pushing it would make the parser skip the rest of the file.
                if (!token.selfClosing) skipStack.push(token.name);
                continue;
            }
            if (skipStack.length) continue;

            switch (token.name) {
                case 'text:p':
                case 'text:h':
                    paragraphs.push({
                        parts: [],
                        heading:
                            token.name === 'text:h'
                                ? Math.max(1, Number(token.attrs['text:outline-level']) || 1)
                                : 0,
                    });
                    break;
                case 'text:s': {
                    const paragraph = currentParagraph();
                    const count = Math.max(1, Math.min(64, Number(token.attrs['text:c']) || 1));
                    if (paragraph) paragraph.parts.push(' '.repeat(count));
                    break;
                }
                case 'text:tab': {
                    const paragraph = currentParagraph();
                    if (paragraph) paragraph.parts.push('\t');
                    break;
                }
                case 'text:line-break':
                case 'text:soft-page-break': {
                    const paragraph = currentParagraph();
                    if (paragraph) paragraph.parts.push('\n');
                    break;
                }
                case 'table:table':
                    tableDepth += 1;
                    if (tableDepth === 1) {
                        // Keep document order when a list precedes the table.
                        flushList();
                        table = {
                            name: token.attrs['table:name'] || `Table ${++sectionCount}`,
                            rows: [],
                            row: null,
                            cell: null,
                            rowRepeats: 1,
                            cellRepeats: 1,
                            truncated: false,
                        };
                    }
                    break;
                case 'table:table-row':
                    if (tableDepth === 1 && table) {
                        table.row = [];
                        table.rowRepeats = Math.max(
                            1,
                            Math.min(200, Number(token.attrs['table:number-rows-repeated']) || 1),
                        );
                    }
                    break;
                case 'table:table-cell':
                case 'table:covered-table-cell':
                    if (tableDepth === 1 && table) {
                        table.cell = [];
                        table.cellRepeats = Math.max(
                            1,
                            Math.min(
                                200,
                                Number(token.attrs['table:number-columns-repeated']) || 1,
                            ),
                        );
                    }
                    break;
                case 'text:list':
                    listDepth += 1;
                    break;
                case 'draw:page': {
                    if (kind === 'presentation' || kind === 'drawing') {
                        flushList();
                        sectionCount += 1;
                        const label = kind === 'presentation' ? 'Slide' : 'Page';
                        writer.push(`## ${label} ${sectionCount}`);
                    }
                    break;
                }
                default:
                    break;
            }

            if (token.selfClosing) {
                // Route empty elements through the same close handling used by
                // their explicit counterparts (e.g. repeated empty cells).
                // Leaving a counter incremented here would make the rest of the
                // file look like it is still inside that element.
                if (token.name === 'text:p' || token.name === 'text:h') {
                    paragraphs.pop();
                } else if (
                    token.name === 'table:table-cell' ||
                    token.name === 'table:covered-table-cell'
                ) {
                    if (tableDepth === 1) finishCell('');
                } else if (token.name === 'table:table-row') {
                    if (tableDepth === 1) finishRow();
                } else if (token.name === 'table:table') {
                    tableDepth = Math.max(0, tableDepth - 1);
                    if (tableDepth === 0) closeTable();
                } else if (token.name === 'text:list') {
                    listDepth = Math.max(0, listDepth - 1);
                    if (listDepth === 0) flushList();
                }
            }
            continue;
        }

        if (skipStack.length) {
            if (skipStack[skipStack.length - 1] === token.name) skipStack.pop();
            continue;
        }

        switch (token.name) {
            case 'text:p':
            case 'text:h':
                closeParagraph(paragraphs.pop());
                break;
            case 'table:table-cell':
            case 'table:covered-table-cell':
                if (tableDepth === 1) finishCell((table?.cell || []).join(' '));
                break;
            case 'table:table-row':
                if (tableDepth === 1) finishRow();
                break;
            case 'table:table':
                tableDepth = Math.max(0, tableDepth - 1);
                if (tableDepth === 0) closeTable();
                break;
            case 'text:list':
                listDepth = Math.max(0, listDepth - 1);
                if (listDepth === 0) flushList();
                break;
            default:
                break;
        }
    }

    while (paragraphs.length) closeParagraph(paragraphs.pop());
    flushList();
    return blocks.join('\n').trim();
}

function extractOdfContainerText(zip, extension) {
    const family = getOfficeFamily(extension);
    const kind =
        family === 'odf-sheet'
            ? 'sheet'
            : family === 'odf-presentation'
              ? 'presentation'
              : family === 'odf-drawing'
                ? 'drawing'
                : 'text';

    const xml = zip.readText('content.xml');
    if (!xml) {
        throw new OfficeParseError('This OpenDocument file has no content.xml part.', {
            code: 'invalid-odf-document',
        });
    }
    return odfXmlToText(xml, kind);
}

// ── CSV / TSV ──────────────────────────────────────────────────────────────

function sniffDelimiter(text) {
    const sample = String(text || '').slice(0, 64 * 1024);
    const counts = { ',': 0, ';': 0, '\t': 0, '|': 0 };
    let inQuotes = false;

    for (const character of sample) {
        if (character === '"') inQuotes = !inQuotes;
        else if (!inQuotes && counts[character] !== undefined) counts[character] += 1;
    }

    let best = ',';
    for (const delimiter of [',', ';', '\t', '|']) {
        if (counts[delimiter] > counts[best]) best = delimiter;
    }
    return best;
}

function splitDelimitedRows(text, delimiter) {
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    let truncated = false;
    let produced = 0;
    const source = String(text ?? '');

    for (let index = 0; index < source.length; index++) {
        // Stop reading once the table can no longer fit the output budget —
        // otherwise a single multi-megabyte quoted cell costs a full scan.
        if (produced >= MAX_EXTRACTED_CHARS) {
            truncated = true;
            break;
        }
        const character = source[index];

        if (inQuotes) {
            if (character === '"') {
                if (source[index + 1] === '"') {
                    field += '"';
                    index += 1;
                    produced += 1;
                } else {
                    inQuotes = false;
                }
            } else {
                field += character;
                produced += 1;
            }
            continue;
        }

        if (character === '"' && field === '') {
            inQuotes = true;
            continue;
        }
        if (character === delimiter) {
            row.push(field);
            produced += 1;
            field = '';
            continue;
        }
        if (character === '\r' || character === '\n') {
            if (character === '\r' && source[index + 1] === '\n') index += 1;
            row.push(field);
            produced += 1;
            field = '';
            rows.push(row);
            row = [];
            if (rows.length >= TABLE_MAX_ROWS) {
                truncated = true;
                break;
            }
            continue;
        }
        field += character;
        produced += 1;
    }

    // Keep a partially-read row when the budget stopped the scan mid-field so
    // oversized cells still contribute their leading text.
    if (field.length > 0 || row.length > 0) {
        row.push(field);
        rows.push(row);
    }
    return { rows, truncated };
}

export function parseDelimitedText(text, extension) {
    const source = String(text ?? '').replace(/^\uFEFF/, '');
    const lower = String(extension || '').toLowerCase();
    const delimiter = lower === 'tsv' || lower === 'tab' ? '\t' : sniffDelimiter(source);

    const parsed = splitDelimitedRows(source, delimiter);
    const limited = [];
    let characters = 0;
    let truncated = parsed.truncated;
    for (const row of parsed.rows) {
        let rowCharacters = 0;
        for (const cell of row) rowCharacters += cell.length;

        const remaining = MAX_EXTRACTED_CHARS - characters;
        if (remaining <= 0) {
            truncated = true;
            break;
        }
        if (rowCharacters > remaining) {
            // Keep the row but clip its cells so an oversized single cell
            // still contributes readable text instead of dropping the table.
            let budget = remaining;
            const clipped = row.map((cell) => {
                if (budget <= 0) return '';
                const slice = cell.slice(0, budget);
                budget -= slice.length;
                return slice;
            });
            limited.push(clipped);
            truncated = true;
            break;
        }
        characters += rowCharacters;
        limited.push(row);
    }

    const rendered = renderMarkdownTable(limited);
    if (!rendered) return '';
    return truncated ? `${rendered}\n\n[...table truncated by Katab...]` : rendered;
}

// ── RTF ────────────────────────────────────────────────────────────────────

const RTF_IGNORABLE_DESTINATIONS = new Set([
    'fonttbl',
    'colortbl',
    'stylesheet',
    'info',
    'pict',
    'object',
    'objdata',
    'header',
    'headerl',
    'headerr',
    'headerf',
    'footer',
    'footerl',
    'footerr',
    'footerf',
    'footnote',
    'filetbl',
    'revtbl',
    'rsidtbl',
    'generator',
    'themedata',
    'colorschememapping',
    'latentstyles',
    'datastore',
    'xmlnstbl',
    'listtable',
    'listoverridetable',
    'pgdsctbl',
    'fldinst',
]);

const RTF_SYMBOLS = {
    lquote: "'",
    rquote: "'",
    ldblquote: '"',
    rdblquote: '"',
    endash: '\u2013',
    emdash: '\u2014',
    bullet: '\u2022',
    emspace: ' ',
    enspace: ' ',
};

export function rtfToText(source) {
    const text = String(source ?? '');
    const out = [];
    const byteQueue = [];
    const stack = [];
    let ignorable = false;
    let codepage = 1252;
    // \ucN sets how many fallback characters follow a \uN escape.  It is a
    // formatting state (group-scoped), not a pending skip count — conflating
    // the two made a plain `\uc1` header eat the first letter of the document.
    let ucSkip = 1;
    let pendingSkip = 0;
    let characters = 0;
    let exhausted = false;

    const flushBytes = () => {
        if (!byteQueue.length) return;
        if (exhausted) {
            byteQueue.length = 0;
            return;
        }
        out.push(decodeAnsiBytes(byteQueue, codepage));
        byteQueue.length = 0;
    };

    const write = (value) => {
        if (ignorable || exhausted) return;
        flushBytes();
        characters += value.length;
        if (characters > MAX_EXTRACTED_CHARS) {
            exhausted = true;
            out.push('\n[...document truncated by Katab...]');
            return;
        }
        out.push(value);
    };

    let index = 0;
    while (index < text.length && !exhausted) {
        const character = text[index];

        if (character === '{') {
            stack.push({ ignorable, ucSkip });
            index += 1;
            continue;
        }
        if (character === '}') {
            flushBytes();
            const state = stack.pop();
            ignorable = state ? state.ignorable : true;
            if (state) ucSkip = state.ucSkip;
            index += 1;
            continue;
        }

        // \uN is followed by `\uc` fallback characters (usually \'hh, sometimes
        // literal text) that must be swallowed whole — skipping a single raw
        // character would eat the first letter of the following word.
        if (pendingSkip > 0 && character !== '{' && character !== '}') {
            pendingSkip -= 1;
            if (character === '\\') {
                let cursor = index + 1;
                if (text[cursor] === "'") {
                    index = cursor + 3;
                    continue;
                }
                while (cursor < text.length && /[A-Za-z]/.test(text[cursor])) cursor += 1;
                if (text[cursor] === '-') cursor += 1;
                while (cursor < text.length && /[0-9]/.test(text[cursor])) cursor += 1;
                if (text[cursor] === ' ') cursor += 1;
                index = cursor;
                continue;
            }
            index += 1;
            continue;
        }

        if (character === '\r' || character === '\n') {
            index += 1;
            continue;
        }

        if (character === '\\') {
            const next = text[index + 1];
            if (next === undefined) break;

            if (next === '\\' || next === '{' || next === '}') {
                write(next);
                index += 2;
                continue;
            }
            if (next === "'") {
                const hex = text.slice(index + 2, index + 4);
                const byte = parseInt(hex, 16);
                if (Number.isFinite(byte) && !ignorable) byteQueue.push(byte & 0xff);
                index += 4;
                continue;
            }
            if (next === '*') {
                ignorable = true;
                index += 2;
                continue;
            }
            if (next === '~') {
                write('\u00a0');
                index += 2;
                continue;
            }
            if (next === '_' || next === '-') {
                write('-');
                index += 2;
                continue;
            }
            if (next === '\n' || next === '\r') {
                write('\n');
                index += 2;
                continue;
            }

            let cursor = index + 1;
            let word = '';
            while (cursor < text.length && /[A-Za-z]/.test(text[cursor])) {
                word += text[cursor];
                cursor += 1;
            }
            let parameter = '';
            if (text[cursor] === '-') {
                parameter += '-';
                cursor += 1;
            }
            while (cursor < text.length && /[0-9]/.test(text[cursor])) {
                parameter += text[cursor];
                cursor += 1;
            }
            if (text[cursor] === ' ') cursor += 1;
            index = cursor;

            const value = parameter === '' ? null : Number(parameter);
            switch (word) {
                case 'par':
                case 'line':
                case 'sect':
                case 'page':
                case 'row':
                    write('\n');
                    break;
                case 'tab':
                case 'cell':
                    write('\t');
                    break;
                case 'ansicpg':
                    if (Number.isFinite(value) && value > 0) codepage = value;
                    break;
                case 'uc':
                    if (Number.isFinite(value)) ucSkip = Math.min(Math.max(0, value), 8);
                    break;
                case 'u': {
                    if (!Number.isFinite(value)) break;
                    const codePoint = value < 0 ? value + 65536 : value;
                    write(String.fromCodePoint(codePoint));
                    pendingSkip = ucSkip;
                    break;
                }
                case 'bin': {
                    // Binary payload (usually an embedded picture).  Its bytes
                    // may contain braces, so skip them verbatim instead of
                    // letting them corrupt the group stack.
                    if (Number.isFinite(value) && value > 0) {
                        index += Math.min(value, text.length - index);
                    }
                    break;
                }
                default:
                    if (RTF_SYMBOLS[word]) write(RTF_SYMBOLS[word]);
                    else if (RTF_IGNORABLE_DESTINATIONS.has(word)) ignorable = true;
                    break;
            }
            continue;
        }

        write(character);
        index += 1;
    }

    flushBytes();
    return out
        .join('')
        .replace(/\r/g, '')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/^\uFEFF/, '')
        .trim();
}

// ── Entry point ────────────────────────────────────────────────────────────

/**
 * Extracts readable text from an Office/ODF/CSV/RTF file.
 * Throws OfficeParseError when the file cannot be read.
 */
export function extractOfficeText(bytes, extension) {
    const lower = String(extension || '').toLowerCase();
    const family = getOfficeFamily(lower);
    if (!family) {
        throw new OfficeParseError(`Katab has no built-in reader for ".${lower}" files.`, {
            code: 'unsupported-extension',
        });
    }

    if (family === 'delimited') return parseDelimitedText(decodeTextBytes(bytes), lower);
    if (family === 'rtf') return rtfToText(decodeTextBytes(bytes));

    if (FLAT_ODF_EXTENSIONS.has(lower)) {
        // Flat ODF is plain XML, but accept a zipped ODF renamed to .fod* too.
        if (OfficeZipArchive.looksLikeZip(bytes)) {
            return extractOdfContainerText(new OfficeZipArchive(bytes), lower);
        }
        return odfXmlToText(decodeTextBytes(bytes), odfKindForFamily(family));
    }

    if (!OfficeZipArchive.looksLikeZip(bytes)) {
        throw new OfficeParseError(
            'This file is not a valid Office document — it may be a renamed legacy or damaged file.',
            { code: 'invalid-container' },
        );
    }

    const zip = new OfficeZipArchive(bytes);
    switch (family) {
        case 'word':
            return extractDocxText(zip);
        case 'sheet':
            return extractXlsxText(zip);
        case 'slides':
            return extractPptxText(zip);
        default:
            return extractOdfContainerText(zip, lower);
    }
}

function odfKindForFamily(family) {
    switch (family) {
        case 'odf-sheet':
            return 'sheet';
        case 'odf-presentation':
            return 'presentation';
        case 'odf-drawing':
            return 'drawing';
        default:
            return 'text';
    }
}
