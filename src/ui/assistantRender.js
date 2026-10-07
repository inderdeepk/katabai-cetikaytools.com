// Katab AI — assistant reply rendering. Owns the markdown render pipeline for
// assistant messages: the streaming dispatch (single-label fast path vs
// throttled full segmented renders), segment rendering into bounded widgets
// (code blocks, tables, rules, blockquotes), inline [N] citation buttons,
// bibliography parsing, web-source collection rendering, link chips, and the
// drag-selection behaviour shared by every read-only chat label.
//
// Extracted from extension.js (analysis item #4). The dialog keeps thin
// wrappers (`_applyAssistantRender`, `_renderSourcesSection`,
// `_makeTextSelectable`, `_truncateText`) and a `_buildRenderHost()` bag for
// everything the pipeline needs back from the dialog. The message-bubble
// module reaches this through the dialog's `applyAssistantRender` host entry.
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {
    MARKDOWN_SEGMENT_MAX_CHARS,
    buildAssistantRenderModel,
    formatInlineMarkdown,
    normalizeUrl,
    splitTextIntoBoundedChunks,
} from './markdownRender.js';

// ── Streaming render bounds ───────────────────────────────────────────────
// Every StLabel is always redirected to an offscreen framebuffer (St sets
// CLUTTER_OFFSCREEN_REDIRECT_ALWAYS on labels), sized to the WHOLE label. The
// streaming fast path renders the entire reply into ONE label, so a long reply
// makes that label taller than the GPU's GL_MAX_TEXTURE_SIZE (8192 px on many
// iGPUs); the offscreen allocation then fails every frame — flooding logs with
// "Failed to create offscreen effect framebuffer: Failed to create texture 2d
// due to size/format constraints" and painting the label blank. Keep the fast
// label small (≤ ~6000 chars ≈ ~1500 logical px, ~3000 px at 2× scale) and
// switch longer streams to throttled full segmented renders, which produce
// many small bounded labels.
const STREAMING_FAST_THROTTLE_US = 33000; // single-label fast path (~30 fps)
const STREAMING_FULL_THROTTLE_US = 300000; // full markdown render (~3.3 fps)
const STREAMING_SINGLE_LABEL_MAX_CHARS = 6000;

/**
 * Renders assistant replies (streaming + final) into chat bubbles.
 *
 * Host bag contract:
 *   isOpen(), isActorDisposed(actor), isChatUiCurrent(uiElements),
 *   getCurrentBibMap(), setCurrentBibMap(map), getCitationTracker(),
 *   getMessageHistory(), collectWebSources(), addSystemMessage(text),
 *   scrollToBottom()
 */
export class AssistantRender {
    constructor(host) {
        this._host = host;
    }

    truncateText(text, maxLength = 48) {
        if (text.length <= maxLength) {
            return text;
        }

        return `${text.slice(0, maxLength - 3)}...`;
    }

    _setLabelMarkup(label, markup, fallbackText) {
        try {
            label.clutter_text.set_markup(markup);
        } catch (e) {
            log(`Katab: failed to render formatted text: ${e.message}`);
            label.set_text(fallbackText);
        }
    }

    _positionFromTextEvent(clutterText, event) {
        let [x, y] = event.get_coords();
        let [ok, lx, ly] = clutterText.transform_stage_point(x, y);
        if (!ok) {
            return -1;
        }
        // coords_to_position() returns a BYTE index into the layout text, but
        // set_selection()/set_cursor_position() expect CHARACTER offsets. Without
        // converting, any multi-byte UTF-8 character before the pointer (curly
        // quotes, em dashes, ellipses, emoji, accented letters, …) shifts the
        // selection to the right. Mirror Clutter's own handler, which runs the
        // byte index through bytes_to_offset() before selecting.
        let byteIndex = clutterText.coords_to_position(lx, ly);
        if (byteIndex <= 0) {
            return byteIndex < 0 ? -1 : 0;
        }
        return this._byteOffsetToCharOffset(clutterText.get_text(), byteIndex);
    }

