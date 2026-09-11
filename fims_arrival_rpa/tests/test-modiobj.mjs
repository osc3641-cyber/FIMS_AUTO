// 재학생정보 수정대상자(별도처리) 흐름 테스트.
// 이 화면은 실제로 FIMS에 값을 쓰므로, "엑셀 명단의 그 학생이 정확히 1건일 때만
// 진행하고 그 외에는 아무것도 누르지 않는다"는 규칙을 여기서 잠근다.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const source = await fs.readFile(new URL('../content.js', import.meta.url), 'utf8');

const ICRM_LINK = 'a[onclick*="fncGetICRMDetail"], a[title="수정(새창열림)"]';
const RADIO = 'input[name="checkYn"]';
const UPDATE = 'a[onclick*="fncUpdate"]';

class FakeElement {}

function asElement(properties) {
  return Object.assign(new FakeElement(), properties);
}

// 실제 수정대상자 목록은 성명·생년월일·등록번호를 <input> 으로 보여준다.
// innerText 에는 그 값들이 없다. 이 구조를 그대로 흉내내야 의미 있는 테스트가 된다.
function makeRow(text, fieldValues = []) {
  const fields = fieldValues.map((value) => asElement({ tagName: 'INPUT', value, getAttribute: () => null }));
  return asElement({
    tagName: 'TR',
    innerText: text,
    textContent: text,
    querySelectorAll: (selector) => (selector === 'input,select,textarea' ? fields : [])
  });
}
function makeLink(row) {
  return asElement({
    tagName: 'A', value: '', title: '', textContent: '', innerText: '', hidden: false,
    closest: (sel) => (sel === 'tr' ? row : null),
    matches: () => false, getAttribute: () => null,
    getBoundingClientRect: () => ({ width: 10, height: 10 }),
    scrollIntoView() {}, click() { this.clicked = true; }, focus() {}, dispatchEvent() { return true; }
  });
}
function makeRadio(row, title) {
  return asElement({
    tagName: 'INPUT', type: 'radio', name: 'checkYn', title, value: 'on', checked: false, hidden: false,
    closest: (sel) => (sel === 'tr' ? row : null),
    matches: () => false, getAttribute: () => null,
    getBoundingClientRect: () => ({ width: 10, height: 10 }),
    scrollIntoView() {}, click() { this.checked = true; }, focus() {}, dispatchEvent() { return true; }
  });
}

function build({ rows = [], radios = [], bodyText = '', bodyFields = [], hasUpdate = true, pathname = '/isi/IntlStudInfoR.xec' }) {
  const links = rows.map((row) => makeLink(
    typeof row === 'string' ? makeRow(row) : makeRow(row.text || '', row.fields || [])
  ));
  const radioNodes = radios.map(({ text, fields, title }) => makeRadio(makeRow(text, fields || []), title));
  const updateButton = hasUpdate ? makeLink(makeRow('')) : null;
  const bodyNode = makeRow(bodyText, bodyFields);
  const context = vm.createContext({
    console, crypto: webcrypto,
    setTimeout: (cb) => { cb(); return 1; }, clearTimeout() {},
    Element: FakeElement,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
    location: { href: `https://fims.hikorea.go.kr${pathname}`, pathname },
    window: { name: 'mainFrame' },
    document: {
      body: bodyNode,
      querySelector: (sel) => {
        if (sel === UPDATE) return updateButton;
        if (sel === RADIO) return radioNodes[0] || null;
        return null;
      },
      querySelectorAll: (sel) => {
        if (sel === ICRM_LINK) return links;
        if (sel === RADIO) return radioNodes;
        return [];
      }
    },
    chrome: { runtime: { onMessage: { addListener() {} } } }
  });
  context.globalThis = context;
  vm.runInContext(source, context, { filename: 'content.js' });
  return { hooks: context.__FIMS_ARRIVAL_RPA_TEST_HOOKS__, links, radioNodes, updateButton };
}

const student = { name: 'AVAR, YAGMUR', birthDate: '20041213', studentNo: '9623820262' };

