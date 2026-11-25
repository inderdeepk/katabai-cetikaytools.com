// ── Interactive Prompts & Guided Walkthrough Tools ────────────────────────────
// Pure ES module (no St/Clutter/Gtk imports) so the parser, argument normalizer,
// result formatter, and system instructions are unit-testable with `gjs -m`.

export const ASK_USER_TOOL_NAME = 'ask_user';
export const ASK_USER_TOOL_COMMAND = '/guide';
export const ASK_USER_TOOL_ICON = 'dialog-question-symbolic';

export const ASK_USER_DEFAULT_ENABLED = true;
export const ASK_USER_DEFAULT_MAX_PER_TURN = 3;
export const ASK_USER_MIN_MAX_PER_TURN = 1;
export const ASK_USER_MAX_MAX_PER_TURN = 10;
export const ASK_USER_MAX_QUESTIONS = 6;
export const ASK_USER_MAX_OPTIONS = 10;
export const ASK_USER_CUSTOM_TEXT_MAX_CHARS = 2000;

/**
 * Read Interactive Prompts settings from GSettings with safe fallbacks.
 * @param {Object|null} settings
 * @returns {{ enabled: boolean, maxPerTurn: number }}
 */
export function readAskUserConfig(settings) {
    const getBool = (key, fallback) => {
        try {
            const val = settings.get_boolean(key);
            return typeof val === 'boolean' ? val : fallback;
        } catch (_e) {
            return fallback;
        }
    };
    const getInt = (key, fallback) => {
        try {
            const val = Number(settings.get_int(key));
            return Number.isFinite(val) ? val : fallback;
        } catch (_e) {
            return fallback;
        }
    };

    const rawMax = Math.floor(getInt('ask-user-max-per-turn', ASK_USER_DEFAULT_MAX_PER_TURN));
    const maxPerTurn = Math.max(
        ASK_USER_MIN_MAX_PER_TURN,
        Math.min(ASK_USER_MAX_MAX_PER_TURN, rawMax || ASK_USER_DEFAULT_MAX_PER_TURN),
    );

    return {
        enabled: getBool('ask-user-enabled', ASK_USER_DEFAULT_ENABLED),
        maxPerTurn,
    };
}

/**
 * Parse a user prompt for the `/guide` command (standalone, prefix, or suffix).
 * Case-insensitive on `/guide`. Returns `{ isCommand: true, prompt }` or `null`.
 *
 * @param {string} promptText
 * @returns {{ isCommand: boolean, prompt: string } | null}
 */
export function parseGuideCommand(promptText) {
    const text = String(promptText ?? '').trim();
    if (!text) {
        return null;
    }

    if (/^\/guide$/i.test(text)) {
        return { isCommand: true, prompt: '' };
    }
    if (/^\/guide\s+/i.test(text)) {
        return { isCommand: true, prompt: text.replace(/^\/guide\s+/i, '').trim() };
    }
    if (/\s+\/guide$/i.test(text)) {
        return { isCommand: true, prompt: text.replace(/\s+\/guide$/i, '').trim() };
    }
    return null;
}

/**
 * Normalize an option entry (string or `{ label, text, value, title }`) into a
 * clean trimmed string, or empty string if invalid.
 * @param {unknown} opt
 * @returns {string}
 */
function extractOptionText(opt) {
    if (typeof opt === 'string') {
        return opt.trim();
    }
    if (opt && typeof opt === 'object' && !Array.isArray(opt)) {
        const candidate = opt.label ?? opt.text ?? opt.value ?? opt.title ?? '';
        return typeof candidate === 'string' ? candidate.trim() : String(candidate || '').trim();
    }
    if (typeof opt === 'number' || typeof opt === 'boolean') {
        return String(opt);
    }
    return '';
}

/**
 * Normalize raw `ask_user` tool arguments into a validated canonical shape.
 * Accepts common LLM shorthand variations (top-level `question`/`prompt`,
 * string array `questions`, snake_case and camelCase flags, object options).
 *
 * @param {unknown} rawArgs
 * @returns {{ ok: boolean, title?: string, questions?: Array<{ id: string, question: string, options: string[], multiSelect: boolean, allowCustom: boolean, placeholder: string }>, error?: string }}
 */
