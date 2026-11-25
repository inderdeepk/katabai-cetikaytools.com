import Gio from 'gi://Gio';
import { buildDocumentSection } from './document.js';
import { buildWebSearchSection } from './webSearch.js';
import { buildCrawlerSection } from './crawler.js';
import { buildKnowledgeSection } from './knowledge.js';
import { buildDeepResearchSection } from './deepResearch.js';
import { buildInteractiveSection } from './interactive.js';
import { gettext as _ } from '../../../shared/i18n.js';

// Builds the Tools page: the index card group listing available tools plus
// each tool's detail subpage. The index row order defines display order.
export function buildToolsPage(ctx) {
    const {
        window,
        extensionPath,
        createPreferencesPage,
        createPreferencesGroup,
        createToolIndexRow,
    } = ctx;

    const toolsPage = createPreferencesPage({
        title: _('Tools'),
        icon_name: 'applications-utilities-symbolic',
    });
    window.add(toolsPage);

    const toolsIndexGroup = createPreferencesGroup({
        title: _('Available Tools'),
        description: _(
            'Optional capabilities Katab can offer the model. Select a tool to open its dedicated settings. Normal chat does not depend on any of these.',
        ),
    });
    toolsPage.add(toolsIndexGroup);

    const documentSubpage = buildDocumentSection(ctx);
    const webSearchSubpage = buildWebSearchSection(ctx);
    const crawl4aiSubpage = buildCrawlerSection(ctx);
    const ragSubpage = buildKnowledgeSection(ctx);
    const deepResearchSubpage = buildDeepResearchSection(ctx);
    const interactiveSubpage = buildInteractiveSection(ctx);

    // Tool index rows (order defines display order on the Tools page).
    createToolIndexRow(toolsIndexGroup, {
        title: _('Document Tool'),
        subtitle: _('Attach and parse local files, and send images to vision-capable models.'),
        iconName: 'text-x-generic-symbolic',
        enabledKey: 'document-tool-enabled',
        navPage: documentSubpage.navPage,
    });

    createToolIndexRow(toolsIndexGroup, {
        title: _('Web Search'),
        subtitle: _('Look things up on the web through your self-hosted SearxNG instance.'),
        iconName: 'system-search-symbolic',
        enabledKey: 'web-search-enabled',
        navPage: webSearchSubpage.navPage,
    });

    createToolIndexRow(toolsIndexGroup, {
        title: _('Web Scraper'),
        subtitle: _(
            'Deep-scrape web pages into clean Markdown through your self-hosted Crawl4AI instance.',
        ),
        iconName: 'document-open-symbolic',
        enabledKey: 'crawl4ai-enabled',
        navPage: crawl4aiSubpage.navPage,
    });

    createToolIndexRow(toolsIndexGroup, {
        title: _('Knowledge Base'),
        subtitle: _(
            'Semantically search across documents, conversations, and research using local RAG.',
        ),
        iconName: 'drive-harddisk-symbolic',
        gicon: Gio.icon_new_for_string(`${extensionPath}/icons/katab-knowledge-symbolic.svg`),
        enabledKey: 'rag-enabled',
        navPage: ragSubpage.navPage,
    });

    createToolIndexRow(toolsIndexGroup, {
        title: _('Deep Research'),
        subtitle: _(
            'Multi-phase research reports: plan, search, gap analysis, refinement, and two-pass synthesis.',
        ),
        iconName: 'content-loading-symbolic',
        navPage: deepResearchSubpage.navPage,
    });

    createToolIndexRow(toolsIndexGroup, {
        title: _('Interactive Prompts'),
        subtitle: _('Clarifying question cards and /guide step-by-step walkthrough mode.'),
        iconName: 'dialog-question-symbolic',
        enabledKey: 'ask-user-enabled',
        navPage: interactiveSubpage.navPage,
    });
}
