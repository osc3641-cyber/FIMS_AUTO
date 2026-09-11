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

assert.equal(
  vm.runInContext('FIMS_LOGIN_URL', context),
  'https://fims.hikorea.go.kr/isi/MembIsiLogin.isi',
  '공개 하이코리아 경유 주소가 아니라 실제 FIMS 로그인 주소로 새 창을 열어야 합니다.'
);

const freshWindowFlow = await vm.runInContext(`(async () => {
  const calls = {removed:[], created:[]};
  chrome.tabs = {
    query: async (options) => {
      if (options.url) return [
        {id:21,url:'https://www.hikorea.go.kr/isi/index.html',windowId:8},
        {id:22,url:'https://fims.hikorea.go.kr/isi/MainR.isi',windowId:9}
      ];
      if (options.windowId === 77) return [{id:31,url:FIMS_LOGIN_URL,windowId:77,status:'complete'}];
      return [];
    },
    remove: async (ids) => { calls.removed.push(...ids); }
  };
  chrome.windows = {
    create: async (options) => {
      calls.created.push(options);
      return {id:77,tabs:[{id:31,url:FIMS_LOGIN_URL,windowId:77,status:'complete'}]};
    }
  };
  waitForTabReady = async (tabId) => ({id:tabId,status:'complete'});
  focusTab = async () => {};
  const result = await openFreshFimsWindow();
  return {calls,result};
})()`, context);
assert.deepEqual(Array.from(freshWindowFlow.calls.removed), [21, 22],
  '실행 전에 기존 www/fims 탭을 모두 닫아야 합니다.');
assert.equal(freshWindowFlow.calls.created.length, 1,
  'FIMS 자동화용 새 Chrome 창은 정확히 하나만 만들어야 합니다.');
assert.equal(freshWindowFlow.calls.created[0].url,
  'https://fims.hikorea.go.kr/isi/MembIsiLogin.isi');
assert.equal(freshWindowFlow.result.tab.id, 31);
assert.equal(freshWindowFlow.result.closedTabCount, 2);

const isolatedLoginFlow = await vm.runInContext(`(async () => {
  const calls = [];
  openFreshFimsWindow = async () => ({
    tab:{id:41,windowId:88,status:'complete'},
    windowId:88,
    closedTabCount:2
  });
  waitForTabReady = async () => ({id:41,status:'complete'});
  inspectAll = async () => {
    const menuRequested = calls.some((item) => item.action === 'CLICK_LOGIN');
    return menuRequested
      ? [{frameId:52,state:{frameName:'leftFrame',hasChangeMenu:true}}]
      : [{frameId:51,state:{hasLogin:true}}];
  };
  let waitCount = 0;
  waitForFrame = async () => {
    waitCount += 1;
    return waitCount === 1
      ? {frameId:52,state:{frameName:'leftFrame',hasChangeMenu:true}}
      : {frameId:53,state:{frameName:'mainFrame',hasSearchForm:true}};
  };
  sendAction = async (_tabId, frameId, action) => {
    calls.push({frameId,action});
    return {ok:true};
  };
  getFrames = async () => [{frameId:0}, {frameId:51}, {frameId:52}];
  setDialogMode = async () => ({active:true});
  clearDialogMode = async () => {};
  const result = await loginAndOpenChangeReport({userId:'operator',password:'secret'});
  return {result,calls};
})()`, context);
assert.deepEqual(
  Array.from(isolatedLoginFlow.calls, (item) => `${item.frameId}:${item.action}`),
  ['51:FILL_LOGIN', '51:CLICK_LOGIN', '52:CLICK_CHANGE_MENU'],
  '새 창에서 로그인한 뒤 leftFrame의 실제 변동신고 링크를 클릭해야 합니다.'
);
assert.equal(isolatedLoginFlow.result.tabId, 41);
assert.equal(isolatedLoginFlow.result.windowId, 88);
assert.match(isolatedLoginFlow.result.message, /기존 FIMS 탭 2개 종료/);

const exact = vm.runInContext(`comparePendingRows(
  [{name:'STELE EVELIN VICTORIA', studentNo:'9517120256'}, {name:'AHRENS PHILIP', studentNo:'9082820262'}],
  [{name:'STELE   EVELIN VICTORIA', studentNo:'9517-120256'}, {name:'AHRENS PHILIP', studentNo:'9082820262'}]
)`, context);
assert.equal(exact.ok, true);
assert.equal(exact.actualCount, 2);

const missing = vm.runInContext(`comparePendingRows(
  [{name:'A', studentNo:'1001'}, {name:'B', studentNo:'1002'}],
  [{name:'A', studentNo:'1001'}]
)`, context);
assert.equal(missing.ok, false);
assert.equal(missing.missing.length, 1);
assert.equal(missing.extras.length, 0);

