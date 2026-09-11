import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// 예전에는 CODEX_PRIMARY_RUNTIME_NODE_MODULES 환경변수에만 의존해서
// 그 샌드박스 밖에서는 무조건 죽었다(=사실상 검증된 적이 없었다).
// 이제 환경변수 → 일반 node_modules 순으로 찾고, 없으면 명확히 건너뛴다.
function loadOptional(name) {
  const runtimeModules = process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES;
  if (runtimeModules) {
    try { return require(path.join(runtimeModules, name)); } catch (_) {}
  }
  try { return require(name); } catch (_) {}
  return null;
}

const JSZip = loadOptional('jszip');
const sax = loadOptional('sax');
if (!JSZip || !sax) {
  const missing = [!JSZip && 'jszip', !sax && 'sax'].filter(Boolean).join(', ');
  console.log(`SKIP test-workbook-roundtrip: ${missing} 미설치 (npm i -D jszip sax 후 재실행)`);
  process.exit(0);
}
const root = path.resolve(new URL('..', import.meta.url).pathname);

class XmlNode {
  constructor(name = '#document', attributes = {}) {
    this.name = name;
    this.localName = name.includes(':') ? name.split(':').at(-1) : name;
    this.attributes = attributes;
    this.children = [];
    this.textParts = [];
  }
  get textContent() {
    return this.textParts.join('') + this.children.map((child) => child.textContent).join('');
  }
  getAttribute(name) {
    return Object.hasOwn(this.attributes, name) ? String(this.attributes[name]) : null;
  }
  getAttributeNS(_namespace, localName) {
    const key = Object.keys(this.attributes).find((name) => name === localName || name.endsWith(`:${localName}`));
    return key ? String(this.attributes[key]) : null;
  }
  getElementsByTagNameNS(_namespace, localName) {
    const found = [];
    const visit = (node) => {
      for (const child of node.children) {
        if (child.localName === localName) found.push(child);
        visit(child);
      }
    };
    visit(this);
    return found;
  }
  querySelector(selector) {
    return selector === 'parsererror' ? null : null;
  }
}

class DOMParser {
  parseFromString(xml) {
    const documentNode = new XmlNode();
    const stack = [documentNode];
    const parser = sax.parser(true, { trim: false, normalize: false });
    parser.onopentag = (tag) => {
      const node = new XmlNode(tag.name, tag.attributes || {});
      stack.at(-1).children.push(node);
      stack.push(node);
    };
    parser.ontext = (text) => stack.at(-1).textParts.push(text);
    parser.oncdata = (text) => stack.at(-1).textParts.push(text);
    parser.onclosetag = () => stack.pop();
    parser.write(xml).close();
    return documentNode;
  }
}

const source = await fs.readFile(path.join(root, 'xlsx-lite.js'), 'utf8');
const context = vm.createContext({ console, JSZip, DOMParser, Blob, Date });
vm.runInContext(source, context, { filename: 'xlsx-lite.js' });
const FimsXlsx = context.FimsXlsx;

// 예전에는 ../outputs/fims_arrival_excel_1_0_2/ 를 하드코딩해서
// 그 빌드 폴더가 없는 체크아웃에서는 항상 죽었다. 확장 폴더 안의 템플릿을 먼저 본다.
const workbookCandidates = [
  path.join(root, '입국신고_업무파일.xlsx'),
  path.resolve(root, '../outputs/fims_arrival_excel_1_0_3/입국신고_업무파일.xlsx'),
  path.resolve(root, '../outputs/fims_arrival_excel_1_0_2/입국신고_업무파일.xlsx')
];
let workbookPath = null;
for (const candidate of workbookCandidates) {
  try { await fs.access(candidate); workbookPath = candidate; break; } catch (_) {}
}
if (!workbookPath) {
  console.log('SKIP test-workbook-roundtrip: 입국신고_업무파일.xlsx 템플릿을 찾지 못했습니다.');
  process.exit(0);
}
const originalBytes = await fs.readFile(workbookPath);
const zip = await JSZip.loadAsync(originalBytes);
const configXml = await zip.file('xl/worksheets/sheet1.xml').async('text');
assert.match(configXml, /r="B6"[^>]*t="str"[\s\S]*?<x:v>20260901<\/x:v>/);
const sheetPath = 'xl/worksheets/sheet2.xml';
let sheetXml = await zip.file(sheetPath).async('text');
const cells = [
  ['A5', 'Y'],
  ['B5', 'SAMPLE LONGNAME TESTCASE OVERFLOW ALPHA'],
  ['C5', '20000102'],
  ['D5', '0951112345'],
  ['E5', '왕복 테스트']
].map(([ref, value]) => `<x:c r="${ref}" t="inlineStr"><x:is><x:t>${value}</x:t></x:is></x:c>`).join('');
sheetXml = sheetXml.replace(/<x:row r="5"[^>]*>[\s\S]*?<\/x:row>/, `<x:row r="5">${cells}</x:row>`);
zip.file(sheetPath, sheetXml);
const testBytes = await zip.generateAsync({ type: 'uint8array' });
const parsed = await FimsXlsx.parseWorkbook({
  name: '입국신고_업무파일.xlsx',
  arrayBuffer: async () => testBytes.buffer.slice(testBytes.byteOffset, testBytes.byteOffset + testBytes.byteLength)
});

assert.equal(parsed.config.workType, '입국신고');
assert.equal(parsed.config.admissionDate, '2026.09.01');
assert.equal(parsed.students.length, 1);
assert.equal(parsed.students[0].name, 'SAMPLE LONGNAME TESTCASE OVERFLOW ALPHA');
assert.equal(parsed.students[0].birthDate, '2000.01.02');
assert.equal(parsed.students[0].studentNo, '0951112345');

const resultBlob = await FimsXlsx.exportResults(parsed.originalBytes, [{
  sequence: 1,
  name: parsed.students[0].name,
  birthDate: parsed.students[0].birthDate,
  studentNo: parsed.students[0].studentNo,
  stage: '저장 후 검증',
  result: '입국신고 완료',
  arrivalDate: '2026.08.24',
  note: '',
  detail: '2026.08.24 (입국) 확인',
  processedAt: '2026-09-08 16:00:00'
}]);
const outputZip = await JSZip.loadAsync(await resultBlob.arrayBuffer());
const resultXml = await outputZip.file('xl/worksheets/sheet3.xml').async('text');
assert.match(resultXml, /확인된 입국일자/);
assert.match(resultXml, /입국신고 완료/);
assert.match(resultXml, /2026\.08\.24/);
assert.match(resultXml, /2026\.08\.24 \(입국\) 확인/);

console.log('arrival workbook parse/export round-trip test passed');
