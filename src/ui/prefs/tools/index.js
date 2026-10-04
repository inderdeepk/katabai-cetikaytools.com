import Gio from 'gi://Gio';
import { buildDocumentSection } from './document.js';
import { buildWebSearchSection } from './webSearch.js';
import { buildCrawlerSection } from './crawler.js';
import { buildKnowledgeSection } from './knowledge.js';
import { buildDeepResearchSection } from './deepResearch.js';

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
        title: 'Tools',
        icon_name: 'applications-utilities-symbolic',
    });
    window.add(toolsPage);

    const toolsIndexGroup = createPreferencesGroup({
        title: 'Available Tools',
        description:
            'Optional capabilities Katab can offer the model. Select a tool to open its dedicated settings. Normal chat does not depend on any of these.',
    });
    toolsPage.add(toolsIndexGroup);

    const documentSubpage = buildDocumentSection(ctx);
    const webSearchSubpage = buildWebSearchSection(ctx);
    const crawl4aiSubpage = buildCrawlerSection(ctx);
    const ragSubpage = buildKnowledgeSection(ctx);
    const deepResearchSubpage = buildDeepResearchSection(ctx);

    // Tool index rows (order defines display order on the Tools page).
    createToolIndexRow(toolsIndexGroup, {
        title: 'Document Tool',
        subtitle: 'Attach and parse local files, and send images to Ollama vision models.',
        iconName: 'text-x-generic-symbolic',
        enabledKey: 'document-tool-enabled',
        navPage: documentSubpage.navPage,
    });

    createToolIndexRow(toolsIndexGroup, {
        title: 'Web Search',
        subtitle: 'Look things up on the web through your self-hosted SearxNG instance.',
        iconName: 'system-search-symbolic',
        enabledKey: 'web-search-enabled',
        navPage: webSearchSubpage.navPage,
    });

    createToolIndexRow(toolsIndexGroup, {
        title: 'Web Scraper',
        subtitle:
            'Deep-scrape web pages into clean Markdown through your self-hosted Crawl4AI instance.',
        iconName: 'document-open-symbolic',
        enabledKey: 'crawl4ai-enabled',
        navPage: crawl4aiSubpage.navPage,
    });

    createToolIndexRow(toolsIndexGroup, {
        title: 'Knowledge Base',
        subtitle:
            'Semantically search across documents, conversations, and research using local RAG.',
        iconName: 'drive-harddisk-symbolic',
        gicon: Gio.icon_new_for_string(`${extensionPath}/icons/katab-knowledge-symbolic.svg`),
        enabledKey: 'rag-enabled',
        navPage: ragSubpage.navPage,
    });

    createToolIndexRow(toolsIndexGroup, {
        title: 'Deep Research',
        subtitle:
            'Multi-phase research reports: plan, search, gap analysis, refinement, and two-pass synthesis.',
        iconName: 'content-loading-symbolic',
        navPage: deepResearchSubpage.navPage,
    });
}
