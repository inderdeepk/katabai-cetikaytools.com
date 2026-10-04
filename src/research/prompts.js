// prompts.js — Prompt text and pure prompt builders for the research pipeline.
//
// Extracted from extension.js: the research/synthesis/tool-healing system
// instructions, the planner + gap-analysis + outline prompts, and the pure
// helpers that parse/bodge model responses for those phases. Nothing here
// touches dialog state or the network — callers pass everything in.

// Injected into the system prompt for every provider when Deep Research mode
// is explicitly On: tells the model to actually use tools for multi-step
// research rather than answering from training data.  (The mode itself only
// raises iteration limits — the model needs this prompt to know it *should*
// do research.)
export const DEEP_RESEARCH_SYSTEM_INSTRUCTION =
    'Deep Research mode is active. Conduct thorough multi-step research: use web_search to find relevant information, then read_url and crawl_url to extract details from promising pages. When a result is a documentation site (e.g. docs.example.org), use explore_docs on its landing page to get the table of contents, then crawl_url the specific pages most relevant to the question — do not crawl unrelated pages. Gather information from multiple independent sources before synthesizing a comprehensive answer. Cross-reference findings and note any conflicting information. Do not answer from your training data alone — use the tools to find current, specific information. After completing each research angle, briefly summarize what was found before moving to the next angle. Keep findings structured and concise — use clear section headings in your output.';

// ── Planner Agent ────────────────────────────────────────────────────────────
// Deep research starts with an explicit planning phase where the LLM breaks
// the user's query into 3-5 sub-questions, each with a specific
// search-engine-optimized query.  The plan is shown to the user for approval
// before any searching begins.
export const DEEP_RESEARCH_PLANNER_SYSTEM_PROMPT =
    'You are a research planner. Your task is to break a complex research query into ' +
    '3-5 focused research angles, each with a specific search query designed to find ' +
    'the most relevant information. These angles will be tracked as a checklist — keep ' +
    'each sub_task label concise (max 8 words) so the progress tracker stays readable.\n\n' +
    'RULES:\n' +
    '- Each angle should target a distinct aspect of the main query.\n' +
    '- search_query is an INTENT-EXPANSION, not a rephrasing: think "what keywords would ' +
    'appear on a high-quality page that answers this angle?" and list those keywords ' +
    '(avoid natural-language questions).\n' +
    '- Include version numbers, years, or qualifiers (e.g., "2025", "latest", "report", "PDF") ' +
    'in search queries where appropriate.\n' +
    '- If the query involves comparison, create one angle per compared entity.\n' +
    '- If the query is about a specific concept, include definition/overview + applications + ' +
    'recent developments as angles.\n' +
    '- For each angle include:\n' +
    '    "hypothesis": what you expect to find for this angle (one short sentence),\n' +
    '    "evidence_needed": what kind of evidence would satisfy this angle (one short sentence).\n' +
    '- Order the angles by information dependency: put angles that other angles build on FIRST ' +
    '(definitions/overviews before applications/comparisons).\n' +
    '- Sub_task labels should be short and scannable — like checklist items, not full sentences.\n' +
    '- Return ONLY a JSON array. No other text.\n\n' +
    'Output format:\n' +
    '[{"sub_task": "Concise label (max 8 words)", "search_query": "optimized keywords", ' +
    '"hypothesis": "...", "evidence_needed": "..."}, ...]';

// Revision variant of the planner prompt — used when the user sends a
// follow-up message while a research plan is pending approval.  The feedback
// should EDIT the existing plan in place (fix dates, versions, scope, angles),
// not be mistaken for a brand-new research query that replaces the plan.
export const DEEP_RESEARCH_PLANNER_REVISION_SYSTEM_PROMPT =
    'You are a research planner revising an existing research plan based on the ' +
    "user's feedback. You are given the user's ORIGINAL research query, the CURRENT " +
    "plan, and the user's requested changes. Apply ONLY the requested changes — fix " +
    'dates, versions, names, scope, or angle coverage — and preserve everything else ' +
    'that is still accurate and relevant. Do NOT treat the feedback as a brand-new ' +
    'research query and do NOT regenerate the plan from scratch.\n\n' +
    'RULES:\n' +
    '- Keep the SAME 3-5 angle structure unless the feedback explicitly asks to add, ' +
    'remove, or merge angles.\n' +
    "- Carry the user's factual corrections (e.g. the current year, the exact software " +
    'version) into the affected sub_tasks and search queries.\n' +
    '- Keep each sub_task label concise (max 8 words).\n' +
    '- search_query stays an INTENT-EXPANSION (keywords that would appear on a ' +
    'high-quality page, not natural-language questions).\n' +
    '- Preserve the hypothesis/evidence_needed fields from the current plan where the ' +
    'angle is unchanged.\n' +
    '- Return ONLY a JSON array in the same format as the current plan. No other text.\n\n' +
    'Output format:\n' +
    '[{"sub_task": "Concise label (max 8 words)", "search_query": "optimized keywords", ' +
    '"hypothesis": "...", "evidence_needed": "..."}, ...]';

