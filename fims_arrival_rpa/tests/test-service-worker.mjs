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
  waitForArrivalVerification = async () => ({frame:{frameId:21},data:{
    nameMatches:true,birthDateMatches:true,studentNo:'9511123456',admissionDate:'2026.09.01',
    arrivalDate:'',arrivalMarked:false,arrivalConfirmed:false
  }});
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
  sendAction = async (_tabId, frameId, action) => {
    calls.push(action);
    if (action === 'COLLECT_DIAGNOSTICS') return {ok:true,data:{probes:[],hasBasicSearchForm:true}};
    if (action === 'READ_DETAIL_IDENTITY') return {ok:true,data:{nameMatches:true,birthDateMatches:true}};
    if (action === 'OPEN_ARRIVAL_DETAIL') return {ok:true,matchStrategy:'name-match'};
    return {ok:true};
  };
  const report = await diagnoseArrivalStudent({
    tabId:1,
    student:{name:'TEST STUDENT',birthDate:'2000.01.02',studentNo:'9511123456'}
  });
  return {report, calls};
})()`, context);

assert.equal(diagnoseFlow.report.wroteToFims, false);
assert.equal(diagnoseFlow.report.stoppedAt, '상세화면 확인 완료');
for (const forbidden of ['CLICK_ARRIVAL_EDIT', 'FILL_ARRIVAL_EDIT', 'SAVE_ARRIVAL_EDIT']) {
  assert.ok(
    !diagnoseFlow.calls.includes(forbidden),
    `진단 모드가 쓰기 명령 ${forbidden} 을 보내면 안 됩니다.`
  );
}
assert.ok(diagnoseFlow.calls.includes('PREPARE_ARRIVAL_SEARCH'));
assert.ok(diagnoseFlow.calls.includes('OPEN_ARRIVAL_DETAIL'));
assert.ok(diagnoseFlow.calls.includes('READ_DETAIL_IDENTITY'));
assert.ok(diagnoseFlow.report.steps.some((step) => step.step.includes('수정·저장 미실행')));

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
