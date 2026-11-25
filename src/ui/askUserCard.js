// askUserCard.js — Interactive clarification & guided walkthrough card.
//
// Shell-only module: imports gi://St + Clutter + Pango + Atk (excluded from
// the plain-gjs import smoke test via scripts/import-smoke.js).
//
// NOTE (a11y): on GNOME 46 accessibility roles use `Atk.Role` — never
// `Clutter.AccessibleRole` (mutter 47+ only).

import Atk from 'gi://Atk';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import St from 'gi://St';

import { gettext as _, ngettext, format } from '../shared/i18n.js';
import { ASK_USER_CUSTOM_TEXT_MAX_CHARS } from '../tools/askUserTools.js';

function configureWrappedLabel(label) {
    label.clutter_text.line_wrap = true;
    label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
    label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    label.clutter_text.single_line_mode = false;
}

function isDisposedError(err) {
    return /already disposed/i.test(String(err?.message || err || ''));
}

function buildHeaderRow(titleText, badgeText = '', badgeClass = 'katab-ask-user-count-badge') {
    const headerRow = new St.BoxLayout({
        vertical: false,
        style_class: 'katab-ask-user-header',
        x_expand: true,
        y_align: Clutter.ActorAlign.CENTER,
    });

    headerRow.add_child(
        new St.Icon({
            icon_name: 'dialog-question-symbolic',
            style_class: 'katab-ask-user-header-icon',
            y_align: Clutter.ActorAlign.CENTER,
        }),
    );

    const titleLabel = new St.Label({
        text: titleText || _('Quick clarification'),
        style_class: 'katab-ask-user-title',
        x_expand: true,
        y_align: Clutter.ActorAlign.CENTER,
    });
    configureWrappedLabel(titleLabel);
    headerRow.add_child(titleLabel);

    let badgeLabel = null;
    if (badgeText) {
        badgeLabel = new St.Label({
            text: badgeText,
            style_class: badgeClass,
            y_align: Clutter.ActorAlign.CENTER,
        });
        headerRow.add_child(badgeLabel);
    }

    return { headerRow, badgeLabel };
}

function buildSummaryBody(summary) {
    const listBox = new St.BoxLayout({
        vertical: true,
        style_class: 'katab-ask-user-summary-list',
        x_expand: true,
    });

    const pairs = Array.isArray(summary?.pairs) ? summary.pairs : [];
    for (const pair of pairs) {
        const row = new St.BoxLayout({
            vertical: true,
            style_class: 'katab-ask-user-summary-row',
            x_expand: true,
        });

        const qLabel = new St.Label({
            text: String(pair?.question || ''),
            style_class: 'katab-ask-user-summary-q',
            x_expand: true,
        });
        configureWrappedLabel(qLabel);
        row.add_child(qLabel);

        const aLabel = new St.Label({
            text: String(pair?.answer || ''),
            style_class: 'katab-ask-user-summary-a',
            x_expand: true,
        });
        configureWrappedLabel(aLabel);
        row.add_child(aLabel);

        listBox.add_child(row);
    }

    return listBox;
}

/**
 * Create a read-only summary card for a resolved/skipped/cancelled `ask_user`
 * turn (used when replaying conversation history).
 *
 * @param {{ title?: string, skipped?: boolean, cancelled?: boolean, pairs?: Array<{ question: string, answer: string }> }} summary
 * @returns {St.BoxLayout}
 */
export function createAskUserSummaryCard(summary) {
    const card = new St.BoxLayout({
        vertical: true,
        style_class: 'katab-ask-user-card katab-ask-user-resolved',
        x_expand: true,
    });

    const badgeText = summary?.cancelled
        ? _('Cancelled')
        : summary?.skipped
          ? _('Skipped')
          : _('Answered');
    const badgeClass =
        summary?.cancelled || summary?.skipped
            ? `katab-ask-user-status-badge ${summary.cancelled ? 'cancelled' : 'skipped'}`
            : 'katab-ask-user-status-badge';

    const { headerRow } = buildHeaderRow(summary?.title, badgeText, badgeClass);
    card.add_child(headerRow);

    if (!summary?.skipped && !summary?.cancelled && summary?.pairs?.length > 0) {
        card.add_child(buildSummaryBody(summary));
    }

    return card;
}

/**
 * Create an interactive clarification card appended inline into the chat log.
 *
 * @param {Object} params
 * @param {string} [params.title]
 * @param {Array<{ id: string, question: string, options: string[], multiSelect: boolean, allowCustom: boolean, placeholder: string }>} params.questions
 * @param {(answers: Map<string, { selected: string[], customText: string }>) => void} params.onSubmit
 * @param {() => void} params.onSkip
 * @param {() => void} [params.scrollToBottom]
 * @returns {{ actor: St.BoxLayout, focus: () => void, markResolved: (summary: Object) => void, markCancelled: () => void }}
 */