// ── Iterative loop prompts ───────────────────────────────────────────────────
// After the initial branch research, a gap analysis phase reviews all findings
// against the user's original question and generates 0-2 targeted follow-up
// searches.  A causal-chain check verifies multi-hop coverage.  Both feed the
// refinement phase and the two-pass synthesis.
export const CAUSAL_CHAIN_SYSTEM_PROMPT =
    'You are verifying multi-hop research coverage. The final answer to the main ' +
    'question depends on intermediate concepts. List 0-3 SUB-CLAIMS or intermediate ' +
    'concepts that the final answer depends on but that are NOT adequately sourced ' +
    'by the research findings.\n\n' +
    'Output a JSON array of follow-up queries, each:\n' +
    '  "rationale": the unsourced sub-claim the final answer depends on\n' +
    '  "search_query": optimized search-engine query to source it\n\n' +
    'Return an empty array [] if every dependency is adequately covered.';
export const GAP_ANALYSIS_SYSTEM_PROMPT =
    "You are a research director reviewing initial findings against the user's " +
    'original question. Your job is to identify gaps — what critical aspects remain ' +
    'uncovered, what contradictions need resolution, what would add the most value.\n\n' +
    'Output a JSON array of 0-2 follow-up search queries. Each object must have:\n' +
    '  "rationale": Why this search fills a critical gap\n' +
    '  "search_query": Optimized search-engine query (keywords, not a question)\n\n' +
    'Return an empty array [] ONLY if coverage is already excellent across ALL ' +
    'aspects of the question. Be honest — unnecessary searches waste time.\n\n' +
    'Example output:\n' +
    '[{"rationale": "No findings on context management strategies despite user asking about them", ' +
    '"search_query": "LLM context window management chunking strategies 2025"}, ...]';
export const SYNTHESIS_OUTLINE_SYSTEM_PROMPT =
    "You are a research report architect. Given the user's original question and " +
    'all research findings, generate a structured outline for a comprehensive report.\n\n' +
    'The outline should have 4-6 sections, each with:\n' +
    '  - Section title (concrete, not generic)\n' +
    '  - 1-2 key claims that section will make (with source citation numbers)\n' +
    '  - Which research findings support this section\n\n' +
    "CRITICAL: Structure the outline around what best answers the USER'S QUESTION — " +
    'not around the research angles. The angles are just context providers.\n\n' +
    'Output as a JSON object:\n' +
    '{"sections": [{"title": "...", "key_claims": ["... [N]", ...], "based_on": ["topic name", ...]}, ...]}';
export const SYNTHESIS_OUTLINE_CRITIQUE_PROMPT =
    'You are a research report architect refining an outline. Below is a draft ' +
    'outline and the research findings it must cover.\n\n' +
    'Critique the draft against the findings:\n' +
    '1. Which sections are unsupported (no finding backs them)? Drop or rewrite them.\n' +
    '2. Which important findings have no section? Add sections for them.\n' +
    "3. Is the structure optimal for answering the user's question? Reorder if needed.\n\n" +
    'Return an IMPROVED outline with the exact same JSON shape:\n' +
    '{"sections": [{"title": "...", "key_claims": ["... [N]", ...], "based_on": ["topic name", ...]}, ...]}\n\n' +
    'Make targeted changes only — do not churn sections that are already well supported.';

