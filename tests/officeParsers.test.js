// officeParsers.test.js — Tests for the built-in Office/ODF/CSV/RTF readers.
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import {
    OfficeParseError,
    OfficeZipArchive,
    decodeTextBytes,
    extractOfficeText,
    getOfficeFamily,
    isLegacyOfficeExtension,
    isOfficeExtension,
    listOfficeExtensions,
    parseDelimitedText,
    rtfToText,
} from '../src/tools/officeParsers.js';
import { DocumentToolRuntime, DocumentToolError } from '../src/tools/documentTools.js';
import {
    assert,
    assertEqual,
    assertThrows,
    makeTempDir,
    removeTempDir,
    runTests,
} from './testUtils.js';

// ── ZIP fixture builder ────────────────────────────────────────────────────
// Tests build real ZIP containers so the central-directory parser, raw-deflate
// inflation, and every XML reader are exercised exactly as they run in the
// extension (no committed binary fixtures needed).

function deflateRaw(input) {
    const compressor = new Gio.ZlibCompressor({ format: Gio.ZlibCompressorFormat.RAW });
    const memory = Gio.MemoryOutputStream.new_resizable();
    const stream = new Gio.ConverterOutputStream({ base_stream: memory, converter: compressor });
    stream.write_all(input, null);
    stream.close(null);
    return memory.steal_as_bytes().toArray();
}

function crc32(bytes) {
    let crc = 0xffffffff;
    for (let index = 0; index < bytes.length; index++) {
        crc ^= bytes[index];
        for (let bit = 0; bit < 8; bit++) {
            crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
        }
    }
    return (crc ^ 0xffffffff) >>> 0;
}

/** Builds a ZIP archive from `[{ name, data, store?, encrypted? }]`. */
function buildZip(entries) {
    const encoder = new TextEncoder();
    const localParts = [];
    const centralParts = [];
    let offset = 0;

    for (const entry of entries) {
        const nameBytes = encoder.encode(entry.name);
        const raw = typeof entry.data === 'string' ? encoder.encode(entry.data) : entry.data;
        const method = entry.store ? 0 : 8;
        const payload = method === 8 ? deflateRaw(raw) : raw;
        const checksum = crc32(raw);
        const flags = entry.encrypted ? 0x1 : 0;

        const local = new Uint8Array(30 + nameBytes.length);
        const localView = new DataView(local.buffer);
        localView.setUint32(0, 0x04034b50, true);
        localView.setUint16(4, 20, true);
        localView.setUint16(6, flags, true);
        localView.setUint16(8, method, true);
        localView.setUint32(14, checksum, true);
        localView.setUint32(18, payload.length, true);
        localView.setUint32(22, raw.length, true);
        localView.setUint16(26, nameBytes.length, true);
        local.set(nameBytes, 30);
        localParts.push(local, payload);

        const central = new Uint8Array(46 + nameBytes.length);
        const centralView = new DataView(central.buffer);
        centralView.setUint32(0, 0x02014b50, true);
        centralView.setUint16(4, 20, true);
        centralView.setUint16(6, 20, true);
        centralView.setUint16(8, flags, true);
        centralView.setUint16(10, method, true);
        centralView.setUint32(16, checksum, true);
        centralView.setUint32(20, payload.length, true);
        centralView.setUint32(24, raw.length, true);
        centralView.setUint16(28, nameBytes.length, true);
        centralView.setUint32(42, offset, true);
        central.set(nameBytes, 46);
        centralParts.push(central);

        offset += local.length + payload.length;
    }

    const centralSize = centralParts.reduce((total, part) => total + part.length, 0);
    const eocd = new Uint8Array(22);
    const eocdView = new DataView(eocd.buffer);
    eocdView.setUint32(0, 0x06054b50, true);
    eocdView.setUint16(8, entries.length, true);
    eocdView.setUint16(10, entries.length, true);
    eocdView.setUint32(12, centralSize, true);
    eocdView.setUint32(16, offset, true);

    const totalSize = offset + centralSize + eocd.length;
    const archive = new Uint8Array(totalSize);
    let cursor = 0;
    for (const part of [...localParts, ...centralParts, eocd]) {
        archive.set(part, cursor);
        cursor += part.length;
    }
    return archive;
}

// ── Format fixtures ────────────────────────────────────────────────────────

const WORD_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const SHEET_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const DRAWING_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const PRESENTATION_NS = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