const extra = vm.runInContext(`comparePendingRows(
  [{name:'A', studentNo:'1001'}],
  [{name:'A', studentNo:'1001'}, {name:'C', studentNo:'1003'}]
)`, context);
assert.equal(extra.ok, true, '기존 대기 대상은 이번 실행 대상과 별도로 남겨 둘 수 있어야 합니다.');
assert.equal(extra.missing.length, 0);
assert.equal(extra.extras.length, 1);
assert.equal(extra.matchedCount, 1);

const duplicateTarget = vm.runInContext(`comparePendingRows(
  [{name:'A', studentNo:'1001'}],
  [{name:'A', studentNo:'1001'}, {name:'A', studentNo:'1001'}]
)`, context);
assert.equal(duplicateTarget.ok, false, '이번 실행 대상이 대기명단에 중복이면 자동 선택하면 안 됩니다.');
assert.equal(duplicateTarget.duplicates.length, 1);

const sameTableRefresh = await vm.runInContext(`(async () => {
  waitForFrame = async (_tabId, predicate) => {
    const frames = [
      {frameId: 351, state: {frameName:'mainFrame',isSearchMainFrame:true,hasSearchForm:true}},
      {frameId: 352, state: {frameName:'chgIntlStudFrame',isSearchResultsFrame:true,hasSearchResults:true}}
    ];
    return frames.find((frame) => predicate(frame.state, frame)) || null;
  };
  sendAction = async (_tabId, frameId, action) => ({
    ok: true,
    data: {
      state: 'FOUND',
      criteria: {name:'',studentNo:'',similarChecked:false},
      criteriaAvailable: false,
      criteriaMatch: true,
      token: 'internal-token',
      title: 'TARGET STUDENT',
      matchCount: 1,
      candidateCount: 1,
      availableTitles: ['TARGET STUDENT'],
      signature:'FOUND|internal-token|TARGET STUDENT'
    },
    testedFrameId: frameId,
    testedAction: action
  });
  return waitTargetSearchCheckbox(1, {name:'TARGET STUDENT',studentNo:'20260001'}, 3000);
})()`, context);
assert.equal(sameTableRefresh.frame.frameId, 352,
  '학생 체크박스는 mainFrame이 아니라 chgIntlStudFrame에서 찾아야 합니다.');
assert.equal(sameTableRefresh.data.state, 'FOUND');
assert.equal(sameTableRefresh.data.token, 'internal-token',
  '같은 프레임에서 생성된 title 정확 일치 체크박스를 받아들여야 합니다.');

const actionFrames = await vm.runInContext(`(async () => {
  waitForFrame = async (_tabId, predicate) => {
    const frames = [
      {frameId: 352, state: {frameName:'chgIntlStudFrame',isSearchResultsFrame:true,hasSearchResults:true}},
      {frameId: 353, state: {frameName:'notiListFrame',isPendingListFrame:true,hasPendingTable:true}},
      {frameId: 351, state: {
        frameName:'mainFrame',
        isSearchMainFrame:true,
        hasSendButton:true,
        hasBatchButton:true,
        hasFinalButton:true
      }}
    ];
    return frames.find((frame) => predicate(frame.state, frame)) || null;
  };
  return {
    send: await waitMainActionFrame(1, 'hasSendButton'),
    batch: await waitMainActionFrame(1, 'hasBatchButton'),
    final: await waitMainActionFrame(1, 'hasFinalButton')
  };
})()`, context);
assert.equal(actionFrames.send.frameId, 351, '보내기 버튼은 mainFrame에서 실행해야 합니다.');
assert.equal(actionFrames.batch.frameId, 351, '일괄입력 버튼은 mainFrame에서 실행해야 합니다.');
assert.equal(actionFrames.final.frameId, 351, '신고처리 버튼은 mainFrame에서 실행해야 합니다.');

const dialogArming = await vm.runInContext(`(async () => {
  const calls = [];
  getFrames = async () => [{frameId:0}, {frameId:351}, {frameId:352}, {frameId:353}];
  setDialogMode = async (_tabId, frameId, options) => {
    calls.push({frameId, clearLog:options.clearLog});
    return {active:true};
  };
  const result = await setDialogModeAllFrames(1, {confirmValue:true,durationMs:45000,clearLog:true});
  return {result,calls};
})()`, context);
assert.equal(dialogArming.result.armed, 4);
assert.equal(vm.runInContext('dialogGuardReady', context)(dialogArming.result, [0, 351]), true);
assert.deepEqual(
  Array.from(dialogArming.calls, (item) => `${item.frameId}:${item.clearLog}`),
  ['0:true', '351:false', '352:false', '353:false'],
  'native confirm을 호출할 수 있는 모든 FIMS 프레임에 확인 자동승인을 설치해야 합니다.'
);

