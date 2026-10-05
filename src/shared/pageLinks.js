// pageLinks.js — Shared link extraction, normalization, and scoring helpers.
//
// Extracted from the web tools so the same logic powers:
//   • read_url results (link extraction from raw HTML),
//   • crawl_url results (Crawl4AI internal/external link lists),
//   • explore_docs (documentation TOC + relevance suggestions),
//   • the research branch runner (subpage link following).
//
// Everything here is pure (no network / no UI) so it is unit-testable.

import GLib from 'gi://GLib';

// ── HTML entity decoding ─────────────────────────────────────────────────────

const NAMED_ENTITIES = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    hellip: '…',
    mdash: '—',
    ndash: '–',
    rsquo: '’',
    lsquo: '‘',
    ldquo: '“',
    rdquo: '”',
    copy: '©',
    reg: '®',
    trade: '™',
    deg: '°',
};

function safeFromCodePoint(codePoint) {
    try {
        return String.fromCodePoint(codePoint);
    } catch (_error) {
        return '';
    }
}

export function decodeHtmlEntities(text) {
    return String(text || '')
        .replace(/&#x([0-9a-fA-F]+);/g, (_match, hex) => safeFromCodePoint(parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (_match, dec) => safeFromCodePoint(parseInt(dec, 10)))
        .replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (match, name) =>
            Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, name)
                ? NAMED_ENTITIES[name]
                : match,
        );
}

// ── Display caps ─────────────────────────────────────────────────────────────
// "Make it best" defaults (Oct 2026): generous enough for the agent to see the
// navigation surface of a page, small enough to fit a tool result.
export const READ_URL_MAX_LINKS = 25;
export const CRAWL_MAX_LINKS = 30;
export const LINKS_SECTION_MAX_CHARS = 3000;
export const LINKS_SECTION_PREFIX = '--- Links on this page';
const LINK_LABEL_MAX_CHARS = 90;

// ── Noise filtering ──────────────────────────────────────────────────────────

// Navigation/boilerplate link patterns that are never useful page content.
const NOISE_HREF_PATTERNS = [
    /\/print(\/|$)/i,
    /\/(login|logout|signin|signout|signup|register|subscribe|share|feedback|rss|feed)(\/|$)/i,
];

