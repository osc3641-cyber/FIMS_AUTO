// 1.0.5에서 고친 실사이트 결함에 대한 회귀 테스트.
// 각 테스트는 수집본(reference/*.json)에서 확인된 실제 FIMS 화면 구조를 기준으로 한다.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const source = await fs.readFile(new URL('../content.js', import.meta.url), 'utf8');

function element(spec = {}) {
  const node = {
    tagName: (spec.tag || 'input').toUpperCase(),
    value: spec.value ?? '',
    checked: spec.checked ?? false,
    hidden: false,
    title: spec.title ?? '',
    textContent: spec.textContent ?? '',
    innerText: spec.textContent ?? '',
    options: spec.options,
    selectedIndex: spec.selectedIndex ?? -1,
    matches: () => false,
    closest: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    getAttribute: () => null,
    getBoundingClientRect: () => ({ width: 10, height: 10 }),
    scrollIntoView() {},
    click() {},
    focus() {},
    dispatchEvent() { return true; }
  };
  return node;
}

function buildContext({ pathname, nodes = {}, bodyText = '' }) {
  const context = vm.createContext({
    console,
    crypto: webcrypto,
    setTimeout: (callback) => { callback(); return 1; },
    clearTimeout() {},
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    location: { href: `https://fims.hikorea.go.kr${pathname}`, pathname },
    window: { name: 'mainFrame' },
    document: {
      body: { innerText: bodyText, textContent: bodyText },
      querySelector: (selector) => nodes[selector] ?? null,
      querySelectorAll: () => []
    },
    chrome: { runtime: { onMessage: { addListener() {} } } }
  });
  context.globalThis = context;
  vm.runInContext(source, context, { filename: 'content.js' });
  return context.__FIMS_ARRIVAL_RPA_TEST_HOOKS__;
}

// ── 결함 1: 실제 수정화면 URL은 IntlStudBaInfoDtlRU.xec.
// 기존 정규식 /IntlStudBaInfo(?:DtlR|U)\.xec/ 는 DtlRU를 매칭하지 못했다.
for (const pathname of [
  '/isi/IntlStudBaInfoDtlRU.xec',
  '/isi/IntlStudBaInfoDtlR.xec',
  '/isi/IntlStudBaInfoU.xec'
]) {
  const hooks = buildContext({ pathname });
  const state = hooks.inspect();
  assert.equal(state.isStudentPageUrl, true, `${pathname} 을 학생 화면 URL로 인식해야 합니다.`);
  assert.equal(state.canVerifyArrival, true, `${pathname} 에서 저장 결과를 읽을 수 있어야 합니다.`);
}
assert.equal(buildContext({ pathname: '/isi/MainR.isi' }).inspect().isStudentPageUrl, false);

// 읽기전용 상세(DtlR)는 입력칸이 없고 수정/목록 링크만 있다 → 상세화면으로 판정
{
  const state = buildContext({ pathname: '/isi/IntlStudBaInfoDtlR.xec' }).inspect();
  assert.equal(state.hasArrivalEditForm, false);
  assert.equal(state.hasStudentDetailView, true);
}

// ── 결함 2: 저장 후 수정폼(DtlRU)에 그대로 남으면 본문에 "(입국)" 문구가 없을 수 있다.
// 그 경우에도 #entrYN=N + 읽기전용 #eYmd 날짜로 저장 성공을 인정해야 한다.
const editFormNodes = (eYmd) => ({
  '#ekNm': element({ value: 'SAMPLE SURNAME GIVEN MIDDLE' }),
  '#birthYmd': element({ value: '2000.03.04' }),
  '#scholNo': element({ value: '9900000002' }),
  '#admsnYmd': element({ value: '2026.09.01' }),
  '#eYmd': element({ value: eYmd }),
  '#entrYN': element({
    tag: 'select',
    value: 'N',
    options: [{ text: '선택' }, { text: '미입국' }, { text: '입국' }],
    selectedIndex: 2
  })
});
const student = { name: 'SAMPLE SURNAME, GIVEN MIDDLE', birthDate: '20000304' };

{
  // 저장 후: #eYmd에 날짜가 들어왔다 → 본문에 "(입국)"이 없어도 성공으로 확정
  const hooks = buildContext({
    pathname: '/isi/IntlStudBaInfoDtlRU.xec',
    nodes: editFormNodes('2026.09.01'),
    bodyText: 'SAMPLE SURNAME GIVEN MIDDLE 2000.03.04 유학생기본정보 수정'
  });
  const data = hooks.readDetailData(student);
  assert.equal(data.arrivalMarked, false, '수정폼 본문에는 (입국) 문구가 없다');
  assert.equal(data.arrivalConfirmed, true, '#entrYN=N + #eYmd 날짜로 저장 성공을 확인해야 합니다.');
  assert.equal(data.arrivalDate, '2026.09.01');
  assert.equal(data.arrivalCode, 'N');
  assert.equal(data.arrivalCodeText, '입국');
}

{
  // 저장 전: #eYmd는 서버가 채우므로 비어 있다 → 성공으로 오인하면 안 된다
  const hooks = buildContext({
    pathname: '/isi/IntlStudBaInfoDtlRU.xec',
    nodes: editFormNodes(''),
    bodyText: 'SAMPLE SURNAME GIVEN MIDDLE 2000.03.04 유학생기본정보 수정'
  });
  const data = hooks.readDetailData(student);
  assert.equal(data.arrivalConfirmed, false, '저장 전에는 저장 성공으로 판정하면 안 됩니다.');
}

{
  // 읽기전용 상세로 돌아간 경우: 본문의 "YYYY.MM.DD (입국)" 으로 확인
  const hooks = buildContext({
    pathname: '/isi/IntlStudBaInfoDtlR.xec',
    nodes: {},
    bodyText: 'SAMPLE SURNAME GIVEN MIDDLE 2000.03.04 입국일자 2026.09.01 (입국)'
  });
  const data = hooks.readDetailData(student);
  assert.equal(data.arrivalMarked, true);
  assert.equal(data.arrivalConfirmed, true);
  assert.equal(data.arrivalDate, '2026.09.01');
}

console.log('arrival regression test passed');
