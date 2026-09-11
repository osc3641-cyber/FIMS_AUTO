import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../service-worker.js', import.meta.url), 'utf8');
const context = vm.createContext({
  console,
  setTimeout,
  clearTimeout,
  chrome: { runtime: { onMessage: { addListener() {} } } }
});
vm.runInContext(source, context, { filename: 'service-worker.js' });
// 테스트들이 같은 vm 컨텍스트를 공유하므로 전역 목이 다음 테스트로 샌다.
// 실제 구현이 필요한 테스트가 복원해 쓸 수 있게 원본을 보관해 둔다.
vm.runInContext('globalThis.__real = { waitForSaveOutcome, waitForArrivalVerification };', context);

assert.equal(vm.runInContext('FIMS_ENTRY_URL', context), 'https://fims.hikorea.go.kr/isi/index.html');
assert.equal(vm.runInContext("normalizeFimsName('SAMPLE LONGNAME TESTCASE OVERFLOW ALPHA')", context), 'SAMPLE LONGNAME TESTCASE OVERFLOW ALPH');
assert.equal(vm.runInContext("sameFimsName('SAMPLE LONGNAME TESTCASE OVERFLOW ALPHA','SAMPLE LONGNAME TESTCASE OVERFLOW ALPH')", context), true);
assert.equal(vm.runInContext("normalizeFimsName('SAMPLE SURNAME, GIVEN MIDDLE')", context), 'SAMPLE SURNAME GIVEN MIDDLE');
assert.equal(vm.runInContext("sameFimsName('SAMPLE SURNAME, GIVEN MIDDLE','SAMPLE SURNAME GIVEN MIDDLE')", context), true);
assert.equal(vm.runInContext("isPostLoginStatusNotice('아래 유학생현황을 확인 후 처리바랍니다. 변동신고반려처리건수 : 44 재학생정보수정대상자건수 : 384')", context), true);
assert.equal(vm.runInContext("isPostLoginStatusNotice('ID를 확인해주세요.')", context), false);

const freshWindowFlow = await vm.runInContext(`(async () => {
  const calls = {removed:[], cookies:[], created:[]};
  chrome.tabs = {
    query: async (options) => options.url ? [
      {id:21,url:'https://www.hikorea.go.kr/isi/index.html',windowId:8},
      {id:22,url:'https://fims.hikorea.go.kr/isi/MainR.isi',windowId:9}
    ] : [],
    remove: async (ids) => { calls.removed.push(...ids); }
  };
  chrome.cookies = {
    getAll: async (options) => {
      calls.cookieQuery = options;
      return [
        {name:'JSESSIONID',domain:'fims.hikorea.go.kr',path:'/isi',storeId:'0'},
        {name:'FIMS_SESSION',domain:'.fims.hikorea.go.kr',path:'/',storeId:'0'}
      ];
    },
    remove: async (options) => { calls.cookies.push(options); return options; }
  };
  chrome.windows = {
    create: async (options) => {
      calls.created.push(options);
      return {id:77,tabs:[{id:31,url:FIMS_ENTRY_URL,windowId:77,status:'complete'}]};
    }
  };
  waitForTabReady = async (tabId) => ({id:tabId,status:'complete'});
  focusTab = async () => {};
  const result = await openFreshFimsWindow();
  return {calls,result};
})()`, context);
assert.deepEqual(Array.from(freshWindowFlow.calls.removed), [21, 22]);
assert.equal(freshWindowFlow.calls.cookieQuery.domain, 'fims.hikorea.go.kr');
assert.equal(freshWindowFlow.calls.cookies.length, 2);
assert.equal(freshWindowFlow.result.clearedCookieCount, 2);
assert.equal(freshWindowFlow.calls.created.length, 1);
assert.equal(freshWindowFlow.calls.created[0].url, 'https://fims.hikorea.go.kr/isi/index.html');
assert.equal(freshWindowFlow.calls.created[0].type, 'popup');
assert.equal(freshWindowFlow.calls.created[0].width, 1280);
assert.equal(freshWindowFlow.calls.created[0].height, 900);

