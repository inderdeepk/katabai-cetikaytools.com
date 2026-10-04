// markdownRender.js — Pure markdown → render-model parsing for the Katab chat.
//
// Extracted from extension.js's KatabDialog so the parsing pipeline (inline
// formatting, headings/lists/blockquotes, tables, code fences, link
// extraction, and bounded chunking) is unit-testable without the GNOME Shell
// UI.  Everything here is string-in / data-out; the St/Clutter widget builders
// stay in extension.js.

// ── GPU-texture bounds ───────────────────────────────────────────────────────
// Every StLabel is always redirected to an offscreen framebuffer sized to the
// WHOLE label, so a single giant text segment can exceed the GPU's
// GL_MAX_TEXTURE_SIZE and paint blank (plus a journal error flood).  Markdown
// segments and code blocks are therefore split into chunks no longer than this.
export const MARKDOWN_SEGMENT_MAX_CHARS = 6000;

// Split a block of text into chunks no longer than @maxChars, breaking only at
// line boundaries so per-line markdown formatting (headings, lists, quotes,
// inline styles) stays intact inside each chunk. Always returns at least one
// chunk; a pathological single over-long line is kept whole (still far below
// the 8192 px texture cap at typical 2× scale).
export function splitTextIntoBoundedChunks(text, maxChars) {
    const lines = String(text ?? '').split('\n');
    const chunks = [];
    let current = [];
    let currentLen = 0;
    for (const line of lines) {
        const lineLen = line.length + 1; // +1 for the '\n' used to rejoin
        if (currentLen + lineLen > maxChars && current.length > 0) {
            chunks.push(current.join('\n'));
            current = [];
            currentLen = 0;
        }
        current.push(line);
        currentLen += lineLen;
    }
    if (current.length > 0) {
        chunks.push(current.join('\n'));
    }
    return chunks.length > 0 ? chunks : [''];
}

// Convert AI-returned HTML into clean plain text suitable for Pango markup.
// Block-level elements gain newlines so references don't run together;
// all remaining tags are removed, preserving inner text content.
function stripHtmlTags(text) {
    let result = String(text ?? '');
    // <br> variants → newline
    result = result.replace(/<br\s*\/?>/gi, '\n');
    // <li> opens a bullet; </li> adds a newline
    result = result.replace(/<li[^>]*>/gi, '• ');
    result = result.replace(/<\/li>/gi, '\n');
    // </p>, </div>, </ol>, </ul>, </h1>-</h6> → newline for separation
    result = result.replace(/<\/(?:p|div|ol|ul|h[1-6])>/gi, '\n');
    // strip every remaining HTML/XML tag
    result = result.replace(/<[^>]*>/g, '');
    return result;
}

function escapeMarkup(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function renderPlainMarkup(text) {
    return escapeMarkup(stripHtmlTags(text)).replace(/\t/g, '    ');
}

export function normalizeUrl(url) {
    let trimmed = String(url ?? '').trim().replace(/[.,!?;:]+$/g, '');
    return /^https?:\/\/\S+$/i.test(trimmed) ? trimmed : null;
}

function extractLinks(text) {
    let collectedLinks = [];

    let transformedText = String(text ?? '').replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_match, label, url) => {
        let normalizedUrl = normalizeUrl(url);
        if (normalizedUrl) {
            collectedLinks.push({
                label: label.trim(),
                url: normalizedUrl,
            });

            return label;
        }

        return _match;
    });

    transformedText = transformedText.replace(/https?:\/\/[^\s<>()]+/g, match => {
        let normalizedUrl = normalizeUrl(match);
        if (!normalizedUrl) {
            return match;
        }

        collectedLinks.push({
            label: '',
            url: normalizedUrl,
        });

        return normalizedUrl + match.slice(normalizedUrl.length);
    });

    let links = [];
    let seen = new Set();
    for (let link of collectedLinks) {
        if (seen.has(link.url)) {
            continue;
        }

        seen.add(link.url);
        links.push(link);
    }

    return {
        text: transformedText,
        links: links,
    };
}