// ── 날짜 토큰 판정
{
  const { hooks } = build({});
  assert.equal(hooks.containsDateToken('생년월일 2004.12.13 입니다', '20041213'), true);
  assert.equal(hooks.containsDateToken('20041213', '20041213'), true);
  assert.equal(hooks.containsDateToken('2004-12-13', '20041213'), true);
  // 숫자가 우연히 이어진 경우는 인정하지 않는다
  assert.equal(hooks.containsDateToken('920041213456', '20041213'), false);
  assert.deepEqual([...hooks.datesIn('입국 2026.08.24 출국 2026.09.01')], ['2026.08.24', '2026.09.01']);
}

// ── 실제 구조 회귀: 성명·생년월일·학번이 <input> 안에 있어도 찾아야 한다.
// 예전에는 row.innerText 만 읽어 학생이 조회돼도 매칭에 실패했다(실사례).
{
  const { hooks } = build({
    rows: [
      { text: '1 여성 중국 D-2-8 2027.01.31 단기유학과정', fields: ['DING YUQIONG', '1998.11.04', '9625020264'] }
    ]
  });
  assert.equal(
    hooks.matchModiObjRows({ name: 'DING, YUQIONG', birthDate: '19981104', studentNo: '9625020264' }).length,
    1,
    '입력칸 안의 성명·생년월일·학번으로도 대상 학생을 찾아야 합니다.'
  );
}

// ── 목록에서 대상 학생만 고른다: 다른 학생이 같이 떠 있어도 절대 선택하지 않는다
{
  const { hooks } = build({
    rows: [
      'CHEN DONG 2001.05.05 9611111111',              // 다른 학생
      'AVAR YAGMUR 2004.12.13 9623820262 D-2-6',      // 대상
      'SAHA BISHWAJIT 1999.02.02 9622222222'          // 다른 학생
    ]
  });
  const matched = hooks.matchModiObjRows(student);
  assert.equal(matched.length, 1, '대상 학생 1건만 일치해야 합니다.');
  assert.equal(matched[0].index, 1, '두 번째 행이어야 합니다.');
  const result = hooks.readModiObjResult(student);
  assert.equal(result.state, 'FOUND');
  assert.equal(result.rowCount, 3);
  assert.equal(result.targetIndex, 1);
}

// ── 이름만 같고 생년월일이 다르면 고르지 않는다
{
  const { hooks } = build({ rows: ['AVAR YAGMUR 1999.01.01 9623820262'] });
  assert.equal(hooks.matchModiObjRows(student).length, 0, '생년월일이 다르면 일치로 보면 안 됩니다.');
  assert.equal(hooks.readModiObjResult(student).state, 'NOT_FOUND');
}

// ── 학번이 다르면 고르지 않는다
{
  const { hooks } = build({ rows: ['AVAR YAGMUR 2004.12.13 9699999999'] });
  assert.equal(hooks.matchModiObjRows(student).length, 0, '학번이 다르면 일치로 보면 안 됩니다.');
}

// ── 동일 조건이 2건이면 자동 처리하지 않는다
{
  const { hooks } = build({
    rows: ['AVAR YAGMUR 2004.12.13 9623820262', 'AVAR YAGMUR 2004.12.13 9623820262']
  });
  assert.equal(hooks.readModiObjResult(student).state, 'AMBIGUOUS');
}

const popupBody = 'AVAR YAGMUR 2004.12.13 출입국기록';

// ── 팝업: 입국일자가 있는 기록이 정확히 1건이면 선택 후 수정(Update)
{
  const { hooks, radioNodes, updateButton } = build({
    pathname: '/isi/ICRMIntlStudInfoPopR.xec',
    radios: [{ text: '입국 2026.08.24 인천', title: 'AVAR YAGMUR' }],
    bodyText: popupBody
  });
  const applied = hooks.applyIcrmUpdate(student);
  assert.equal(applied.ok, true, applied.message);
  assert.equal(applied.data.arrivalDate, '2026.08.24');
  assert.equal(radioNodes[0].checked, true, '해당 기록이 선택돼야 합니다.');
  assert.equal(updateButton.clicked, true, '수정(Update)이 눌려야 합니다.');
}