const loginFormFlow = await vm.runInContext(`(async () => {
  Event = class Event { constructor(type) { this.type = type; } };
  InputEvent = class InputEvent extends Event {};
  class FakeInput {
    constructor(maxLength) {
      this._value = '';
      this.maxLength = maxLength;
      this.events = [];
      this.form = null;
      this.attributes = {};
    }
    get value() { return this._value; }
    set value(value) { this._value = String(value); }
    focus() {}
    blur() {}
    dispatchEvent(event) { this.events.push(event.type); return true; }
    setAttribute(name, value) { this.attributes[name] = String(value); }
  }
  const id = new FakeInput(12);
  const password = new FakeInput(24);
  const form = {attributes:{},setAttribute(name,value){this.attributes[name]=String(value);}};
  id.form = form;
  password.form = form;
  id.value = 'saved-browser-id';
  password.value = 'saved-browser-password';
  const loginButton = {
    disabled: false,
    clicks: 0,
    click() { this.clicks += 1; }
  };
  document = {
    querySelector: (selector) => {
      if (selector.includes('Button2') || selector.includes('membLogin')) return loginButton;
      if (selector.includes('userPasswd')) return password;
      return id;
    }
  };
  const result = submitFimsLoginForm({
    userId: 'testadmin',
    password: 'test-password',
    settleMs: 100
  });
  setTimeout(() => {
    id.value = 'late-browser-id';
    password.value = 'late-browser-password';
  }, 40);
  await new Promise((resolve) => setTimeout(resolve, 140));
  return {
    result,
    id: id.value,
    password: password.value,
    clicks: loginButton.clicks,
    formAutocomplete: form.attributes.autocomplete,
    idAutocomplete: id.attributes.autocomplete,
    passwordAutocomplete: password.attributes.autocomplete,
    idReadOnly: id.readOnly,
    passwordReadOnly: password.readOnly
  };
})()`, context);
assert.equal(loginFormFlow.result.ok, true);
assert.equal(loginFormFlow.result.method, 'native-login-button');
assert.equal(loginFormFlow.result.autofillReplaced, true);
assert.equal(loginFormFlow.result.selector, 'input[name="Button2"][onclick*="membLogin"]');
assert.equal(loginFormFlow.id, 'testadmin');
assert.equal(loginFormFlow.password, 'test-password');
assert.equal(loginFormFlow.clicks, 1);
assert.equal(loginFormFlow.formAutocomplete, 'off');
assert.equal(loginFormFlow.idAutocomplete, 'off');
assert.equal(loginFormFlow.passwordAutocomplete, 'new-password');
assert.equal(loginFormFlow.idReadOnly, false);
assert.equal(loginFormFlow.passwordReadOnly, false);

const optionalNoticeFlow = await vm.runInContext(`(async () => {
  inspectAll = async () => [{frameId:9,state:{hasStudentInfoParentMenu:true}}];
  getDialogLogs = async () => [{
    kind:'alert',
    message:'아래 유학생현황을 확인 후 처리바랍니다. 변동신고반려처리건수 : 44 재학생정보수정대상자건수 : 384',
    at:'2026-09-10T10:00:00.000Z'
  }];
  return waitForLoginOutcome(1, 10000);
})()`, context);
assert.equal(optionalNoticeFlow.menuFrame.frameId, 9);
assert.equal(optionalNoticeFlow.errorMessage, '');
assert.equal(optionalNoticeFlow.noticeAcknowledged, true);

const noNoticeFlow = await vm.runInContext(`(async () => {
  inspectAll = async () => [{frameId:10,state:{hasStudentBasicMenu:true}}];
  getDialogLogs = async () => [];
  return waitForLoginOutcome(1, 10000);
})()`, context);
assert.equal(noNoticeFlow.menuFrame.frameId, 10);
assert.equal(noNoticeFlow.noticeAcknowledged, false);

const invalidLoginFlow = await vm.runInContext(`(async () => {
  inspectAll = async () => [];
  getDialogLogs = async () => [{kind:'alert',message:'ID를 확인해주세요.',at:'2026-09-10T10:00:01.000Z'}];
  return waitForLoginOutcome(1, 10000);
})()`, context);
assert.equal(invalidLoginFlow.menuFrame, null);
assert.equal(invalidLoginFlow.errorMessage, 'ID를 확인해주세요.');