// Binary/asset extensions that are never readable page content.  PDFs are NOT
// in this list — read_url and Crawl4AI's native PDF path can both read them,
// so callers decide whether to exclude PDFs (docs TOCs do, chat links don't).
const ASSET_EXTENSION_PATTERN =
    /\.(css|js|json|xml|txt|png|jpe?g|gif|webp|svg|ico|zip|rar|7z|tar|gz|tgz|bz2)(\?|#|$)/i;
const PDF_EXTENSION_PATTERN = /\.pdf(\?|#|$)/i;

export function isNoiseHref(absoluteUrl) {
    const url = String(absoluteUrl || '');
    if (!url) return true;
    for (const pattern of NOISE_HREF_PATTERNS) {
        if (pattern.test(url)) return true;
    }
    return false;
}

export function isAssetHref(absoluteUrl) {
    return ASSET_EXTENSION_PATTERN.test(String(absoluteUrl || ''));
}

export function isPdfHref(absoluteUrl) {
    return PDF_EXTENSION_PATTERN.test(String(absoluteUrl || ''));
}

// ── Href resolution ──────────────────────────────────────────────────────────

/**
 * Resolve a raw href against a base URL and return an absolute http(s) URL
 * with its fragment stripped, or '' when the href is unusable.
 */
export function resolveLinkHref(href, baseUrl) {
    const raw = String(href || '').trim();
    if (!raw || /^(mailto:|tel:|javascript:|data:|about:)/i.test(raw)) return '';

    let resolved;
    try {
        if (/^https?:\/\//i.test(raw)) {
            resolved = raw;
        } else {
            const base = String(baseUrl || '').trim();
            if (!base) return '';
            resolved = GLib.Uri.resolve_relative(base, raw, GLib.UriFlags.NONE);
        }
    } catch (_error) {
        return '';
    }
    if (!resolved || !/^https?:\/\//i.test(resolved)) return '';
    // Strip in-page fragment anchors; keep query strings (some docs use them
    // for sections, e.g. /docs/page?section=intro).
    return resolved.split('#')[0];
}

function hostOf(url) {
    try {
        const host = GLib.Uri.parse(String(url || ''), GLib.UriFlags.NONE).get_host();
        return host ? host.toLowerCase() : '';
    } catch (_error) {
        return '';
    }
}

function isExternalHref(href, baseUrl) {
    const target = hostOf(href);
    const base = hostOf(baseUrl);
    return Boolean(target && base && target !== base);
}

/**
 * Resolve a list of link entries to absolute URLs, drop navigation noise and
 * binary asset links, dedupe, and cap.  Input entries may carry `{href, text,
 * title, external}`; the `external` flag is preserved when present.
 *
 * @param {Array<{href?: string, url?: string, text?: string, title?: string, external?: boolean}>} links
 * @param {string} baseUrl - Base URL used to resolve relative hrefs.
 * @param {{max?: number, excludePdfs?: boolean}} [options]
 */
export function normalizeLinkList(links, baseUrl, { max = 100, excludePdfs = false } = {}) {
    const seen = new Set();
    const normalized = [];
    for (const link of links || []) {
        if (!link || typeof link !== 'object') continue;
        const href = resolveLinkHref(link.href ?? link.url ?? '', baseUrl);
        if (!href || isNoiseHref(href) || isAssetHref(href)) continue;
        if (excludePdfs && isPdfHref(href)) continue;
        const key = href.replace(/\/+$/, '').toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        normalized.push({
            href,
            text: String(link.text || '').trim(),
            title: String(link.title || '').trim(),
            ...(link.external ? { external: true } : {}),
        });
        if (normalized.length >= max) break;
    }
    return normalized;
}

// ── HTML anchor extraction ───────────────────────────────────────────────────

// Matches <a ... href="...">text</a> with double-quoted, single-quoted, or
// unquoted hrefs.  Anchor bodies are stripped of inner tags before use.
const ANCHOR_TAG_REGEX =
    /<a\b[^>]*?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))[^>]*>([\s\S]*?)<\/a>/gi;

/**
 * Extract links (with anchor text) from raw HTML.  Used by read_url so the
 * model can see the page's navigation surface and follow promising subpages.
 *
 * @param {string} html - Raw HTML source.
 * @param {string} baseUrl - The page URL used to resolve relative hrefs.
 * @param {{max?: number}} [options]
 * @returns {Array<{href: string, text: string, title: string, external?: boolean}>}
 */
export function extractHtmlLinks(html, baseUrl, { max = 50 } = {}) {
    const source = String(html || '');
    if (!source || !baseUrl) return [];

    const found = [];
    ANCHOR_TAG_REGEX.lastIndex = 0;
    let match;
    while ((match = ANCHOR_TAG_REGEX.exec(source)) !== null) {
        const rawHref = match[1] ?? match[2] ?? match[3] ?? '';
        const anchorHtml = match[4] || '';
        const anchorText = decodeHtmlEntities(anchorHtml.replace(/<[^>]+>/g, ' '))
            .replace(/\s+/g, ' ')
            .trim();
        const href = resolveLinkHref(rawHref, baseUrl);
        if (!href || isNoiseHref(href) || isAssetHref(href)) continue;
        found.push({
            href,
            text: anchorText,
            title: '',
            external: isExternalHref(href, baseUrl),
        });
        // Soft stop before dedupe/cap so pathological pages can't spin the
        // regex loop for megabytes of anchor soup.
        if (found.length >= max * 2) break;
    }
    return normalizeLinkList(found, baseUrl, { max });
}

// ── Relevance scoring ────────────────────────────────────────────────────────

// Small stopword set for keyword-overlap relevance scoring.  Keep it lean —
// this runs in GJS (no embedding model available).
const LINK_SCORE_STOPWORDS = new Set([
    'the',
    'and',
    'for',
    'are',
    'but',
    'not',
    'you',
    'all',
    'can',
    'had',
    'her',
    'was',
    'one',
    'our',
    'out',
    'has',
    'have',
    'from',
    'they',
    'that',
    'this',
    'with',
    'what',
    'how',
    'when',
    'where',
    'which',
    'will',
    'would',
    'about',
    'your',
    'more',
    'than',
    'then',
    'into',
    'only',
    'other',
    'over',
    'such',
    'just',
    'docs',
    'doc',
    'documentation',
    'html',
    'page',
    'pages',
    'guide',
    'guides',
]);

function tokenize(text) {
    return String(text || '')
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((word) => word.length > 2 && !LINK_SCORE_STOPWORDS.has(word));
}

/**
 * Score links by keyword overlap with a query.  Compares query tokens against
 * both the link text/title and the URL slug (docs URLs are usually
 * descriptive: /admin/settings/settings_search.html).  Higher = more relevant.
 *
 * @param {Array<{href: string, text: string, title: string}>} links
 * @param {string} query
 * @returns {Array<{href: string, text: string, title: string, score: number}>}
 */
export function scoreLinksByQuery(links, query) {
    const tokens = tokenize(query);
    if (tokens.length === 0) {
        return (links || []).map((link) => ({ ...link, score: 0 }));
    }

    const scored = [];
    for (const link of links || []) {
        const haystack = `${link.text || ''} ${link.title || ''} ${link.href || ''}`.toLowerCase();
        let score = 0;
        for (const token of tokens) {
            score += haystack.split(token).length - 1;
        }
        scored.push({ ...link, score });
    }
    scored.sort((a, b) => b.score - a.score || String(a.href).localeCompare(String(b.href)));
    return scored;
}

// ── Links section formatting (tool-result blocks + truncation) ───────────────

/**
 * Format a compact "Links on this page" section for a tool result.  The
 * returned string starts with LINKS_SECTION_PREFIX so callers (and the
 * progressive-truncation helper in extension.js) can find and preserve it.
 *
 * @param {Array<{href: string, text?: string, title?: string, external?: boolean}>} links
 * @param {{max?: number}} [options]
 * @returns {string} '' when there are no links.
 */
export function formatLinksSection(links, { max = READ_URL_MAX_LINKS } = {}) {
    const list = Array.isArray(links) ? links.slice(0, max) : [];
    if (list.length === 0) return '';

    const lines = [`${LINKS_SECTION_PREFIX} (${list.length}) ---`];
    list.forEach((link, index) => {
        // Brackets inside the label would break the markdown link syntax.
        const rawLabel = String(link.text || link.title || link.href || '')
            .replace(/\s+/g, ' ')
            .replace(/\[/g, '(')
            .replace(/\]/g, ')');
        const label =
            rawLabel.length > LINK_LABEL_MAX_CHARS
                ? `${rawLabel.slice(0, LINK_LABEL_MAX_CHARS - 1).trimEnd()}…`
                : rawLabel;
        const suffix = link.external ? ' (external)' : '';
        lines.push(`${index + 1}. [${label}](${link.href})${suffix}`);
    });

    let section = lines.join('\n');
    if (section.length > LINKS_SECTION_MAX_CHARS) {
        section = `${section.slice(0, LINKS_SECTION_MAX_CHARS).trimEnd()}\n[...links trimmed]`;
    }
    return section;
}

/**
 * Split a tool-result block into `{head, tail}` at the links section.  The
 * tail keeps everything from the links heading onwards (including any
 * trailing safety guard / nudges), so progressive truncation can trim only
 * the page body and re-append the navigation surface intact.
 *
 * @param {string} text
 * @returns {{head: string, tail: string}} tail is '' when no section exists.
 */
export function splitLinksSection(text) {
    const value = String(text || '');
    const index = value.indexOf(LINKS_SECTION_PREFIX);
    if (index === -1) return { head: value, tail: '' };
    return { head: value.slice(0, index).trimEnd(), tail: value.slice(index) };
}