export function normalizeAskUserArgs(rawArgs) {
    if (!rawArgs || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) {
        return {
            ok: false,
            error: 'ask_user requires a JSON object with a "questions" array.',
        };
    }

    const title = typeof rawArgs.title === 'string' ? rawArgs.title.trim() : '';

    let rawQuestions = Array.isArray(rawArgs.questions) ? rawArgs.questions : [];
    if (rawQuestions.length === 0) {
        const singleQ =
            typeof rawArgs.question === 'string'
                ? rawArgs.question.trim()
                : typeof rawArgs.prompt === 'string'
                  ? rawArgs.prompt.trim()
                  : '';
        if (singleQ) {
            rawQuestions = [
                {
                    id: rawArgs.id,
                    question: singleQ,
                    options: rawArgs.options,
                    multiSelect: rawArgs.multiSelect,
                    multi_select: rawArgs.multi_select,
                    allowCustom: rawArgs.allowCustom,
                    allow_custom: rawArgs.allow_custom,
                    placeholder: rawArgs.placeholder,
                },
            ];
        }
    }

    const seenIds = new Set();
    const normalizedQuestions = [];

    for (
        let i = 0;
        i < rawQuestions.length && normalizedQuestions.length < ASK_USER_MAX_QUESTIONS;
        i++
    ) {
        const entry = rawQuestions[i];
        let questionText = '';
        let rawOptions = [];
        let multiSelect = false;
        let allowCustomExplicit;
        let placeholder = '';
        let rawId = '';

        if (typeof entry === 'string') {
            questionText = entry.trim();
        } else if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
            const candidateQ = entry.question ?? entry.prompt ?? entry.text ?? entry.label ?? '';
            questionText =
                typeof candidateQ === 'string'
                    ? candidateQ.trim()
                    : String(candidateQ || '').trim();
            rawOptions = Array.isArray(entry.options) ? entry.options : [];
            multiSelect = Boolean(entry.multiSelect ?? entry.multi_select);
            if (entry.allowCustom !== undefined) {
                allowCustomExplicit = Boolean(entry.allowCustom);
            } else if (entry.allow_custom !== undefined) {
                allowCustomExplicit = Boolean(entry.allow_custom);
            }
            placeholder = typeof entry.placeholder === 'string' ? entry.placeholder.trim() : '';
            rawId = typeof entry.id === 'string' ? entry.id.trim() : '';
        }

        if (!questionText) {
            continue;
        }

        // Deduplicate options case-insensitively while preserving order.
        const options = [];
        const seenOpts = new Set();
        for (const rawOpt of rawOptions) {
            if (options.length >= ASK_USER_MAX_OPTIONS) {
                break;
            }
            const optText = extractOptionText(rawOpt);
            if (!optText) {
                continue;
            }
            const key = optText.toLowerCase();
            if (seenOpts.has(key)) {
                continue;
            }
            seenOpts.add(key);
            options.push(optText);
        }

        // Always allow custom text if no clickable options exist, or when not explicitly disabled.
        const allowCustom = options.length === 0 ? true : (allowCustomExplicit ?? true);

        let id = rawId || `q${normalizedQuestions.length + 1}`;
        if (seenIds.has(id)) {
            let suffix = 2;
            while (seenIds.has(`${id}_${suffix}`)) {
                suffix++;
            }
            id = `${id}_${suffix}`;
        }
        seenIds.add(id);

        normalizedQuestions.push({
            id,
            question: questionText,
            options,
            multiSelect,
            allowCustom,
            placeholder,
        });
    }

    if (normalizedQuestions.length === 0) {
        return {
            ok: false,
            error: 'ask_user requires at least one non-empty question in "questions".',
        };
    }

    return {
        ok: true,
        title,
        questions: normalizedQuestions,
    };
}

/**
 * Resolve one question's answer into a clean display string.
 * @param {string} qId
 * @param {Map<string, { selected?: string[], customText?: string }>|Object|null} answers
 * @returns {string}
 */
function formatSingleAnswer(qId, answers) {
    let entry = null;
    if (answers instanceof Map) {
        entry = answers.get(qId);
    } else if (answers && typeof answers === 'object') {
        entry = answers[qId];
    }

    const selected = Array.isArray(entry?.selected)
        ? entry.selected.map((s) => String(s ?? '').trim()).filter(Boolean)
        : [];
    const customText =
        typeof entry?.customText === 'string'
            ? entry.customText.trim().slice(0, ASK_USER_CUSTOM_TEXT_MAX_CHARS)
            : '';

    const parts = [];
    if (selected.length > 0) {
        parts.push(selected.join(', '));
    }
    if (customText) {
        parts.push(selected.length > 0 ? `Note: ${customText}` : customText);
    }
    return parts.length > 0 ? parts.join(' — ') : '(no answer provided)';
}

