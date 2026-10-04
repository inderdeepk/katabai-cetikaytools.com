// pipeline.js — Research pipeline analysis phases (LLM calls + parsing).
//
// Extracted from extension.js: gap analysis, the mid-research re-planning
// critique, the causal-chain dependency check, and the synthesis-outline
// critique/refinement pass. These are the "analysis" phases between branch
// research and refinement/synthesis.
//
// Host bag (see KatabDialog._pipelineHost):
//   {
//     requestCompletion(messages, { cancellable, maxTokens, modelOverride }),
//     modelOverride,     // model override for the synthesis/analysis role
//     getCancellable(),  // read per LLM call
//     isCancelled(error) // true when a thrown error is a user cancel
//   }
// runGapAnalysis additionally needs:
//   gapAnalysisMaxQueries  — effective cap from the depth config
//   qualityRetryMaxQueries — follow-up cap used during quality retries
import {
    CAUSAL_CHAIN_SYSTEM_PROMPT,
    GAP_ANALYSIS_SYSTEM_PROMPT,
    MID_RESEARCH_CRITIQUE_SYSTEM_PROMPT,
    RESEARCH_QUALITY_CHECK_SYSTEM_PROMPT,
    SYNTHESIS_OUTLINE_SYSTEM_PROMPT,
    SYNTHESIS_OUTLINE_CRITIQUE_PROMPT,
    parsePlannerResponse,
} from './prompts.js';

export const GAP_ANALYSIS_MAX_TOKENS = 512;
export const CAUSAL_CHAIN_MAX_TOKENS = 512;
export const CAUSAL_CHAIN_MAX_QUERIES = 3;
export const MID_RESEARCH_CRITIQUE_MAX_TOKENS = 640;
export const SYNTHESIS_OUTLINE_MAX_TOKENS = 1024;
export const SYNTHESIS_OUTLINE_CRITIQUE_MAX_TOKENS = 512;
export const RESEARCH_QUALITY_CHECK_MAX_TOKENS = 640;

/**
 * Gap analysis: review initial findings against the user's question and
 * generate 0-2 (depth-scaled) follow-up queries. Returns the capped queries
 * plus the rationale string for synthesis context ('' when none).
 *
 * @param {object} host see module header
 * @param {Array} branchResults
 * @param {string} originalQuery
 * @param {Array<string>|null} missingAspects - gaps reported by a failed quality check
 * @returns {Promise<{queries: Array, rationale: string}>}
 */
export async function runGapAnalysis(host, branchResults, originalQuery, missingAspects = null) {
    const {
        requestCompletion,
        modelOverride = undefined,
        getCancellable = () => null,
        isCancelled = () => false,
        gapAnalysisMaxQueries = 2,
        qualityRetryMaxQueries = 2,
    } = host;

    if (!branchResults || branchResults.length === 0) return { queries: [], rationale: '' };

    log('[Katab:research] Starting gap analysis phase...');

    // Build a compact summary of all branch findings
    const summaries = branchResults
        .filter((r) => r.findings && r.findings.length > 50)
        .map((r) => {
            const snippet =
                r.findings.length > 400
                    ? r.findings.slice(0, 400).replace(/\n/g, ' ') + '...'
                    : r.findings.replace(/\n/g, ' ');
            return `- ${r.topic}: ${snippet}`;
        })
        .join('\n');

    if (!summaries) {
        log('[Katab:research] Gap analysis skipped — no usable findings to analyze.');
        return { queries: [], rationale: '' };
    }

    // When the caller supplies missingAspects (from a failed quality check),
    // target the follow-up queries specifically at those gaps instead of
    // doing an open-ended coverage sweep.
    let userContent = `Original question: "${originalQuery}"\n\nResearch findings so far:\n${summaries}\n\n`;
    if (missingAspects && missingAspects.length > 0) {
        userContent +=
            'The previous report was rated low because these aspects were missing or poorly covered:\n';
        for (const aspect of missingAspects) {
            userContent += `- ${aspect}\n`;
        }
        userContent +=
            `\nGenerate follow-up search queries that specifically target these missing aspects ` +
            `(up to ${qualityRetryMaxQueries} queries). Output a JSON array.\n`;
    } else {
        userContent +=
            'What critical gaps remain? Output 0-2 follow-up search queries as a JSON array.\n';
    }

    const messages = [
        { role: 'system', content: GAP_ANALYSIS_SYSTEM_PROMPT },
        { role: 'user', content: userContent },
    ];

    try {
        const response = await requestCompletion(messages, {
            cancellable: getCancellable(),
            maxTokens: GAP_ANALYSIS_MAX_TOKENS,
            modelOverride,
        });

        const queries = parsePlannerResponse(response); // Reuse planner JSON parser
        if (queries && queries.length > 0) {
            const cap =
                missingAspects && missingAspects.length > 0
                    ? Math.max(gapAnalysisMaxQueries, qualityRetryMaxQueries)
                    : gapAnalysisMaxQueries;
            const capped = queries.slice(0, cap);
            log(
                `[Katab:research] Gap analysis found ${capped.length} follow-up queries: ${capped.map((q) => q.search_query).join(', ')}`,
            );
            // Rationale for synthesis context
            const rationale = capped.map((q) => `${q.rationale} → "${q.search_query}"`).join('; ');
            return { queries: capped, rationale };
        }

        log(
            '[Katab:research] Gap analysis complete — coverage is sufficient, no follow-up needed.',
        );
        return { queries: [], rationale: '' };
    } catch (e) {
        if (isCancelled(e)) throw e;
        log(`[Katab:research] Gap analysis failed: ${e.message}`);
        return { queries: [], rationale: '' };
    }
}

