// citationTracker.js — Citation binding layer for deep research reports
//
// Tracks claim→source mappings throughout a deep research session and
// produces inline citation markers ([1][2]) and a numbered bibliography
// for the final synthesis report.
//
// Every extracted fact gets a unique claim ID; the tracker maintains a
// mapping of claim→URLs and can generate the final citation-annotated text.

// ── Citation entry ───────────────────────────────────────────────────────────

/**
 * @typedef {Object} CitationEntry
 * @property {string} id - Unique citation ID (e.g., "c1")
 * @property {string} claim - The factual claim text
 * @property {string[]} urls - Source URLs supporting this claim
 */

/**
 * @typedef {Object} CitationMap
 * @property {CitationEntry[]} entries - All tracked citations
 * @property {Map<string, number>} urlToNumber - URL → citation number mapping
 */

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Normalize a citation URL for deduplication: strip trailing slashes on the
 * path and lowercase for deduplication matching. Original-case URLs are
 * preserved separately in `tracker.numberToUrl` so rendered bibliography links
 * (Wikipedia/YouTube case-sensitive paths/queries) never 404.
 * @param {string} url
 * @returns {string}
 */
export function normalizeCitationUrl(url) {
    const trimmed = String(url || '').trim();
    if (!trimmed) return '';
    const qOrH = trimmed.search(/[?#]/);
    if (qOrH >= 0) {
        const base = trimmed.slice(0, qOrH).replace(/\/+$/, '');
        return `${base}${trimmed.slice(qOrH)}`.toLowerCase();
    }
    return trimmed.replace(/\/+$/, '').toLowerCase();
}

/**
 * Create a new citation tracker for a research session.
 * @returns {CitationMap}
 */
export function createCitationTracker() {
    return {
        entries: [],
        urlToNumber: new Map(),
        numberToUrl: new Map(),
    };
}

/**
 * Register facts with their source URL into the tracker.
 * Each unique URL gets a citation number. Facts from the same URL
 * are grouped under the same number.
 *
 * @param {CitationMap} tracker
 * @param {Array<{claim: string, url: string}>} facts - Facts from compressPage
 */
export function registerFacts(tracker, facts) {
    if (!tracker || !Array.isArray(facts)) return;

    for (const fact of facts) {
        if (!fact.claim || !fact.url) continue;

        const originalUrl = String(fact.url).trim();
        const normalizedUrl = normalizeCitationUrl(originalUrl);
        if (!normalizedUrl) continue;

        // Assign citation number if new URL
        if (!tracker.urlToNumber.has(normalizedUrl)) {
            const nextNum = tracker.urlToNumber.size + 1;
            tracker.urlToNumber.set(normalizedUrl, nextNum);
            if (tracker.numberToUrl instanceof Map) {
                tracker.numberToUrl.set(nextNum, originalUrl);
            }
        }

        const num = tracker.urlToNumber.get(normalizedUrl);
        tracker.entries.push({
            id: `c${tracker.entries.length + 1}`,
            claim: String(fact.claim).trim(),
            urls: [originalUrl],
            citationNum: num,
        });
    }
}

/**
 * Register a URL directly (from sources list, without a specific claim).
 *
 * @param {CitationMap} tracker
 * @param {string} url
 * @param {string} [_label] - Optional label/description for the bibliography entry
 */
export function registerSource(tracker, url, _label = '') {
    if (!tracker || !url) return;

    const originalUrl = String(url).trim();
    const normalizedUrl = normalizeCitationUrl(originalUrl);
    if (!normalizedUrl) return;
    if (!tracker.urlToNumber.has(normalizedUrl)) {
        const nextNum = tracker.urlToNumber.size + 1;
        tracker.urlToNumber.set(normalizedUrl, nextNum);
        if (tracker.numberToUrl instanceof Map) {
            tracker.numberToUrl.set(nextNum, originalUrl);
        }
    }
}

/**
 * Get all unique sources with their citation numbers.
 *
 * @param {CitationMap} tracker
 * @returns {Array<{num: number, url: string}>}
 */
export function getUniqueSources(tracker) {
    if (!tracker || !tracker.urlToNumber) return [];

    // Single pass over the citation entries — the first original URL seen for
    // each citation number wins (previously an O(sources × entries) find()
    // ran per source).
    const numToUrl = new Map();
    for (const entry of tracker.entries || []) {
        if (numToUrl.has(entry.citationNum)) continue;
        const url = Array.isArray(entry.urls) && entry.urls.length > 0 ? entry.urls[0] : null;
        if (url) {
            numToUrl.set(entry.citationNum, url);
        }
    }

    // Fall back to preserved original URL (from registerSource) or normalized key.
    for (const [normalized, num] of tracker.urlToNumber.entries()) {
        if (!numToUrl.has(num)) {
            const preserved =
                tracker.numberToUrl instanceof Map ? tracker.numberToUrl.get(num) : null;
            numToUrl.set(num, preserved || normalized);
        }
    }

    return Array.from(numToUrl.entries())
        .sort(([a], [b]) => a - b)
        .map(([num, url]) => ({ num, url }));
}

/**
 * Build a bibliography section string for the final report.
 *
 * @param {CitationMap} tracker
 * @returns {string} Markdown bibliography
 */
export function buildBibliography(tracker) {
    const sources = getUniqueSources(tracker);
    if (sources.length === 0) return '';

    let text = '\n\n---\n\n## Sources & References\n\n';
    for (const { num, url } of sources) {
        text += `${num}. [${url}](${url})\n`;
    }
    return text;
}

/**
 * Append citation markers to a synthesis text by finding known claims
 * and inserting footnote-style citation numbers inline.
 * Uses simple substring matching against registered claims.
 *
 * @param {CitationMap} tracker
 * @param {string} text - The synthesis text
 * @returns {string} Text with inline citation markers like [1][2]
 */
export function annotateCitations(tracker, text) {
    if (!tracker || !tracker.entries.length || !text) return text;

    let annotated = text;

    // For each claim, find it in the text and append its citation numbers
    for (const entry of tracker.entries) {
        if (!entry.claim || entry.claim.length < 30) continue; // Skip very short claims (too noisy)

        // Find the claim substring in the text
        const idx = annotated.indexOf(entry.claim);
        if (idx >= 0) {
            const endIdx = idx + entry.claim.length;
            // Collect unique citation numbers for this claim
            const nums = [
                ...new Set(
                    entry.urls
                        .map((u) => {
                            const normalized = normalizeCitationUrl(u);
                            return (
                                tracker.urlToNumber.get(normalized) ||
                                tracker.urlToNumber.get(
                                    String(u).trim().replace(/\/+$/, '').toLowerCase(),
                                )
                            );
                        })
                        .filter(Boolean),
                ),
            ].sort((a, b) => a - b);

            if (nums.length > 0) {
                const marker = nums.map((n) => `[${n}]`).join('');
                // Only insert if there isn't already a citation marker right after
                const after = annotated.slice(endIdx, endIdx + 20);
                if (!/^(\s*\[(\d+)\])+/.test(after)) {
                    annotated = annotated.slice(0, endIdx) + marker + annotated.slice(endIdx);
                }
            }
        }
    }

    return annotated;
}

/**
 * Get a summary of the citation tracker for injection into synthesis prompts.
 *
 * @param {CitationMap} tracker
 * @returns {string} Summary text
 */
export function buildCitationSummary(tracker) {
    if (!tracker) return '';

    const sources = getUniqueSources(tracker);
    if (sources.length === 0) return '';

    let summary = 'SOURCES COLLECTED (cite these in your report using [N] notation):\n';
    for (const { num, url } of sources) {
        summary += `  [${num}] ${url}\n`;
    }
    return summary;
}
