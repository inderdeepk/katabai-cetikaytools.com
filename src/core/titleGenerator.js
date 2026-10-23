// titleGenerator.js — Pure helpers for conversation titles.
//
// Two flows share this module:
//   • Manual editor — the dialog asks the active provider to summarize a saved
//     conversation (title + description).
//   • First prompt — a tiny title-only request names a new chat before the main
//     request starts.
//
// Everything here is testable without the shell: transcript excerpt building,
// single-user-message prompt shapes (safe for providers that drop system
// messages, e.g. Anthropic's non-streaming dialect), and tolerant response
// parsers (strict JSON / labeled lines; quotes, fences, and bullets).

export const TITLE_GEN_TITLE_MAX_CHARS = 80;
export const TITLE_GEN_DESCRIPTION_MAX_CHARS = 240;
export const TITLE_GEN_TRANSCRIPT_MAX_CHARS = 8000;
export const TITLE_GEN_MESSAGE_MAX_CHARS = 600;
export const TITLE_GEN_MAX_TOKENS = 160;

// ── Instant auto titles (first prompt of a new chat) ─────────────────────
// Kept deliberately tiny: the title request runs before the main chat
// request, so prompt size and output budget are the latency guardrails.
export const AUTO_TITLE_MAX_CHARS = 48;
export const AUTO_TITLE_PROMPT_MAX_CHARS = 600;
export const AUTO_TITLE_MAX_TOKENS = 24;
// Hard socket timeout.  The send flow hands off to the main request after a
// shorter soft deadline (see AUTO_TITLE_HANDOFF_MS in extension.js), so a cold
// local model can keep naming the chat in the background.
export const AUTO_TITLE_TIMEOUT_SECONDS = 30;

export const AUTO_TITLE_INSTRUCTION = `You name chat conversations.
Read the user's first message and reply with ONLY a short title.

Rules:
- 2–6 words, at most 48 characters.
- Name the concrete topic, not the wording of the request.
- No quotes, no markdown, no "Title:" prefix, no trailing punctuation.
- Use the same language as the message.
- Never answer the message; only name it.`;

// Conversation markers for messages that were injected internally and should
// never influence a title (self-healing retries, research summaries, synthesis
// priming, plan injections, the session-memory marker).
const INTERNAL_MESSAGE_FLAGS = [
    '_healingInjection',
    '_researchSummary',
    '_synthesisRetry',
    '_planInjection',
    '_sessionMemory',
];

export const TITLE_GEN_INSTRUCTION = `You write titles and descriptions for chat conversations.
Read the transcript below and reply with STRICT JSON ONLY — no markdown fences, no commentary:
{"title": "<short title>", "description": "<one-sentence summary>"}

Rules:
- "title": at most 60 characters, specific to the topic, without surrounding quotes or trailing punctuation.
- "description": one sentence, at most 160 characters, summarizing what the conversation covers.
- Use the same language as the conversation.`;

/** Extract displayable plain text from a message (string or content blocks). */
export function messageText(msg) {
    const content = msg?.content;
    if (typeof content === 'string') {
        return content;
    }
    if (Array.isArray(content)) {
        const parts = [];
        for (const block of content) {
            if (!block) continue;
            if (typeof block === 'string') {
                parts.push(block);
            } else if (typeof block.text === 'string') {
                parts.push(block.text);
            } else if (block.type === 'tool_result' && typeof block.content === 'string') {
                parts.push(block.content);
            }
        }
        return parts.join(' ');
    }
    return '';
}

export function isInternalMessage(msg) {
    return INTERNAL_MESSAGE_FLAGS.some((flag) => msg?.[flag]);
}

/**
 * Build a bounded "User: …/Assistant: …" transcript excerpt from the start of
 * the conversation (first exchanges carry the topic best).  Skips tool/system/
 * internal messages.  Returns '' when nothing displayable exists.
 */