// ── Mid-research self-critique ───────────────────────────────────────────────
// After every N branches, the system pauses to evaluate accumulated findings
// against the original question.  If coverage gaps are detected, remaining
// search angles can be adjusted before execution continues.
export const MID_RESEARCH_CRITIQUE_SYSTEM_PROMPT =
    'You are a research director re-planning mid-research. Below are findings from ' +
    'completed angles and the remaining planned angles. Your job:\n\n' +
    '1. sufficiency_score (1-5): how well completed findings already answer the main question.\n' +
    '2. Decide what to do with each REMAINING angle (indexes start at 0):\n' +
    '   - adjustments: keep the angle but improve its query: {"index": N, "new_query": "...", "rationale": "..."}\n' +
    '   - drop_indices: angles now redundant or low-value given what was found.\n' +
    '   - new_branches: NEW angles spawned from discovered sub-topics or gaps:\n' +
    '     [{"sub_task": "...", "search_query": "..."}] (keep to 0-2, focused).\n' +
    '3. contradictions: any conflicting claims across sources.\n\n' +
    'Output JSON:\n' +
    '{"sufficiency_score": 3, "sufficient": false, "contradictions": [], ' +
    '"adjustments": [], "drop_indices": [], "new_branches": []}\n\n' +
    'Set sufficient:true ONLY if findings already fully answer the question.\n' +
    'Use index to reference remaining angles (0 = first remaining angle).';

// Injected into the system prompt when synthesis is forced (tools removed).
// This is the ONLY reliable way to stop DeepSeek V4 Pro from emitting raw
// tool-call XML — a system-level instruction carries more weight than a
// user message, which the thinking model routinely ignores.
export const FORCE_SYNTHESIS_SYSTEM_INSTRUCTION =
    '\n\n[SYSTEM DIRECTIVE — HIGHEST PRIORITY — OVERRIDE ALL PREVIOUS BEHAVIOR] ' +
    'Your research phase is COMPLETE. All tool-calling is now FORBIDDEN — you have ' +
    'no access to web_search, read_url, crawl_url, or any other tool. Any attempt ' +
    'to emit tool-call syntax will fail silently.\n\n' +
    'Your ONLY task now is to write a comprehensive, well-structured synthesis of ' +
    'everything you learned from the tool results in the conversation above. ' +
    'Go back to what the user was originally asking for. Write a report that ' +
    'answers their specific question — do not just summarize your research steps. ' +
    'Structure your report around what best answers the user:\n\n' +
    "1. EXECUTIVE SUMMARY — 2-3 sentences answering the user's core question.\n" +
    '2. DETAILED ANALYSIS — Substantive sections organized around the concepts, ' +
    'mechanisms, or comparisons the user asked about. Explain, compare, and ' +
    'synthesize — do NOT structure this as a tour of your search queries.\n' +
    '3. KEY TECHNICAL DETAILS — Architecture patterns, data flows, specific ' +
    "techniques, benchmarks, or code patterns relevant to the user's question.\n" +
    '4. SOURCES & REFERENCES — List URLs you drew from with brief notes on what each contributed.\n' +
    '5. RECOMMENDATIONS — Actionable suggestions grounded in the research.\n\n' +
    'CRITICAL RULES:\n' +
    '- Write ONLY natural-language prose. No XML, JSON, function-call, or tool-call syntax.\n' +
    '- Do NOT suggest additional searches, do NOT list search queries, do NOT ask to search again.\n' +
    '- Cite specific URLs from the tool results above. Use the exact URLs you were given.\n' +
    '- Synthesize across ALL the information you gathered — do not write a section per search.\n' +
    '- Be thorough — this is a DEEP research report, not a surface-level summary.';

// Injected as the system instruction when synthesis is forced for a REGULAR
// (non-deep-research) conversation.  The full FORCE_SYNTHESIS_SYSTEM_INSTRUCTION
// prescribes a 5-section research report that confuses models (especially Flash)
// on simple queries, producing 200-char near-empty responses.  This lighter
// instruction just tells the model to answer the question directly.
export const REGULAR_SYNTHESIS_SYSTEM_INSTRUCTION =
    '\n\n[SYSTEM DIRECTIVE — HIGHEST PRIORITY — OVERRIDE ALL PREVIOUS BEHAVIOR] ' +
    'Tool-calling is now FORBIDDEN. You have no access to web_search, read_url, ' +
    'crawl_url, or any other tool.\n\n' +
    "Answer the user's question directly and thoroughly based on the information " +
    'you gathered from the tool results above. Be substantive — explain what you ' +
    'found, cite specific sources, and give actionable guidance. Do NOT structure ' +
    'this as a formal research report or list of search queries. Just answer the ' +
    'question in a natural, helpful way.\n\n' +
    'CRITICAL RULES:\n' +
    '- Write ONLY natural-language prose. No XML, JSON, function-call, or tool-call syntax.\n' +
    '- Do NOT suggest additional searches, do NOT list search queries.\n' +
    '- Cite specific URLs from the tool results when relevant.';