export function createAskUserCard({
    title = '',
    questions = [],
    onSubmit,
    onSkip,
    scrollToBottom,
}) {
    const card = new St.BoxLayout({
        vertical: true,
        style_class: 'katab-ask-user-card',
        reactive: true,
        x_expand: true,
    });

    const countText = format(ngettext('{count} question', '{count} questions', questions.length), {
        count: questions.length,
    });
    const { headerRow } = buildHeaderRow(title, countText);
    card.add_child(headerRow);

    const questionsBox = new St.BoxLayout({
        vertical: true,
        style_class: 'katab-ask-user-questions',
        x_expand: true,
    });
    card.add_child(questionsBox);

    const validationLabel = new St.Label({
        text: '',
        style_class: 'katab-ask-user-validation',
        x_expand: true,
        visible: false,
    });
    configureWrappedLabel(validationLabel);

    const stateByQuestionId = new Map();
    let firstFocusTarget = null;
    let settled = false;

    const collectAnswers = () => {
        const result = new Map();
        for (const q of questions) {
            const st = stateByQuestionId.get(q.id);
            const selected = q.options.filter((opt) => st?.selectedSet?.has(opt));
            const customText = st?.entry ? String(st.entry.get_text() || '').trim() : '';
            result.set(q.id, { selected, customText });
        }
        return result;
    };

    const hasAnyAnswer = (answers) => {
        for (const val of answers.values()) {
            if (
                (val.selected && val.selected.length > 0) ||
                (val.customText && val.customText.length > 0)
            ) {
                return true;
            }
        }
        return false;
    };

    const trySubmit = () => {
        if (settled) return;
        const answers = collectAnswers();
        if (!hasAnyAnswer(answers)) {
            validationLabel.set_text(_('Choose an option or enter an answer, or click Skip.'));
            validationLabel.visible = true;
            if (typeof scrollToBottom === 'function') scrollToBottom();
            return;
        }
        settled = true;
        validationLabel.visible = false;
        if (typeof onSubmit === 'function') {
            onSubmit(answers);
        }
    };

    const trySkip = () => {
        if (settled) return;
        settled = true;
        validationLabel.visible = false;
        if (typeof onSkip === 'function') {
            onSkip();
        }
    };

    for (let qi = 0; qi < questions.length; qi++) {
        const q = questions[qi];
        const qBlock = new St.BoxLayout({
            vertical: true,
            style_class: 'katab-ask-user-question-block',
            x_expand: true,
        });

        const qLabel = new St.Label({
            text: questions.length > 1 ? `${qi + 1}. ${q.question}` : q.question,
            style_class: 'katab-ask-user-question-label',
            x_expand: true,
        });
        configureWrappedLabel(qLabel);
        qBlock.add_child(qLabel);

        if (q.multiSelect && q.options.length > 0) {
            const hint = new St.Label({
                text: _('Select all that apply'),
                style_class: 'katab-ask-user-question-hint',
                x_expand: true,
            });
            qBlock.add_child(hint);
        }

        const selectedSet = new Set();
        const optionButtons = [];

        const syncOptionVisuals = () => {
            for (const item of optionButtons) {
                const isSelected = selectedSet.has(item.value);
                item.checkIcon.visible = isSelected;
                item.button.checked = isSelected;
                if (isSelected) {
                    item.button.add_style_class_name('selected');
                } else {
                    item.button.remove_style_class_name('selected');
                }
            }
        };

        if (q.options.length > 0) {
            const optionsBox = new St.BoxLayout({
                vertical: true,
                style_class: 'katab-ask-user-options',
                x_expand: true,
            });

            for (const optText of q.options) {
                const optBtn = new St.Button({
                    style_class: 'katab-ask-user-option',
                    can_focus: true,
                    reactive: true,
                    track_hover: true,
                    x_expand: true,
                    x_align: Clutter.ActorAlign.FILL,
                    accessible_name: optText,
                    accessible_role: q.multiSelect ? Atk.Role.CHECK_BOX : Atk.Role.RADIO_BUTTON,
                });

                const optRow = new St.BoxLayout({
                    vertical: false,
                    style_class: 'katab-ask-user-option-row',
                    x_expand: true,
                    y_align: Clutter.ActorAlign.CENTER,
                });

                const indicator = new St.Widget({
                    style_class: q.multiSelect
                        ? 'katab-ask-user-option-indicator'
                        : 'katab-ask-user-option-indicator radio',
                    layout_manager: new Clutter.BinLayout(),
                    y_align: Clutter.ActorAlign.CENTER,
                });
                const checkIcon = new St.Icon({
                    icon_name: 'emblem-ok-symbolic',
                    style_class: 'katab-ask-user-option-check',
                    visible: false,
                    x_align: Clutter.ActorAlign.CENTER,
                    y_align: Clutter.ActorAlign.CENTER,
                });
                indicator.add_child(checkIcon);
                optRow.add_child(indicator);

                const optLabel = new St.Label({
                    text: optText,
                    style_class: 'katab-ask-user-option-text',
                    x_expand: true,
                    y_align: Clutter.ActorAlign.CENTER,
                });
                configureWrappedLabel(optLabel);
                optRow.add_child(optLabel);

                optBtn.set_child(optRow);
                optionButtons.push({ button: optBtn, checkIcon, value: optText });
                if (!firstFocusTarget) {
                    firstFocusTarget = optBtn;
                }

                optBtn.connect('clicked', () => {
                    if (settled) return;
                    validationLabel.visible = false;
                    if (q.multiSelect) {
                        if (selectedSet.has(optText)) {
                            selectedSet.delete(optText);
                        } else {
                            selectedSet.add(optText);
                        }
                    } else {
                        if (selectedSet.has(optText)) {
                            selectedSet.clear();
                        } else {
                            selectedSet.clear();
                            selectedSet.add(optText);
                        }
                    }
                    syncOptionVisuals();
                });

                optionsBox.add_child(optBtn);
            }

            qBlock.add_child(optionsBox);
        }

        let entry = null;
        if (q.allowCustom || q.options.length === 0) {
            entry = new St.Entry({
                style_class: 'katab-ask-user-entry',
                hint_text:
                    q.placeholder ||
                    (q.options.length > 0 ? _('Or type your own answer…') : _('Type your answer…')),
                can_focus: true,
                x_expand: true,
            });
            const ct = entry.clutter_text;
            let trimming = false;
            ct.connect('text-changed', () => {
                validationLabel.visible = false;
                if (trimming) return;
                const current = entry.get_text() ?? '';
                if (current.length > ASK_USER_CUSTOM_TEXT_MAX_CHARS) {
                    trimming = true;
                    try {
                        entry.set_text(current.slice(0, ASK_USER_CUSTOM_TEXT_MAX_CHARS));
                    } finally {
                        trimming = false;
                    }
                }
            });
            ct.connect('key-press-event', (_actor, event) => {
                const sym = event.get_key_symbol();
                const mods = event.get_state();
                if (sym === Clutter.KEY_Return || sym === Clutter.KEY_KP_Enter) {
                    if (questions.length === 1 || mods & Clutter.ModifierType.CONTROL_MASK) {
                        trySubmit();
                        return Clutter.EVENT_STOP;
                    }
                    return Clutter.EVENT_PROPAGATE;
                }
                // Explicit St.Clipboard paste inside GNOME Shell overlay.
                if (
                    mods & Clutter.ModifierType.CONTROL_MASK &&
                    (sym === Clutter.KEY_v || sym === Clutter.KEY_V)
                ) {
                    St.Clipboard.get_default().get_text(St.ClipboardType.CLIPBOARD, (_cb, text) => {
                        if (settled || !text) return;
                        try {
                            ct.delete_selection();
                            const pos = ct.get_cursor_position();
                            const curLen = (entry.get_text() ?? '').length;
                            const avail = Math.max(0, ASK_USER_CUSTOM_TEXT_MAX_CHARS - curLen);
                            if (avail > 0) {
                                ct.insert_text(text.slice(0, avail), pos);
                            }
                        } catch (err) {
                            if (!isDisposedError(err)) throw err;
                        }
                    });
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });

            if (!firstFocusTarget) {
                firstFocusTarget = entry;
            }
            qBlock.add_child(entry);
        }

        stateByQuestionId.set(q.id, { selectedSet, entry });
        questionsBox.add_child(qBlock);
    }

    card.add_child(validationLabel);

    const footer = new St.BoxLayout({
        vertical: false,
        style_class: 'katab-ask-user-footer',
        x_expand: true,
        y_align: Clutter.ActorAlign.CENTER,
    });

    const skipBtn = new St.Button({
        label: _('Skip'),
        style_class: 'katab-ask-user-btn katab-ask-user-btn-secondary',
        can_focus: true,
        reactive: true,
        track_hover: true,
        accessible_role: Atk.Role.PUSH_BUTTON,
        accessible_name: _('Skip clarifying questions'),
    });
    skipBtn.connect('clicked', () => trySkip());
    footer.add_child(skipBtn);

    footer.add_child(new St.Widget({ x_expand: true }));

    const continueBtn = new St.Button({
        label: _('Continue'),
        style_class: 'katab-ask-user-btn katab-ask-user-btn-primary',
        can_focus: true,
        reactive: true,
        track_hover: true,
        accessible_role: Atk.Role.PUSH_BUTTON,
        accessible_name: _('Submit answers and continue'),
    });
    continueBtn.connect('clicked', () => trySubmit());
    footer.add_child(continueBtn);

    card.add_child(footer);

    const replaceWithResolvedView = (summary) => {
        try {
            card.destroy_all_children();
            card.add_style_class_name('katab-ask-user-resolved');
            const resolvedCard = createAskUserSummaryCard(summary);
            const children = resolvedCard.get_children();
            for (const child of children) {
                resolvedCard.remove_child(child);
                card.add_child(child);
            }
            resolvedCard.destroy();
        } catch (err) {
            if (!isDisposedError(err)) throw err;
        }
    };

    return {
        actor: card,
        focus() {
            if (settled || !firstFocusTarget) return;
            try {
                firstFocusTarget.grab_key_focus();
            } catch (_e) {
                /* actor may not be mapped yet */
            }
        },
        markResolved(summary) {
            settled = true;
            replaceWithResolvedView(summary);
        },
        markCancelled() {
            if (settled) return;
            settled = true;
            replaceWithResolvedView({ title, cancelled: true, pairs: [] });
        },
    };
}