    // Convert a UTF-8 byte offset into a character (code point) offset, matching
    // GLib's bytes_to_offset()/g_utf8_strlen() so positions align with what the
    // Clutter selection API expects.
    _byteOffsetToCharOffset(text, byteIndex) {
        if (!text || byteIndex <= 0) {
            return 0;
        }
        let bytes = 0;
        let chars = 0;
        for (const ch of text) {
            const cp = ch.codePointAt(0);
            let cpBytes;
            if (cp <= 0x7f) {
                cpBytes = 1;
            } else if (cp <= 0x7ff) {
                cpBytes = 2;
            } else if (cp <= 0xffff) {
                cpBytes = 3;
            } else {
                cpBytes = 4;
            }
            if (bytes + cpBytes > byteIndex) {
                break;
            }
            bytes += cpBytes;
            chars += 1;
        }
        return chars;
    }

    // Make a read-only chat text label drag-selectable without making it
    // editable (which would strip its Pango markup). The underlying ClutterText
    // stays non-editable but reactive + selectable, and selection is driven from
    // our own pointer handlers. Returning EVENT_STOP from button-press suppresses
    // Clutter's default press handler, which would otherwise call input-method
    // functions that emit CRITICAL warnings for non-editable actors (and can
    // crash gnome-shell when it runs with fatal-criticals).
    makeTextSelectable(label) {
        let ct = label && label.clutter_text;
        if (!ct) {
            return label;
        }

        ct.editable = false;
        ct.selectable = true;
        ct.reactive = true;
        ct.cursor_visible = true;
        ct.selection_color = new Clutter.Color({ red: 53, green: 132, blue: 228, alpha: 255 });
        ct.selected_text_color = new Clutter.Color({ red: 255, green: 255, blue: 255, alpha: 255 });

        ct.connect('button-press-event', (actor, event) => {
            if (event.get_button() !== Clutter.BUTTON_PRIMARY) {
                return Clutter.EVENT_PROPAGATE;
            }
            let pos = this._positionFromTextEvent(actor, event);
            if (pos < 0) {
                return Clutter.EVENT_PROPAGATE;
            }
            actor.set_selection(pos, pos);
            actor._katabSelAnchor = pos;
            actor._katabSelecting = true;
            actor.grab_key_focus();
            return Clutter.EVENT_STOP;
        });

        ct.connect('motion-event', (actor, event) => {
            if (!actor._katabSelecting) {
                return Clutter.EVENT_PROPAGATE;
            }
            // If the primary button was released without us seeing the release
            // (e.g. outside the actor), stop tracking instead of extending the
            // selection on a plain hover.
            if (!(event.get_state() & Clutter.ModifierType.BUTTON1_MASK)) {
                actor._katabSelecting = false;
                return Clutter.EVENT_PROPAGATE;
            }
            let pos = this._positionFromTextEvent(actor, event);
            if (pos >= 0) {
                actor.set_selection(actor._katabSelAnchor, pos);
            }
            return Clutter.EVENT_STOP;
        });

        ct.connect('button-release-event', (actor) => {
            if (!actor._katabSelecting) {
                return Clutter.EVENT_PROPAGATE;
            }
            actor._katabSelecting = false;
            return Clutter.EVENT_STOP;
        });

        return label;
    }

    _createAssistantTextLabel(markup, fallbackText) {
        let label = new St.Label({
            text: '',
            style_class: 'katab-chat-content-label',
            x_expand: true,
        });
        label.clutter_text.line_wrap = true;
        label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        label.clutter_text.single_line_mode = false;
        label.clutter_text.can_focus = false;
        this.makeTextSelectable(label);
        this._setLabelMarkup(label, markup, fallbackText);
        return label;
    }

    _createMarkdownRuleWidget() {
        return new St.Widget({
            style_class: 'katab-markdown-rule',
            x_expand: true,
            height: 1,
        });
    }