const menuFlow = await vm.runInContext(`(async () => {
  const calls = [];
  let waitCount = 0;
  waitForFrame = async (_tabId, predicate) => {
    waitCount += 1;
    const frames = waitCount === 1
      ? []
      : waitCount === 2
        ? [{frameId:7,state:{hasStudentInfoParentMenu:true,hasStudentBasicMenu:false}}]
        : waitCount === 3
          ? [{frameId:7,state:{hasStudentInfoParentMenu:true,hasStudentBasicMenu:true}}]
          : [{frameId:8,state:{hasBasicSearchForm:true}}];
    return frames.find((frame) => predicate(frame.state, frame)) || null;
  };
  sendAction = async (_tabId, frameId, action) => {
    calls.push({frameId,action});
    return {ok:true};
  };
  const frame = await openStudentBasicInfo(1);
  return {frame,calls};
})()`, context);
assert.equal(menuFlow.frame.frameId, 8);
assert.deepEqual(Array.from(menuFlow.calls, (item) => `${item.frameId}:${item.action}`), [
  '7:EXPAND_STUDENT_INFO_MENU',
  '7:CLICK_STUDENT_BASIC_MENU'
]);

const completedFlow = await vm.runInContext(`(async () => {
  const calls = [];
  ensureBasicSearchFrame = async () => ({frameId:10,state:{documentToken:'old'}});
  waitArrivalSearchResult = async () => ({frame:{frameId:10},data:{state:'FOUND',matchCount:1}});
  waitForDetailFrame = async () => ({frameId:11,state:{hasStudentDetailView:true}});
  waitForEditFrame = async () => ({frameId:12,state:{hasArrivalEditForm:true}});
  inspectAll = async () => ([{frameId:11,state:{canVerifyArrival:true}}]);
  setDialogModeAllFrames = async () => ({armed:1,armedFrameIds:[12]});
  getDialogLogs = async () => [{kind:'alert',message:'정상적으로 처리되었습니다.'}];
  clearDialogMode = async () => {};
  sendAction = async (_tabId, frameId, action) => {
    calls.push({frameId,action});
    if (action === 'READ_DETAIL_IDENTITY') return {ok:true,data:{nameMatches:true,birthDateMatches:true}};
    if (action === 'READ_ARRIVAL_VERIFICATION') return {ok:true,data:{
      nameMatches:true,birthDateMatches:true,studentNo:'9511123456',admissionDate:'2026.09.01',
      arrivalDate:'2026.08.24',arrivalMarked:true,arrivalConfirmed:true
    }};
    return {ok:true};
  };
  const outcome = await processArrivalStudent({
    tabId:1,
    student:{name:'TEST STUDENT',birthDate:'2000.01.02',studentNo:'9511123456'},
    config:{admissionDate:'2026.09.01'}
  });
  return {outcome,calls};
})()`, context);
assert.equal(completedFlow.outcome.code, 'COMPLETED');
assert.equal(completedFlow.outcome.result, '입국신고 완료');
assert.equal(completedFlow.outcome.arrivalDate, '2026.08.24');
assert.deepEqual(Array.from(completedFlow.calls, (item) => item.action), [
  'PREPARE_ARRIVAL_SEARCH',
  'OPEN_ARRIVAL_DETAIL',
  'READ_DETAIL_IDENTITY',
  'CLICK_ARRIVAL_EDIT',
  'FILL_ARRIVAL_EDIT',
  'SAVE_ARRIVAL_EDIT',
  'READ_ARRIVAL_VERIFICATION'
]);