const restoredMenuSearch = await vm.runInContext(`(async () => {
  let waitCount = 0;
  const calls = [];
  waitForFrame = async () => {
    waitCount += 1;
    return waitCount === 1
      ? null
      : {frameId:351,state:{frameName:'mainFrame',hasSearchForm:true}};
  };
  inspectAll = async () => [
    {frameId:16,state:{hasChangeMenu:true}},
    {frameId:351,state:{frameName:'mainFrame'}}
  ];
  sendAction = async (_tabId, frameId, action) => {
    calls.push({frameId,action});
    return {ok:true};
  };
  const frame = await ensureSearchFrame(1);
  return {frame,calls};
})()`, context);
assert.equal(restoredMenuSearch.frame.frameId, 351);
assert.deepEqual(
  Array.from(restoredMenuSearch.calls, (item) => `${item.frameId}:${item.action}`),
  ['16:CLICK_CHANGE_MENU'],
  '검색 화면이 없으면 2.0.5 방식대로 변동신고 메뉴를 클릭하고 mainFrame 검색 폼을 기다려야 합니다.'
);

const staleEmptyResult = await vm.runInContext(`(async () => {
  let readCount = 0;
  waitForFrame = async () => ({
    frameId:352,
    state:{isSearchResultsFrame:true,hasSearchResults:true,documentToken:'old-document'}
  });
  sendAction = async () => {
    readCount += 1;
    if (readCount === 1) {
      return {ok:true,data:{state:'NONE',documentToken:'old-document',candidateCount:0,availableTitles:[]}};
    }
    return {ok:true,data:{
      state:'FOUND',documentToken:'new-document',candidateCount:1,
      token:'xing-token',title:'SAMPLE BETA',matchCount:1,availableTitles:['SAMPLE BETA']
    }};
  };
  const result = await waitTargetSearchCheckbox(
    1,
    {name:'SAMPLE BETA',studentNo:'9900000003'},
    3000,
    'old-document'
  );
  return {result,readCount};
})()`, context);
assert.equal(staleEmptyResult.result.data.state, 'FOUND',
  '직전 학생의 빈 결과를 새 조회의 조회실패로 즉시 확정하면 안 됩니다.');
assert.ok(staleEmptyResult.readCount >= 3);

const studentFlow = await vm.runInContext(`(async () => {
  const calls = [];
  readPending = async () => ({frame:{frameId:353},rows:[]});
  inspectAll = async () => [{frameId:352,state:{isSearchResultsFrame:true,documentToken:'before-search'}}];
  ensureSearchFrame = async () => ({frameId:351, state:{isSearchMainFrame:true,hasSearchForm:true}});
  waitTargetSearchCheckbox = async () => ({
    frame:{frameId:352, state:{isSearchResultsFrame:true}},
    data:{state:'FOUND',token:'student-token',title:'TARGET STUDENT'}
  });
  waitMainActionFrame = async (_tabId, capability) => {
    if (capability !== 'hasSendButton') return null;
    return {frameId:351, state:{isSearchMainFrame:true,hasSendButton:true}};
  };
  sendAction = async (_tabId, frameId, action) => {
    calls.push({frameId, action});
    return {ok:true};
  };
  setDialogModeAllFrames = async () => ({armed:4,total:4,armedFrameIds:[0,351,352,353]});
  waitPendingContains = async () => ({frame:{frameId:353}, found:{name:'TARGET STUDENT',studentNo:'20260001'}});
  getDialogLogs = async () => [];
  clearDialogMode = async () => {};
  const outcome = await processStudent({
    tabId:1,
    student:{name:'TARGET STUDENT',studentNo:'20260001'}
  });
  return {outcome, calls};
})()`, context);
assert.equal(studentFlow.outcome.code, 'SENT');
assert.deepEqual(
  Array.from(studentFlow.calls, (item) => `${item.frameId}:${item.action}`),
  [
    '351:PREPARE_STUDENT_SEARCH',
    '352:SELECT_TARGET_SEARCH_CHECKBOX',
    '351:SEND_SELECTED'
  ],
  '학생별 조회→체크→보내기를 실제 세 프레임 구조대로 실행해야 합니다.'
);

const alreadyPendingFlow = await vm.runInContext(`(async () => {
  readPending = async () => ({
    frame:{frameId:353},
    rows:[{name:'SAMPLE BETA',studentNo:'9900000003'}]
  });
  return processStudent({
    tabId:1,
    student:{name:'SAMPLE BETA',studentNo:'9900000003'}
  });
})()`, context);
assert.equal(alreadyPendingFlow.code, 'ALREADY_PENDING');
assert.equal(alreadyPendingFlow.result, '보내기 완료');

console.log('service-worker audit tests passed');