export function formatInlineMarkdown(text) {
    let escapedText = escapeMarkup(stripHtmlTags(text));
    let codeTokens = [];

    escapedText = escapedText.replace(/`([^`\n]+)`/g, (_match, code) => {
        let token = `@@KATAB_CODE_${codeTokens.length}@@`;
        codeTokens.push(
            `<span font_family="monospace" weight="600">${code}</span>`
        );
        return token;
    });

    escapedText = escapedText.replace(/\*\*([^\n]+?)\*\*/g, '<b>$1</b>');
    escapedText = escapedText.replace(/__([^\n]+?)__/g, '<b>$1</b>');
    escapedText = escapedText.replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s).,!?:;])/g, '$1<i>$2</i>');
    escapedText = escapedText.replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s).,!?:;])/g, '$1<i>$2</i>');

    // Note: [N] citation markers are NOT styled here — they are rendered
    // as clickable St.Button widgets by _createTextWithCitationButtons.

    for (let i = 0; i < codeTokens.length; i++) {
        escapedText = escapedText.replace(`@@KATAB_CODE_${i}@@`, codeTokens[i]);
    }

    return escapedText;
}

function formatMarkdownLine(line) {
    if (line === '') {
        return '';
    }

    let headingMatch = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/);
    if (headingMatch) {
        let headingSizes = {
            1: 'x-large',
            2: 'large',
            3: 'medium',
            4: 'medium',
            5: 'small',
            6: 'small',
        };

        return `<span size="${headingSizes[headingMatch[1].length]}" weight="bold">${formatInlineMarkdown(headingMatch[2].trim())}</span>`;
    }

    let bulletMatch = line.match(/^\s{0,3}[-*]\s+(.*)$/);
    if (bulletMatch) {
        return `• ${formatInlineMarkdown(bulletMatch[1])}`;
    }

    let orderedMatch = line.match(/^\s{0,3}(\d+)\.\s+(.*)$/);
    if (orderedMatch) {
        return `${orderedMatch[1]}. ${formatInlineMarkdown(orderedMatch[2])}`;
    }

    return formatInlineMarkdown(line);
}

function formatMarkdownTextSegment(text) {
    return String(text ?? '')
        .split('\n')
        .map(line => formatMarkdownLine(line))
        .join('\n');
}

function splitMarkdownTableRow(line) {
    let normalized = String(line ?? '').trim();
    if (!normalized.includes('|')) {
        return [];
    }

    if (normalized.startsWith('|')) {
        normalized = normalized.slice(1);
    }

    if (normalized.endsWith('|')) {
        normalized = normalized.slice(0, -1);
    }

    return normalized.split('|').map(cell => cell.trim());
}

function looksLikeMarkdownTableRow(line) {
    let cells = splitMarkdownTableRow(line);
    return cells.length > 1;
}

function isMarkdownTableSeparator(line) {
    let cells = splitMarkdownTableRow(line);
    return cells.length > 1 && cells.every(cell => /^:?-{3,}:?$/.test(cell));
}

function parseMarkdownTable(lines, startIndex) {
    if (startIndex + 1 >= lines.length) {
        return null;
    }

    let headerLine = lines[startIndex];
    let separatorLine = lines[startIndex + 1];
    if (!looksLikeMarkdownTableRow(headerLine) || !isMarkdownTableSeparator(separatorLine)) {
        return null;
    }

    let headers = splitMarkdownTableRow(headerLine);
    let separatorCells = splitMarkdownTableRow(separatorLine);
    if (headers.length < 2 || separatorCells.length !== headers.length) {
        return null;
    }

    let rows = [];
    let rawLines = [headerLine, separatorLine];
    let index = startIndex + 2;

    while (index < lines.length && looksLikeMarkdownTableRow(lines[index])) {
        let cells = splitMarkdownTableRow(lines[index]);
        if (cells.length !== headers.length) {
            break;
        }

        rows.push(cells);
        rawLines.push(lines[index]);
        index++;
    }

    return {
        headers,
        rows,
        nextIndex: index,
        rawText: rawLines.join('\n'),
    };
}

function isMarkdownDividerLine(line) {
    return /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/.test(String(line ?? ''));
}

function appendMarkdownSegmentsFromText(segments, text) {
    let lines = String(text ?? '').split('\n');
    for (const segment of buildMarkdownSegmentsFromLines(lines)) {
        segments.push(segment);
    }
}

function buildMarkdownSegmentsFromLines(lines) {
    let segments = [];
    let bufferedLines = [];

    let flushBufferedLines = () => {
        if (bufferedLines.length === 0) {
            return;
        }

        let blockText = bufferedLines.join('\n');
        bufferedLines = [];

        if (blockText === '') {
            return;
        }

        for (const chunk of splitTextIntoBoundedChunks(blockText, MARKDOWN_SEGMENT_MAX_CHARS)) {
            segments.push({
                type: 'text',
                markup: formatMarkdownTextSegment(chunk),
                fallbackText: chunk,
            });
        }
    };

    let index = 0;
    while (index < lines.length) {
        let line = lines[index];

        // Blockquote: group consecutive "> ..." lines, strip the markers,
        // and parse the inner block as full markdown (tables, lists,
        // headings, bold, etc.) inside a styled quote container. This
        // replaces the old per-line "| " prefix that rendered as a stray
        // slash/pipe before every quoted line.
        if (/^\s{0,3}>\s?(.*)$/.test(line)) {
            flushBufferedLines();

            let innerLines = [];
            while (index < lines.length) {
                let quoteMatch = lines[index].match(/^\s{0,3}>\s?(.*)$/);
                if (!quoteMatch) {
                    break;
                }

                innerLines.push(quoteMatch[1]);
                index++;
            }

            if (innerLines.length > 0) {
                segments.push({
                    type: 'blockquote',
                    segments: buildMarkdownSegmentsFromLines(innerLines),
                });
            }

            continue;
        }

        let table = parseMarkdownTable(lines, index);
        if (table) {
            flushBufferedLines();
            segments.push({
                type: 'table',
                headers: table.headers,
                rows: table.rows,
                fallbackText: table.rawText,
            });
            index = table.nextIndex;
            continue;
        }

        if (isMarkdownDividerLine(line)) {
            flushBufferedLines();
            segments.push({ type: 'rule' });
            index++;
            continue;
        }

        bufferedLines.push(line);
        index++;
    }

    flushBufferedLines();

    return segments;
}

function buildCodeBlockSegment(language, codeText) {
    return {
        type: 'code',
        language: String(language ?? '').trim(),
        code: String(codeText ?? '').replace(/\t/g, '    ').replace(/\n$/, ''),
    };
}

export function buildAssistantRenderModel(rawText, { final = false, plain = false } = {}) {
    let sourceText = String(rawText ?? '');
    if (plain) {
        const plainSegments = [];
        for (const chunk of splitTextIntoBoundedChunks(sourceText, MARKDOWN_SEGMENT_MAX_CHARS)) {
            plainSegments.push({
                type: 'text',
                markup: renderPlainMarkup(chunk),
                fallbackText: chunk,
            });
        }
        return {
            segments: plainSegments,
            links: [],
        };
    }

    let parseableText = sourceText;
    let trailingPlainText = '';
    let fenceMatches = parseableText.match(/```/g) || [];
    if (!final && fenceMatches.length % 2 === 1) {
        let lastFenceIndex = parseableText.lastIndexOf('```');
        trailingPlainText = parseableText.slice(lastFenceIndex);
        parseableText = parseableText.slice(0, lastFenceIndex);
    }

    let segments = [];
    let links = [];
    let codeBlockRegex = /```([^\n`]*)\n([\s\S]*?)```/g;
    let lastIndex = 0;
    let match;

    while ((match = codeBlockRegex.exec(parseableText)) !== null) {
        if (match.index > lastIndex) {
            let extracted = extractLinks(parseableText.slice(lastIndex, match.index));
            links.push(...extracted.links);
            if (extracted.text !== '') {
                appendMarkdownSegmentsFromText(segments, extracted.text);
            }
        }

        segments.push(buildCodeBlockSegment(match[1], match[2]));
        lastIndex = codeBlockRegex.lastIndex;
    }

    if (lastIndex < parseableText.length) {
        let extracted = extractLinks(parseableText.slice(lastIndex));
        links.push(...extracted.links);
        if (extracted.text !== '') {
            appendMarkdownSegmentsFromText(segments, extracted.text);
        }
    }

    if (trailingPlainText) {
        for (const chunk of splitTextIntoBoundedChunks(trailingPlainText, MARKDOWN_SEGMENT_MAX_CHARS)) {
            segments.push({
                type: 'text',
                markup: renderPlainMarkup(chunk),
                fallbackText: chunk,
            });
        }
    }

    let uniqueLinks = [];
    let seen = new Set();
    for (let link of links) {
        if (seen.has(link.url)) {
            continue;
        }

        seen.add(link.url);
        uniqueLinks.push(link);
    }

    return {
        segments,
        links: uniqueLinks,
    };
}