// Injected as the system instruction when synthesis is forced but ALL search
// engines are down AND no useful results were gathered.  Without real findings
// to synthesise, the research-oriented FORCE_SYNTHESIS_SYSTEM_INSTRUCTION
// produces garbled keyword-echo garbage.  This lighter instruction tells the
// model to answer from its training knowledge instead.
export const NO_RESULTS_SYNTHESIS_SYSTEM_INSTRUCTION =
    '\n\n[SYSTEM DIRECTIVE — HIGHEST PRIORITY — OVERRIDE ALL PREVIOUS BEHAVIOR] ' +
    'Web search was attempted but ALL search engines are currently unavailable ' +
    '(rate-limited, CAPTCHA-blocked, or IP-restricted). You have NO search results ' +
    'to work with — do not pretend otherwise.\n\n' +
    "Answer the user's question based on your existing training knowledge. " +
    'Be direct, honest, and substantive. If your knowledge on this topic is ' +
    'limited or dated, say so plainly. Do NOT suggest running additional searches. ' +
    'Do NOT emit tool-call syntax of any kind.\n\n' +
    'CRITICAL RULES:\n' +
    '- Write ONLY natural-language prose. No XML, JSON, function-call, or tool-call syntax.\n' +
    '- Answer the question directly — do NOT describe what you "would have searched for."\n' +
    '- Be honest about knowledge gaps; do not fabricate search results.';

// ── Self-healing retry loop ───────────────────────────────────────────────────
// When a local model emits malformed tool-call syntax (broken XML/JSON), we
// strip the malformed markup, inject a correction prompt, and retry on the
// SAME turn — without consuming a tool iteration.
export const TOOL_CALL_HEALING_INSTRUCTION =
    '\n\n[SYSTEM NOTE: Your previous tool-call syntax was malformed. ' +
    'Use this exact format to call tools:\n' +
    '<tool_call>{"name":"tool_name","arguments":{...}}</tool_call>\n' +
    'Please retry your tool call now.]';

// ── Post-synthesis quality check ─────────────────────────────────────────────
// The quality gate scores the report on TWO independent axes and, when coverage
// is insufficient, auto-iterates the research loop (extended test-time compute)
// by targeting the missing aspects with new research — up to the retry budget.
export const RESEARCH_QUALITY_CHECK_SYSTEM_PROMPT =
    'You are a research quality evaluator. Rate how well the report below ' +
    "answers the user's original question on TWO independent axes (1-5 each):\n\n" +
    '  coverage_score: Did the report cover ALL critical aspects of the question?\n' +
    '                  List concrete missing_aspects — angles, subtopics, or data\n' +
    '                  points the question implies that the report did not address.\n' +
    "  groundedness_score: Do the report's claims trace to the provided research\n" +
    '                  facts, or does it fabricate or overreach beyond the evidence?\n\n' +
    'Also flag:\n' +
    '  unsupported_claims: report claims NOT supported by any provided research fact\n' +
    '                  (quote each briefly).\n' +
    '  unverified_citations: any [N] citation that does not actually support the\n' +
    '                  sentence it is attached to (list the [N] marker).\n\n' +
    'Output JSON: {"coverage_score": 4, "groundedness_score": 5, ' +
    '"missing_aspects": ["aspect 1"], "unsupported_claims": ["claim text"], ' +
    '"unverified_citations": ["[3]"]}\n' +
    '1=misses the question entirely, 3=partially answers, 5=fully answers.\n' +
    'Use empty arrays when nothing is flagged.';

// ── Pure response parsers / builders ─────────────────────────────────────────

/**
 * Parse a planner (or gap-analysis) model response into plan entries.
 * Accepts: direct JSON array, JSON in a fenced code block, an embedded JSON
 * array, or a numbered "1. Topic → query" list (2+ entries). Returns null when
 * nothing usable is found.
 */
