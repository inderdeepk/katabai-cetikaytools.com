// synthesisPrompt.js — Pure synthesis-prompt construction for the final
// research report (Pass 2), plus the helpers it depends on: contradiction
// detection, token estimation, and source recency/reliability hints.
//
// Extracted from extension.js. Everything is pure — the caller passes the
// research state it needs through the context object (see
// KatabDialog._buildSynthesisPrompt for the dialog-side assembly):
//
//   {
//     branchResults,            // all findings (branches + refinement)
//     citationTracker,          // may be null
//     originalQuery,            // user's question ('' = plan-less synthesis)
//     gapRationale,             // gap-analysis rationale string ('' = none)
//     synthesisOutline,         // { sections } from Pass 1 (may be null)
//     documentContext,          // attached-document context ('' = none)
//     contextBudgetChars,       // depth-scaled findings budget
//   }
import { buildCitationSummary } from './citationTracker.js';

// ── Source contradiction detection ───────────────────────────────────────────
// Heuristic clustering parameters — no embedding model available in GJS.
export const CONTRADICTION_TOPIC_SIMILARITY_THRESHOLD = 3; // min shared words for same topic
export const CONTRADICTION_NUMERIC_TOLERANCE = 0.15; // 15% difference flags a conflict

// ── Shared stopwords for relevance scoring and contradiction detection ───────
const COMMON_STOPWORDS = new Set([
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
    'when',
    'where',
    'which',
    'will',
    'would',
    'about',
    'there',
    'their',
    'been',
    'more',
    'some',
    'than',
    'then',
    'also',
    'into',
    'only',
    'other',
    'over',
    'such',
    'each',
    'very',
    'just',
    'after',
    'before',
    'between',
    'through',
    'its',
    'his',
    'these',
    'those',
    'them',
]);

/**
 * Heuristically detect contradictory claims across branch findings.
 * Clusters facts by shared topic keywords, then flags clusters where
 * numeric values or claims diverge beyond a tolerance threshold.
 *
 * No embedding model is available in GJS, so this uses keyword overlap
 * and numeric extraction.  The flagged contradictions are injected into
 * the synthesis prompt for the LLM to resolve.
 *
 * @param {Array} branchResults
 * @returns {Array<{topic: string, claims: Array}>}
 */
export function detectContradictions(branchResults) {
    const allFacts = [];
    for (const br of branchResults || []) {
        if (br.facts && br.facts.length > 0) {
            for (const f of br.facts) {
                if (f.claim && f.url) {
                    allFacts.push({ claim: String(f.claim).trim(), url: String(f.url).trim() });
                }
            }
        }
    }
    if (allFacts.length < 2) return [];

    // ── Extract significant words from each claim for clustering ────
    const tokenize = (text) => {
        return new Set(
            text
                .toLowerCase()
                .replace(/[^a-z0-9\s]/g, ' ')
                .split(/\s+/)
                .filter((w) => w.length > 2 && !COMMON_STOPWORDS.has(w)),
        );
    };

    // ── Cluster claims by topic similarity ──────────────────────────
    const clusters = [];
    const assigned = new Set();

    for (let i = 0; i < allFacts.length; i++) {
        if (assigned.has(i)) continue;
        const baseWords = tokenize(allFacts[i].claim);
        if (baseWords.size < 2) continue;

        const cluster = [allFacts[i]];
        assigned.add(i);

        for (let j = i + 1; j < allFacts.length; j++) {
            if (assigned.has(j)) continue;
            const otherWords = tokenize(allFacts[j].claim);
            let overlap = 0;
            for (const w of baseWords) {
                if (otherWords.has(w)) overlap++;
            }
            if (overlap >= CONTRADICTION_TOPIC_SIMILARITY_THRESHOLD) {
                cluster.push(allFacts[j]);
                assigned.add(j);
            }
        }
        if (cluster.length >= 2) clusters.push(cluster);
    }

    // ── Within each cluster, check for numeric divergence ───────────
    const contradictions = [];
    for (const cluster of clusters) {
        const numericClaims = [];
        for (const c of cluster) {
            const nums = c.claim.match(
                /\b\d+(?:\.\d+)?(?:\s*(?:%|million|billion|trillion|k|m|b|t))?\b/gi,
            );
            if (nums && nums.length > 0) {
                for (const n of nums) {
                    const val = parseFloat(n.replace(/[^\d.]/g, ''));
                    if (!isNaN(val) && val > 0) {
                        numericClaims.push({ ...c, numericValue: val, numericStr: n });
                    }
                }
            }
        }

        // Flag if two claims in same cluster have diverging numeric values
        for (let i = 0; i < numericClaims.length; i++) {
            for (let j = i + 1; j < numericClaims.length; j++) {
                const a = numericClaims[i];
                const b = numericClaims[j];
                if (a.url === b.url) continue; // Same source — not a contradiction

                const maxVal = Math.max(a.numericValue, b.numericValue);
                const minVal = Math.min(a.numericValue, b.numericValue);
                if (maxVal === 0) continue;
                const divergence = (maxVal - minVal) / maxVal;

                if (divergence > CONTRADICTION_NUMERIC_TOLERANCE) {
                    // Build a topic label from shared words
                    const sharedWords = [];
                    const aWords = tokenize(a.claim);
                    const bWords = tokenize(b.claim);
                    for (const w of aWords) {
                        if (bWords.has(w)) sharedWords.push(w);
                    }
                    const topic = sharedWords.slice(0, 5).join(' ') || 'conflicting claims';

                    contradictions.push({
                        topic,
                        claims: [a, b],
                    });
                }
            }
        }
    }

    if (contradictions.length > 0) {
        log(
            `[Katab:synthesis] Detected ${contradictions.length} potential contradictions across ${allFacts.length} facts.`,
        );
    }
    return contradictions;
}