// 1.0.5 회귀: 저장 후 FIMS가 수정폼(DtlRU)에 그대로 남는 경우.
// 본문에 "(입국)" 문구가 없어 arrivalMarked는 false지만 #entrYN=N + #eYmd 날짜로
// 저장이 확인된다. 예전에는 상세화면만 기다리다 45초 뒤 '저장 결과 확인 실패'였다.
const editFormLandingFlow = await vm.runInContext(`(async () => {
  ensureBasicSearchFrame = async () => ({frameId:30,state:{documentToken:'old'}});
  waitArrivalSearchResult = async () => ({frame:{frameId:30},data:{state:'FOUND',matchCount:1}});
  waitForDetailFrame = async () => ({frameId:31,state:{hasStudentDetailView:true}});
  waitForEditFrame = async () => ({frameId:32,state:{hasArrivalEditForm:true}});
  setDialogModeAllFrames = async () => ({armed:1,armedFrameIds:[32]});
  getDialogLogs = async () => [];
  clearDialogMode = async () => {};
  // 저장 후에도 수정폼 프레임만 남아 있는 상황
  inspectAll = async () => ([{frameId:32,state:{canVerifyArrival:true,hasArrivalEditForm:true}}]);
  sendAction = async (_tabId, _frameId, action) => {
    if (action === 'READ_DETAIL_IDENTITY') return {ok:true,data:{nameMatches:true,birthDateMatches:true}};
    if (action === 'READ_ARRIVAL_VERIFICATION') return {ok:true,data:{
      nameMatches:true,birthDateMatches:true,studentNo:'9511123456',admissionDate:'2026.09.01',
      arrivalDate:'2026.09.01',arrivalMarked:false,arrivalConfirmed:true,
      arrivalCode:'N',arrivalCodeText:'입국'
    }};
    return {ok:true};
  };
  return processArrivalStudent({
    tabId:1,
    student:{name:'TEST STUDENT',birthDate:'2000.01.02',studentNo:'9511123456'},
    config:{admissionDate:'2026.09.01'}
  });
})()`, context);
assert.equal(editFormLandingFlow.code, 'COMPLETED');
assert.equal(editFormLandingFlow.result, '입국신고 완료');
assert.equal(editFormLandingFlow.arrivalDate, '2026.09.01');
assert.match(editFormLandingFlow.detail, /수정화면 입국일자 기준/);

const missingDateFlow = await vm.runInContext(`(async () => {
  ensureBasicSearchFrame = async () => ({frameId:20,state:{documentToken:'old'}});
  waitArrivalSearchResult = async () => ({frame:{frameId:20},data:{state:'FOUND',matchCount:1}});
  waitForDetailFrame = async () => ({frameId:21,state:{hasStudentDetailView:true}});
  waitForEditFrame = async () => ({frameId:22,state:{hasArrivalEditForm:true}});
  // 1.1.1: 저장은 실제로 확인됐지만(성공 알림) 입국일자만 없는 경우.
  // 저장 증거가 없으면 이 분기로 오면 안 된다(아래 saveSilent 테스트가 잠금).
  waitForSaveOutcome = async () => ({
    state:'SAVED',
    messages:['성공적으로 저장되었습니다.[1건]'],
    verification:{frame:{frameId:21},data:{
      nameMatches:true,birthDateMatches:true,studentNo:'9511123456',admissionDate:'2026.09.01',
      arrivalDate:'',arrivalMarked:false,arrivalConfirmed:false
    }}
  });
  setDialogModeAllFrames = async () => ({armed:1,armedFrameIds:[22]});
  getDialogLogs = async () => [];
  clearDialogMode = async () => {};
  sendAction = async (_tabId, _frameId, action) => {
    if (action === 'READ_DETAIL_IDENTITY') return {ok:true,data:{nameMatches:true,birthDateMatches:true}};
    if (action === 'READ_ARRIVAL_VERIFICATION') return {ok:true,data:{
      nameMatches:true,birthDateMatches:true,studentNo:'9511123456',admissionDate:'2026.09.01',
      arrivalDate:'',arrivalMarked:false
    }};
    return {ok:true};
  };
  return processArrivalStudent({
    tabId:1,
    student:{name:'TEST STUDENT',birthDate:'2000.01.02',studentNo:'9511123456'},
    config:{admissionDate:'2026.09.01'}
  });
})()`, context);
assert.equal(missingDateFlow.code, 'ARRIVAL_DATE_MISSING');
assert.equal(missingDateFlow.result, '입국일자 미확인');
assert.match(missingDateFlow.note, /별도 처리 필요/);

console.log('arrival service-worker tests passed');

