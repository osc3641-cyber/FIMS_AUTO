// 엑셀 선택 항목(현지추천단체·현지추천단체구분·최종출신학교)과
// 입학(복학)일자 형식 검증 테스트.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const source = await fs.readFile(new URL('../content.js', import.meta.url), 'utf8');

class FakeElement {}
const el = (props) => Object.assign(new FakeElement(), {
  tagName: 'INPUT', value: '', checked: false, hidden: false, title: '',
  textContent: '', innerText: '', defaultValue: '',
  matches: () => false, closest: () => null,
  querySelector: () => null, querySelectorAll: () => [],
  getAttribute: () => null, getBoundingClientRect: () => ({ width: 10, height: 10 }),
  scrollIntoView() {}, click() {}, focus() {}, dispatchEvent() { return true; }
}, props);

function select(options, value = '') {
  const node = el({ tagName: 'SELECT', value });
  node.options = options.map((o) => ({ value: o.value, text: o.text }));
  Object.defineProperty(node, 'selectedIndex', {
    get: () => node.options.findIndex((o) => o.value === node.value)
  });
  return node;
}

function build(nodes, bodyText = '') {
  const context = vm.createContext({
    console, crypto: webcrypto, Element: FakeElement,
    HTMLInputElement: FakeElement, HTMLSelectElement: class {}, HTMLTextAreaElement: class {},
    setTimeout: (cb) => { cb(); return 1; }, clearTimeout() {},
    InputEvent: class { constructor() {} }, Event: class { constructor() {} },
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    location: { href: 'https://fims.hikorea.go.kr/isi/IntlStudBaInfoDtlRU.xec', pathname: '/isi/IntlStudBaInfoDtlRU.xec' },
    window: { name: 'mainFrame' },
    document: {
      body: el({ innerText: bodyText, textContent: bodyText }),
      querySelector: (sel) => {
        for (const [key, node] of Object.entries(nodes)) {
          if (sel === key || sel.split(',').map((s) => s.trim()).includes(key)) return node;
        }
        return null;
      },
      querySelectorAll: () => []
    },
    chrome: { runtime: { onMessage: { addListener() {} } } }
  });
  context.globalThis = context;
  vm.runInContext(source, context, { filename: 'content.js' });
  return context.__FIMS_ARRIVAL_RPA_TEST_HOOKS__;
}

const TYPE_OPTIONS = [
  { value: '', text: '선택' },
  { value: '20', text: '대학자체현지모집' },
  { value: '30', text: '현지유학원추천' },
  { value: '40', text: '개인직접신청' },
  { value: '50', text: '현지자매학교추천' },
  { value: '90', text: '기타' }
];

// ── 엑셀 칸이 비어 있으면 FIMS 값을 건드리지 않는다
{
  const recommender = el({ value: 'Mainz University of Applied Sciences' });
  const lastSchool = el({ value: 'Mainz University' });
  const type = select(TYPE_OPTIONS, '50');
  const hooks = build({ '#lcRecomEntity': recommender, '#lastOriSchol': lastSchool, '#lcRecomEntityGb': type });

  const result = hooks.applyOptionalFields({});
  assert.deepEqual([...result.applied], [], '빈 칸은 아무것도 입력하지 않아야 합니다.');
  assert.deepEqual([...result.failed], []);
  assert.equal(recommender.value, 'Mainz University of Applied Sciences', 'FIMS 값이 그대로여야 합니다.');
  assert.equal(lastSchool.value, 'Mainz University');
  assert.equal(type.value, '50');
}

// ── "-" 를 적으면 그대로 덮어쓴다 (학위과정 학생)
{
  const recommender = el({ value: 'Mainz University of Applied Sciences' });
  const hooks = build({ '#lcRecomEntity': recommender });
  const result = hooks.applyOptionalFields({ localRecommender: '-' });
  assert.equal(recommender.value, '-');
  assert.ok([...result.applied].some((item) => item.includes('현지추천단체=-')));
}

// ── 콤보는 표시문자로도, 코드값으로도 고를 수 있어야 한다
{
  const type = select(TYPE_OPTIONS, '');
  const hooks = build({ '#lcRecomEntityGb': type });
  hooks.applyOptionalFields({ localRecommenderType: '현지자매학교추천' });
  assert.equal(type.value, '50', '표시문자로 선택되어야 합니다.');
}
{
  const type = select(TYPE_OPTIONS, '');
  const hooks = build({ '#lcRecomEntityGb': type });
  hooks.applyOptionalFields({ localRecommenderType: '50' });
  assert.equal(type.value, '50', '코드값으로도 선택되어야 합니다.');
}
{
  const type = select(TYPE_OPTIONS, '50');
  const hooks = build({ '#lcRecomEntityGb': type });
  const result = hooks.applyOptionalFields({ localRecommenderType: '없는항목' });
  assert.equal(type.value, '50', '선택지에 없으면 기존 값을 바꾸면 안 됩니다.');
  assert.ok([...result.failed].some((item) => item.includes('현지추천단체구분')));
}

// ── 입학(복학)일자는 점 있는 형식이어야 저장된다
// 예전 검증은 digits() 로 점을 떼고 비교해 20260901 을 통과시켰다.
{
  const stuck = el({ value: '20260901' });
  stuck.dispatchEvent = () => true;
  // setNativeValue 가 값을 바꾸지 못하는(FIMS가 되돌리는) 상황을 흉내낸다
  Object.defineProperty(stuck, 'value', { get: () => '20260901', set: () => {} });
  const hooks = build({
    '#scholNo': el({ value: '9611320267' }),
    '#entrYN': select([{ value: '', text: '선택' }, { value: 'Y', text: '미입국' }, { value: 'N', text: '입국' }], 'N'),
    '#admsnYmd': stuck,
    '#ekNm': el({ value: 'TEST STUDENT' }),
    '#birthYmd': el({ value: '2000.01.02' }),
    '#eYmd': el({ value: '' })
  }, 'TEST STUDENT 2000.01.02');

  const outcome = hooks.fillArrivalEdit({
    name: 'TEST STUDENT', birthDate: '20000102', studentNo: '9611320267', admissionDate: '20260901'
  });
  assert.equal(outcome.ok, false, '점 없는 형식은 통과시키면 안 됩니다.');
  assert.match(outcome.message, /형식으로 남아 있습니다/);
  assert.match(outcome.message, /2026\.09\.01/);
}

console.log('optional fields tests passed');
