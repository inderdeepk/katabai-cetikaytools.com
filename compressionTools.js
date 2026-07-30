// compressionTools.js — LLM-based hierarchical compression for deep research
//
// Implements a multi-level summarization pipeline modeled after Google Gemini's
// context management strategy:
//   Level 1: Per-page compression  (3-5 factual bullets with source URL)
//   Level 2: Page merge             (≤10 bullets, deduplicated)
//   Level 3: Thematic clustering    (paragraph per theme, multi-source citations)
//   Level 4: Section drafting       (coherent prose with intro + conclusion)
//
// All compression functions accept an `llmCall` callback so they work with
// any provider/endpoint — extension.js passes its _requestNonStreamingCompletion.

// ── Compression system prompts ───────────────────────────────────────────────

const COMPRESS_PAGE_SYSTEM = `You are a research assistant extracting key facts from a web page.
Extract 3-5 key factual claims from the provided page content.
For each claim, include the source URL that was provided.

RULES:
- Skip marketing fluff, navigation text, repeated content, and boilerplate.
- Focus on substantive, verifiable claims: statistics, dates, names, events, technical details.
- If the page is mostly ads/navigation/empty, return fewer than 3 claims.
- Do NOT summarize the page — extract individual factual claims.

Output as a JSON array of objects with "claim" and "url" fields.
Example: [{"claim": "Company X raised $50M in Series B funding in Q3 2025", "url": "https://example.com/article"}]`;

const MERGE_PAGE_SYSTEM = `You are a research assistant consolidating findings from multiple pages about the same topic.
You will receive several page summaries (each with 3-5 bullet points). Merge them into a single,
deduplicated summary of no more than 10 bullet points.

RULES:
- If two or more pages report the same fact, keep it ONCE but note that multiple sources confirm it.
- Preserve ALL unique facts — do not drop information just to save space.
- Group related facts together.
- Keep source URLs with each fact when available.

Output as markdown bullet points. Example:
- Company X raised $50M Series B (confirmed by [source1](url1), [source2](url2))
- Competitor Y launched product Z in January 2025 [source3](url3)`;

const CLUSTER_THEMES_SYSTEM = `You are a research synthesizer organizing findings into thematic clusters.
You will receive several topic summaries. Group related facts into 2-4 themes.
For each theme, write a paragraph that synthesizes the evidence from multiple sources.

RULES:
- Each paragraph should weave together facts from different pages/topics into a coherent narrative.
- Cite source URLs at the end of each paragraph: [1](url1), [2](url2), ...
- Do not add information not present in the provided evidence.
- Each paragraph should start with a bold theme title.

Output as markdown with themed sections.`;