export function parsePlannerResponse(text) {
    if (!text || typeof text !== 'string') return null;

    const clean = text.trim();

    const mapItem = (item) => ({
        sub_task: String(item.sub_task || item.subTask || item.topic || '').trim(),
        search_query: String(item.search_query || item.searchQuery || '').trim(),
        rationale: String(item.rationale || item.reason || '').trim(),
        hypothesis: String(item.hypothesis || '').trim(),
        evidence_needed: String(item.evidence_needed || item.evidenceNeeded || '').trim(),
    });

    // Try direct JSON parse
    try {
        const parsed = JSON.parse(clean);
        if (Array.isArray(parsed) && parsed.length > 0) {
            return parsed.map(mapItem).filter((item) => item.search_query);
        }
    } catch (_) {
        /* not pure JSON */
    }

    // Try to find JSON array inside markdown code blocks
    const jsonBlock = clean.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (jsonBlock) {
        try {
            const parsed = JSON.parse(jsonBlock[1].trim());
            if (Array.isArray(parsed) && parsed.length > 0) {
                return parsed.map(mapItem).filter((item) => item.search_query);
            }
        } catch (_) {
            /* not valid JSON in code block */
        }
    }

    // Try to find a JSON array anywhere in the response (non-greedy)
    const arrayMatch = clean.match(/\[\s*\{[\s\S]*?\}\s*\]/);
    if (arrayMatch) {
        try {
            const parsed = JSON.parse(arrayMatch[0]);
            if (Array.isArray(parsed) && parsed.length > 0) {
                return parsed.map(mapItem).filter((item) => item.search_query);
            }
        } catch (_) {
            /* not valid JSON */
        }
    }

    // Fallback: parse numbered list format
    // 1. Topic → search query
    const lines = clean.split('\n');
    const plan = [];
    const numPattern = /^\d+[.)]\s+(.+?)\s*(?:→|->|:)\s*(.+)$/;
    for (const line of lines) {
        const match = line.match(numPattern);
        if (match) {
            plan.push({
                sub_task: match[1].trim(),
                search_query: match[2].trim(),
            });
        }
    }
    if (plan.length >= 2) return plan;

    return null;
}

/**
 * Build a structured prompt from the research plan that instructs the model
 * to search for each sub-task's query.
 *
 * NOTE: unreferenced since the iterative-loop planner replaced the old
 * one-shot fallback (July 2026) — kept intentionally for potential reuse.
 *
 * @param {Array} plan
 * @returns {string}
 */
export function buildResearchPlanPrompt(plan) {
    let prompt =
        '[RESEARCH PLAN — Execute these research steps in order using web_search, read_url, and crawl_url tools. ' +
        'Search for each angle below, gather relevant pages, and synthesize findings into a comprehensive report.]\n\n';

    for (let i = 0; i < plan.length; i++) {
        const task = plan[i];
        prompt += `${i + 1}. ${task.sub_task}\n   Search: "${task.search_query}"\n`;
    }

    prompt +=
        '\nFor each angle, web_search the specified query, then use read_url or crawl_url on the most promising results. ' +
        'Gather information from multiple sources per angle before moving to the next. ' +
        'Cross-reference findings and note any conflicting information.\n\n' +
        'After completing all angles, synthesize a comprehensive research report with sections, citations, and a bibliography.';

    return prompt;
}

/**
 * Heuristic detection of "synthesis regurgitation": a model echoing search
 * queries / tool fragments instead of writing prose, seen only with DeepSeek
 * under context pressure.  Fires when ≥ 3 of 8 signals match.
 *
 * Signals of regurgitation (≥ 3 triggers detection):
 *   1. Response is very short (<400 chars) after extensive tool use
 *   2. Content consists mostly of search-query-like lines
 *      (what/how/why... + technical terms, no paragraph structure)
 *   3. Response starts with a number/bullet followed by a query fragment
 *   4. No citations, URLs, or source references
 *   5. No paragraph/sentence structure (sentences < 3)
 *   6. Echoes search query keywords (Gemini, deep research, architecture, etc.)
 *   7. Contains raw tool-call XML fragments (truncated <invoke>, <tool_call>, etc.)
 *   8. Very low lexical diversity (< 30 unique words in < 500 chars)
 */