/**
 * Re-plan mid-research: evaluate completed findings against the original
 * question and decide how to handle the REMAINING plan. Unlike the old
 * critique (which only adjusted queries), this can keep/adjust, DROP
 * redundant angles, and SPAWN new angles from discovered sub-topics —
 * mirroring Google's "iterate" step and WebWeaver's iterative refinement.
 *
 * @param {object} host see module header
 * @param {Array} completedResults - Results from branches already run
 * @param {Array} remainingPlan - Plan items still to execute
 * @param {string} originalQuery
 * @returns {Promise<{sufficient: boolean, contradictions: Array,
 *   adjustments: Array, drop_indices: Array, new_branches: Array}>}
 */
export async function runRePlanningCritique(host, completedResults, remainingPlan, originalQuery) {
    const {
        requestCompletion,
        modelOverride = undefined,
        getCancellable = () => null,
        isCancelled = () => false,
    } = host;

    const empty = {
        sufficient: false,
        contradictions: [],
        adjustments: [],
        drop_indices: [],
        new_branches: [],
    };
    if (!completedResults || completedResults.length === 0) return empty;
    if (!remainingPlan || remainingPlan.length === 0) return { ...empty, sufficient: true };

    log(
        `[Katab:critique] Mid-research re-plan — ${completedResults.length} completed, ${remainingPlan.length} remaining.`,
    );

    // Compact summary of completed findings
    const completedSummary = completedResults
        .filter((r) => r.findings && r.findings.length > 50)
        .map((r) => {
            const s =
                r.findings.length > 300
                    ? r.findings.slice(0, 300).replace(/\n/g, ' ') + '...'
                    : r.findings.replace(/\n/g, ' ');
            return `- ${r.topic}: ${s}`;
        })
        .join('\n');

    const remainingList = remainingPlan
        .map(
            (t, i) =>
                `${i}. ${t.sub_task} (query: "${t.search_query}")${t.evidence_needed ? ` — evidence needed: ${t.evidence_needed}` : ''}`,
        )
        .join('\n');

    const messages = [
        { role: 'system', content: MID_RESEARCH_CRITIQUE_SYSTEM_PROMPT },
        {
            role: 'user',
            content: `MAIN QUESTION: "${originalQuery}"\n\nCOMPLETED FINDINGS:\n${completedSummary}\n\nREMAINING ANGLES:\n${remainingList}\n\nEvaluate and output JSON.`,
        },
    ];

    try {
        const response = await requestCompletion(messages, {
            cancellable: getCancellable(),
            maxTokens: MID_RESEARCH_CRITIQUE_MAX_TOKENS,
            modelOverride,
        });

        // Parse JSON response
        const clean = String(response || '').trim();
        let parsed;
        try {
            parsed = JSON.parse(clean);
        } catch (_) {
            // Try to extract JSON from markdown wrapping
            const jsonMatch = clean.match(/\{[\s\S]*\}/);
            if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
        }

        if (parsed) {
            const sufficient = !!parsed.sufficient;
            log(
                `[Katab:critique] Sufficient: ${sufficient}, adjustments: ${(parsed.adjustments || []).length}, drops: ${(parsed.drop_indices || []).length}, spawns: ${(parsed.new_branches || []).length}`,
            );
            return {
                sufficient,
                contradictions: parsed.contradictions || [],
                adjustments: parsed.adjustments || [],
                drop_indices: (parsed.drop_indices || []).filter((i) => Number.isInteger(i)),
                new_branches: (parsed.new_branches || []).filter((nb) => nb && nb.search_query),
            };
        }

        log('[Katab:critique] Failed to parse re-plan response — continuing.');
        return empty;
    } catch (e) {
        if (isCancelled(e)) throw e;
        log(`[Katab:critique] Mid-research re-plan failed: ${e.message}`);
        return empty;
    }
}