/**
 * Estimate token count for a text string.  GJS cannot import tiktoken, so
 * we use the characters/4 heuristic (reasonable for English prose) with a
 * code/JSON multiplier of 2.5 chars/token.  If the tokenize endpoint probe
 * is available, it could provide more precise counts, but the heuristic
 * is sufficient for budget decisions.
 *
 * @param {string} text
 * @returns {number} estimated token count
 */
export function estimateTokens(text) {
    if (!text) return 0;
    const str = String(text);
    // Detect if text is mostly code/JSON (high ratio of punctuation/symbols)
    const codeLike = (str.match(/[{}[\];:]/g) || []).length / Math.max(str.length, 1);
    const charsPerToken = codeLike > 0.05 ? 2.5 : 4.0;
    return Math.ceil(str.length / charsPerToken);
}

/**
 * Heuristic recency hint for a source URL: extract a 4-digit year from the
 * URL path when present (news-style URLs carry dates), else returns ''.
 * @param {string} url
 * @returns {string} e.g. "2025" or ''
 */
export function sourceRecencyHint(url) {
    const m = String(url || '').match(/\b(19|20)\d{2}\b/);
    return m ? m[0] : '';
}

/**
 * Heuristic reliability tier for a source domain. Government/education/
 * established journals rank high; general news/company sites rank medium;
 * blogs, forums, and user-generated sites rank low.
 * @param {string} url
 * @returns {'high'|'medium'|'low'}
 */