// ── 진단 모드 안전 속성 ────────────────────────────────────────────────
// 진단은 실제 FIMS 계정으로 돌리므로, 수정·저장 계열 명령을 단 한 번도
// 보내지 않아야 한다. 이 테스트가 그 계약을 잠근다.
const diagnoseFlow = await vm.runInContext(`(async () => {
  const calls = [];
  ensureBasicSearchFrame = async () => ({frameId:40,state:{documentToken:'old'}});
  getFrames = async () => ([{frameId:40,parentFrameId:-1,url:'https://fims.hikorea.go.kr/isi/IntlStudBaInfoPageR.xec'}]);
  ensureContentScript = async () => true;
  waitArrivalSearchResult = async () => ({frame:{frameId:40},data:{state:'FOUND',matchCount:1}});
  waitForDetailFrame = async () => ({frameId:41,state:{hasStudentDetailView:true}});
  waitForEditFrame = async () => ({frameId:42,state:{hasArrivalEditForm:true}});
  sendAction = async (_tabId, frameId, action) => {
    calls.push(action);
    if (action === 'COLLECT_DIAGNOSTICS') return {ok:true,data:{probes:[],hasBasicSearchForm:true}};
    if (action === 'READ_DETAIL_IDENTITY') return {ok:true,data:{nameMatches:true,birthDateMatches:true}};
    if (action === 'OPEN_ARRIVAL_DETAIL') return {ok:true,matchStrategy:'name-match'};
    return {ok:true};
  };
  const report = await diagnoseArrivalStudent({
    tabId:1,
    student:{name:'TEST STUDENT',birthDate:'2000.01.02',studentNo:'9511123456',admissionDate:'20260901'}
  });
  return {report, calls};
})()`, context);

// 진단의 안전 계약: 저장은 절대 호출하지 않는다.
// 수정화면 열기와 입력 재현은 저장하지 않는 한 FIMS에 반영되지 않으므로 허용한다.
assert.equal(diagnoseFlow.report.wroteToFims, false);
assert.ok(
  !diagnoseFlow.calls.includes('SAVE_ARRIVAL_EDIT'),
  '진단 모드는 저장 명령을 절대 보내면 안 됩니다.'
);
assert.ok(diagnoseFlow.calls.includes('PREPARE_ARRIVAL_SEARCH'));
assert.ok(diagnoseFlow.calls.includes('OPEN_ARRIVAL_DETAIL'));
assert.ok(diagnoseFlow.calls.includes('READ_DETAIL_IDENTITY'));
assert.ok(diagnoseFlow.calls.includes('CLICK_ARRIVAL_EDIT'));
assert.ok(diagnoseFlow.calls.includes('FILL_ARRIVAL_EDIT'));
assert.ok(diagnoseFlow.report.steps.some((step) => step.step.includes('저장 미실행')));

// depth:'search' 면 수정화면에도 들어가지 않는다
const diagnoseSearchOnly = await vm.runInContext(`(async () => {
  const calls = [];
  ensureBasicSearchFrame = async () => ({frameId:60,state:{documentToken:'old'}});
  getFrames = async () => ([{frameId:60,parentFrameId:-1,url:'x'}]);
  ensureContentScript = async () => true;
  waitArrivalSearchResult = async () => ({frame:{frameId:60},data:{state:'FOUND',matchCount:1}});
  waitForDetailFrame = async () => ({frameId:61,state:{hasStudentDetailView:true}});
  sendAction = async (_tabId, _frameId, action) => {
    calls.push(action);
    if (action === 'COLLECT_DIAGNOSTICS') return {ok:true,data:{}};
    if (action === 'READ_DETAIL_IDENTITY') return {ok:true,data:{nameMatches:true,birthDateMatches:true}};
    if (action === 'OPEN_ARRIVAL_DETAIL') return {ok:true,matchStrategy:'name-match'};
    return {ok:true};
  };
  const report = await diagnoseArrivalStudent({
    tabId:1, depth:'search',
    student:{name:'TEST STUDENT',birthDate:'2000.01.02',studentNo:'9511123456'}
  });
  return {report, calls};
})()`, context);
for (const forbidden of ['CLICK_ARRIVAL_EDIT', 'FILL_ARRIVAL_EDIT', 'SAVE_ARRIVAL_EDIT']) {
  assert.ok(!diagnoseSearchOnly.calls.includes(forbidden), `depth:'search' 에서 ${forbidden} 금지`);
}