/**
 * Causal-chain dependency check. After gap analysis, verify that every
 * intermediate concept the final answer depends on has a source. Returns
 * additional targeted follow-up queries for any unsourced sub-claims.
 *
 * @param {object} host see module header
 * @param {Array} allFindings - Combined branch findings so far
 * @param {string} originalQuery
 * @returns {Promise<Array<{rationale: string, search_query: string}>>}
 */
export async function runCausalChainCheck(host, allFindings, originalQuery) {
    const {
        requestCompletion,
        modelOverride = undefined,
        getCancellable = () => null,
        isCancelled = () => false,
    } = host;

    if (!allFindings || allFindings.length === 0) return [];

    log('[Katab:research] Running causal-chain dependency check...');

    const summaries = allFindings
        .filter((r) => r.findings && r.findings.length > 50)
        .map((r) => {
            const s =
                r.findings.length > 400
                    ? r.findings.slice(0, 400).replace(/\n/g, ' ') + '...'
                    : r.findings.replace(/\n/g, ' ');
            return `- ${r.topic}: ${s}`;
        })
        .join('\n');

    if (!summaries) return [];

    const messages = [
        { role: 'system', content: CAUSAL_CHAIN_SYSTEM_PROMPT },
        {
            role: 'user',
            content: `MAIN QUESTION: "${originalQuery}"\n\nRESEARCH FINDINGS:\n${summaries}\n\nOutput a JSON array of follow-up queries.`,
        },
    ];

    try {
        const response = await requestCompletion(messages, {
            cancellable: getCancellable(),
            maxTokens: CAUSAL_CHAIN_MAX_TOKENS,
            modelOverride,
        });
        const queries = parsePlannerResponse(response);
        if (queries && queries.length > 0) {
            const capped = queries.slice(0, CAUSAL_CHAIN_MAX_QUERIES);
            log(
                `[Katab:research] Causal-chain check found ${capped.length} unsourced dependency queries: ${capped.map((q) => q.search_query).join(', ')}`,
            );
            return capped;
        }
        return [];
    } catch (e) {
        if (isCancelled(e)) throw e;
        log(`[Katab:research] Causal-chain check failed: ${e.message}`);
        return [];
    }
}

/**
 * Pass 1 of synthesis: generate a structured report outline from all findings.
 * Returns the parsed `{ sections: [...] }` object, or null when there is
 * nothing to outline or the response cannot be parsed.
 *
 * @param {object} host see module header
 * @param {Array} allFindings - Combined branch + refinement findings
 * @param {string} originalQuery
 * @returns {Promise<{sections: Array}|null>}
 */