const DOCX_DOCUMENT = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="${WORD_NS}"><w:body>
<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Quarterly Report</w:t></w:r></w:p>
<w:p><w:r><w:t>Revenue grew </w:t></w:r><w:r><w:t>12% &amp; up &#233;</w:t></w:r></w:p>
<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/></w:numPr></w:pPr><w:r><w:t>Alpha</w:t></w:r></w:p>
<w:p><w:pPr><w:numPr/></w:pPr><w:r><w:t>Beta</w:t></w:r></w:p>
<w:tbl>
<w:tr><w:tc><w:p><w:r><w:t>Region</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Sales</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:p><w:r><w:t>North</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>100</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:p><w:r><w:t>South</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>200</w:t></w:r></w:p></w:tc></w:tr>
</w:tbl>
<w:p><w:r><w:t>Line A</w:t><w:br/><w:t>Line B</w:t></w:r></w:p>
<w:p><w:del><w:r><w:delText>removed text</w:delText></w:r></w:del><w:r><w:t>kept text</w:t></w:r></w:p>
</w:body></w:document>`;

function buildDocx(documentXml = DOCX_DOCUMENT) {
    return buildZip([
        {
            name: '[Content_Types].xml',
            data: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
        },
        { name: 'word/document.xml', data: documentXml },
    ]);
}

const XLSX_STYLES = `<?xml version="1.0" encoding="UTF-8"?>
<styleSheet xmlns="${SHEET_NS}">
<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy\\\\-mm\\\\-dd\\\\ hh:mm"/></numFmts>
<fonts count="1"><font><sz val="11"/></font></fonts>
<fills count="1"><fill><patternFill patternType="none"/></fill></fills>
<borders count="1"><border/></borders>
<cellStyleXfs count="1"><xf numFmtId="0"/></cellStyleXfs>
<cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/></cellXfs>
</styleSheet>`;

function buildXlsx() {
    const workbook = `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="${SHEET_NS}" xmlns:r="${REL_NS}"><sheets>
<sheet name="Report" sheetId="1" r:id="rId1"/>
<sheet name="Notes &amp; Log" sheetId="2" r:id="rId2"/>
</sheets></workbook>`;

    const workbookRels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="worksheet" Target="/xl/worksheets/sheet2.xml"/>
</Relationships>`;

    const sharedStrings = `<?xml version="1.0" encoding="UTF-8"?>
<sst xmlns="${SHEET_NS}" count="5" uniqueCount="5">
<si><t>Item</t></si>
<si><t>When</t></si>
<si><t>Amount</t></si>
<si><r><t>Rich </t></r><r><t>Text</t></r><rPh sb="0" eb="1"><t>PHONETIC</t></rPh></si>
<si><t>Note &amp; detail</t></si>
</sst>`;

    const sheet = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="${SHEET_NS}"><sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>
<row r="2"><c r="A2" t="s"><v>3</v></c><c r="B2" s="1"><v>45366</v></c><c r="C2"><v>1234.5</v></c></row>
<row r="3"><c r="A3" t="inlineStr"><is><t>Inline</t></is></c><c r="B3" s="1"><v>45366.5</v></c><c r="C3" t="b"><v>1</v></c></row>
<row r="4"><c r="A4" t="e"><v>#DIV/0!</v></c><c r="B4" t="str"><f>A1&amp;"x"</f><v>Itemx</v></c><c r="C4" t="s"><v>4</v></c></row>
</sheetData></worksheet>`;

    const secondSheet = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="${SHEET_NS}"><sheetData>
<row r="1"><c r="A1" t="inlineStr"><is><t>Only note</t></is></c></row>
</sheetData></worksheet>`;

    return buildZip([
        { name: 'xl/workbook.xml', data: workbook },
        { name: 'xl/_rels/workbook.xml.rels', data: workbookRels },
        { name: 'xl/styles.xml', data: XLSX_STYLES },
        { name: 'xl/sharedStrings.xml', data: sharedStrings },
        { name: 'xl/worksheets/sheet1.xml', data: sheet },
        { name: 'xl/worksheets/sheet2.xml', data: secondSheet },
    ]);
}