// 조회 실패로 끝나도 쓰기 명령은 없어야 한다
const diagnoseNotFound = await vm.runInContext(`(async () => {
  const calls = [];
  ensureBasicSearchFrame = async () => ({frameId:50,state:{documentToken:'old'}});
  getFrames = async () => ([{frameId:50,parentFrameId:-1,url:'x'}]);
  ensureContentScript = async () => true;
  waitArrivalSearchResult = async () => ({frame:{frameId:50},data:{state:'NONE'}});
  sendAction = async (_tabId, _frameId, action) => {
    calls.push(action);
    if (action === 'COLLECT_DIAGNOSTICS') return {ok:true,data:{}};
    return {ok:true};
  };
  const report = await diagnoseArrivalStudent({
    tabId:1, student:{name:'TEST STUDENT',birthDate:'2000.01.02',studentNo:'9511123456'}
  });
  return {report, calls};
})()`, context);
assert.match(diagnoseNotFound.report.stoppedAt, /조회 결과 NONE/);
assert.equal(diagnoseNotFound.report.wroteToFims, false);
for (const forbidden of ['CLICK_ARRIVAL_EDIT', 'FILL_ARRIVAL_EDIT', 'SAVE_ARRIVAL_EDIT']) {
  assert.ok(!diagnoseNotFound.calls.includes(forbidden), `조회 실패 경로에서도 ${forbidden} 금지`);
}

// ── 별도처리(재학생정보 수정대상자) 안전 계약 ──────────────────────────────
// 이 흐름은 실제로 FIMS에 값을 쓴다. 대상이 정확히 1건으로 확정되지 않으면
// 팝업조차 열지 않고 '별도 처리 필요'로 남겨야 한다.
const recheckAmbiguous = await vm.runInContext(`(async () => {
  const calls = [];
  setDialogModeAllFrames = async () => ({armed:1,armedFrameIds:[70]});
  clearDialogMode = async () => {};
  getFrames = async () => ([{frameId:70,parentFrameId:-1,url:'x'}]);
  ensureContentScript = async () => true;
  openModiObjScreen = async () => ({frameId:70,state:{hasModiObjSearchForm:true}});
  waitForFrame = async () => ({frameId:70,state:{hasModiObjSearchForm:true}});
  waitModiObjResult = async () => ({frame:{frameId:70},data:{state:'AMBIGUOUS',matchCount:2,rowCount:5}});
  findIcrmPopupTab = async () => { calls.push('findIcrmPopupTab'); return null; };
  sendAction = async (_tabId, _frameId, action) => {
    calls.push(action);
    if (action === 'PREPARE_MODIOBJ_SEARCH') return {ok:true,data:{}};
    return {ok:true};
  };
  const outcome = await recheckArrivalStudent({
    tabId:1, student:{name:'TEST STUDENT',birthDate:'2000.01.02',studentNo:'9511123456'}
  });
  return {outcome, calls};
})()`, context);
assert.equal(recheckAmbiguous.outcome.result, '별도 처리 필요');
assert.equal(recheckAmbiguous.outcome.code, 'MODIOBJ_AMBIGUOUS');
for (const forbidden of ['OPEN_MODIOBJ_ICRM', 'APPLY_ICRM_UPDATE']) {
  assert.ok(!recheckAmbiguous.calls.includes(forbidden), `대상이 애매하면 ${forbidden} 를 보내면 안 됩니다.`);
}
assert.ok(!recheckAmbiguous.calls.includes('findIcrmPopupTab'), '대상이 애매하면 팝업을 열면 안 됩니다.');

// 목록에서 못 찾은 경우에도 동일하게 아무것도 쓰지 않는다
const recheckNotFound = await vm.runInContext(`(async () => {
  const calls = [];
  setDialogModeAllFrames = async () => ({armed:1,armedFrameIds:[71]});
  clearDialogMode = async () => {};
  getFrames = async () => ([{frameId:71,parentFrameId:-1,url:'x'}]);
  ensureContentScript = async () => true;
  openModiObjScreen = async () => ({frameId:71,state:{hasModiObjSearchForm:true}});
  waitForFrame = async () => ({frameId:71,state:{hasModiObjSearchForm:true}});
  waitModiObjResult = async () => ({frame:{frameId:71},data:{state:'NOT_FOUND',matchCount:0,rowCount:3}});
  sendAction = async (_tabId, _frameId, action) => {
    calls.push(action);
    if (action === 'PREPARE_MODIOBJ_SEARCH') return {ok:true,data:{}};
    return {ok:true};
  };
  const outcome = await recheckArrivalStudent({
    tabId:1, student:{name:'TEST STUDENT',birthDate:'2000.01.02',studentNo:'9511123456'}
  });
  return {outcome, calls};
})()`, context);
assert.equal(recheckNotFound.outcome.code, 'MODIOBJ_NOT_FOUND');
assert.equal(recheckNotFound.outcome.result, '별도 처리 필요');
for (const forbidden of ['OPEN_MODIOBJ_ICRM', 'APPLY_ICRM_UPDATE']) {
  assert.ok(!recheckNotFound.calls.includes(forbidden), `대상을 못 찾으면 ${forbidden} 금지`);
}