export async function buildSynthesisOutline(host, allFindings, originalQuery) {
    const {
        requestCompletion,
        modelOverride = undefined,
        getCancellable = () => null,
        isCancelled = () => false,
    } = host;

    if (!allFindings || allFindings.length === 0) return null;

    log('[Katab:synthesis] Pass 1: Generating report outline...');

    // Compact summaries for the outline prompt
    const findingSummaries = allFindings
        .filter((r) => r.findings && r.findings.length > 50)
        .map((r) => {
            const snippet =
                r.findings.length > 500
                    ? r.findings.slice(0, 500).replace(/\n/g, ' ') + '...'
                    : r.findings.replace(/\n/g, ' ');
            return `Topic "${r.topic}": ${snippet}\nSources: ${(r.sources || []).join(', ') || 'none'}`;
        })
        .join('\n\n');

    if (!findingSummaries) {
        log('[Katab:synthesis] Outline skipped — no findings to synthesize.');
        return null;
    }

    const messages = [
        { role: 'system', content: SYNTHESIS_OUTLINE_SYSTEM_PROMPT },
        {
            role: 'user',
            content: `USER'S QUESTION: "${originalQuery}"\n\nALL RESEARCH FINDINGS:\n${findingSummaries}\n\nGenerate a structured outline for the final report. Output as JSON.`,
        },
    ];

    try {
        const response = await requestCompletion(messages, {
            cancellable: getCancellable(),
            maxTokens: SYNTHESIS_OUTLINE_MAX_TOKENS,
            modelOverride,
        });

        // Parse the JSON outline
        const clean = String(response || '').trim();
        // Try direct parse
        try {
            const parsed = JSON.parse(clean);
            if (parsed.sections && Array.isArray(parsed.sections)) {
                log(`[Katab:synthesis] Outline generated — ${parsed.sections.length} sections.`);
                return parsed;
            }
        } catch (_) {
            /* not pure JSON */
        }

        // Try to find JSON object in the response
        const jsonMatch = clean.match(/\{[\s\S]*"sections"[\s\S]*\}/);
        if (jsonMatch) {
            try {
                const parsed = JSON.parse(jsonMatch[0]);
                if (parsed.sections && Array.isArray(parsed.sections)) {
                    log(
                        `[Katab:synthesis] Outline extracted — ${parsed.sections.length} sections.`,
                    );
                    return parsed;
                }
            } catch (_) {
                /* invalid */
            }
        }

        log('[Katab:synthesis] Outline parsing failed — proceeding without outline.');
        return null;
    } catch (e) {
        if (isCancelled(e)) throw e;
        log(`[Katab:synthesis] Outline generation failed: ${e.message}`);
        return null;
    }
}

/**
 * Post-synthesis quality gate: score the report on coverage + groundedness and
 * extract the flagged aspects/claims. Returns
 * `{ coverage, groundedness, missingAspects, unsupportedClaims, unverifiedCitations }`
 * or null when there is no usable score (or the call failed — errors are
 * swallowed and logged, matching the original fire-and-forget caller).
 *
 * @param {object} host see module header
 * @param {string} reportText - The final report text
 * @param {string} originalQuery - The user's research question
 * @param {Array<{claim: string, url?: string}>} facts - Research facts to ground against
 * @returns {Promise<object|null>}
 */
export async function runQualityCheck(host, reportText, originalQuery, facts = []) {
    const { requestCompletion, modelOverride = undefined, getCancellable = () => null } = host;

    // Build a capped fact list so the evaluator can ground claims against
    // the actual evidence gathered during research.
    const factsBlock =
        facts.length > 0
            ? '\n\nRESEARCH FACTS (ground the report against these):\n' +
              facts
                  .slice(0, 60)
                  .map((f) => `- ${f.claim.slice(0, 200)}${f.url ? ` [${f.url}]` : ''}`)
                  .join('\n')
            : '\n\nRESEARCH FACTS: (none provided)';

    const messages = [
        { role: 'system', content: RESEARCH_QUALITY_CHECK_SYSTEM_PROMPT },
        {
            role: 'user',
            content: `USER'S QUESTION: "${originalQuery}"\n\nREPORT:\n${reportText.slice(0, 6000)}${factsBlock}\n\nRate the report and output JSON.`,
        },
    ];

    try {
        const response = await requestCompletion(messages, {
            cancellable: getCancellable(),
            maxTokens: RESEARCH_QUALITY_CHECK_MAX_TOKENS,
            modelOverride,
        });

        const clean = String(response || '').trim();
        let parsed;
        try {
            parsed = JSON.parse(clean);
        } catch (_) {
            const jsonMatch = clean.match(/\{[\s\S]*\}/);
            if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
        }

        // Accept the new two-axis shape, and fall back to the legacy single
        // `score` field so older check prompts still work.
        const coverage =
            parsed &&
            (typeof parsed.coverage_score === 'number'
                ? parsed.coverage_score
                : typeof parsed.score === 'number'
                  ? parsed.score
                  : null);
        const groundedness =
            parsed && typeof parsed.groundedness_score === 'number'
                ? parsed.groundedness_score
                : null;
        const missingAspects =
            parsed && Array.isArray(parsed.missing_aspects) ? parsed.missing_aspects : [];
        const unsupportedClaims =
            parsed && Array.isArray(parsed.unsupported_claims)
                ? parsed.unsupported_claims.map(String).filter(Boolean)
                : [];
        const unverifiedCitations =
            parsed && Array.isArray(parsed.unverified_citations)
                ? parsed.unverified_citations.map(String).filter(Boolean)
                : [];

        // A totally unparseable response leaves `parsed` undefined and the
        // expression above short-circuits to undefined — treat that the same
        // as a parsed-but-unscored response (original only checked null, which
        // recorded a result with an undefined score and skipped the gate
        // silently).
        if (coverage === null || coverage === undefined) {
            log('[Katab:quality] No usable score parsed — skipping quality gate.');
            return null;
        }

        log(
            `[Katab:quality] coverage=${coverage}/5 groundedness=${groundedness ?? 'n/a'}/5 missing=${missingAspects.length} unsupported=${unsupportedClaims.length} badCites=${unverifiedCitations.length}`,
        );
        return { coverage, groundedness, missingAspects, unsupportedClaims, unverifiedCitations };
    } catch (e) {
        // Fire-and-forget caller — swallow and log (NO cancellation rethrow).
        log(`[Katab:quality] Quality check failed: ${e.message}`);
        return null;
    }
}