export function isSynthesisRegurgitation(content, provider) {
    if (!content || typeof content !== 'string') return false;
    if (provider !== 'deepseek') return false; // Only DeepSeek exhibits this pattern

    let signals = 0;
    const trimmed = content.trim();

    // Signal 1: Very short response after tool use — a synthesis should be
    // at least 400 chars given the context.  Under 200 chars is almost
    // certainly regurgitation.
    if (trimmed.length < 400) signals++;
    if (trimmed.length < 200) signals++;

    // Signal 2: Content dominated by search-query-like lines.
    // Search queries look like: "keyword phrase about topic" with no
    // sentence structure.  Check ratio of query-like lines to total lines.
    const lines = trimmed.split('\n').filter((l) => l.trim());
    if (lines.length > 0) {
        let queryLikeLines = 0;
        for (const line of lines) {
            const lt = line.trim().toLowerCase();
            // Search query indicators: starts with a number, or looks like
            // a keyword phrase (no verbs, no sentence structure)
            if (/^\d+\s/.test(lt)) queryLikeLines++;
            else if (/^(what|how|why|who|when|where)\b/i.test(lt) && !/[.!?]$/.test(lt))
                queryLikeLines++;
            else if (
                lt.length < 80 &&
                !/[.!?]/.test(lt) &&
                !/\b(is|are|was|were|has|have|can|could|should|would|will|may|might|must)\b/i.test(
                    lt,
                )
            )
                queryLikeLines++;
        }
        if (queryLikeLines >= lines.length * 0.5) signals++;
        if (queryLikeLines >= lines.length * 0.75) signals++;
    }

    // Signal 3: No paragraph structure — content is one block or fragmented
    // lines without double-newline separators.
    const paragraphs = trimmed.split(/\n\n+/).filter((p) => p.trim());
    const sentences = (trimmed.match(/[.!?]\s/g) || []).length;
    if (paragraphs.length < 2 && sentences < 3) signals++;

    // Signal 4: No citations or URLs.  A synthesis from web research MUST
    // reference sources.  If there are zero URLs, it's likely regurgitation.
    if (!/https?:\/\//i.test(trimmed)) signals++;

    // Signal 5: Content starts with a number (like "10\nGemini deep research...")
    // which is the model hallucinating search result rankings.
    if (/^\d+\s*\n/i.test(trimmed)) signals++;
    if (/^\d+\s+\w/i.test(trimmed)) signals++;

    // Signal 6: Echoes search query keywords — the model is regurgitating
    // fragments of its own search queries rather than synthesizing.
    // Common patterns from Gemini/deep research queries.
    const queryEchoPatterns = [
        /\bGemini\s+deep\s+research\b/i,
        /\bdeep\s+research\s+(?:agent|architecture|system|tool)\b/i,
        /\bcontext\s+(?:management|window|compression)\b/i,
        /\b(?:RAG|million\s+token)\b/i,
        /\b(?:crawl4ai|searxng|SearXNG)\b/i,
        /\b(?:reinforcement\s+learning|RL\s+training)\b/i,
    ];
    let echoMatches = 0;
    for (const pat of queryEchoPatterns) {
        if (pat.test(trimmed)) echoMatches++;
    }
    if (echoMatches >= 3) signals++;
    if (echoMatches >= 5) signals++;

    // Signal 7: Contains raw tool-call XML fragments — truncated <invoke>,
    // <tool_call>, <parameter> tags that survived stripping.
    if (/<\s*(?:invoke|tool_call|function_calls|parameter)\b/i.test(trimmed)) signals++;

    // Signal 8: Very low lexical diversity — for short responses, unique
    // word count is a strong signal of regurgitation vs. real synthesis.
    const words = new Set(
        trimmed
            .toLowerCase()
            .split(/\s+/)
            .filter((w) => w.length > 2),
    );
    if (trimmed.length < 500 && words.size < 30) signals++;
    if (trimmed.length < 300 && words.size < 20) signals++;

    const detected = signals >= 3;
    if (detected) {
        log(
            `[Katab:synth-gate] Regurgitation detected: ${signals} signal(s) — len=${trimmed.length} paras=${paragraphs.length} sents=${sentences} urls=${/https?:\/\//i.test(trimmed)} echoMatches=${echoMatches} uniqueWords=${words.size}`,
        );
    }
    return detected;
}