export function sourceReliabilityHint(url) {
    try {
        const host = String(url || '')
            .replace(/^https?:\/\//i, '')
            .split('/')[0]
            .toLowerCase();
        if (
            /(\.gov|\.edu|\.mil)$/.test(host) ||
            host.includes('arxiv.') ||
            host.includes('acm.org') ||
            host.includes('ieee.') ||
            host.includes('nature.com') ||
            host.includes('science.org')
        ) {
            return 'high';
        }
        if (
            /(wikipedia|medium|wordpress|blogspot|reddit|quora|stackoverflow|github|substack|forum)/.test(
                host,
            )
        ) {
            return 'low';
        }
        return 'medium';
    } catch (_e) {
        return 'medium';
    }
}

/**
 * Build a synthesis prompt that grounds the final report in the USER'S
 * ORIGINAL QUESTION, not in the individual branch topics.  The branch
 * findings are presented as information/context sources — the model must
 * write a unified report that answers what the user actually asked for,
 * using the gathered data as supporting evidence.
 *
 * This is a conscious departure from the simpler "summarize each branch"
 * approach.  The five research angles exist only to gather smart, up-to-date
 * information.  The final report's structure should emerge from what best
 * answers the user's question, not from mirroring the research angles.
 *
 * @param {Object} context see module header
 * @returns {string}
 */
export function buildSynthesisPrompt(context) {
    const {
        branchResults,
        citationTracker = null,
        originalQuery = '',
        gapRationale = '',
        synthesisOutline = null,
        documentContext = '',
        contextBudgetChars = 80000,
    } = context;

    // ── Detect contradictory claims before synthesis ────────────────
    const contradictions = detectContradictions(branchResults);

    // Build global URL→number map from tracker for consistent citations
    const urlToNum = citationTracker?.urlToNumber || new Map();
    const formatSources = (urls) => {
        if (!urls || !urls.length) return '';
        return urls
            .map((u) => {
                const normalized = String(u).trim().replace(/\/+$/, '').toLowerCase();
                const num = urlToNum.get(normalized);
                return num ? `[${num}](${u})` : `[?](${u})`;
            })
            .join(', ');
    };

    // ── Build the synthesis prompt ──────────────────────────────────
    // The prompt is structured in three layers:
    // 1. THE USER'S QUESTION — the single thing the report must answer
    // 2. RESEARCH FINDINGS — raw context gathered from the branches
    // 3. CITATION MAP — global source numbers for consistent referencing

    let prompt = '';

    // ── Layer 1: The user's question (the NORTH STAR) ───────────────
    if (originalQuery) {
        prompt += `You have just completed an iterative deep research process to answer the following question:\n\n`;
        prompt += `USER'S QUESTION:\n"${originalQuery}"\n\n`;

        // Mention gap analysis if performed
        if (gapRationale) {
            prompt += `After initial research, a gap analysis identified and filled the following gaps: ${gapRationale}\n\n`;
        }

        prompt += `Your task is to write a comprehensive, well-structured research report that directly answers this question. The research findings below were gathered through multiple phases of research (initial angles followed by targeted refinement to fill gaps). Use them as your primary source material — but do NOT organize your report around the research angles. Instead, organize your report around what best answers the user's question.\n\n`;
        prompt += `IMPORTANT: Determine the best structure for your report based on the user's question. If the question is about "how something works," organize around architecture/mechanisms/pipeline. If it's a comparison, organize around the compared entities and their trade-offs. If it asks "what makes a good X," organize around principles, criteria, and examples. Let the question dictate the structure — the research angles were just tools to gather information.\n\n`;
    } else {
        prompt +=
            '[SYNTHESIS TASK — Write a comprehensive research report based on the findings below.]\n\n';
    }

    // ── Layer 1.5: Outline scaffold (from Pass 1 synthesis) ─────────
    if (synthesisOutline && synthesisOutline.sections && synthesisOutline.sections.length > 0) {
        prompt += '─── SUGGESTED OUTLINE (use as a scaffold — adapt as needed) ───\n\n';
        for (let i = 0; i < synthesisOutline.sections.length; i++) {
            const section = synthesisOutline.sections[i];
            prompt += `${i + 1}. ${section.title}\n`;
            if (section.key_claims && section.key_claims.length > 0) {
                for (const claim of section.key_claims.slice(0, 2)) {
                    prompt += `   - ${claim}\n`;
                }
            }
            prompt += '\n';
        }
        prompt += '─── END OUTLINE ───\n\n';
    }

    // ── Layer 2: Research findings (CONTEXT, not structure) ─────────
    prompt += '─── RESEARCH FINDINGS (context only — use as evidence) ───\n\n';

    // Inject attached document context if available — the user attached
    // document(s) that should inform the research report.
    if (documentContext) {
        const docContextPreview =
            documentContext.length > 6000
                ? documentContext.slice(0, 6000) +
                  '\n[...document truncated for synthesis — full content available in conversation history...]'
                : documentContext;
        prompt += '─── ATTACHED DOCUMENT CONTEXT ───\n\n';
        prompt +=
            'The user attached the following document(s) as additional source material. Reference them alongside the web research findings below:\n\n';
        prompt += docContextPreview + '\n\n';
        prompt += '─── WEB RESEARCH FINDINGS ───\n\n';
    }

    // Adaptive truncation: compute total findings size and only truncate
    // if it exceeds the budget.  The compression pipeline already does
    // deduplication and summarization — preserve as much as possible.
    // The budget is depth-aware (Phase 5 scales it with the depth knob).
    const FINDINGS_BUDGET_CHARS = contextBudgetChars;
    const validResults = branchResults.filter((r) => r.findings && r.findings.length > 100);

    // Compute total chars including both merged summaries and raw facts
    let totalRawChars = 0;
    for (const result of validResults) {
        totalRawChars += result.findings.length;
        if (result.facts && result.facts.length > 0) {
            totalRawChars += result.facts.reduce((sum, f) => sum + (f.claim?.length || 0) + 60, 0);
        }
    }
    const needsTruncation = totalRawChars > FINDINGS_BUDGET_CHARS;

    // ── Relevance ranking: counter "Lost in the Middle" by sorting
    // branches so the most query-relevant findings appear first.
    // Uses keyword-overlap scoring (no embedding model — GJS-compatible).
    if (originalQuery && validResults.length > 1) {
        const _scoreRelevance = (result) => {
            // Tokenize the query into lowercase words, skip stopwords
            const queryTokens = new Set(
                originalQuery
                    .toLowerCase()
                    .replace(/[^a-z0-9\s]/g, ' ')
                    .split(/\s+/)
                    .filter((w) => w.length > 2 && !COMMON_STOPWORDS.has(w)),
            );
            if (queryTokens.size === 0) return 0;

            // Count how many query tokens appear in the findings text
            const findingsLower = (result.findings || '').toLowerCase();
            let score = 0;
            for (const token of queryTokens) {
                // Count occurrences (weighted — multiple matches = stronger signal)
                const matches = findingsLower.split(token).length - 1;
                score += matches;
            }
            return score;
        };

        validResults.sort((a, b) => _scoreRelevance(b) - _scoreRelevance(a));

        // Relevance-sandwich: re-interleave so the most relevant branches sit
        // at the beginning AND end of the context (where LLM attention is
        // strongest), with the least relevant in the middle. Directly
        // counteracts the "Lost in the Middle" effect.
        const n = validResults.length;
        const sandwich = new Array(n);
        let low = 0;
        let high = n - 1;
        let i = 0;
        while (low <= high) {
            sandwich[low] = validResults[i++];
            low++;
            if (low > high) break;
            sandwich[high] = validResults[i++];
            high--;
        }
        validResults.length = 0;
        validResults.push(...sandwich);
        log(`[Katab:synthesis] Relevance-sandwich ordered ${n} branches for query.`);
    }

    // Per-branch rendering helper
    const renderBranch = (result, maxChars = Infinity) => {
        let text = '';
        // Merged narrative summary (primary)
        const summaryChars = Math.min(result.findings.length, Math.floor(maxChars * 0.6));
        const condensedSummary =
            result.findings.length > summaryChars
                ? result.findings.slice(0, summaryChars) + '\n[...summary trimmed...]'
                : result.findings;
        text += `${condensedSummary}\n`;

        // Granular facts (complementary data points the merge may have generalized)
        if (result.facts && result.facts.length > 0) {
            const remainingBudget = maxChars - summaryChars;
            text += '\n**Key data points:**\n';
            let factChars = 0;
            let included = 0;
            for (const fact of result.facts) {
                const line = `- ${fact.claim} [source](${fact.url})\n`;
                if (factChars + line.length > remainingBudget && included >= 3) break;
                text += line;
                factChars += line.length;
                included++;
            }
            if (included < result.facts.length) {
                text += `- [+${result.facts.length - included} more facts available]\n`;
            }
        }
        return text;
    };

    if (needsTruncation) {
        const scale = FINDINGS_BUDGET_CHARS / totalRawChars;
        for (const result of validResults) {
            const budget = Math.max(
                2000,
                Math.floor((result.findings.length + (result.facts?.length || 0) * 100) * scale),
            );
            const srcLabel = formatSources(result.sources);
            prompt += `### Research Context: ${result.topic}\n${renderBranch(result, budget)}`;
            if (srcLabel) prompt += `Sources: ${srcLabel}\n`;
            prompt += '\n---\n\n';
        }
        log(
            `[Katab:synthesis] Context budget exceeded — scaled ${totalRawChars} → ~${FINDINGS_BUDGET_CHARS} chars across ${validResults.length} branches.`,
        );
    } else {
        for (const result of validResults) {
            const srcLabel = formatSources(result.sources);
            prompt += `### Research Context: ${result.topic}\n${renderBranch(result, 20000)}`;
            if (srcLabel) prompt += `Sources: ${srcLabel}\n`;
            prompt += '\n---\n\n';
        }
    }

    // Log context stats for debugging — include token estimate
    const factCount = validResults.reduce((sum, r) => sum + (r.facts?.length || 0), 0);
    const estimatedTokens = estimateTokens(prompt);
    log(
        `[Katab:synthesis] Feeding ~${estimatedTokens} tokens (${totalRawChars} chars, ${validResults.length} branches, ${factCount} facts, ${needsTruncation ? 'truncated' : 'full'}) into synthesis prompt.`,
    );

    // ── Layer 3: Citation map ───────────────────────────────────────
    if (citationTracker && citationTracker.entries.length > 0) {
        prompt += buildCitationSummary(citationTracker) + '\n\n';
    }

    // ── Contradictions to resolve (if any) ──────────────────────────
    if (contradictions.length > 0) {
        prompt += '─── CONTRADICTIONS TO RESOLVE ───\n\n';
        prompt += 'The following conflicting claims were detected across sources. You MUST:\n';
        prompt += '- Address each conflict explicitly in your report.\n';
        prompt +=
            '- Present BOTH figures/positions with their source attributions — do not silently pick one.\n';
        prompt +=
            '- Note which source is most recent (by publication year) and most reliable (by domain authority).\n';
        prompt +=
            '- If one source is clearly more recent AND reliable, say why and prioritise it; otherwise present both with their uncertainty.\n\n';
        for (const c of contradictions.slice(0, 5)) {
            prompt += `**Topic**: ${c.topic}\n`;
            for (const claim of c.claims.slice(0, 3)) {
                const recency = sourceRecencyHint(claim.url);
                const reliability = sourceReliabilityHint(claim.url);
                prompt += `- "${claim.claim}" [source](${claim.url})${recency ? ` (published ${recency})` : ''} (reliability: ${reliability})\n`;
            }
            prompt += '\n';
        }
        prompt += '─── END CONTRADICTIONS ───\n\n';
    }

    // ── Report guidelines ───────────────────────────────────────────
    prompt += '─── REPORT GUIDELINES ───\n\n';
    prompt += 'Your report should include:\n';
    prompt +=
        "1. EXECUTIVE SUMMARY — A concise answer to the user's question, capturing the most important findings (2-3 sentences).\n";
    prompt +=
        "2. DETAILED ANALYSIS — Substantive sections organized in whatever way best answers the user's question. Explain concepts, compare approaches, highlight insights. This is NOT a tour of the research angles — it is a coherent answer to the user's question, supported by the research.\n";
    prompt +=
        '3. KEY TECHNICAL DETAILS — Architecture patterns, data flows, specific techniques, benchmarks, or code patterns relevant to the question.\n';
    prompt +=
        '4. SOURCES & REFERENCES — List each source with its [N] number and a brief note on what it contributed.\n';
    prompt += '5. RECOMMENDATIONS — Actionable, specific suggestions grounded in the research.\n\n';
    // NOTE: an inline-SVG charts option was removed — the chat surface is a
    // Pango text renderer and cannot display SVG, so enabling it only
    // produced raw <svg> markup in the report text.
    prompt += 'CRITICAL RULES:\n';
    prompt += '- Write ONLY natural-language prose. No XML, JSON, or tool-call syntax.\n';
    prompt += '- Cite sources using [N] notation matching the citation numbers above.\n';
    prompt += '- Use ONLY the research findings above as your factual basis — do not fabricate.\n';
    prompt += '- Be thorough — this is a DEEP research report, not a surface-level summary.\n';
    prompt +=
        '- Do NOT structure your report as "Angle 1... Angle 2... Angle 3..." — the research angles were tools, not an outline. Synthesize across them.';

    return prompt;
}
