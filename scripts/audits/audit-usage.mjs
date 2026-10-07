// Fidelity audit — ported from /tmp during the audit-rescue pass (Phase 1).
// Baseline: git 100a1d0:extension.js, loaded via ./lib.js (skips on shallow clones).
// Run from the repository root (`make audit`).
// Fidelity audit: usage panel extraction (extension.js -> src/ui/usagePanel.js)
import fs from 'node:fs';
import { loadBaseline } from './lib.js';

const OLD = loadBaseline('100a1d0');
const MOD = fs.readFileSync('src/ui/usagePanel.js', 'utf8');
const NEW = fs.readFileSync('extension.js', 'utf8');

function extractMethod(src, name) {
    const re = new RegExp(`^    ${name}\\([^)]*\\) \\{$`, 'm');
    const m = re.exec(src);
    if (!m) return null;
    const start = m.index + m[0].length;
    let depth = 1;
    let i = start;
    while (i < src.length && depth > 0) {
        const c = src[i];
        if (c === '{') depth++;
        else if (c === '}') depth--;
        i++;
    }
    return src.slice(start, i - 1);
}

// Order matters (longest / most specific first where names share prefixes).
const RENAMES = [
    [/this\._usageRangeDropdownCaptureId/g, 'this._rangeDropdownCaptureId'],
    [/this\._usageRangeDropdownOpen/g, 'this._rangeDropdownOpen'],
    [/this\._usageRangeDropdown/g, 'this._rangeDropdown'],
    [/this\._usageRangeKey/g, 'this._rangeKey'],
    [/this\._usagePanelListBox/g, 'this._listBox'],
    [/this\._usagePanelTitle/g, 'this._title'],
    [/this\._usageProviderModelTab/g, 'this._providerModelTab'],
    [/this\._usageCompanionSprite/g, 'this._companionSprite'],
    [/this\._usageTab/g, 'this._tab'],
    [/this\._usageView/g, 'this._view'],
    [/this\._usageDetailFormId/g, 'this._detailFormId'],
    [/this\._extension\.path/g, 'this._extPath'],
    [/this\._getPetSelection\(\)/g, 'this._host.getPetSelection()'],
    [/this\._currentProvider/g, 'this._host.getCurrentProvider()'],
    [/this\._showChatView\(\)/g, 'this._host.showChatView()'],
    [/this\._switchToLocalDraft\(\)/g, 'this._host.switchToLocalDraft()'],
    [/this\._openAuxPanel\(this\._usagePanel\)/g, 'this._host.openAuxPanel(this.panel)'],
    [/this\._showUsageCollection\(\)/g, 'this._showCollection()'],
    [/this\._showUsageOverview\(\)/g, 'this._showOverview()'],
    [/this\._showUsageSpending\(\)/g, 'this._showSpending()'],
    [/this\._showUsagePetDetail\(/g, 'this._showPetDetail('],
    [/this\._setUsagePanelTitle\(/g, 'this._setTitle('],
    [/this\._buildUsageTabBar\(/g, 'this._buildTabBar('],
    [/this\._buildUsageBackRow\(/g, 'this._buildBackRow('],
    [/this\._renderUsageCollection\(/g, 'this._renderCollection('],
    [/this\._renderUsagePetDetail\(/g, 'this._renderPetDetail('],
    [/this\._renderUsageSpending\(/g, 'this._renderSpending('],
    [/this\._buildUsageCompanionCard\(/g, 'this._buildCompanionCard('],
    [/this\._buildUsageActivityCard\(/g, 'this._buildActivityCard('],
    [/this\._buildUsageProviderModelCard\(/g, 'this._buildProviderModelCard('],
    [/this\._buildUsageMilestoneCard\(/g, 'this._buildMilestoneCard('],
    [/this\._buildUsagePausedCard\(/g, 'this._buildPausedCard('],
    [/this\._buildUsageRangeDropdown\(/g, 'this._buildRangeDropdown('],
    [/this\._openUsageRangeDropdown\(/g, 'this._openRangeDropdown('],
    [/this\._buildUsagePrivacyNote\(/g, 'this._buildPrivacyNote('],
    [/this\._buildUsageTipRow\(/g, 'this._buildTipRow('],
    [/this\._createUsageCard\(/g, 'this._createCard('],
    [/this\._formatUsageDate\(/g, 'this._formatDate('],
    [/this\._formatUsageDay\(/g, 'this._formatDay('],
    [/this\._refreshUsagePanel\(\)/g, 'this.refresh()'],
    [/this\._closeUsageRangeDropdown\(\)/g, 'this.closeRangeDropdown()'],
    [/this\._getDefaultUsageRange\(\)/g, 'this.defaultRange()'],
    [/this\._isValidUsageRange\(/g, 'this._isValidRange('],
    [/createProviderIcon\(/g, 'this._host.createProviderIcon('],
    [/(?<!\.)getProviderLabel\(/g, 'this._host.getProviderLabel('],
];

const NEW_A11Y = [
    'accessible_name:title,accessible_role:Clutter.AccessibleRole.PUSH_BUTTON',
    "accessible_name:'Toolsandtoggles'",
    "accessible_name:'Openchat'",
    "accessible_name:'Deletechat'",
    "accessible_name:'Deleteconversation'",
    "accessible_name:'Closesessioninfo'",
    "accessible_name:'Closetoolspanel'",
    "accessible_name:'Closepicker'",
    "accessible_name:'Closepresetlist'",
    "accessible_name:'Togglesourcelist'",
    "accessible_name:'Cachesavingsdetails'",
    "accessible_name:'Knowledgebaseusage'",
    'accessible_name:`Deletepreset"${preset.name}"`',
    'accessible_name:this._host.getToolButtonLabel(tool)',
    "accessible_name:entry.companion?.name||'Petcompanion'",
    'accessible_name:range.label',
    'accessible_role:Clutter.AccessibleRole.PUSH_BUTTON',
];
function stripA11y(s) {
    for (const frag of NEW_A11Y) s = s.split(frag).join('');
    s = s.replace(/_\('[^']*'\)/g, (m) => m.slice(2, -1));
    return s
        .replace(/,,+/g, ',')
        .replace(/,([)}\]])/g, '$1')
        .replace(/\{,/g, '{');
}

function flat(text) {
    let out = [];
    let inBlockComment = false;
    for (let rawLine of text.split('\n')) {
        let line = rawLine;
        if (inBlockComment) {
            const end = line.indexOf('*/');
            if (end === -1) continue;
            line = line.slice(end + 2);
            inBlockComment = false;
        }
        line = line.replace(/\/\*.*?\*\//g, '');
        const bc = line.indexOf('/*');
        if (bc !== -1) {
            inBlockComment = true;
            line = line.slice(0, bc);
        }
        line = line.replace(/\s+/g, ' ').trim();
        if (line) out.push(line);
    }
    return out
        .join(' ')
        .replace(/\s+/g, '')
        .replace(/,(?=[)\]}])/g, '')
        .replace(/─+/g, '─')
        .replace(/═+/g, '═');
}

const PAIRS = [
    ['_refreshUsagePanel', 'refresh'],
    ['_buildUsageTabBar', '_buildTabBar'],
    ['_setUsagePanelTitle', '_setTitle'],
    ['_showUsageOverview', '_showOverview'],
    ['_showUsageCollection', '_showCollection'],
    ['_showUsageSpending', '_showSpending'],
    ['_showUsagePetDetail', '_showPetDetail'],
    ['_followCurrentProviderPet', '_followCurrentProviderPet'],
    ['_pinPetForm', '_pinPetForm'],
    ['_buildUsageBackRow', '_buildBackRow'],
    ['_renderUsageCollection', '_renderCollection'],
    ['_buildPetCollectionItem', '_buildPetCollectionItem'],
    ['_renderUsagePetDetail', '_renderPetDetail'],
    ['_createUsageCard', '_createCard'],
    ['_getDefaultUsageRange', 'defaultRange'],
    ['_isValidUsageRange', '_isValidRange'],
    ['_buildUsagePausedCard', '_buildPausedCard'],
    ['_buildUsageRangeDropdown', '_buildRangeDropdown'],
    ['_openUsageRangeDropdown', '_openRangeDropdown'],
    ['_closeUsageRangeDropdown', 'closeRangeDropdown'],
    ['_isDescendantOf', '_isDescendantOf'],
    ['_buildUsageCompanionCard', '_buildCompanionCard'],
    ['_buildUsageActivityCard', '_buildActivityCard'],
    ['_buildUsageProviderModelCard', '_buildProviderModelCard'],
    ['_buildUsageMilestoneCard', '_buildMilestoneCard'],
    ['_formatUsageDay', '_formatDay'],
    ['_buildUsagePrivacyNote', '_buildPrivacyNote'],
    ['_buildUsageTipRow', '_buildTipRow'],
    ['_renderUsageSpending', '_renderSpending'],
    ['_formatUsageDate', '_formatDate'],
];

let fails = 0;
for (const [oldName, newName] of PAIRS) {
    const oldBody = extractMethod(OLD, oldName);
    const newBody = extractMethod(MOD, newName);
    if (oldBody === null || newBody === null) {
        console.log(`!! MISSING: ${oldName} -> ${newName} (old=${!!oldBody} new=${!!newBody})`);
        fails++;
        continue;
    }
    let expected = oldBody;
    for (const [re, repl] of RENAMES) expected = expected.replace(re, repl);
    const a = flat(expected);
    let b = flat(newBody);
    // Allowance: accessible_name/accessible_role attrs added by the a11y pass.
    b = stripA11y(b);
    if (a === b) {
        console.log(`OK  ${oldName} -> ${newName}`);
    } else {
        fails++;
        console.log(`DIFF ${oldName} -> ${newName}`);
        // Locate first divergence for diagnosis
        let lo = 0;
        const lim = Math.min(a.length, b.length);
        while (lo < lim && a[lo] === b[lo]) lo++;
        console.log(`  at ${lo}: ...${a.slice(Math.max(0, lo - 80), lo + 80)}`);
        console.log(`      vs: ...${b.slice(Math.max(0, lo - 80), lo + 80)}`);
    }
}

// Residual audit on new extension.js: moved members must be gone.
const RESIDUAL = [
    /this\._usagePanelListBox/,
    /this\._usagePanelTitle/,
    /this\._usageTab\b/,
    /this\._usageView\b/,
    /this\._usageDetailFormId/,
    /this\._usageRangeKey/,
    /this\._usageRangeDropdown(?!\?)/,
    /this\._usageRangeDropdownOpen/,
    /this\._usageRangeDropdownCaptureId/,
    /this\._usageProviderModelTab/,
    /this\._usageCompanionSprite/,
    /this\._buildUsageTabBar/,
    /this\._renderUsageCollection/,
    /this\._createUsageCard/,
    /this\._formatUsageDate/,
    /this\._formatUsageDay/,
    /this\._getDefaultUsageRange/,
    /this\._isValidUsageRange/,
    /this\._buildUsageBackRow/,
    /this\._showUsage/,
    /this\._followCurrentProviderPet/,
    /this\._pinPetForm/,
    /this\._buildPetCollectionItem/,
    /this\._buildUsageCompanionCard/,
    /this\._buildUsageActivityCard/,
    /this\._buildUsageProviderModelCard/,
    /this\._buildUsageMilestoneCard/,
    /this\._buildUsagePausedCard/,
    /this\._buildUsagePrivacyNote/,
    /this\._buildUsageTipRow/,
    /this\._renderUsageSpending/,
    /this\._renderUsagePetDetail/,
    /this\._setUsagePanelTitle/,
    /this\._buildUsageRangeDropdown/,
    /this\._openUsageRangeDropdown/,
];
for (const p of RESIDUAL) {
    if (p.test(NEW)) {
        console.log(`!! RESIDUAL in extension.js: ${p}`);
        fails++;
    }
}

// Wrappers + host bag must exist with delegation.
const WRAPPER_CHECKS = [
    ['_buildUsagePanel()', 'new UsagePanel(this._buildUsageHost())'],
    ['_buildUsageHost()', 'switchToLocalDraft: () => this._switchToLocalDraft()'],
    ['_toggleUsagePanel()', 'this._usage?.toggle()'],
    ['_openUsagePanel()', 'this._usage?.open()'],
    ['_refreshUsagePanel()', 'this._usage?.refresh()'],
    ['_closeUsageRangeDropdown()', 'this._usage?.closeRangeDropdown()'],
];
for (const [sig, call] of WRAPPER_CHECKS) {
    const idx = NEW.indexOf(`    ${sig} {`);
    const seg = idx === -1 ? '' : NEW.slice(idx, idx + 620);
    if (idx === -1 || !seg.includes(call)) {
        console.log(`!! WRAPPER BROKEN: ${sig}`);
        fails++;
    }
}

// Allowed external touchpoints still wired
const ALLOWED = [
    ['this._usage?.resetRangeToDefault()', 'watcher'],
    ['this._usage?.rangeDropdown', 'popup hit-test'],
    ['this._usage?.showCompanionPose', 'pose calls'],
];
for (const [needle, what] of ALLOWED) {
    if (!NEW.includes(needle)) {
        console.log(`!! MISSING EXTERNAL WIRE: ${what} (${needle})`);
        fails++;
    }
}

console.log(fails === 0 ? '\nFIDELITY: PASS' : `\nFIDELITY: ${fails} FAILURES`);
process.exit(fails === 0 ? 0 : 1);
