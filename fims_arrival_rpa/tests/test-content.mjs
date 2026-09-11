import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const source = await fs.readFile(new URL('../content.js', import.meta.url), 'utf8');
const context = vm.createContext({
  console,
  crypto: webcrypto,
  setTimeout: (callback) => { callback(); return 1; },
  clearTimeout() {},
  location: { href: 'https://fims.hikorea.go.kr/isi/IntlStudBaInfoU.xec', pathname: '/isi/IntlStudBaInfoU.xec' },
  document: {
    body: { innerText: '', textContent: '' },
    querySelector: () => null,
    querySelectorAll: () => []
  },
  chrome: { runtime: { onMessage: { addListener() {} } } }
});
context.globalThis = context;
vm.runInContext(source, context, { filename: 'content.js' });
const hooks = context.__FIMS_ARRIVAL_RPA_TEST_HOOKS__;

assert.equal(hooks.normalizeFimsName('SAMPLE LONGNAME TESTCASE OVERFLOW ALPHA'), 'SAMPLE LONGNAME TESTCASE OVERFLOW ALPH');
assert.equal(hooks.sameFimsName('SAMPLE LONGNAME TESTCASE OVERFLOW ALPHA', 'SAMPLE LONGNAME TESTCASE OVERFLOW ALPH'), true);
assert.equal(hooks.normalizeFimsName('SAMPLE SURNAME, GIVEN MIDDLE'), 'SAMPLE SURNAME GIVEN MIDDLE');
assert.equal(hooks.sameFimsName('SAMPLE SURNAME, GIVEN MIDDLE', 'SAMPLE SURNAME GIVEN MIDDLE'), true);
assert.equal(hooks.sameFimsName('SAMPLE BETA', 'XING HAQ'), false);
assert.equal(hooks.formatDate('20260901'), '2026.09.01');
assert.equal(hooks.resultNameMatches('SAMPLE SUR...', 'SAMPLE SURNAME GIVEN MIDDLE'), true);
assert.equal(hooks.resultNameMatches('OTHER STUDENT', 'SAMPLE SURNAME GIVEN MIDDLE'), false);

const truncated = hooks.resolveDetailCandidate({
  criteriaMatch: true,
  candidates: [{ index: 0, name: 'SAMPLE SUR...' }],
  noResult: false,
  expectedName: 'SAMPLE SURNAME GIVEN MIDDLE'
});
assert.equal(truncated.state, 'FOUND');
assert.equal(truncated.target.index, 0);
assert.equal(truncated.matchStrategy, 'name-match');

const singleDetailLink = hooks.resolveDetailCandidate({
  criteriaMatch: true,
  candidates: [{ index: 0, name: '' }],
  noResult: false,
  expectedName: 'TEST STUDENT'
});
assert.equal(singleDetailLink.state, 'FOUND');
assert.equal(singleDetailLink.target.index, 0);
assert.equal(singleDetailLink.matchStrategy, 'single-detail-link');

const ambiguousUnmatched = hooks.resolveDetailCandidate({
  criteriaMatch: true,
  candidates: [{ index: 0, name: 'ONE' }, { index: 1, name: 'TWO' }],
  noResult: false,
  expectedName: 'TEST STUDENT'
});
assert.equal(ambiguousUnmatched.state, 'NOT_FOUND');

const commaSearchFlow = vm.runInContext(`(() => {
  Event = class Event { constructor(type) { this.type = type; } };
  InputEvent = class InputEvent extends Event {};
  Element = class Element {
    constructor() { this.hidden = false; }
    getBoundingClientRect() { return {width: 100, height: 20}; }
    scrollIntoView() {}
  };
  HTMLInputElement = class HTMLInputElement extends Element {
    constructor() {
      super();
      this._value = '';
      this.checked = false;
      this.events = [];
    }
    get value() { return this._value; }
    set value(next) { this._value = String(next); }
    focus() {}
    dispatchEvent(event) { this.events.push(event.type); return true; }
    click() { this.checked = !this.checked; }
  };
  HTMLTextAreaElement = class HTMLTextAreaElement extends Element {};
  HTMLSelectElement = class HTMLSelectElement extends Element {};
  getComputedStyle = () => ({display:'block',visibility:'visible'});

  const nameInput = new HTMLInputElement();
  const birthInput = new HTMLInputElement();
  const similar = new HTMLInputElement();
  const searchButton = new Element();
  searchButton.clicks = 0;
  searchButton.click = () => { searchButton.clicks += 1; };
  const form = {
    querySelector: (selector) => selector.includes('fncSearchPage') ? searchButton : null
  };
  nameInput.closest = () => form;
  document.querySelector = (selector) => ({
    '#sEkNm': nameInput,
    '#sBirthYmd': birthInput,
    '#sLikeYn': similar
  })[selector] || null;
  document.querySelectorAll = () => [];

  const result = __FIMS_ARRIVAL_RPA_TEST_HOOKS__.prepareArrivalSearch({
    name: 'SAMPLE SURNAME, GIVEN MIDDLE',
    birthDate: '20000304'
  });
  return {
    result,
    name: nameInput.value,
    birthDate: birthInput.value,
    similar: similar.checked,
    clicks: searchButton.clicks
  };
})()`, context);
assert.equal(commaSearchFlow.result.ok, true);
assert.equal(commaSearchFlow.name, 'SAMPLE SURNAME GIVEN MIDDLE');
assert.equal(commaSearchFlow.birthDate, '2000.03.04');
assert.equal(commaSearchFlow.similar, true);
assert.equal(commaSearchFlow.clicks, 1);

const fields = new Map([
  ['#ekNm', { value: 'TEST STUDENT' }],
  ['#birthYmd', { value: '2000.01.02' }],
  ['#scholNo', { value: '9511123456' }],
  ['#admsnYmd', { value: '2026.09.01' }],
  ['#eYmd', { value: '2026.08.24' }]
]);
context.document.body.innerText = '성명 TEST STUDENT 생년월일 2000.01.02 학번 9511123456 입국일자 2026.08.24  (입국)';
context.document.querySelector = (selector) => fields.get(selector) || null;
const verified = hooks.readDetailData({ name: 'TEST STUDENT', birthDate: '20000102' });
assert.equal(verified.nameMatches, true);
assert.equal(verified.birthDateMatches, true);
assert.equal(verified.arrivalDate, '2026.08.24');
assert.equal(verified.arrivalMarked, true);

context.document.body.innerText = '성명 TEST STUDENT 생년월일 2000.01.02 입국일자';
fields.set('#eYmd', { value: '' });
const missing = hooks.readDetailData({ name: 'TEST STUDENT', birthDate: '20000102' });
assert.equal(missing.arrivalDate, '');
assert.equal(missing.arrivalMarked, false);

console.log('arrival content tests passed');
