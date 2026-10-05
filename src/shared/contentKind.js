// contentKind.js — Content classification helpers shared by the Crawl4AI
// result pipeline and the deep-research compression stage.
//
// Two responsibilities:
//   1. analyzeCodeHeaviness(text) — decide whether a page is code-centric
//      (docs with samples, API references, source files).  Code pages should
//      NOT be LLM-summarized: the raw code is the data the user wants.
//      Also used to detect when Crawl4AI's content filter dropped code.
//   2. buildRawCodeExcerpt(text) — build a bounded verbatim excerpt that keeps
//      headings and fenced code blocks so code survives into research
//      findings without paying for an LLM round-trip.
//
// Pure functions (no network / no UI) so they are unit-testable.

const FENCE_LINE_REGEX = /^\s*```/;
const HEADING_LINE_REGEX = /^#{1,6}\s/;

const CODE_KEYWORD_REGEX =
    /\b(function|class|import|export|const|let|var|def|return|async|await|public|private|protected|static|void|struct|enum|interface|typedef|#include|#define|npm|yarn|pnpm|pip|docker|cargo|curl|SELECT|INSERT|UPDATE|DELETE|FROM|WHERE)\b/g;

// Symbol shapes that are common in code and rare in prose.
const CODE_SYMBOL_REGEX = /=>|[{}();]|<\/|\/>/g;

export const RAW_CODE_EXCERPT_MAX_CHARS = 6000;

/**
 * Classify how code-heavy a page's text is.
 *
 * Heuristics (any one may trigger):
 *   • 2+ fenced code blocks;
 *   • fenced lines ≥ 30% of all lines AND at least 5 fenced lines;
 *   • on texts ≥ 400 chars: keyword density ≥ 4/1k AND symbol density ≥ 20/1k;
 *   • on texts ≥ 400 chars: symbol density ≥ 45/1k on its own.
 *
 * The density rules require a minimum length so a short page that happens to
 * contain a couple of parentheses is not misclassified as code.
 *
 * @param {string} text
 * @returns {{codeHeavy: boolean, fenceBlocks: number, fencedLineRatio: number,
 *            keywordDensity: number, symbolDensity: number}}
 */
export function analyzeCodeHeaviness(text) {
    const value = String(text || '');
    const lines = value.split('\n');

    let inFence = false;
    let fencedLines = 0;
    let fenceToggles = 0;
    for (const line of lines) {
        if (FENCE_LINE_REGEX.test(line)) {
            fenceToggles++;
            inFence = !inFence;
            continue;
        }
        if (inFence) fencedLines++;
    }
    const fenceBlocks = Math.floor(fenceToggles / 2);
    const fencedLineRatio = fencedLines / Math.max(1, lines.length);

    const keywordMatches = value.match(CODE_KEYWORD_REGEX) || [];
    const symbolMatches = value.match(CODE_SYMBOL_REGEX) || [];
    const per1k = (count) => (count * 1000) / Math.max(1, value.length);
    const keywordDensity = per1k(keywordMatches.length);
    const symbolDensity = per1k(symbolMatches.length);
    const densityEligible = value.length >= 400;

    const codeHeavy =
        fenceBlocks >= 2 ||
        (fencedLineRatio >= 0.3 && fencedLines >= 5) ||
        (densityEligible && keywordDensity >= 4 && symbolDensity >= 20) ||
        (densityEligible && symbolDensity >= 45);

    return { codeHeavy, fenceBlocks, fencedLineRatio, keywordDensity, symbolDensity };
}

/**
 * Build a bounded verbatim excerpt that preserves headings and fenced code
 * blocks (the parts a code page exists for).  Non-code prose is dropped.
 * Falls back to a plain bounded slice when no code structure is found.
 *
 * @param {string} text - Page markdown.
 * @param {{maxChars?: number}} [options]
 * @returns {string}
 */
export function buildRawCodeExcerpt(text, { maxChars = RAW_CODE_EXCERPT_MAX_CHARS } = {}) {
    const value = String(text || '');
    if (!value) return '';

    const kept = [];
    let inFence = false;
    for (const line of value.split('\n')) {
        if (FENCE_LINE_REGEX.test(line)) {
            inFence = !inFence;
            kept.push(line);
            continue;
        }
        if (inFence || HEADING_LINE_REGEX.test(line)) {
            kept.push(line);
        }
    }

    let excerpt = kept.join('\n').trim();
    if (!excerpt) {
        // No fenced structure (inline-code-heavy page) — keep a bounded slice.
        excerpt = value.slice(0, maxChars).trimEnd();
    }
    if (excerpt.length > maxChars) {
        excerpt = `${excerpt.slice(0, maxChars).trimEnd()}\n[...raw excerpt trimmed]`;
    }
    return excerpt;
}