function buildPptx() {
    const presentation = `<?xml version="1.0" encoding="UTF-8"?>
<p:presentation xmlns:p="${PRESENTATION_NS}" xmlns:a="${DRAWING_NS}" xmlns:r="${REL_NS}">
<p:sldIdLst><p:sldId id="256" r:id="rId1"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst>
</p:presentation>`;

    const rels = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="slide" Target="slides/slide1.xml"/>
<Relationship Id="rId2" Type="slide" Target="slides/slide2.xml"/>
</Relationships>`;

    const slideOne = `<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:p="${PRESENTATION_NS}" xmlns:a="${DRAWING_NS}"><p:cSld><p:spTree>
<p:sp><p:txBody><a:p><a:r><a:t>Intro Slide</a:t></a:r></a:p><a:p><a:r><a:t>Welcome &amp; hello</a:t></a:r></a:p></p:txBody></p:sp>
<p:sp><p:txBody><a:p><a:fld id="{1}" type="slidenum"><a:t>1</a:t></a:fld></a:p></p:txBody></p:sp>
</p:spTree></p:cSld></p:sld>`;

    const slideTwo = `<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:p="${PRESENTATION_NS}" xmlns:a="${DRAWING_NS}"><p:cSld><p:spTree>
<p:sp><p:txBody><a:p><a:r><a:t>Results</a:t></a:r></a:p></p:txBody></p:sp>
<p:graphicFrame><a:graphic><a:graphicData><a:tbl>
<a:tr><a:tc><a:txBody><a:p><a:r><a:t>Metric</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>Value</a:t></a:r></a:p></a:txBody></a:tc></a:tr>
<a:tr><a:tc><a:txBody><a:p><a:r><a:t>Revenue</a:t></a:r></a:p></a:txBody></a:tc><a:tc><a:txBody><a:p><a:r><a:t>12%</a:t></a:r></a:p></a:txBody></a:tc></a:tr>
</a:tbl></a:graphicData></a:graphic></p:graphicFrame>
</p:spTree></p:cSld></p:sld>`;

    return buildZip([
        { name: 'ppt/presentation.xml', data: presentation },
        { name: 'ppt/_rels/presentation.xml.rels', data: rels },
        { name: 'ppt/slides/slide1.xml', data: slideOne },
        { name: 'ppt/slides/slide2.xml', data: slideTwo },
    ]);
}

const ODF_TEXT_NS =
    'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" ' +
    'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" ' +
    'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" ' +
    'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"';

function buildOdt() {
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content ${ODF_TEXT_NS}><office:scripts/>
<office:automatic-styles><style:style xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"/></office:automatic-styles>
<office:body><office:text>
<text:h text:outline-level="1">Heading One</text:h>
<text:p>First paragraph with<text:s text:c="3"/>extra spacing.</text:p>
<text:list><text:list-item><text:p>Bullet one</text:p></text:list-item><text:list-item><text:p>Bullet two</text:p></text:list-item></text:list>
<table:table table:name="Table1">
<table:table-row><table:table-cell><text:p>Col A</text:p></table:table-cell><table:table-cell><text:p>Col B</text:p></table:table-cell></table:table-row>
<table:table-row><table:table-cell><text:p>1</text:p></table:table-cell><table:table-cell><text:p>2</text:p></table:table-cell></table:table-row>
</table:table>
</office:text></office:body></office:document-content>`;

    return buildZip([
        { name: 'mimetype', data: 'application/vnd.oasis.opendocument.text', store: true },
        { name: 'content.xml', data: content },
    ]);
}

function buildOds() {
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content ${ODF_TEXT_NS}><office:body><office:spreadsheet>
<table:table table:name="Revenue">
<table:table-row><table:table-cell office:value-type="string"><text:p>Quarter</text:p></table:table-cell><table:table-cell office:value-type="string"><text:p>Total</text:p></table:table-cell></table:table-row>
<table:table-row><table:table-cell office:value-type="string"><text:p>Q1</text:p></table:table-cell><table:table-cell office:value-type="float" office:value="100"><text:p>100</text:p></table:table-cell></table:table-row>
</table:table>
<table:table table:name="Costs">
<table:table-row><table:table-cell office:value-type="string"><text:p>Item</text:p></table:table-cell><table:table-cell table:number-columns-repeated="2"/><table:table-cell office:value-type="string"><text:p>Cost</text:p></table:table-cell></table:table-row>
<table:table-row><table:table-cell office:value-type="string"><text:p>Cloud</text:p></table:table-cell><table:table-cell/><table:table-cell/><table:table-cell office:value-type="float" office:value="500"><text:p>500</text:p></table:table-cell></table:table-row>
</table:table>
</office:spreadsheet></office:body></office:document-content>`;

    return buildZip([{ name: 'content.xml', data: content }]);
}

function buildOdp() {
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content ${ODF_TEXT_NS}><office:body><office:presentation>
<draw:page draw:name="page1"><draw:frame><draw:text-box><text:p>Slide one body</text:p></draw:text-box></draw:frame></draw:page>
<draw:page draw:name="page2"><draw:frame><draw:text-box><text:p>Slide two body</text:p></draw:text-box></draw:frame></draw:page>
</office:presentation></office:body></office:document-content>`;

    return buildZip([{ name: 'content.xml', data: content }]);
}

