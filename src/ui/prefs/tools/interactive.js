// Interactive Prompts & Guided Mode settings section for the Tools page.
import Gtk from 'gi://Gtk';
import { gettext as _ } from '../../../shared/i18n.js';
import {
    ASK_USER_MAX_MAX_PER_TURN,
    ASK_USER_MIN_MAX_PER_TURN,
} from '../../../tools/askUserTools.js';

export function buildInteractiveSection(ctx) {
    const {
        createToolSubpage,
        createPreferencesGroup,
        createInfoRow,
        createBooleanRow,
        createIntRow,
        addCssClasses,
    } = ctx;

    const subpage = createToolSubpage(_('Interactive Prompts'));
    const detailPage = subpage.detailPage;

    const introGroup = createPreferencesGroup({});
    detailPage.add(introGroup);
    const introRow = createInfoRow(
        _('Clarifying questions & Guided Walkthrough Mode'),
        _(
            'In Auto mode, capable models can pause and show an interactive card with clickable choices and a freeform input when your request needs clarification. Switch Guide to On (or use /guide) for hands-on, step-by-step walkthroughs of checklists and multi-phase tasks.',
        ),
        introGroup,
    );
    introRow.add_prefix(
        addCssClasses(
            new Gtk.Image({
                icon_name: 'dialog-question-symbolic',
                valign: Gtk.Align.CENTER,
            }),
            'katab-prefs-tool-icon',
        ),
    );

    const behaviorGroup = createPreferencesGroup({
        title: _('Behavior'),
        description: _(
            'Control whether models may present interactive clarification cards and how many rounds can happen per message.',
        ),
    });
    detailPage.add(behaviorGroup);

    createBooleanRow(
        _('Enable Interactive Prompts'),
        _(
            'Advertise the ask_user clarification tool in Auto mode and allow /guide step-by-step walkthroughs.',
        ),
        'ask-user-enabled',
        behaviorGroup,
    );

    createIntRow(
        _('Max Prompts Per Turn'),
        _(
            'Maximum number of interactive ask_user cards a model can present in a single turn before continuing.',
        ),
        'ask-user-max-per-turn',
        behaviorGroup,
        ASK_USER_MIN_MAX_PER_TURN,
        ASK_USER_MAX_MAX_PER_TURN,
        1,
    );

    return subpage;
}