/**
 * Format user responses to `ask_user` into a clear, unambiguous tool result
 * string for the model.
 *
 * @param {{ title?: string, questions: Array<{ id: string, question: string }>, answers?: Map|Object|null, skipped?: boolean }} params
 * @returns {string}
 */
export function formatAskUserResult({
    title = '',
    questions = [],
    answers = null,
    skipped = false,
}) {
    if (skipped) {
        return '[User skipped the clarifying questions — proceed with your best reasonable assumptions and state them briefly.]';
    }

    const header = title ? `[User answered "${title}"]` : '[User answered clarifying questions]';
    const lines = [header];
    for (let i = 0; i < questions.length; i++) {
        const q = questions[i];
        const answerText = formatSingleAnswer(q.id, answers);
        lines.push(`${i + 1}. ${q.question}`);
        lines.push(`   Answer: ${answerText}`);
    }
    lines.push(
        'Use these answers directly in your next step. Do not re-ask questions the user already answered.',
    );
    return lines.join('\n');
}

/**
 * Build a compact, JSON-serializable summary object for UI card resolution and
 * conversation history persistence.
 *
 * @param {{ title?: string, questions: Array<{ id: string, question: string }>, answers?: Map|Object|null, skipped?: boolean }} params
 * @returns {{ title: string, skipped: boolean, pairs: Array<{ question: string, answer: string }> }}
 */
export function buildAskUserSummary({
    title = '',
    questions = [],
    answers = null,
    skipped = false,
}) {
    const cleanTitle = String(title || '').trim();
    if (skipped) {
        return {
            title: cleanTitle,
            skipped: true,
            pairs: [],
        };
    }
    const pairs = (Array.isArray(questions) ? questions : []).map((q) => ({
        question: String(q?.question || ''),
        answer: formatSingleAnswer(q?.id, answers),
    }));
    return {
        title: cleanTitle,
        skipped: false,
        pairs,
    };
}

/**
 * Build the system instruction for Interactive Prompts (`ask_user`) and Guided
 * Walkthrough Mode (`/guide`).
 *
 * @param {{ guided?: boolean, canCallAskUser?: boolean }} [options]
 * @returns {string}
 */
export function buildInteractiveSystemInstruction({ guided = false, canCallAskUser = false } = {}) {
    if (guided) {
        const base =
            'Guided Walkthrough Mode is active. Act as a hands-on, step-by-step guide rather than dumping a wall of text or completing every phase at once. ' +
            'Start by establishing what is already done, what constraints or preferences apply, and which step to tackle first. ' +
            'Walk the user through ONE concrete step at a time: explain what to do next, supply any exact values/templates/scripts relevant to that single step (from attached documents or the knowledge base), and pause to confirm completion or gather the next decision before moving on. ' +
            'Track progress explicitly (e.g., "Step 1 of N") so the user always knows where they stand.';

        if (canCallAskUser) {
            return (
                base +
                ' Use the `ask_user` tool upfront when current progress, scope, or priorities are unclear, and between steps whenever a user choice, confirmation, or missing detail is needed before advancing.'
            );
        }
        return (
            base +
            ' When progress, choices, or missing details are needed before advancing, ask 1–3 concise, numbered questions and wait for the user to reply before continuing.'
        );
    }

    if (canCallAskUser) {
        return (
            'You have access to the `ask_user` tool to ask the user structured clarifying questions (with clickable options and/or a text input) before continuing. ' +
            'When a request is ambiguous, underspecified, or involves a multi-step workflow/checklist where current status, constraints, or preferred pacing (step-by-step walkthrough vs. full draft) is unknown, call `ask_user` FIRST instead of guessing or dumping speculative drafts. ' +
            'Keep `ask_user` concise (1–3 focused questions with clear `options` where helpful). Do NOT call `ask_user` for straightforward factual questions or when the user already gave enough detail to answer directly.'
        );
    }

    return '';
}
