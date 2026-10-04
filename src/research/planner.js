// planner.js — Research planner agent + plan revision (stateful orchestration).
//
// Extracted from extension.js: the planner retry loops, the plan-snapshot
// serialization, and the format-nudge handling. All dialog/runtime coupling is
// injected through a small host bag so the module stays free of UI, settings,
// and Gio imports:
//
//   host = {
//     requestCompletion(messages, { cancellable, maxTokens, modelOverride }),
//     modelOverride,            // model override for the planner role
//     getCancellable(),         // called per attempt (dialog re-arms it)
//     isCancelled(error),       // true when a thrown error is a user cancel
//   }
import {
    DEEP_RESEARCH_PLANNER_SYSTEM_PROMPT,
    DEEP_RESEARCH_PLANNER_REVISION_SYSTEM_PROMPT,
    parsePlannerResponse,
} from './prompts.js';

// How many attempts the planner makes before giving up on generating a plan.
// DeepSeek occasionally returns prose or a malformed payload instead of the
// required JSON array; retrying once (with a format nudge) makes the planning
// phase resilient instead of silently falling straight into tool use/answering.
export const PLANNER_MAX_ATTEMPTS = 2;

/**
 * Serialize only a plan's content fields — strips the live UI refs
 * (status, _progressRow, _planTaskLabel) so the JSON payload stays clean.
 *
 * @param {Array} currentPlan
 * @returns {Array<{sub_task: string, search_query: string, hypothesis?: string, evidence_needed?: string}>}
 */
export function buildPlanSnapshot(currentPlan) {
    return (currentPlan || []).map((task) => ({
        sub_task: task.sub_task,
        search_query: task.search_query,
        ...(task.hypothesis ? { hypothesis: task.hypothesis } : {}),
        ...(task.evidence_needed ? { evidence_needed: task.evidence_needed } : {}),
    }));
}

/**
 * Generate a research plan from the user's query.
 * Calls a non-streaming LLM completion with the planner system prompt.
 *
 * @param {object} host see module header
 * @param {string} query - The user's research query
 * @returns {Promise<Array<{sub_task: string, search_query: string}>|null>}
 */
export async function runPlannerAgent(host, query) {
    const {
        requestCompletion,
        modelOverride = undefined,
        getCancellable = () => null,
        isCancelled = () => false,
    } = host;

    const baseMessages = [
        { role: 'system', content: DEEP_RESEARCH_PLANNER_SYSTEM_PROMPT },
        { role: 'user', content: `Research query: ${query}` },
    ];

    // Retry on unparseable output.  A single transient malformed model
    // response shouldn't silently discard the planning phase and fall
    // straight into tool use / direct answering.
    for (let attempt = 1; attempt <= PLANNER_MAX_ATTEMPTS; attempt++) {
        const messages = [...baseMessages];
        if (attempt > 1) {
            messages.push({
                role: 'user',
                content:
                    'The previous response was not a valid JSON array. Return ONLY the plan as a JSON array in the specified format, with no other text.',
            });
        }
        try {
            const response = await requestCompletion(messages, {
                cancellable: getCancellable(),
                maxTokens: 1024,
                modelOverride,
            });
            const plan = parsePlannerResponse(response);
            if (plan && plan.length > 0) {
                return plan;
            }
            // Log a truncated sample of the raw response for diagnosis.
            log(
                `[Katab:planner] Planner returned unparseable response (attempt ${attempt}/${PLANNER_MAX_ATTEMPTS}): ${String(response || '').slice(0, 300)}`,
            );
        } catch (e) {
            if (isCancelled(e)) throw e;
            log(
                `[Katab:planner] Planner agent failed (attempt ${attempt}/${PLANNER_MAX_ATTEMPTS}): ${e.message}`,
            );
        }
    }
    return null;
}

/**
 * Revise an existing research plan based on user feedback.
 *
 * Unlike runPlannerAgent, this sends the ORIGINAL query, the CURRENT plan,
 * and the user's change request to the revision planner so the model edits
 * the plan in place rather than treating the feedback as a brand-new query.
 *
 * @param {object} host see module header
 * @param {string} originalQuery - The user's original research query
 * @param {Array} currentPlan - The currently pending plan (with status fields)
 * @param {string} feedback - The user's requested changes
 * @returns {Promise<Array|null>}
 */
export async function reviseResearchPlan(host, originalQuery, currentPlan, feedback) {
    const {
        requestCompletion,
        modelOverride = undefined,
        getCancellable = () => null,
        isCancelled = () => false,
    } = host;

    const planSnapshot = buildPlanSnapshot(currentPlan);

    const baseMessages = [
        { role: 'system', content: DEEP_RESEARCH_PLANNER_REVISION_SYSTEM_PROMPT },
        {
            role: 'user',
            content:
                `Original research query:\n${originalQuery}\n\n` +
                `Current plan (JSON array):\n${JSON.stringify(planSnapshot, null, 2)}\n\n` +
                `User's requested changes to the plan:\n${feedback}\n\n` +
                'Return the UPDATED full plan as a JSON array in the same format.',
        },
    ];

    // Retry once on unparseable output so a transient malformed response
    // doesn't force the user to repeat their change request.
    for (let attempt = 1; attempt <= PLANNER_MAX_ATTEMPTS; attempt++) {
        const messages = [...baseMessages];
        if (attempt > 1) {
            messages.push({
                role: 'user',
                content:
                    'The previous response was not a valid JSON array. Return ONLY the updated plan as a JSON array in the specified format, with no other text.',
            });
        }
        try {
            const response = await requestCompletion(messages, {
                cancellable: getCancellable(),
                maxTokens: 1024,
                modelOverride,
            });
            const plan = parsePlannerResponse(response);
            if (plan && plan.length > 0) {
                return plan;
            }
            log(
                `[Katab:planner] Plan revision returned unparseable response (attempt ${attempt}/${PLANNER_MAX_ATTEMPTS}): ${String(response || '').slice(0, 300)}`,
            );
        } catch (e) {
            if (isCancelled(e)) throw e;
            log(
                `[Katab:planner] Plan revision failed (attempt ${attempt}/${PLANNER_MAX_ATTEMPTS}): ${e.message}`,
            );
        }
    }
    return null;
}