const tests = [
    // ── Registry ───────────────────────────────────────────────────────────

    [
        'registry: recognises Office, OpenDocument and legacy extensions',
        () => {
            for (const extension of [
                'docx',
                'docm',
                'xlsx',
                'xlsm',
                'pptx',
                'ppsx',
                'odt',
                'ods',
                'odp',
                'odg',
                'csv',
                'tsv',
                'rtf',
            ]) {
                assert(isOfficeExtension(extension), `${extension} is an office format`);
            }
            for (const extension of ['doc', 'xls', 'ppt']) {
                assert(!isOfficeExtension(extension), `${extension} is legacy, not native`);
                assert(isLegacyOfficeExtension(extension), `${extension} is legacy`);
            }
            assert(!isOfficeExtension('wpd'), 'wpd is unsupported');
            assertEqual(getOfficeFamily('DOCX'), 'word', 'family lookup lower-cases');
            assert(listOfficeExtensions('sheet').includes('xlsx'), 'sheet family lists xlsx');
        },
    ],

    // ── ZIP reader ─────────────────────────────────────────────────────────

    [
        'OfficeZipArchive: reads deflated and stored entries',
        () => {
            const archive = new OfficeZipArchive(
                buildZip([
                    { name: 'deflated.txt', data: 'compressed payload' },
                    { name: 'stored.txt', data: 'stored payload', store: true },
                ]),
            );
            assertEqual(archive.readText('deflated.txt'), 'compressed payload', 'deflated entry');
            assertEqual(archive.readText('stored.txt'), 'stored payload', 'stored entry');
            assertEqual(archive.readText('missing.txt'), null, 'missing entry returns null');
            assert(
                OfficeZipArchive.looksLikeZip(buildZip([{ name: 'a', data: 'a' }])),
                'looks like zip',
            );
            assert(!OfficeZipArchive.looksLikeZip(new Uint8Array([1, 2, 3, 4])), 'not a zip');
        },
    ],

    [
        'OfficeZipArchive: rejects encrypted entries',
        () => {
            const archive = new OfficeZipArchive(
                buildZip([{ name: 'secret.xml', data: '<x/>', encrypted: true }]),
            );
            assertThrows(
                () => archive.readText('secret.xml'),
                'Password-protected',
                'encrypted entry rejected',
            );
        },
    ],

    // ── DOCX ───────────────────────────────────────────────────────────────

    [
        'extractOfficeText: docx headings, paragraphs, lists and tables',
        () => {
            const text = extractOfficeText(buildDocx(), 'docx');
            assert(text.includes('# Quarterly Report'), 'heading rendered as Markdown');
            assert(text.includes('Revenue grew 12% & up \u00e9'), 'entities decoded');
            assert(text.includes('- Alpha\n- Beta'), 'list items grouped');
            assert(
                text.includes(
                    '| Region | Sales |\n| --- | --- |\n| North | 100 |\n| South | 200 |',
                ),
                'table rendered as Markdown',
            );
            assert(
                text.indexOf('- Alpha') < text.indexOf('| Region |'),
                'list stays before the table',
            );
            assert(text.includes('Line A\nLine B'), 'line break preserved');
            assert(!text.includes('removed text'), 'tracked deletions skipped');
            assert(text.includes('kept text'), 'kept text present');
        },
    ],

    [
        'extractOfficeText: docx without document.xml throws a clear error',
        () => {
            const bytes = buildZip([{ name: 'word/styles.xml', data: '<x/>' }]);
            assertThrows(
                () => extractOfficeText(bytes, 'docx'),
                'document.xml',
                'missing part reported',
            );
        },
    ],

    // ── XLSX ───────────────────────────────────────────────────────────────

    [
        'extractOfficeText: xlsx renders every sheet as a Markdown table',
        () => {
            const text = extractOfficeText(buildXlsx(), 'xlsx');
            assert(text.includes('## Sheet: Report'), 'first sheet heading');
            assert(text.includes('## Sheet: Notes & Log'), 'second sheet heading (entity decoded)');
            assert(
                text.includes('| Item | When | Amount |\n| --- | --- | --- |'),
                'header row rendered',
            );
            assert(text.includes('| Rich Text | 2024-03-15 | 1234.5 |'), 'shared strings + date');
            assert(
                text.includes('| Inline | 2024-03-15 12:00 | TRUE |'),
                'inline string + datetime + boolean',
            );
            assert(
                text.includes('| #DIV/0! | Itemx | Note & detail |'),
                'errors and formula results',
            );
            assert(text.includes('| Only note |'), 'second sheet content');
        },
    ],

    [
        'extractOfficeText: xlsx honours the 1904 date system',
        () => {
            const serial = (Date.UTC(2024, 2, 15) - Date.UTC(1904, 0, 1)) / 86400000;
            const bytes = buildZip([
                {
                    name: 'xl/workbook.xml',
                    data: `<?xml version="1.0"?><workbook xmlns="${SHEET_NS}" xmlns:r="${REL_NS}"><workbookPr date1904="1"/><sheets><sheet name="Dates" sheetId="1" r:id="rId1"/></sheets></workbook>`,
                },
                {
                    name: 'xl/_rels/workbook.xml.rels',
                    data: `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
                },
                {
                    name: 'xl/styles.xml',
                    data: `<?xml version="1.0"?><styleSheet xmlns="${SHEET_NS}"><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14"/></cellXfs></styleSheet>`,
                },
                {
                    name: 'xl/worksheets/sheet1.xml',
                    data: `<?xml version="1.0"?><worksheet xmlns="${SHEET_NS}"><sheetData><row r="1"><c r="A1" s="1"><v>${serial}</v></c></row></sheetData></worksheet>`,
                },
            ]);
            const text = extractOfficeText(bytes, 'xlsx');
            assert(text.includes('| 2024-03-15 |'), '1904-based serial converted to a date');
        },
    ],

    [
        'extractOfficeText: xlsx without workbook.xml throws',
        () => {
            assertThrows(
                () =>
                    extractOfficeText(buildZip([{ name: 'xl/styles.xml', data: '<x/>' }]), 'xlsx'),
                'workbook.xml',
                'missing workbook part reported',
            );
        },
    ],

    // ── PPTX ───────────────────────────────────────────────────────────────

    [
        'extractOfficeText: pptx renders slides in presentation order',
        () => {
            const text = extractOfficeText(buildPptx(), 'pptx');
            assert(text.includes('## Slide 1'), 'first slide heading');
            assert(text.includes('Intro Slide'), 'first slide body');
            assert(text.includes('Welcome & hello'), 'entity decoded on slide');
            assert(!text.includes('\n1\n'), 'slide-number placeholder skipped');
            assert(text.includes('## Slide 2'), 'second slide heading');
            assert(
                text.includes('| Metric | Value |\n| --- | --- |\n| Revenue | 12% |'),
                'slide table rendered',
            );
            assert(
                text.indexOf('## Slide 1') < text.indexOf('## Slide 2'),
                'slide order preserved',
            );
        },
    ],

    // ── ODF ────────────────────────────────────────────────────────────────

    [
        'extractOfficeText: odt headings, lists, spacing and tables',
        () => {
            const text = extractOfficeText(buildOdt(), 'odt');
            assert(text.includes('# Heading One'), 'heading rendered');
            assert(text.includes('First paragraph with extra spacing.'), 'text:s collapsed');
            assert(text.includes('- Bullet one\n- Bullet two'), 'list items rendered');
            assert(
                text.indexOf('- Bullet one') < text.indexOf('| Col A |'),
                'list stays before the table',
            );
            assert(text.includes('| Col A | Col B |\n| --- | --- |\n| 1 | 2 |'), 'table rendered');
        },
    ],

    [
        'extractOfficeText: odt text frames keep the surrounding paragraph text',
        () => {
            const content = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content ${ODF_TEXT_NS}><office:body><office:text>
<text:p>Before frame <draw:frame><draw:text-box><text:p>Inner note</text:p></draw:text-box></draw:frame> after frame</text:p>
<text:p>Next paragraph</text:p>
</office:text></office:body></office:document-content>`;
            const text = extractOfficeText(
                buildZip([{ name: 'content.xml', data: content }]),
                'odt',
            );
            for (const needle of ['Before frame', 'Inner note', 'after frame', 'Next paragraph']) {
                assert(text.includes(needle), `${needle} preserved`);
            }
        },
    ],

    [
        'extractOfficeText: ods splits sheets and honours repeated cells',
        () => {
            const text = extractOfficeText(buildOds(), 'ods');
            assert(text.includes('## Sheet: Revenue'), 'first sheet heading');
            assert(text.includes('## Sheet: Costs'), 'second sheet heading');
            assert(text.includes('| Item |  |  | Cost |'), 'repeated empty columns preserved');
            assert(text.includes('| Cloud |  |  | 500 |'), 'sparse row aligned');
        },
    ],

    [
        'extractOfficeText: odp renders slide headings',
        () => {
            const text = extractOfficeText(buildOdp(), 'odp');
            assert(text.includes('## Slide 1'), 'first slide heading');
            assert(text.includes('Slide one body'), 'first slide body');
            assert(text.includes('## Slide 2'), 'second slide heading');
        },
    ],

    [
        'extractOfficeText: flat ODF (.fods) is read as plain XML',
        () => {
            const xml = `<?xml version="1.0" encoding="UTF-8"?>
<office:document ${ODF_TEXT_NS}><office:body><office:spreadsheet>
<table:table table:name="Flat"><table:table-row><table:table-cell><text:p>Cell</text:p></table:table-cell></table:table-row></table:table>
</office:spreadsheet></office:body></office:document>`;
            const text = extractOfficeText(new TextEncoder().encode(xml), 'fods');
            assert(text.includes('## Sheet: Flat'), 'flat sheet heading');
            assert(text.includes('| Cell |'), 'flat cell content');
        },
    ],

    // ── CSV / TSV ──────────────────────────────────────────────────────────

    [
        'parseDelimitedText: quotes, embedded delimiters and newlines',
        () => {
            const csv = 'Name,Note\n"Smith, Jane","Said ""hi""\nthen left"\n';
            const text = parseDelimitedText(csv, 'csv');
            assert(text.includes('| Name | Note |'), 'header rendered');
            assert(
                text.includes('| Smith, Jane | Said "hi" then left |'),
                'quoted fields unescaped',
            );
        },
    ],

    [
        'parseDelimitedText: semicolons are sniffed when they dominate',
        () => {
            const text = parseDelimitedText('a;b;c\n1;2;3\n', 'csv');
            assert(text.includes('| a | b | c |'), 'semicolon-delimited header');
            assert(text.includes('| 1 | 2 | 3 |'), 'semicolon-delimited row');
        },
    ],

    [
        'parseDelimitedText: TSV and BOM handling',
        () => {
            const text = parseDelimitedText('\uFEFFa\tb\n1\t2\n', 'tsv');
            assert(text.includes('| a | b |'), 'tab-separated header');
            assert(!text.includes('\uFEFF'), 'BOM stripped');
        },
    ],

    [
        'parseDelimitedText: an oversized single cell keeps its leading text',
        () => {
            const huge = 'x'.repeat(300000);
            const text = parseDelimitedText(`"${huge}"`, 'csv');
            assert(text.length > 0, 'table is not dropped');
            assert(text.startsWith('| xxx'), 'leading cell text preserved');
            assert(text.includes('truncated by Katab'), 'truncation is reported');
        },
    ],

    // ── RTF ────────────────────────────────────────────────────────────────

    [
        'rtfToText: control words, escapes and ignorable destinations',
        () => {
            const rtf =
                '{\\rtf1\\ansi\\ansicpg1252{\\fonttbl{\\f0 Times;}}{\\*\\generator Katab;}' +
                "Hello \\{world\\}\\par Second \\'e9 line\\tab end}";
            const text = rtfToText(rtf);
            assert(text.includes('Hello {world}'), 'escaped braces restored');
            assert(text.includes('Second \u00e9 line\tend'), 'codepage escapes decoded');
            assert(!text.includes('Times'), 'font table skipped');
            assert(!text.includes('Katab;'), 'ignorable destination skipped');
        },
    ],

    [
        'rtfToText: unicode escape swallows its fallback character only',
        () => {
            const rtf = "{\\rtf1\\ansi{\\listtext\\u8226\\'95\\tab}Alpha\\par Beta}";
            const text = rtfToText(rtf);
            assert(text.includes('\u2022'), 'bullet unicode escape decoded');
            assert(text.includes('Alpha'), 'word after the fallback survives');
            assert(!text.includes('\ufffd'), 'no replacement characters');
        },
    ],

    [
        'rtfToText: a document-level \\uc1 does not eat the first character',
        () => {
            const text = rtfToText('{\\rtf1\\ansi\\uc1 Hello world}');
            assertEqual(text, 'Hello world', 'text after \\uc1 untouched');
        },
    ],

    [
        'rtfToText: \\uc0 disables fallback skipping',
        () => {
            const text = rtfToText('{\\rtf1\\ansi\\uc0\\u8226 Next}');
            // The space after \u8226 terminates the control word, so "Next"
            // must follow the bullet directly with no swallowed letter.
            assertEqual(text, '\u2022Next', 'no fallback character is swallowed');
        },
    ],

    [
        'rtfToText: \\bin payload braces do not corrupt the group stack',
        () => {
            const rtf = '{\\rtf1\\ansi{\\pict\\bin3 {{{Hidden}Visible}';
            const text = rtfToText(rtf);
            assertEqual(text, 'Visible', 'text after the binary payload survives');
        },
    ],

    [
        'extractOfficeText: xlsx empty shared-string cell stays empty',
        () => {
            const bytes = buildZip([
                {
                    name: 'xl/workbook.xml',
                    data: `<?xml version="1.0"?><workbook xmlns="${SHEET_NS}" xmlns:r="${REL_NS}"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>`,
                },
                {
                    name: 'xl/_rels/workbook.xml.rels',
                    data: `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
                },
                {
                    name: 'xl/sharedStrings.xml',
                    data: `<?xml version="1.0"?><sst xmlns="${SHEET_NS}"><si><t>First</t></si></sst>`,
                },
                {
                    name: 'xl/worksheets/sheet1.xml',
                    data: `<?xml version="1.0"?><worksheet xmlns="${SHEET_NS}"><sheetData><row r="1"><c r="A1" t="s"><v></v></c><c r="B1" t="s"><v>0</v></c></row></sheetData></worksheet>`,
                },
            ]);
            const text = extractOfficeText(bytes, 'xlsx');
            assert(text.includes('|  | First |'), 'empty index does not resolve to entry 0');
        },
    ],

    [
        'extractOfficeText: xlsx caps very large sheets with a truncation note',
        () => {
            const rows = [];
            for (let index = 1; index <= 3200; index++) {
                rows.push(
                    `<row r="${index}"><c r="A${index}" t="inlineStr"><is><t>Row ${index}</t></is></c></row>`,
                );
            }
            const bytes = buildZip([
                {
                    name: 'xl/workbook.xml',
                    data: `<?xml version="1.0"?><workbook xmlns="${SHEET_NS}" xmlns:r="${REL_NS}"><sheets><sheet name="Big" sheetId="1" r:id="rId1"/></sheets></workbook>`,
                },
                {
                    name: 'xl/_rels/workbook.xml.rels',
                    data: `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
                },
                {
                    name: 'xl/worksheets/sheet1.xml',
                    data: `<?xml version="1.0"?><worksheet xmlns="${SHEET_NS}"><sheetData>${rows.join('')}</sheetData></worksheet>`,
                },
            ]);
            const text = extractOfficeText(bytes, 'xlsx');
            assert(text.includes('Row 1'), 'first rows parsed');
            assert(!text.includes('Row 3200'), 'rows past the cap skipped');
            assert(text.includes('[...sheet truncated by Katab...]'), 'truncation note present');
        },
    ],

    [
        'extractOfficeText: docx text boxes keep the surrounding paragraph text',
        () => {
            const bytes = buildDocx(`<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="${WORD_NS}"><w:body>
<w:p><w:r><w:t>Before </w:t></w:r><w:r><w:pict><v:textbox xmlns:v="urn:schemas-microsoft-com:vml"><w:txbxContent><w:p><w:r><w:t>Inner</w:t></w:r></w:p></w:txbxContent></v:textbox></w:pict></w:r><w:r><w:t>After</w:t></w:r></w:p>
</w:body></w:document>`);
            const text = extractOfficeText(bytes, 'docx');
            assert(text.includes('Before'), 'text before the text box survives');
            assert(text.includes('Inner'), 'text box content extracted');
            assert(text.includes('After'), 'text after the text box survives');
        },
    ],

    [
        'extractOfficeText: repeated empty ODF cells do not widen the table',
        () => {
            const content = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content ${ODF_TEXT_NS}><office:body><office:spreadsheet>
<table:table table:name="Narrow">
<table:table-row><table:table-cell office:value-type="string"><text:p>Heading</text:p></table:table-cell><table:table-cell table:number-columns-repeated="256"/></table:table-row>
<table:table-row><table:table-cell office:value-type="string"><text:p>Value</text:p></table:table-cell><table:table-cell table:number-columns-repeated="256"/></table:table-row>
</table:table>
</office:spreadsheet></office:body></office:document-content>`;
            const text = extractOfficeText(
                buildZip([{ name: 'content.xml', data: content }]),
                'ods',
            );
            const tableLines = text.split('\n').filter((line) => line.startsWith('|'));
            assertEqual(tableLines.length, 3, 'header, separator and one data row');
            for (const line of tableLines) {
                assertEqual(line.split('|').length - 2, 1, `single column: ${line}`);
            }
        },
    ],

    [
        'extractOfficeText: ods self-closing empty table does not swallow later sheets',
        () => {
            const content = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content ${ODF_TEXT_NS}><office:body><office:spreadsheet>
<table:table table:name="Empty"/>
<table:table table:name="Real"><table:table-row><table:table-cell><text:p>Value</text:p></table:table-cell></table:table-row></table:table>
</office:spreadsheet></office:body></office:document-content>`;
            const text = extractOfficeText(
                buildZip([{ name: 'content.xml', data: content }]),
                'ods',
            );
            assert(text.includes('## Sheet: Empty'), 'empty sheet heading');
            assert(text.includes('## Sheet: Real'), 'following sheet still parsed');
            assert(text.includes('| Value |'), 'following sheet content present');
        },
    ],

    [
        'extractOfficeText: odt self-closing empty list does not turn text into bullets',
        () => {
            const content = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content ${ODF_TEXT_NS}><office:body><office:text>
<text:list/><text:p>Plain paragraph</text:p>
</office:text></office:body></office:document-content>`;
            const text = extractOfficeText(
                buildZip([{ name: 'content.xml', data: content }]),
                'odt',
            );
            assertEqual(text, 'Plain paragraph', 'paragraph not rendered as a list item');
        },
    ],

    [
        'extractOfficeText: Markdown tables escape backslashes before pipes',
        () => {
            const bytes = buildDocx(
                `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="${WORD_NS}"><w:body><w:tbl>
<w:tr><w:tc><w:p><w:r><w:t>Path</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:p><w:r><w:t>C:\\temp|x</w:t></w:r></w:p></w:tc></w:tr>
</w:tbl></w:body></w:document>`,
            );
            const text = extractOfficeText(bytes, 'docx');
            assert(text.includes('C:\\\\temp\\|x'), 'backslash escaped and pipe escaped');
        },
    ],

    // ── Errors ─────────────────────────────────────────────────────────────

    [
        'extractOfficeText: non-ZIP bytes and unknown extensions throw OfficeParseError',
        () => {
            assertThrows(
                () => extractOfficeText(new TextEncoder().encode('plain text'), 'docx'),
                'not a valid Office document',
                'renamed/corrupt container rejected',
            );
            let error = null;
            try {
                extractOfficeText(new TextEncoder().encode('x'), 'wpd');
            } catch (e) {
                error = e;
            }
            assert(error instanceof OfficeParseError, 'unknown extension throws OfficeParseError');
            assertEqual(error.code, 'unsupported-extension', 'error code');
        },
    ],

    [
        'decodeTextBytes: decodes UTF-16 BOM content',
        () => {
            const utf16 = new Uint8Array([0xff, 0xfe, 0x41, 0x00, 0x42, 0x00]);
            assertEqual(decodeTextBytes(utf16), 'AB', 'UTF-16LE decoded');
        },
    ],

    // ── Runtime integration ────────────────────────────────────────────────

    [
        'DocumentToolRuntime: parses a docx attachment from disk',
        async () => {
            const directory = makeTempDir('katabai-docx-XXXXXX');
            try {
                const path = GLib.build_filenamev([directory, 'report.docx']);
                GLib.file_set_contents(path, buildDocx());
                const runtime = new DocumentToolRuntime();
                const document = await runtime.parseDocument(path, null);
                assertEqual(document.kind, 'document', 'document kind');
                assertEqual(document.extension, 'docx', 'extension');
                assertEqual(document.parserName, 'Katab Office reader', 'parser name');
                assert(document.text.includes('# Quarterly Report'), 'text extracted');
                assert(!document.truncated, 'short document not truncated');
            } finally {
                removeTempDir(directory);
            }
        },
    ],

    [
        'DocumentToolRuntime: caches parsed office files and rejects unsupported formats',
        async () => {
            const directory = makeTempDir('katabai-cache-XXXXXX');
            try {
                const path = GLib.build_filenamev([directory, 'book.xlsx']);
                GLib.file_set_contents(path, buildXlsx());
                const runtime = new DocumentToolRuntime();
                const first = await runtime.parseDocument(path, null);
                const second = await runtime.parseDocument(path, null);
                assertEqual(first.id, second.id, 'cached parse reused');

                const unsupported = GLib.build_filenamev([directory, 'archive.zip']);
                GLib.file_set_contents(unsupported, new Uint8Array([1, 2, 3]));
                let error = null;
                try {
                    await runtime.parseDocument(unsupported, null);
                } catch (e) {
                    error = e;
                }
                assert(
                    error instanceof DocumentToolError,
                    'unsupported file throws DocumentToolError',
                );
                assertEqual(error.code, 'unsupported-format', 'unsupported format code');
                assert(error.message.includes('xlsx'), 'error lists supported formats');
            } finally {
                removeTempDir(directory);
            }
        },
    ],
];

await runTests(tests);
