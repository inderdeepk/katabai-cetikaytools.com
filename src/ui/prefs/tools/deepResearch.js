// Deep Research settings section for the Tools page.
import { gettext as _, format } from '../../../shared/i18n.js';

export function buildDeepResearchSection(ctx) {
    const {
        settings,
        createToolSubpage,
        createPreferencesGroup,
        createChoiceRow,
        bindChoiceRow,
        createStringRow,
    } = ctx;

    const subpage = createToolSubpage(_('Deep Research'));
    const detailPage = subpage.detailPage;

    const drIntroGroup = createPreferencesGroup({
        title: _('Deep Research'),
        description: _(
            'Deep Research runs a multi-phase pipeline (plan → branches → gap analysis → refinement → two-pass synthesis). Enable Web Search or Web Scraper to use it, then start a run from the chat footer Research button or the /research command.',
        ),
    });

    const drDepthRow = createChoiceRow(
        _('Research Depth'),
        _(
            'Standard keeps the current pipeline. Deep adds automatic quality retries and more gap queries. Max raises the quality bar and synthesis context budget further — more tokens and longer runs.',
        ),
        drIntroGroup,
    );
    bindChoiceRow(
        drDepthRow,
        'deep-research-depth',
        [
            { label: _('Standard (Recommended)'), value: 'standard' },
            { label: _('Deep'), value: 'deep' },
            { label: _('Max'), value: 'max' },
        ],
        settings.get_string.bind(settings),
        settings.set_string.bind(settings),
        (value) => format(_('Custom ({value})'), { value }),
    );

    const drModelsGroup = createPreferencesGroup({
        title: _('Model Overrides'),
        description: _(
            'Optional per-role model overrides — leave empty to use the active provider model. Compression runs on every scraped page (high volume); synthesis covers planning, critique, gap analysis, outline, and the final report.',
        ),
    });

    createStringRow(
        _('Compression Model'),
        _('Cheap/fast model for high-volume page compression. Leave empty for the active model.'),
        'deep-research-compression-model',
        drModelsGroup,
    );

    createStringRow(
        _('Synthesis Model'),
        _('Stronger model for planning and the final report. Leave empty for the active model.'),
        'deep-research-synthesis-model',
        drModelsGroup,
    );

    detailPage.add(drIntroGroup);
    detailPage.add(drModelsGroup);

    return subpage;
}