const DRAFT_SECTION_SYSTEM = `You are a research report writer drafting a section of a comprehensive report.
Using the provided themed paragraphs, write a coherent section with the given title.

RULES:
- Include an introductory sentence that frames the section.
- Develop the theme paragraphs into flowing prose.
- End with a concluding insight or forward-looking statement.
- Preserve all source citations: [N](url) format.
- Do NOT add information not present in the provided evidence.
- Do NOT fabricate sources or citations.

Output as markdown prose.`;

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_MAX_TOKENS_COMPRESS = 1024;
// 3072 tokens lets mergePageSummaries preserve substantial detail from 3-page
// summaries (was 1536 — too restrictive, caused ~58% information loss when combined
// with the second truncation layer in _buildSynthesisPrompt).
const DEFAULT_MAX_TOKENS_MERGE = 3072;
const DEFAULT_MAX_TOKENS_CLUSTER = 2048;
const DEFAULT_MAX_TOKENS_DRAFT = 3072;
const MAX_PAGE_CHARS = 15000; // Truncate raw pages before compression

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Split text into sections at markdown heading boundaries (#, ##, ###, etc.).
 * Returns an array of { heading, content } objects. If no headings are found
 * (plain text or only paragraphs), returns a single section with empty heading.
 */
function _splitByMarkdownHeadings(text) {
    const sections = [];
    const lines = text.split('\n');
    let currentHeading = '';
    let currentContent = [];

    for (const line of lines) {
        // Match ATX headings: # through ###### followed by a space and text
        const headingMatch = line.match(/^#{1,6}\s+(.+)/);
        if (headingMatch) {
            // Flush previous section
            const body = currentContent.join('\n').trim();
            if (body.length > 0 || currentHeading) {
                sections.push({ heading: currentHeading, content: body });
            }
            currentHeading = headingMatch[0].trim();
            currentContent = [];
        } else {
            currentContent.push(line);
        }
    }

    // Flush final section
    const body = currentContent.join('\n').trim();
    if (body.length > 0 || currentHeading) {
        sections.push({ heading: currentHeading, content: body });
    }

    // If no headings were found at all, the single section has heading=''
    return sections;
}

/**
 * Truncate text to fit within maxChars by splitting at sentence boundaries.
 * Preserves the first N sentences and a tail of closing sentences for context.
 * Falls back to a simple head/tail character split if sentence detection fails.
 */
function _truncateToSentences(text, maxChars) {
    if (text.length <= maxChars) return text;

    // Split by sentence-ending punctuation followed by whitespace.
    // Uses a simple split (no lookbehind — GJS/SpiderMonkey 115 supports it,
    // but plain split+join is safer across versions).
    const rawParts = text.split(/(?<=[.!?])\s+/);
    // Fallback if regex split returns a single element (lookbehind unsupported)
    const sentences = rawParts.length > 1 ? rawParts : text.split(/\s+(?=[A-Z])/);

    if (sentences.length <= 1) {
        // Can't split into sentences — use simple head/tail
        const head = text.slice(0, Math.floor(maxChars * 0.8));
        const tail = text.slice(-Math.floor(maxChars * 0.2));
        return head + '\n\n[...content truncated...]\n\n' + tail;
    }

    const tailReserve = Math.floor(maxChars * 0.2);
    let result = '';

    // Take sentences from the beginning
    for (const sentence of sentences) {
        const candidate = result ? result + ' ' + sentence : sentence;
        if (candidate.length > maxChars - tailReserve) break;
        result = candidate;
    }

    // Append a tail from the end (last few sentences) if there's room
    if (tailReserve > 100 && sentences.length > 0) {
        let tail = '';
        for (let i = sentences.length - 1; i >= 0; i--) {
            const candidate = sentences[i] + (tail ? ' ' : '') + tail;
            if (candidate.length > tailReserve) break;
            tail = candidate;
        }
        if (tail && !result.includes(tail.trim())) {
            result += '\n\n[...middle content trimmed...]\n\n' + tail.trim();
        }
    }

    if (!result) {
        // Even one sentence didn't fit — hard truncate
        result = text.slice(0, maxChars - 3) + '...';
    }

    return result.trim();
}

/**
 * Truncate text for LLM prompt using structure-aware chunking.
 *
 * Strategy (inspired by page-level + semantic chunking):
 * 1. Split by markdown heading boundaries to respect document structure.
 * 2. Keep complete heading+content sections until the char budget is nearly full.
 * 3. For the final section, apply sentence-boundary truncation to avoid cutting
 *    mid-sentence (preserving semantic coherence).
 * 4. If no heading structure exists, fall back to sentence-boundary truncation
 *    with head+tail preservation.
 *
 * Page-level chunking (respecting heading boundaries) won NVIDIA's 2024
 * benchmarks with 0.648 accuracy.  Semantic (sentence-boundary) chunking
 * improves recall by up to 9%.
 */
function _truncateForPrompt(text, maxChars = MAX_PAGE_CHARS) {
    if (!text || typeof text !== 'string') return '';
    if (text.length <= maxChars) return text;

    // Step 1: Split by heading structure
    const sections = _splitByMarkdownHeadings(text);

    // If we have heading structure, keep complete sections
    if (sections.length > 1) {
        let result = '';
        for (let i = 0; i < sections.length; i++) {
            const section = sections[i];
            const sectionText = section.heading
                ? section.heading + '\n' + section.content
                : section.content;

            if (result.length + sectionText.length + 2 <= maxChars) {
                // Whole section fits
                result += (result ? '\n\n' : '') + sectionText;
            } else {
                // Section doesn't fit — try sentence-boundary truncation
                const remaining = maxChars - result.length;
                if (remaining > 300) {
                    const header = section.heading ? section.heading + '\n' : '';
                    const contentBudget = remaining - header.length;
                    const truncatedContent = _truncateToSentences(section.content, contentBudget);
                    if (truncatedContent) {
                        result += (result ? '\n\n' : '') + header + truncatedContent;
                    }
                }
                break;
            }
        }
        if (result) return result;
    }

    // Step 2: No heading structure — use sentence-boundary truncation
    return _truncateToSentences(text, maxChars);
}

function _safeParseJson(text) {
    try {
        // Extract JSON array from possible markdown wrapping
        const clean = String(text || '').trim();
        // Try direct parse first
        try { return JSON.parse(clean); } catch (_) { }
        // Try to find a JSON array in the response (non-greedy)
        const match = clean.match(/\[\s*\{[\s\S]*?\}\s*\]/);
        if (match) return JSON.parse(match[0]);
        return null;
    } catch (_e) {
        return null;
    }
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Compress a single raw page into 3-5 factual claims with citations.
 *
 * @param {Object} options
 * @param {string} options.rawText - The raw page text or markdown
 * @param {string} options.sourceUrl - The URL the content came from
 * @param {Function} options.llmCall - async (messages, opts) => string (the LLM completion function)
 * @param {Object} [options.cancellable] - Gio.Cancellable
 * @returns {Promise<Array<{claim: string, url: string}>>}
 */
export async function compressPage({ rawText, sourceUrl, llmCall, cancellable = null } = {}) {
    if (!rawText || !sourceUrl || !llmCall) return [];

    const truncated = _truncateForPrompt(rawText, MAX_PAGE_CHARS);
    if (!truncated) return [];

    const messages = [
        { role: 'system', content: COMPRESS_PAGE_SYSTEM },
        { role: 'user', content: `SOURCE URL: ${sourceUrl}\n\nPAGE CONTENT:\n${truncated}` },
    ];

    try {
        const response = await llmCall(messages, { cancellable, maxTokens: DEFAULT_MAX_TOKENS_COMPRESS });
        const parsed = _safeParseJson(response);
        if (Array.isArray(parsed) && parsed.length > 0) {
            return parsed.map(item => ({
                claim: String(item.claim || '').trim(),
                url: String(item.url || sourceUrl).trim(),
            })).filter(item => item.claim.length > 0);
        }
        // Fallback: treat response as a bullet list
        const bullets = String(response || '')
            .split('\n')
            .filter(line => line.trim().startsWith('-') || line.trim().startsWith('*'))
            .map(line => line.replace(/^[-*]\s*/, '').trim())
            .filter(Boolean);
        if (bullets.length > 0) {
            return bullets.slice(0, 5).map(claim => ({ claim, url: sourceUrl }));
        }
        return [];
    } catch (_e) {
        return [];
    }
}

/**
 * Merge multiple page summaries into a single deduplicated summary.
 *
 * @param {Object} options
 * @param {Array<string>} options.summaries - Array of bullet-point strings from compressPage results formatted as text
 * @param {string} options.topic - The sub-topic these pages are about
 * @param {Function} options.llmCall - async (messages, opts) => string
 * @param {Object} [options.cancellable] - Gio.Cancellable
 * @returns {Promise<string>} Merged markdown bullet list
 */
export async function mergePageSummaries({ summaries, topic, llmCall, cancellable = null } = {}) {
    if (!summaries || summaries.length === 0 || !llmCall) return '';

    // If only one summary, return it directly
    if (summaries.length === 1) return summaries[0];

    const combined = summaries.map((s, i) => `--- Page ${i + 1} ---\n${s}`).join('\n\n');
    // Truncate if excessively long
    const truncated = combined.length > 24000 ? combined.slice(0, 24000) + '\n\n[...additional pages trimmed...]' : combined;

    const messages = [
        { role: 'system', content: MERGE_PAGE_SYSTEM },
        { role: 'user', content: `TOPIC: ${topic}\n\nPAGE SUMMARIES:\n${truncated}` },
    ];

    try {
        const response = await llmCall(messages, { cancellable, maxTokens: DEFAULT_MAX_TOKENS_MERGE });
        return String(response || '').trim();
    } catch (_e) {
        // Fallback: simple concatenation
        return summaries.join('\n\n');
    }
}

/**
 * Cluster topic summaries into themed paragraphs.
 *
 * @param {Object} options
 * @param {Array<{topic: string, findings: string}>} options.topicSummaries - Array of {topic, findings} from mergePageSummaries
 * @param {Function} options.llmCall - async (messages, opts) => string
 * @param {Object} [options.cancellable] - Gio.Cancellable
 * @returns {Promise<string>} Themed markdown paragraphs
 */
export async function clusterThemes({ topicSummaries, llmCall, cancellable = null } = {}) {
    if (!topicSummaries || topicSummaries.length === 0 || !llmCall) return '';

    const combined = topicSummaries.map(ts =>
        `### ${ts.topic}\n${ts.findings}`
    ).join('\n\n---\n\n');

    const truncated = combined.length > 32000 ? combined.slice(0, 32000) + '\n\n[...additional topics trimmed...]' : combined;

    const messages = [
        { role: 'system', content: CLUSTER_THEMES_SYSTEM },
        { role: 'user', content: `TOPIC SUMMARIES:\n${truncated}` },
    ];

    try {
        const response = await llmCall(messages, { cancellable, maxTokens: DEFAULT_MAX_TOKENS_CLUSTER });
        return String(response || '').trim();
    } catch (_e) {
        return combined;
    }
}

/**
 * Build a coherent section draft from themed paragraphs.
 *
 * @param {Object} options
 * @param {string} options.themedParagraphs - The themed markdown from clusterThemes
 * @param {string} options.sectionTitle - The section title
 * @param {Function} options.llmCall - async (messages, opts) => string
 * @param {Object} [options.cancellable] - Gio.Cancellable
 * @returns {Promise<string>} Section prose in markdown
 */
export async function buildSectionDraft({ themedParagraphs, sectionTitle, llmCall, cancellable = null } = {}) {
    if (!themedParagraphs || !sectionTitle || !llmCall) return themedParagraphs || '';

    const truncated = themedParagraphs.length > 24000
        ? themedParagraphs.slice(0, 24000) + '\n\n[...content trimmed...]'
        : themedParagraphs;

    const messages = [
        { role: 'system', content: DRAFT_SECTION_SYSTEM },
        { role: 'user', content: `SECTION TITLE: ${sectionTitle}\n\nTHEMED PARAGRAPHS:\n${truncated}` },
    ];

    try {
        const response = await llmCall(messages, { cancellable, maxTokens: DEFAULT_MAX_TOKENS_DRAFT });
        return String(response || '').trim();
    } catch (_e) {
        return themedParagraphs;
    }
}

/**
 * Full hierarchical compression pipeline for a single research branch.
 * Takes raw crawled pages → compressed facts → merged summary.
 *
 * @param {Object} options
 * @param {Array<{url: string, text: string}>} options.pages - Array of {url, text} from crawl results
 * @param {string} options.topic - The sub-topic / sub-question this branch addresses
 * @param {Function} options.llmCall - async (messages, opts) => string
 * @param {Object} [options.cancellable] - Gio.Cancellable
 * @returns {Promise<{findings: string, facts: Array<{claim: string, url: string}>, sources: string[]}>}
 */
export async function compressResearchBranch({ pages, topic, llmCall, cancellable = null } = {}) {
    if (!pages || pages.length === 0 || !llmCall) {
        return { findings: '', facts: [], sources: [] };
    }

    // Level 1: Compress each page
    const allFacts = [];
    const pageSummaries = [];
    const sources = new Set();

    for (const page of pages) {
        const facts = await compressPage({
            rawText: page.text,
            sourceUrl: page.url,
            llmCall,
            cancellable,
        });
        if (facts.length > 0) {
            allFacts.push(...facts);
            const summaryText = facts.map(f => `- ${f.claim} [source](${f.url})`).join('\n');
            pageSummaries.push(summaryText);
            sources.add(page.url);
        }
    }

    if (allFacts.length === 0) {
        return { findings: '', facts: [], sources: [] };
    }

    // Level 2: Merge page summaries
    const findings = await mergePageSummaries({
        summaries: pageSummaries,
        topic,
        llmCall,
        cancellable,
    });

    return {
        findings,
        facts: allFacts,
        sources: Array.from(sources),
    };
}