    _createMarkdownTableCell(text, { header = false } = {}) {
        let cellBox = new St.BoxLayout({
            vertical: true,
            style_class: 'katab-markdown-table-cell',
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
        });
        if (header) {
            cellBox.add_style_class_name('katab-markdown-table-cell-header');
        }

        let label = new St.Label({
            text: '',
            style_class: 'katab-markdown-table-cell-label',
            x_expand: true,
            x_align: Clutter.ActorAlign.FILL,
        });
        if (header) {
            label.add_style_class_name('katab-markdown-table-cell-label-header');
        }

        label.clutter_text.line_wrap = true;
        label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        label.clutter_text.single_line_mode = false;
        label.clutter_text.can_focus = false;
        this.makeTextSelectable(label);

        let markup = formatInlineMarkdown(text);
        if (header) {
            markup = `<b>${markup}</b>`;
        }

        this._setLabelMarkup(label, markup, text);
        cellBox.add_child(label);
        return cellBox;
    }

    _createMarkdownTableWidget(segment) {
        let tableWindow = new St.BoxLayout({
            vertical: true,
            style_class: 'katab-markdown-table-window',
            x_expand: true,
        });

        let headerRow = new St.BoxLayout({
            vertical: false,
            style_class: 'katab-markdown-table-header',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        let headerLabel = new St.Label({
            text: 'Table',
            style_class: 'katab-markdown-table-language',
            y_align: Clutter.ActorAlign.CENTER,
        });
        headerRow.add_child(headerLabel);
        headerRow.add_child(new St.Widget({ x_expand: true }));

        let copyBtn = new St.Button({
            label: 'Copy table',
            style_class: 'katab-markdown-table-copy-btn',
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
            accessible_name: 'Copy table to clipboard',
        });
        copyBtn.connect('clicked', () => {
            St.Clipboard.get_default().set_text(
                St.ClipboardType.CLIPBOARD,
                String(segment.fallbackText ?? ''),
            );
        });
        headerRow.add_child(copyBtn);
        tableWindow.add_child(headerRow);

        let tableBox = new St.BoxLayout({
            vertical: true,
            style_class: 'katab-markdown-table',
            x_expand: true,
        });

        let allRows = [segment.headers, ...(segment.rows || [])];
        for (let rowIndex = 0; rowIndex < allRows.length; rowIndex++) {
            let row = allRows[rowIndex];
            let rowBox = new St.Widget({
                layout_manager: new Clutter.BoxLayout({
                    orientation: Clutter.Orientation.HORIZONTAL,
                    homogeneous: true,
                    spacing: 0,
                }),
                style_class: 'katab-markdown-table-row',
                x_expand: true,
                x_align: Clutter.ActorAlign.FILL,
            });

            if (rowIndex === 0) {
                rowBox.add_style_class_name('katab-markdown-table-row-header');
            }

            for (let cellText of row) {
                rowBox.add_child(
                    this._createMarkdownTableCell(cellText, { header: rowIndex === 0 }),
                );
            }

            tableBox.add_child(rowBox);
        }

        tableWindow.add_child(tableBox);
        return tableWindow;
    }

    _createCodeBlockWidget(language, codeText) {
        let codeWindow = new St.BoxLayout({
            vertical: true,
            style_class: 'katab-code-window',
            x_expand: true,
        });

        let headerRow = new St.BoxLayout({
            vertical: false,
            style_class: 'katab-code-window-header',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        let languageLabel = new St.Label({
            text: language || 'Code',
            style_class: 'katab-code-window-language',
            y_align: Clutter.ActorAlign.CENTER,
        });
        headerRow.add_child(languageLabel);
        headerRow.add_child(new St.Widget({ x_expand: true }));

        let copyBtn = new St.Button({
            label: 'Copy',
            style_class: 'katab-code-copy-btn',
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
            accessible_name: 'Copy code to clipboard',
        });
        copyBtn.connect('clicked', () => {
            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, codeText);
        });
        headerRow.add_child(copyBtn);
        codeWindow.add_child(headerRow);

        let bodyBox = new St.BoxLayout({
            vertical: true,
            style_class: 'katab-code-window-body',
            x_expand: true,
        });

        for (const chunk of splitTextIntoBoundedChunks(codeText, MARKDOWN_SEGMENT_MAX_CHARS)) {
            let codeLabel = new St.Label({
                text: chunk,
                style_class: 'katab-code-window-label',
                x_expand: true,
            });
            codeLabel.clutter_text.line_wrap = true;
            codeLabel.clutter_text.line_wrap_mode = Pango.WrapMode.CHAR;
            codeLabel.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            codeLabel.clutter_text.single_line_mode = false;
            codeLabel.clutter_text.can_focus = false;
            this.makeTextSelectable(codeLabel);
            bodyBox.add_child(codeLabel);
        }
        codeWindow.add_child(bodyBox);

        return codeWindow;
    }

    _renderAssistantSegments(contentBox, segments) {
        if (!contentBox) {
            return;
        }

        contentBox.destroy_all_children();

        let hasChildren = false;
        for (let segment of segments) {
            if (segment.type === 'code') {
                contentBox.add_child(this._createCodeBlockWidget(segment.language, segment.code));
                hasChildren = true;
                continue;
            }

            if (segment.type === 'blockquote') {
                let quoteBox = new St.BoxLayout({
                    vertical: true,
                    style_class: 'katab-markdown-blockquote',
                    x_expand: true,
                });
                this._renderAssistantSegments(quoteBox, segment.segments || []);
                contentBox.add_child(quoteBox);
                hasChildren = true;
                continue;
            }

            if (segment.type === 'table') {
                contentBox.add_child(this._createMarkdownTableWidget(segment));
                hasChildren = true;
                continue;
            }

            if (segment.type === 'rule') {
                contentBox.add_child(this._createMarkdownRuleWidget());
                hasChildren = true;
                continue;
            }

            if (!segment.markup && !segment.fallbackText) {
                continue;
            }

            // Render text with inline clickable citation buttons
            contentBox.add_child(
                this._createTextWithCitationButtons(
                    segment.fallbackText || '',
                    segment.markup || '',
                    segment.fallbackText || '',
                ),
            );
            hasChildren = true;
        }

        if (!hasChildren) {
            contentBox.add_child(this._createAssistantTextLabel('', ''));
        }
    }

    _openExternalLink(url) {
        try {
            Gio.AppInfo.launch_default_for_uri(url, null);
        } catch (e) {
            this._host.addSystemMessage(`Failed to open link: ${e.message}`);
        }
    }

    /**
     * Parse bibliography entries from message text.
     * Handles formats like:
     *   [1] **Title** (https://url.com)
     *   [1] https://url.com
     *   [1] (https://url.com)
     *   [1] [Title](https://url.com)
     *
     * @param {string} text - Full message text
     * @returns {Map<number, {url: string, title: string}>}
     */
    _parseMessageBibliography(text) {
        const map = new Map();
        if (!text) return map;

        // Look for bibliography sections — common header patterns (case-insensitive).
        // Handles: "## Sources & References", "## 4. SOURCES & REFERENCES", "## Bibliography", etc.
        const sectionPatterns = [
            /^#{1,4}\s*(?:\d+\.\s*)?(?:sources?\s*(?:&|and)\s*)?references?\s*$/im,
            /^#{1,4}\s*(?:\d+\.\s*)?bibliography\s*$/im,
            /^#{1,4}\s*(?:\d+\.\s*)?sources?\s*$/im,
        ];

        let bibStart = -1;
        for (const pat of sectionPatterns) {
            const m = pat.exec(text);
            if (m) {
                bibStart = m.index + m[0].length;
                break;
            }
        }

        // If no explicit section header, scan the entire text for [N] URL patterns
        const scanText = bibStart >= 0 ? text.slice(bibStart) : text;

        // Match lines like:
        // [1] **Title** (https://url.com) — description...
        // [1] (https://url.com)
        // [1] https://url.com
        // [1] [Title](https://url.com)
        const linePatterns = [
            // [N] **bold title** (url) ...  or  [N] plain title (url) ...
            /^\[(\d{1,3})\]\s+(.+?)\s*\((https?:\/\/[^\s)]+)\)/m,
            // [N] (url) ...
            /^\[(\d{1,3})\]\s*\((https?:\/\/[^\s)]+)\)/m,
            // [N] [markdown link](url) ...
            /^\[(\d{1,3})\]\s+\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/m,
        ];

        // Try structured patterns first
        for (const pat of linePatterns) {
            const matches = scanText.matchAll(new RegExp(pat.source, 'gm'));
            for (const m of matches) {
                const num = parseInt(m[1], 10);
                const url = m[m.length - 1]; // URL is always the last capture group
                const title = m.length >= 4 ? m[2].replace(/\*\*/g, '').trim() : '';
                if (!map.has(num)) {
                    map.set(num, { url: normalizeUrl(url) || url, title });
                }
            }
        }

        // Fallback: [N] bare URL (must follow a [N] marker)
        const bareUrlRe = /^\[(\d{1,3})\]\s+(https?:\/\/[^\s<>"')\]]+)/gm;
        for (const m of scanText.matchAll(bareUrlRe)) {
            const num = parseInt(m[1], 10);
            const url = m[2].replace(/[.,;:!]+$/g, '');
            if (!map.has(num)) {
                map.set(num, { url: normalizeUrl(url) || url, title: '' });
            }
        }

        return map;
    }

    /**
     * Collect citation number→URL mappings.
     * @returns {Map<number, {url: string}>}
     */
    _collectCitationMap() {
        const map = new Map();

        // Source 1: Active citation tracker (from parallel branch research)
        if (this._host.getCitationTracker() && this._host.getCitationTracker().urlToNumber) {
            for (const [normalizedUrl, num] of this._host
                .getCitationTracker()
                .urlToNumber.entries()) {
                if (!map.has(num)) {
                    const entry = this._host
                        .getCitationTracker()
                        .entries.find((e) => e.citationNum === num);
                    const url = entry ? entry.urls[0] : normalizedUrl;
                    map.set(num, { url });
                }
            }
        }

        // Source 2: Message history tool results (from model-driven research)
        for (const msg of this._host.getMessageHistory()) {
            if (msg.role !== 'tool') continue;
            const content = typeof msg.content === 'string' ? msg.content : '';
            if (!content) continue;
            const urlMatches = content.matchAll(
                /\[Full text (?:scraped|extracted|fetched) from\s+(https?:\/\/[^\]]+)\]/g,
            );
            for (const match of urlMatches) {
                const url = match[1];
                const norm = url.replace(/\/+$/, '').toLowerCase();
                const num = map.size + 1;
                if (
                    ![...map.values()].some((v) => v.url.replace(/\/+$/, '').toLowerCase() === norm)
                ) {
                    map.set(num, { url });
                }
            }
        }

        // Source 3: Parsed bibliography from the current assistant message
        if (this._host.getCurrentBibMap() && this._host.getCurrentBibMap().size > 0) {
            for (const [num, entry] of this._host.getCurrentBibMap().entries()) {
                if (!map.has(num)) {
                    map.set(num, { url: entry.url, title: entry.title || '' });
                }
            }
        }

        return map;
    }

    /**
     * Render text with clickable [N] citation markers.
     * Uses the standard Pango-markup label (preserving ALL formatting:
     * headings, bold, italic, code, tables) and styles [N] markers
     * as teal underlined links.  Clicks on [N] markers open the
     * referenced URL.  Drag-selection still works normally.
     * @param {string} rawText - The original text with [N] markers
     * @param {string} markupText - Pango-markup text
     * @param {string} fallbackText - Plain text fallback
     * @returns {St.Widget}
     */
    _createTextWithCitationButtons(rawText, markupText, fallbackText) {
        const citationMap = this._collectCitationMap();

        // Quick check: does the text contain any [N] markers?
        if (!/\[\d{1,3}\]/.test(rawText) || citationMap.size === 0) {
            return this._createAssistantTextLabel(markupText, fallbackText);
        }

        // Style [N] markers that have URL mappings as teal underlined links.
        // Unmapped markers are left as plain text.
        const styledMarkup = (markupText || rawText).replace(/\[(\d{1,3})\]/g, (full, numStr) => {
            const num = parseInt(numStr, 10);
            if (citationMap.has(num)) {
                return `<span foreground="#94e2d5" underline="single" font_weight="bold">[${num}]</span>`;
            }
            return full;
        });

        // Render as a normal label — all formatting is preserved
        const lbl = this._createAssistantTextLabel(styledMarkup, fallbackText);

        // Attach click-to-open behaviour for [N] markers.
        // We connect after makeTextSelectable so selection still works;
        // we only open URLs on clicks (not drag-selections).
        const ct = lbl.clutter_text;
        if (ct) {
            const releaseId = ct.connect('button-release-event', (actor, event) => {
                if (event.get_button() !== Clutter.BUTTON_PRIMARY) {
                    return Clutter.EVENT_PROPAGATE;
                }

                // Only act on clicks, not drag-selections
                const sel = actor.get_selection?.();
                if (sel && String(sel).length > 0) {
                    return Clutter.EVENT_PROPAGATE;
                }

                const pos = this._positionFromTextEvent(actor, event);
                if (pos < 0) return Clutter.EVENT_PROPAGATE;

                // Scan the visible text for [N] markers and check if
                // the clicked position falls inside one
                const text = actor.get_text();
                const markerRe = /\[(\d{1,3})\]/g;
                let m;
                while ((m = markerRe.exec(text)) !== null) {
                    if (pos >= m.index && pos < m.index + m[0].length) {
                        const num = parseInt(m[1], 10);
                        const entry = citationMap.get(num);
                        if (entry) {
                            this._openExternalLink(entry.url);
                            return Clutter.EVENT_STOP;
                        }
                    }
                }
                return Clutter.EVENT_PROPAGATE;
            });
            lbl._katabCitReleaseId = releaseId;
        }

        return lbl;
    }

    renderSourcesSection(uiElements) {
        const sourcesBox = uiElements?.sourcesBox;
        if (!sourcesBox) return;

        sourcesBox.destroy_all_children();

        const sources = this._host.collectWebSources();
        if (!sources || sources.length === 0) {
            sourcesBox.visible = false;
            return;
        }

        // Collapsible header row with disclosure arrow
        const headerRow = new St.BoxLayout({
            vertical: false,
            style_class: 'katab-chat-sources-header-row',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });

        const arrowIcon = new St.Icon({
            icon_name: 'pan-end-symbolic',
            style_class: 'katab-chat-sources-arrow',
            icon_size: 14,
        });
        headerRow.add_child(arrowIcon);

        const headerLabel = new St.Label({
            text: sources.length === 1 ? '1 Source' : `${sources.length} Sources`,
            style_class: 'katab-chat-sources-header',
            y_align: Clutter.ActorAlign.CENTER,
        });
        headerRow.add_child(headerLabel);

        // Subtitle clarifying these are tool-accessed sites, not text citations
        const headerSubtitle = new St.Label({
            text: 'Sites accessed during research',
            style_class: 'katab-chat-sources-subtitle',
            y_align: Clutter.ActorAlign.CENTER,
        });
        headerRow.add_child(headerSubtitle);

        // Toggle button that spans the header row
        const toggleBtn = new St.Button({
            style_class: 'katab-chat-sources-toggle',
            can_focus: true,
            toggle_mode: true,
            checked: false,
            x_expand: true,
            accessible_name: 'Toggle source list',
        });
        toggleBtn.set_child(headerRow);

        // Container for source buttons — hidden by default
        const sourcesList = new St.BoxLayout({
            vertical: true,
            style_class: 'katab-chat-sources-list',
            x_expand: true,
            visible: false,
        });

        for (const source of sources) {
            const displayLabel =
                source.title && source.title !== source.url
                    ? source.title
                    : source.url.replace(/^https?:\/\//i, '');
            const truncated = this.truncateText(displayLabel, 72);

            const button = new St.Button({
                label: truncated,
                style_class: 'katab-chat-source-button',
                can_focus: true,
                x_expand: true,
                x_align: Clutter.ActorAlign.START,
            });
            button.connect('clicked', () => this._openExternalLink(source.url));
            sourcesList.add_child(button);
        }

        toggleBtn.connect('clicked', () => {
            const expanded = toggleBtn.checked;
            sourcesList.visible = expanded;
            arrowIcon.icon_name = expanded ? 'pan-down-symbolic' : 'pan-end-symbolic';
        });

        sourcesBox.add_child(toggleBtn);
        sourcesBox.add_child(sourcesList);
        sourcesBox.visible = true;
    }

    _getLinkChipLabel(link) {
        try {
            let host = new URL(link.url).hostname.replace(/^www\./i, '');
            return this.truncateText(host, 26);
        } catch (_) {
            return this.truncateText((link.label || link.url).replace(/^https?:\/\//i, ''), 26);
        }
    }

    _updateLinkActions(linkBox, links) {
        if (!linkBox) {
            return;
        }

        linkBox.destroy_all_children();

        if (!links || links.length === 0) {
            linkBox.visible = false;
            return;
        }

        // Tiny "References" label to distinguish cited links from research sources
        const refLabel = new St.Label({
            text: 'References',
            style_class: 'katab-chat-link-section-label',
            y_align: Clutter.ActorAlign.CENTER,
        });
        linkBox.add_child(refLabel);

        const MAX_VISIBLE = 3;
        const visibleLinks = links.slice(0, MAX_VISIBLE);
        const overflowLinks = links.slice(MAX_VISIBLE);

        const chipRow = new St.BoxLayout({
            vertical: false,
            style_class: 'katab-chat-link-chip-row',
            x_expand: true,
        });

        for (let link of visibleLinks) {
            let chip = new St.Button({
                label: this._getLinkChipLabel(link),
                style_class: 'katab-chat-link-chip',
                can_focus: true,
            });
            chip.connect('clicked', () => this._openExternalLink(link.url));
            chipRow.add_child(chip);
        }

        if (overflowLinks.length > 0) {
            let toggleBtn = new St.Button({
                label: `+${overflowLinks.length} more`,
                style_class: 'katab-chat-link-more-toggle',
                can_focus: true,
            });
            let overflowBox = new St.BoxLayout({
                vertical: true,
                style_class: 'katab-chat-link-overflow',
                x_expand: true,
                visible: false,
            });
            for (let link of overflowLinks) {
                let chip = new St.Button({
                    label: this._getLinkChipLabel(link),
                    style_class: 'katab-chat-link-chip',
                    can_focus: true,
                });
                chip.connect('clicked', () => this._openExternalLink(link.url));
                overflowBox.add_child(chip);
            }
            toggleBtn.connect('clicked', () => {
                overflowBox.visible = !overflowBox.visible;
                toggleBtn.label = overflowBox.visible
                    ? `-${overflowLinks.length} fewer`
                    : `+${overflowLinks.length} more`;
                this._host.scrollToBottom();
            });
            chipRow.add_child(toggleBtn);
            linkBox.add_child(chipRow);
            linkBox.add_child(overflowBox);
        } else {
            linkBox.add_child(chipRow);
        }

        linkBox.visible = true;
    }

    applyAssistantRender(uiElements, rawText, options = {}) {
        if (!uiElements || !uiElements.contentBox) {
            return;
        }

        // If the chat was rebuilt while an async operation was in flight, this
        // bubble (and its contentBox St.BoxLayout) has been destroyed. Bail
        // instead of touching the disposed widget, which would make GJS throw
        // "Object St.BoxLayout … has been already disposed".
        if (
            !this._host.isChatUiCurrent(uiElements) ||
            this._host.isActorDisposed(uiElements.contentBox)
        ) {
            return;
        }

        let sourceText = String(rawText ?? '');
        if (uiElements.footerRow) {
            uiElements.footerRow._katabCopyText = sourceText;
        }

        // ── Streaming fast path ──────────────────────────────────────────
        // During non-final streaming renders, avoid the expensive full
        // markdown parse + widget rebuild + sources/link collection that
        // would run on every SSE delta. Short replies use a single StLabel
        // updated ~30 fps.
        //
        // LONG replies must NOT use the single-label path: every StLabel
        // renders through an offscreen-redirect texture sized to the WHOLE
        // label (St always sets CLUTTER_OFFSCREEN_REDIRECT_ALWAYS). Once the
        // label outgrows the GPU's max texture size the allocation fails,
        // flooding the journal with "Failed to create offscreen effect
        // framebuffer: Failed to create texture 2d due to size/format
        // constraints" and painting the label blank. So long streams switch
        // to throttled full segmented renders (many small bounded labels).
        if (!options.final && !options.plain) {
            const now = GLib.get_monotonic_time(); // microseconds
            const lastRender = uiElements._katabStreamRenderUs || 0;
            const longText = sourceText.length > STREAMING_SINGLE_LABEL_MAX_CHARS;
            const throttleUs = options.forceRender
                ? 0
                : longText
                  ? STREAMING_FULL_THROTTLE_US
                  : STREAMING_FAST_THROTTLE_US;

            if (now - lastRender >= throttleUs || options.clearState) {
                uiElements._katabStreamRenderUs = now;
                if (longText) {
                    this._renderAssistantFull(uiElements, sourceText, options);
                } else {
                    this._renderAssistantStreamingFast(uiElements, sourceText);
                }
            }
            return;
        }
        uiElements._katabStreamRenderUs = 0; // reset throttle

        this._renderAssistantFull(uiElements, sourceText, options);
    }

    // Full markdown render: parses the reply into segments and rebuilds the
    // content/link/sources boxes as many small bounded widgets. Used by the
    // final render and by the throttled long-streaming path (which must avoid
    // a single oversized StLabel — see applyAssistantRender).
    _renderAssistantFull(uiElements, sourceText, options = {}) {
        // Discard the streaming fast-path label before doing a full render.
        if (uiElements._katabStreamLabel) {
            uiElements._katabStreamLabel = null;
        }

        let rendered = buildAssistantRenderModel(sourceText, options);

        // Parse bibliography section for clickable [N] citation button mapping
        this._host.setCurrentBibMap(this._parseMessageBibliography(sourceText));

        this._renderAssistantSegments(uiElements.contentBox, rendered.segments);
        this._updateLinkActions(uiElements.linkBox, rendered.links);
        this.renderSourcesSection(uiElements);

        if (uiElements.diagnosticBox && uiElements.diagnosticLabel) {
            const details = options.errorDetails ? String(options.errorDetails).trim() : '';
            uiElements.diagnosticLabel.set_text(details);
            uiElements.diagnosticBox.visible = details.length > 0;
        }
    }

    // Fast incremental rendering path for streaming text. Uses a single
    // persisted StLabel so we never destroy/recreate widgets mid-stream.
    _renderAssistantStreamingFast(uiElements, text) {
        // Guard: when the dialog is closed, the contentBox actor may have
        // been hidden or removed from the stage — skip UI updates to avoid
        // "not in the stage" warnings and NULL pointer crashes.
        if (!this._host.isOpen()) {
            return;
        }

        // On first call, create the persistent streaming label.
        if (!uiElements._katabStreamLabel) {
            uiElements.contentBox.destroy_all_children();
            const label = new St.Label({
                text: '',
                style_class: 'katab-chat-content-label',
                x_expand: true,
            });
            label.clutter_text.line_wrap = true;
            label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
            label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
            label.clutter_text.single_line_mode = false;
            label.clutter_text.can_focus = false;
            this.makeTextSelectable(label);
            uiElements.contentBox.add_child(label);
            uiElements._katabStreamLabel = label;
        }

        // Plain-text update — MUCH faster than Pango markup re-parse.
        uiElements._katabStreamLabel.clutter_text.set_text(text);
    }
}