// 학생 정보가 부족하면 시작조차 하지 않는다
await assert.rejects(
  () => vm.runInContext(`recheckArrivalStudent({tabId:1, student:{name:'X'}})`, context),
  /성명·생년월일·학번/
);

// ── 저장 판정: 증거 없이 '저장됨'이라고 하면 안 된다 ────────────────────────
// 실사례: 학번·입학일자가 하나도 저장되지 않은 학생을 '저장은 완료됐으나
// 입국일자 미확인'으로 기록해, 엉뚱하게 별도처리 대상이 됐다.
vm.runInContext('SAVE_OUTCOME_TIMEOUT_MS = 900;', context);

function saveScenario({ alerts, arrivalConfirmed, arrivalDate }) {
  return `(async () => {
    waitForSaveOutcome = globalThis.__real.waitForSaveOutcome;
    waitForArrivalVerification = globalThis.__real.waitForArrivalVerification;
    ensureBasicSearchFrame = async () => ({frameId:80,state:{documentToken:'old'}});
    waitArrivalSearchResult = async () => ({frame:{frameId:80},data:{state:'FOUND',matchCount:1}});
    waitForDetailFrame = async () => ({frameId:81,state:{hasStudentDetailView:true}});
    waitForEditFrame = async () => ({frameId:82,state:{hasArrivalEditForm:true}});
    waitForFrame = async () => ({frameId:82,state:{hasArrivalEditForm:true}});
    setDialogModeAllFrames = async () => ({armed:1,armedFrameIds:[82]});
    clearDialogMode = async () => {};
    getDialogLogs = async () => (${JSON.stringify(alerts)}).map((m) => ({kind:'alert',message:m}));
    inspectAll = async () => ([{frameId:82,state:{canVerifyArrival:true}}]);
    sendAction = async (_tabId, _frameId, action) => {
      if (action === 'READ_DETAIL_IDENTITY') return {ok:true,data:{nameMatches:true,birthDateMatches:true}};
      if (action === 'READ_ARRIVAL_VERIFICATION') return {ok:true,data:{
        nameMatches:true,birthDateMatches:true,studentNo:'9511123456',admissionDate:'2026.09.01',
        arrivalDate:${JSON.stringify(arrivalDate)},arrivalMarked:false,arrivalConfirmed:${arrivalConfirmed}
      }};
      return {ok:true};
    };
    return processArrivalStudent({
      tabId:1,
      student:{name:'TEST STUDENT',birthDate:'2000.01.02',studentNo:'9511123456'},
      config:{admissionDate:'2026.09.01'}
    });
  })()`;
}

// 저장 알림도 없고 입국일자도 안 채워졌다 → 저장 실패로 기록해야 한다
const saveSilent = await vm.runInContext(
  saveScenario({ alerts: [], arrivalConfirmed: false, arrivalDate: '' }), context);
assert.equal(saveSilent.code, 'SAVE_NOT_EXECUTED');
assert.equal(saveSilent.result, '입국정보 저장 실패');
assert.notEqual(saveSilent.result, '입국일자 미확인', '저장이 안 됐는데 입국일자 미확인으로 분류하면 안 됩니다.');
assert.doesNotMatch(saveSilent.detail, /저장은 완료/, '증거 없이 저장 완료라고 쓰면 안 됩니다.');

// FIMS가 경고창으로 거부 → 그 문구를 그대로 남겨야 한다
const saveRejected = await vm.runInContext(
  saveScenario({ alerts: ['입학(복학)일자를 입력하세요.'], arrivalConfirmed: false, arrivalDate: '' }), context);
assert.equal(saveRejected.code, 'SAVE_REJECTED');
assert.equal(saveRejected.result, '입국정보 저장 실패');
assert.match(saveRejected.detail, /입학\(복학\)일자를 입력하세요/, 'FIMS 거부 사유를 그대로 보여줘야 합니다.');

// 저장 알림은 떴지만 입국일자가 없다 → 진짜 별도처리 대상
const saveNoArrival = await vm.runInContext(
  saveScenario({ alerts: ['성공적으로 저장되었습니다.[1건]'], arrivalConfirmed: false, arrivalDate: '' }), context);
