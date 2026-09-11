import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const source = await fs.readFile(new URL('../content.js', import.meta.url), 'utf8');
const hooks = {};
const context = vm.createContext({
  console,
  crypto: webcrypto,
  __FIMS_GRADUATION_RPA_TEST_HOOKS__: hooks,
  chrome: { runtime: { onMessage: { addListener() {} } } }
});
vm.runInContext(source, context, { filename: 'content.js' });

assert.equal(
  hooks.classifyTableHeaders(
    ['전체선택', '성명', '학번', '외국인등록번호', '체류기간만료일'],
    { hasRowCheck: true, hasAllCheck: true }
  ),
  'SEARCH_RESULTS',
  '초기 학생조회 표를 실제 신고 대기명단으로 분류하면 안 됩니다.'
);

assert.equal(
  hooks.classifyTableHeaders(
    ['전체선택', '성명', '학번', '사유발생일', '신고구분', '신고내용'],
    { hasRowCheck: true, hasAllCheck: true }
  ),
  'PENDING',
  '사유발생일과 신고구분이 있는 실제 유학생신고 목록만 대기명단이어야 합니다.'
);

assert.equal(
  hooks.classifyTableHeaders(
    ['전체선택', '성명', '학번'],
    { hasRowCheck: true, hasAllCheck: true }
  ),
  'OTHER'
);

assert.equal(hooks.checkboxTitleMatches('GIL FERRER NURIA', 'GIL FERRER NURIA'), true);
assert.equal(hooks.checkboxTitleMatches('  Gil   Ferrer Nuria ', 'GIL FERRER NURIA'), true);
assert.equal(hooks.checkboxTitleMatches('OTHER STUDENT', 'GIL FERRER NURIA'), false);
const capturedResultCheckbox = {
  closest: (selector) => selector === 'tr'
    ? { textContent: 'GIL FERRER NURIA 스페인 041019-882-0061 전자공학부 9517820253 입국 20260731' }
    : null
};
assert.equal(hooks.checkboxRowHasStudentNo(capturedResultCheckbox, '9517820253'), true,
  '수집한 결과 행에서 대상 학번을 정확히 확인해야 합니다.');
assert.equal(hooks.checkboxRowHasStudentNo(capturedResultCheckbox, '9517820999'), false,
  '성명이 같아도 학번이 다르면 선택하면 안 됩니다.');

function cell(text) {
  return { textContent: text, matches: (selector) => selector === 'th,td' };
}
function row(owner, text, cells) {
  return {
    textContent: text,
    children: cells,
    closest: (selector) => selector === 'table' ? owner : null,
    querySelector: () => null
  };
}

const outerTable = {};
const searchTable = {};
const outerRow = row(outerTable, '변동신고', [cell('변동신고')]);
const searchHeader = row(searchTable, '성명 학번 외국인등록번호 체류기간만료일', [
  cell(''), cell('성명'), cell('학번'), cell('외국인등록번호'), cell('체류기간만료일')
]);
const searchInput = { closest: (selector) => selector === 'table' ? searchTable : null };
outerTable.querySelectorAll = (selector) => {
  if (selector === 'tr') return [outerRow, searchHeader];
  if (selector.includes('checkYn')) return [searchInput];
  return [];
};
searchTable.querySelectorAll = (selector) => {
  if (selector === 'tr') return [searchHeader];
  if (selector.includes('checkYn')) return [searchInput];
  return [];
};

assert.equal(hooks.classifyTable(outerTable), 'OTHER',
  '바깥 레이아웃 표가 안쪽 조회표 체크박스를 소유한 것으로 판정되면 안 됩니다.');
assert.equal(hooks.classifyTable(searchTable), 'SEARCH_RESULTS',
  '실제 조회결과 표의 직접 소유 체크박스를 인식해야 합니다.');

const clickedMenuIds = [];
const fakeMenuElements = {
  nMenuTreeHome15: {
    matches: () => false,
    scrollIntoView() {},
    click() { clickedMenuIds.push('nMenuTreeHome15'); }
  },
  nMenuTreeHome16: {
    matches: () => false,
    scrollIntoView() {},
    click() { clickedMenuIds.push('nMenuTreeHome16'); }
  }
};
context.document = {
  querySelector(selector) {
    if (selector === '#nMenuTreeHome16') return fakeMenuElements.nMenuTreeHome16;
    if (selector === '#nMenuTreeHome15') return fakeMenuElements.nMenuTreeHome15;
    return null;
  },
  querySelectorAll() { return []; }
};
const menuClick = hooks.clickChangeMenu();
assert.equal(menuClick.ok, true);
assert.deepEqual(clickedMenuIds, ['nMenuTreeHome16'],
  '상위 토글 #nMenuTreeHome15가 아니라 실제 변동신고 링크 #nMenuTreeHome16만 클릭해야 합니다.');

console.log('content table-classification tests passed');