/**
 * Critique a draft outline against the research findings and return an
 * improved outline (same JSON shape). Returns null when the critique LLM call
 * fails or produces an unparseable outline, so the caller keeps the previous draft.
 *
 * @param {object} host see module header
 * @param {Object} outline - { sections: [{title, key_claims, based_on}] }
 * @param {Array} allFindings
 * @param {string} originalQuery
 * @returns {Promise<Object|null>}
 */
export async function critiqueAndRefineOutline(host, outline, allFindings, originalQuery) {
    const {
        requestCompletion,
        modelOverride = undefined,
        getCancellable = () => null,
        isCancelled = () => false,
    } = host;

    if (!outline || !allFindings) return null;

    // Compact serialized draft outline
    const outlineText = outline.sections
        .map(
            (s, i) =>
                `${i + 1}. ${s.title}\n   Key claims: ${(s.key_claims || []).join('; ') || '—'}\n   Based on: ${(s.based_on || []).join(', ') || '—'}`,
        )
        .join('\n');

    // Compact findings summary
    const findingSummaries = allFindings
        .filter((r) => r.findings && r.findings.length > 50)
        .map((r) => {
            const snippet =
                r.findings.length > 500
                    ? r.findings.slice(0, 500).replace(/\n/g, ' ') + '...'
                    : r.findings.replace(/\n/g, ' ');
            return `Topic "${r.topic}": ${snippet}`;
        })
        .join('\n\n');

    if (!findingSummaries) return null;

    const messages = [
        { role: 'system', content: SYNTHESIS_OUTLINE_CRITIQUE_PROMPT },
        {
            role: 'user',
            content: `USER'S QUESTION: "${originalQuery}"\n\nCURRENT OUTLINE:\n${outlineText}\n\nRESEARCH FINDINGS:\n${findingSummaries}\n\nReturn the improved outline as JSON.`,
        },
    ];

    try {
        const response = await requestCompletion(messages, {
            cancellable: getCancellable(),
            maxTokens: SYNTHESIS_OUTLINE_CRITIQUE_MAX_TOKENS,
            modelOverride,
        });
        const clean = String(response || '').trim();
        try {
            const parsed = JSON.parse(clean);
            if (parsed.sections && Array.isArray(parsed.sections) && parsed.sections.length > 0) {
                return parsed;
            }
        } catch (_) {
            /* not pure JSON */
        }
        const jsonMatch = clean.match(/\{[\s\S]*"sections"[\s\S]*\}/);
        if (jsonMatch) {
            try {
                const parsed = JSON.parse(jsonMatch[0]);
                if (
                    parsed.sections &&
                    Array.isArray(parsed.sections) &&
                    parsed.sections.length > 0
                ) {
                    return parsed;
                }
            } catch (_) {
                /* invalid */
            }
        }
        log('[Katab:outline] Critique parsing failed — keeping previous outline.');
        return null;
    } catch (e) {
        if (isCancelled(e)) throw e;
        log(`[Katab:outline] Outline critique failed: ${e.message}`);
        return null;
    }
}