export function buildTranscriptExcerpt(
    messages,
    {
        maxChars = TITLE_GEN_TRANSCRIPT_MAX_CHARS,
        maxMessageChars = TITLE_GEN_MESSAGE_MAX_CHARS,
    } = {},
) {
    if (!Array.isArray(messages) || messages.length === 0) return '';

    const lines = [];
    let total = 0;
    let truncated = false;
    for (const msg of messages) {
        if (!msg || isInternalMessage(msg)) continue;
        if (msg.role !== 'user' && msg.role !== 'assistant') continue;

        let text = messageText(msg).replace(/\s+/g, ' ').trim();
        if (!text) continue;
        if (text.length > maxMessageChars) {
            text = `${text.slice(0, maxMessageChars)}\u2026`;
        }

        const line = `${msg.role === 'user' ? 'User' : 'Assistant'}: ${text}`;
        if (total + line.length + 1 > maxChars) {
            // Always keep at least a fragment of the first eligible message so
            // a single huge opening message still yields a usable excerpt.
            if (lines.length === 0) lines.push(line.slice(0, Math.max(1, maxChars)));
            truncated = true;
            break;
        }
        lines.push(line);
        total += line.length + 1;
    }

    if (lines.length === 0) return '';
    let excerpt = lines.join('\n');
    if (truncated) excerpt += '\n[The conversation continues beyond this excerpt.]';
    return excerpt;
}

/**
 * Build the messages array for `_requestNonStreamingCompletion`.
 * Returns null when there is nothing to summarize.  A single user message is
 * used deliberately: Anthropic's non-streaming builder drops system messages.
 */
export function buildTitleGenerationMessages(messages, options = {}) {
    const excerpt = buildTranscriptExcerpt(messages, options);
    if (!excerpt) return null;
    return [
        {
            role: 'user',
            content: `${TITLE_GEN_INSTRUCTION}\n\nConversation transcript:\n\n${excerpt}`,
        },
    ];
}

function sanitizeField(value, maxChars) {
    if (typeof value !== 'string') return '';
    let text = value
        .replace(/^[\s"'“”‘’]+|[\s"'“”‘’]+$/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    if (text.length > maxChars) text = text.slice(0, maxChars).trim();
    return text;
}

function extractLabeledField(text, label) {
    const re = new RegExp(
        `(?:^|\\n)\\s*(?:#+\\s*)?(?:\\*\\*)?${label}(?:\\*\\*)?\\s*[:\\-\u2013]\\s*(.+)`,
        'i',
    );
    const match = text.match(re);
    return match ? match[1] : '';
}

/**
 * Parse a model response into `{ title, description }` (description may be '').
 * Accepts strict JSON (raw, fenced, or embedded in prose) and falls back to
 * labeled "Title: …"/"Description: …" lines.  Returns null when no usable
 * title can be recovered.
 */
export function parseTitleDescriptionResponse(text) {
    if (!text || typeof text !== 'string') return null;
    let cleaned = text.trim();
    if (!cleaned) return null;

    // Strip a single fenced block (```json … ``` or ``` … ```).
    const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) cleaned = fence[1].trim();

    let title = '';
    let description = '';

    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start !== -1 && end > start) {
        try {
            const parsed = JSON.parse(cleaned.slice(start, end + 1));
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                title = sanitizeField(parsed.title, TITLE_GEN_TITLE_MAX_CHARS);
                description = sanitizeField(parsed.description, TITLE_GEN_DESCRIPTION_MAX_CHARS);
            }
        } catch (_e) {
            // fall through to the labeled-line fallback
        }
    }

    if (!title) {
        title = sanitizeField(extractLabeledField(cleaned, 'title'), TITLE_GEN_TITLE_MAX_CHARS);
    }
    if (!description) {
        description = sanitizeField(
            extractLabeledField(cleaned, 'description'),
            TITLE_GEN_DESCRIPTION_MAX_CHARS,
        );
    }

    if (!title) return null;
    return { title, description };
}

/** Slice by Unicode code points so an emoji is never split in half. */
function truncateCodePoints(text, maxChars) {
    if (typeof text !== 'string' || maxChars <= 0) return '';
    let count = 0;
    for (let index = 0; index < text.length; index++) {
        const code = text.codePointAt(index);
        if (code > 0xffff) index += 1; // surrogate pair
        count += 1;
        if (count === maxChars) {
            return text.slice(0, index + 1);
        }
    }
    return text;
}

/**
 * Build the single-user-message request used to name a brand-new chat from
 * its first prompt.  The prompt is capped so the request stays quick even
 * when the user pastes a wall of text.
 */
