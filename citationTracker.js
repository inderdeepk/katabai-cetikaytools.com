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
 * Create a new citation tracker for a research session.
 * @returns {CitationMap}
 */
export function createCitationTracker() {
    return {
        entries: [],
        urlToNumber: new Map(),
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

        // Normalize URL for deduplication
        const normalizedUrl = String(fact.url).trim().replace(/\/+$/, '').toLowerCase();

        // Assign citation number if new URL
        if (!tracker.urlToNumber.has(normalizedUrl)) {
            tracker.urlToNumber.set(normalizedUrl, tracker.urlToNumber.size + 1);
        }

        const num = tracker.urlToNumber.get(normalizedUrl);
        tracker.entries.push({
            id: `c${tracker.entries.length + 1}`,
            claim: String(fact.claim).trim(),
            urls: [String(fact.url).trim()],
            citationNum: num,
        });
    }
}

/**
 * Register a URL directly (from sources list, without a specific claim).
 *
 * @param {CitationMap} tracker
 * @param {string} url
 * @param {string} [label] - Optional label/description for the bibliography entry
 */
export function registerSource(tracker, url, label = '') {
    if (!tracker || !url) return;

    const normalizedUrl = String(url).trim().replace(/\/+$/, '').toLowerCase();
    if (!tracker.urlToNumber.has(normalizedUrl)) {
        tracker.urlToNumber.set(normalizedUrl, tracker.urlToNumber.size + 1);
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

    // Build reverse map: number → original URL
    const numToUrl = new Map();
    for (const [normalized, num] of tracker.urlToNumber.entries()) {
        if (!numToUrl.has(num)) {
            // Find the original (non-normalized) URL from entries
            const entry = tracker.entries.find(e => e.citationNum === num);
            numToUrl.set(num, entry ? entry.urls[0] : normalized);
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
            const nums = [...new Set(
                entry.urls.map(u => {
                    const normalized = String(u).trim().replace(/\/+$/, '').toLowerCase();
                    return tracker.urlToNumber.get(normalized);
                }).filter(Boolean)
            )].sort((a, b) => a - b);

            if (nums.length > 0) {
                const marker = nums.map(n => `[${n}]`).join('');
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
    if (!tracker || !tracker.entries.length) return '';

    const sources = getUniqueSources(tracker);
    let summary = 'SOURCES COLLECTED (cite these in your report using [N] notation):\n';
    for (const { num, url } of sources) {
        summary += `  [${num}] ${url}\n`;
    }
    return summary;
}