assert.equal(saveNoArrival.code, 'ARRIVAL_DATE_MISSING');
assert.equal(saveNoArrival.result, '입국일자 미확인');

// 입국일자까지 확인 → 완료
const saveComplete = await vm.runInContext(
  saveScenario({ alerts: ['성공적으로 저장되었습니다.[1건]'], arrivalConfirmed: true, arrivalDate: '2026.08.24' }), context);
assert.equal(saveComplete.code, 'COMPLETED');
assert.equal(saveComplete.arrivalDate, '2026.08.24');

// ── 1.2.1: 수정대상자로 분류되지 않은 학생은 체크박스가 켜진 상태에서 조회되지 않는다.
// 못 찾으면 체크를 풀고(전체 재학생) 한 번 더 찾아야 한다.
const recheckWidens = await vm.runInContext(`(async () => {
  const searches = [];
  let call = 0;
  setDialogModeAllFrames = async () => ({armed:1,armedFrameIds:[90]});
  clearDialogMode = async () => {};
  getFrames = async () => ([{frameId:90,parentFrameId:-1,url:'x'}]);
  ensureContentScript = async () => true;
  openModiObjScreen = async () => ({frameId:90,state:{hasModiObjSearchForm:true}});
  waitForFrame = async () => ({frameId:90,state:{hasModiObjSearchForm:true}});
  waitModiObjResult = async () => {
    call += 1;
    // 첫 조회(수정대상자만)는 못 찾고, 두 번째(전체 재학생)에서 찾는다
    return call === 1
      ? ({frame:{frameId:90},data:{state:'NOT_FOUND',matchCount:0,rowCount:0}})
      : ({frame:{frameId:90},data:{state:'FOUND',matchCount:1,targetIndex:0}});
  };
  findIcrmPopupTab = async () => null;
  sendAction = async (_tabId, _frameId, action, payload) => {
    if (action === 'PREPARE_MODIOBJ_SEARCH') {
      searches.push(payload?.options?.allStudents === true ? 'all' : 'targetOnly');
      return {ok:true,data:{}};
    }
    if (action === 'OPEN_MODIOBJ_ICRM') return {ok:true,data:{rowIndex:0}};
    return {ok:true};
  };
  const outcome = await recheckArrivalStudent({
    tabId:1, student:{name:'DING, YUQIONG',birthDate:'1998.11.04',studentNo:'9625020264'}
  });
  return {outcome, searches};
})()`, context);
assert.deepEqual([...recheckWidens.searches], ['targetOnly', 'all'],
  '못 찾으면 전체 재학생으로 한 번 더 조회해야 합니다.');
// 두 번째 조회에서 찾았으므로 팝업 단계까지 진행한다
assert.equal(recheckWidens.outcome.code, 'ICRM_POPUP_NOT_FOUND');

// 첫 조회에서 찾으면 다시 조회하지 않는다
const recheckNoWiden = await vm.runInContext(`(async () => {
  const searches = [];
  setDialogModeAllFrames = async () => ({armed:1,armedFrameIds:[91]});
  clearDialogMode = async () => {};
  getFrames = async () => ([{frameId:91,parentFrameId:-1,url:'x'}]);
  ensureContentScript = async () => true;
  openModiObjScreen = async () => ({frameId:91,state:{hasModiObjSearchForm:true}});
  waitForFrame = async () => ({frameId:91,state:{hasModiObjSearchForm:true}});
  waitModiObjResult = async () => ({frame:{frameId:91},data:{state:'FOUND',matchCount:1,targetIndex:0}});
  findIcrmPopupTab = async () => null;
  sendAction = async (_tabId, _frameId, action, payload) => {
    if (action === 'PREPARE_MODIOBJ_SEARCH') {
      searches.push(payload?.options?.allStudents === true ? 'all' : 'targetOnly');
      return {ok:true,data:{}};
    }
    if (action === 'OPEN_MODIOBJ_ICRM') return {ok:true,data:{rowIndex:0}};
    return {ok:true};
  };
  await recheckArrivalStudent({
    tabId:1, student:{name:'DING, YUQIONG',birthDate:'1998.11.04',studentNo:'9625020264'}
  });
  return searches;
})()`, context);
assert.deepEqual([...recheckNoWiden], ['targetOnly'], '찾았으면 재조회하지 않아야 합니다.');