// ── 팝업: 입국일자가 없으면 아무것도 누르지 않는다
{
  const { hooks, radioNodes, updateButton } = build({
    pathname: '/isi/ICRMIntlStudInfoPopR.xec',
    radios: [{ text: '기록 없음', title: 'AVAR YAGMUR' }],
    bodyText: popupBody
  });
  const applied = hooks.applyIcrmUpdate(student);
  assert.equal(applied.ok, false);
  assert.equal(applied.code, 'NO_ARRIVAL_DATE');
  assert.equal(radioNodes[0].checked, false);
  assert.equal(updateButton.clicked, undefined, '입국일자가 없으면 수정을 누르면 안 됩니다.');
}

// ── 팝업: 입국일자 있는 기록이 여러 건이면 자동으로 고르지 않는다
{
  const { hooks, radioNodes, updateButton } = build({
    pathname: '/isi/ICRMIntlStudInfoPopR.xec',
    radios: [
      { text: '입국 2026.08.24', title: 'AVAR YAGMUR' },
      { text: '입국 2026.03.01', title: 'AVAR YAGMUR' }
    ],
    bodyText: popupBody
  });
  const applied = hooks.applyIcrmUpdate(student);
  assert.equal(applied.ok, false);
  assert.equal(applied.code, 'AMBIGUOUS');
  assert.equal(radioNodes.some((radio) => radio.checked), false, '애매하면 아무것도 선택하면 안 됩니다.');
  assert.equal(updateButton.clicked, undefined);
}

// ── 팝업: 다른 학생의 팝업이면 즉시 중단한다
{
  const { hooks, radioNodes, updateButton } = build({
    pathname: '/isi/ICRMIntlStudInfoPopR.xec',
    radios: [{ text: '입국 2026.08.24', title: 'CHEN DONG' }],
    bodyText: 'CHEN DONG 2001.05.05 출입국기록'
  });
  const applied = hooks.applyIcrmUpdate(student);
  assert.equal(applied.ok, false);
  assert.equal(applied.code, 'IDENTITY_MISMATCH');
  assert.equal(radioNodes[0].checked, false);
  assert.equal(updateButton.clicked, undefined, '다른 학생 화면에서는 절대 수정하면 안 됩니다.');
}

console.log('modiobj tests passed');

// ── 최종출신학교 특수문자 정리 ────────────────────────────────────────────
// FIMS: "최종출신학교에 -,(,),. 이외의 특수문자를 입력하실 수 없습니다."
{
  const { hooks } = build({});
  const { sanitizeSchoolName, needsSchoolSanitize } = hooks;

  // 사용자가 확인한 기대 동작
  assert.equal(
    sanitizeSchoolName('University of Applied Sciences, Worms'),
    'University of Applied Sciences Worms'
  );
  // 쉼표 뒤에 공백이 없어도 단어가 붙지 않아야 한다
  assert.equal(sanitizeSchoolName('ABC,DEF'), 'ABC DEF');
  // 허용 문자는 그대로 둔다
  assert.equal(sanitizeSchoolName('Seoul Nat.-Univ. (Main)'), 'Seoul Nat.-Univ. (Main)');
  assert.equal(sanitizeSchoolName('한양대학교(ERICA)'), '한양대학교(ERICA)');
  // 한자·비라틴 문자도 글자이므로 남긴다
  assert.equal(sanitizeSchoolName('北京大学'), '北京大学');
  // 그 외 특수문자는 제거
  assert.equal(sanitizeSchoolName('A&B / C@D #1'), 'A B C D 1');
  assert.equal(sanitizeSchoolName("St. John's College"), 'St. John s College');

  // 문제가 없으면 건드리지 않는다
  assert.equal(needsSchoolSanitize('Seoul Nat.-Univ. (Main)'), false);
  assert.equal(needsSchoolSanitize('한양대학교(ERICA)'), false);
  assert.equal(needsSchoolSanitize(''), false);
  assert.equal(needsSchoolSanitize('University of Applied Sciences, Worms'), true);
}

console.log('school sanitize tests passed');