export function buildAutoTitleMessages(
    promptText,
    { maxChars = AUTO_TITLE_PROMPT_MAX_CHARS } = {},
) {
    const seed = String(promptText ?? '')
        .replace(/\s+/g, ' ')
        .trim();
    if (!seed) return null;

    const excerptBase = truncateCodePoints(seed, maxChars);
    const excerpt =
        excerptBase.length < seed.length ? `${excerptBase.trimEnd()}\u2026` : excerptBase;
    return [
        {
            role: 'user',
            content: `${AUTO_TITLE_INSTRUCTION}\n\nUser message:\n"""\n${excerpt}\n"""`,
        },
    ];
}

function sanitizeAutoTitleLine(line, maxChars) {
    let cleaned = String(line ?? '')
        .trim()
        // "Title: …", "**Title**: …", "Sure — here is your title: …"
        .replace(/^.{0,40}?\btitle\b[*_`]*\s*(?::|\s[-\u2013]\s)\s*/i, '')
        .replace(/^\s*(?:[-\u2022]|\d+[.)])\s+/, '')
        .replace(/^\s*#+\s+/, '')
        .replace(/^[*_`\s"'“”‘’]+|[*_`\s"'“”‘’]+$/g, '')
        .replace(/\s+#+\s*$/, '')
        .replace(/[.!?;:,\u2026]+$/g, '')
        .replace(/\s+/g, ' ')
        .trim();

    const capped = truncateCodePoints(cleaned, maxChars);
    if (capped.length < cleaned.length) {
        cleaned = capped.trimEnd();
        const lastSpace = cleaned.lastIndexOf(' ');
        if (lastSpace >= Math.floor(maxChars * 0.6)) {
            cleaned = cleaned.slice(0, lastSpace);
        }
        cleaned = cleaned.replace(/[.!?;:,\u2026]+$/g, '').trim();
    }

    if (
        !cleaned ||
        /^\d+$/.test(cleaned) ||
        (cleaned.startsWith('{') && !cleaned.includes('}')) ||
        (cleaned.startsWith('[') && !cleaned.includes(']')) ||
        /^[{}[\]()<>]+$/.test(cleaned) ||
        /^(?:untitled|n\/?a|none|no title|unknown|title|chat|conversation|new chat)$/i.test(
            cleaned,
        ) ||
        /^(?:i (?:cannot|can't|can not|won't|will not)\b|sorry[,.]?\s*(?:i|we)\b|as an ai\b)/i.test(
            cleaned,
        )
    ) {
        return '';
    }
    return cleaned;
}

/**
 * Parse a title-only response.  Tolerates the usual model habits: fenced
 * blocks, JSON objects, labeled lines, bullets, surrounding quotes/markdown,
 * trailing punctuation, and multi-line chatter.  Returns '' when no usable
 * title can be recovered.
 */
export function parseAutoTitleResponse(text, { maxChars = AUTO_TITLE_MAX_CHARS } = {}) {
    if (typeof text !== 'string') return '';
    let cleaned = text.trim();
    if (!cleaned) return '';

    const fence = cleaned.match(/```(?:[a-z0-9_-]+)?\s*([\s\S]*?)```/i);
    if (fence) cleaned = fence[1].trim();

    // A bare JSON array is a formatting failure, not a title.
    if (cleaned.startsWith('[') && cleaned.endsWith(']')) {
        try {
            if (Array.isArray(JSON.parse(cleaned))) return '';
        } catch (_e) {
            // Not JSON — may be a bracketed title such as "[GNOME] Wayland crash".
        }
    }

    // Some models answer structured even when asked for plain text.
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start !== -1 && end > start) {
        try {
            const parsed = JSON.parse(cleaned.slice(start, end + 1));
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                if (typeof parsed.title === 'string') cleaned = parsed.title;
            }
        } catch (_e) {
            // plain-text response
        }
    }

    // Titles never span lines.  Skip lead-in chatter ("Here is your title:")
    // and return the first line that survives sanitizing.
    for (const line of cleaned.split(/\r?\n/)) {
        const title = sanitizeAutoTitleLine(line, maxChars);
        if (title) return title;
    }
    return '';
}
