// FIMS의 실제 로그인/프레임셋 진입점이다. 공개 하이코리아 주소를 거치면
// 기존 탭 또는 별도 팝업과 섞일 수 있으므로 자동화는 이 주소에서 새로 시작한다.
const FIMS_LOGIN_URL = 'https://fims.hikorea.go.kr/isi/MembIsiLogin.isi';
const FIMS_HOST_PATTERNS = [
  'https://www.hikorea.go.kr/isi/*',
  'https://fims.hikorea.go.kr/*'
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const normalizeText = (value) => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
const normalizeName = (value) => normalizeText(value).toUpperCase();
const normalizeStudentNo = (value) => String(value ?? '').replace(/\D/g, '');
const normalizeDate = (value) => String(value ?? '').replace(/\D/g, '');

async function getFimsTabs() {
  return chrome.tabs.query({ url: FIMS_HOST_PATTERNS });
}

async function focusTab(tab) {
  if (!tab?.id) return;
  await chrome.tabs.update(tab.id, { active: true });
  if (tab.windowId) {
    try { await chrome.windows.update(tab.windowId, { focused: true }); } catch (_) {}
  }
}

async function closeExistingFimsTabs() {
  const tabs = await getFimsTabs();
  const tabIds = [...new Set(tabs.map((tab) => tab.id).filter(Number.isInteger))];
  if (!tabIds.length) return 0;
  await chrome.tabs.remove(tabIds);
  return tabIds.length;
}

async function openFreshFimsWindow() {
  const closedTabCount = await closeExistingFimsTabs();
  // 기존 창 제거와 새 창 생성이 같은 이벤트 루프에서 겹치지 않도록 짧게 분리한다.
  await sleep(350);

  const createdWindow = await chrome.windows.create({
    url: FIMS_LOGIN_URL,
    focused: true,
    type: 'normal'
  });
  let tab = Array.isArray(createdWindow?.tabs) ? createdWindow.tabs[0] : null;
  if (!tab?.id && Number.isInteger(createdWindow?.id)) {
    const tabs = await chrome.tabs.query({ windowId: createdWindow.id });
    tab = tabs.find((item) => item.url === FIMS_LOGIN_URL) || tabs[0] || null;
  }
  if (!tab?.id) throw new Error('새 FIMS 전용 창을 열지 못했습니다.');
  await waitForTabReady(tab.id, 30000);
  await focusTab(tab);
  return { tab, windowId: createdWindow?.id ?? tab.windowId, closedTabCount };
}

async function waitForTabReady(tabId, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === 'complete') return tab;
    } catch (_) {}
    await sleep(300);
  }
  return chrome.tabs.get(tabId);
}

async function getFrames(tabId) {
  try {
    const frames = await chrome.webNavigation.getAllFrames({ tabId });
    return Array.isArray(frames) && frames.length ? frames : [{ frameId: 0, parentFrameId: -1, url: '' }];
  } catch (_) {
    return [{ frameId: 0, parentFrameId: -1, url: '' }];
  }
}

async function ensureContentScript(tabId, frameId) {
  try {
    const response = await chrome.tabs.sendMessage(
      tabId,
      { type: 'FIMS_GRAD_RPA_ACTION', action: 'INSPECT' },
      { frameId }
    );
    return Boolean(response?.ok);
  } catch (_) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId, frameIds: [frameId] },
        files: ['content.js']
      });
      return true;
    } catch (_) {
      return false;
    }
  }
}

async function inspectAll(tabId) {
  const frames = await getFrames(tabId);
  const inspected = await Promise.all(frames.map(async (frame) => {
    const ready = await ensureContentScript(tabId, frame.frameId);
    if (!ready) return null;
    try {
      const response = await chrome.tabs.sendMessage(
        tabId,
        { type: 'FIMS_GRAD_RPA_ACTION', action: 'INSPECT' },
        { frameId: frame.frameId }
      );
      return response?.ok ? { ...frame, state: response.data } : null;
    } catch (_) {
      return null;
    }
  }));
  return inspected.filter(Boolean);
}

async function waitForFrame(tabId, predicate, timeoutMs = 30000, intervalMs = 450) {
  const started = Date.now();
  let latest = [];
  while (Date.now() - started < timeoutMs) {
    latest = await inspectAll(tabId);
    const found = latest.find((frame) => {
      try { return predicate(frame.state || {}, frame); } catch (_) { return false; }
    });
    if (found) return found;
    await sleep(intervalMs);
  }
  return null;
}

async function waitMainActionFrame(tabId, capability, timeoutMs = 5000) {
  return waitForFrame(
    tabId,
    (state) => state.isSearchMainFrame === true && state[capability] === true,
    timeoutMs
  );
}

async function sendAction(tabId, frameId, action, payload = {}) {
  try {
    const response = await chrome.tabs.sendMessage(
      tabId,
      { type: 'FIMS_GRAD_RPA_ACTION', action, payload },
      { frameId }
    );
    return response || { ok: false, message: '응답 없음' };
  } catch (error) {
    return { ok: false, message: error?.message || String(error) };
  }
}

async function setDialogMode(tabId, frameId, { confirmValue, durationMs = 60000, clearLog = true }) {
  try {
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      world: 'MAIN',
      args: [{ confirmValue: confirmValue === true, durationMs, clearLog }],
      func: (options) => {
        if (typeof window.__FIMS_GRAD_RPA_SET_DIALOG_MODE__ === 'function') {
          return window.__FIMS_GRAD_RPA_SET_DIALOG_MODE__(options);
        }
        const flagKey = 'FIMS_GRAD_RPA_DIALOG_MODE';
        const logKey = 'FIMS_GRAD_RPA_DIALOG_LOG';
        const nativeDialogs = window.__FIMS_GRAD_RPA_NATIVE_DIALOGS__ || {
          alert: window.alert.bind(window),
          confirm: window.confirm.bind(window)
        };
        window.__FIMS_GRAD_RPA_NATIVE_DIALOGS__ = nativeDialogs;
        const mode = {
          active: true,
          confirmValue: options.confirmValue === true,
          until: Date.now() + Number(options.durationMs || 60000)
        };
        const readMode = () => {
          try {
            const value = JSON.parse(sessionStorage.getItem(flagKey) || 'null');
            return value?.active === true && Number(value.until || 0) >= Date.now() ? value : null;
          } catch (_) {
            return null;
          }
        };
        const writeLog = (kind, message, answer = null) => {
          try {
            const log = JSON.parse(sessionStorage.getItem(logKey) || '[]');
            log.push({ kind, message: String(message ?? ''), answer, at: new Date().toISOString(), href: location.href });
            sessionStorage.setItem(logKey, JSON.stringify(log.slice(-30)));
          } catch (_) {}
        };
        sessionStorage.setItem(flagKey, JSON.stringify(mode));
        if (options.clearLog !== false) sessionStorage.setItem(logKey, '[]');
        window.confirm = (message) => {
          const current = readMode();
          if (!current) return nativeDialogs.confirm(message);
          const answer = current.confirmValue === true;
          writeLog('confirm', message, answer);
          return answer;
        };
        window.alert = (message) => {
          if (!readMode()) return nativeDialogs.alert(message);
          writeLog('alert', message);
          return undefined;
        };
        window.__FIMS_GRAD_RPA_GET_DIALOG_LOG__ = () => {
          try { return JSON.parse(sessionStorage.getItem(logKey) || '[]'); } catch (_) { return []; }
        };
        window.__FIMS_GRAD_RPA_CLEAR_DIALOG_MODE__ = () => {
          sessionStorage.removeItem(flagKey);
          window.alert = nativeDialogs.alert;
          window.confirm = nativeDialogs.confirm;
        };
        return mode;
      }
    });
    return result;
  } catch (_) {
    return null;
  }
}

async function setDialogModeAllFrames(tabId, options) {
  const frames = await getFrames(tabId);
  const armedFrameIds = [];
  for (let index = 0; index < frames.length; index += 1) {
    const result = await setDialogMode(tabId, frames[index].frameId, {
      ...options,
      clearLog: index === 0 ? options.clearLog !== false : false
    });
    if (result?.active === true) armedFrameIds.push(frames[index].frameId);
  }
  return { armed: armedFrameIds.length, total: frames.length, armedFrameIds };
}

function dialogGuardReady(guard, requiredFrameIds = []) {
  const armed = new Set(Array.isArray(guard?.armedFrameIds) ? guard.armedFrameIds : []);
  return requiredFrameIds.every((frameId) => armed.has(frameId));
}

async function clearDialogMode(tabId) {
  const frames = await getFrames(tabId);
  await Promise.all(frames.map(async (frame) => {
    try {
      await chrome.scripting.executeScript({
        target: { tabId, frameIds: [frame.frameId] },
        world: 'MAIN',
        func: () => {
          if (typeof window.__FIMS_GRAD_RPA_CLEAR_DIALOG_MODE__ === 'function') {
            window.__FIMS_GRAD_RPA_CLEAR_DIALOG_MODE__();
          } else {
            sessionStorage.removeItem('FIMS_GRAD_RPA_DIALOG_MODE');
          }
        }
      });
    } catch (_) {}
  }));
}

async function getDialogLogs(tabId) {
  const frames = await getFrames(tabId);
  const entries = [];
  await Promise.all(frames.map(async (frame) => {
    try {
      const [{ result } = {}] = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [frame.frameId] },
        world: 'MAIN',
        func: () => {
          try {
            if (typeof window.__FIMS_GRAD_RPA_GET_DIALOG_LOG__ === 'function') {
              return window.__FIMS_GRAD_RPA_GET_DIALOG_LOG__();
            }
            return JSON.parse(sessionStorage.getItem('FIMS_GRAD_RPA_DIALOG_LOG') || '[]');
          } catch (_) {
            return [];
          }
        }
      });
      if (Array.isArray(result)) {
        for (const item of result) entries.push({ ...item, frameId: frame.frameId });
      }
    } catch (_) {}
  }));
  const seen = new Set();
  return entries
    .sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')))
    .filter((entry) => {
      const key = `${entry.kind}|${entry.message}|${entry.at}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

async function loginAndOpenChangeReport({ userId, password }) {
  if (!userId || !password) throw new Error('FIMS 사용자 ID와 비밀번호를 입력하세요.');
  const fresh = await openFreshFimsWindow();
  const tab = fresh.tab;
  const tabId = tab.id;
  await waitForTabReady(tabId, 30000);

  let frames = await inspectAll(tabId);
  let searchFrame = frames.find((frame) => frame.state?.hasSearchForm);
  if (searchFrame) {
    return {
      tabId,
      windowId: fresh.windowId,
      closedTabCount: fresh.closedTabCount,
      alreadyLoggedIn: true,
      message: `새 FIMS 창에서 기존 로그인 세션과 변동신고 화면 확인 완료 (기존 FIMS 탭 ${fresh.closedTabCount}개 종료)`
    };
  }

  let loginFrame = frames.find((frame) => frame.state?.hasLogin);
  if (!loginFrame) loginFrame = await waitForFrame(tabId, (state) => state.hasLogin, 30000);

  if (loginFrame) {
    const filled = await sendAction(tabId, loginFrame.frameId, 'FILL_LOGIN', { userId, password });
    if (!filled.ok) throw new Error(filled.message || '로그인 정보 입력 실패');
    await setDialogModeAllFrames(tabId, { confirmValue: true, durationMs: 60000, clearLog: true });
    const clicked = await sendAction(tabId, loginFrame.frameId, 'CLICK_LOGIN');
    if (!clicked.ok) throw new Error(clicked.message || '로그인 버튼 클릭 실패');
  }

  const menuFrame = await waitForFrame(
    tabId,
    (state) => state.hasChangeMenu || state.hasSearchForm,
    60000
  );
  if (!menuFrame) {
    const logs = await getDialogLogs(tabId);
    const lastAlert = logs.filter((item) => item.kind === 'alert').at(-1)?.message;
    throw new Error(lastAlert ? `로그인 확인 실패: ${lastAlert}` : '로그인 후 FIMS 메뉴가 나타나지 않았습니다.');
  }

  await clearDialogMode(tabId);
  if (menuFrame.state?.hasSearchForm) {
    return {
      tabId,
      windowId: fresh.windowId,
      closedTabCount: fresh.closedTabCount,
      alreadyLoggedIn: !loginFrame,
      message: `새 FIMS 창에서 변동신고 화면 확인 완료 (기존 FIMS 탭 ${fresh.closedTabCount}개 종료)`
    };
  }

  const menuCandidates = (await inspectAll(tabId)).filter((frame) => frame.state?.hasChangeMenu);
  let clickedMenu = false;
  for (const candidate of menuCandidates) {
    const clicked = await sendAction(tabId, candidate.frameId, 'CLICK_CHANGE_MENU');
    if (clicked.ok) {
      clickedMenu = true;
      break;
    }
  }
  if (!clickedMenu) throw new Error('변동신고 메뉴 클릭에 실패했습니다.');

  searchFrame = await waitForFrame(tabId, (state) => state.hasSearchForm, 60000);
  if (!searchFrame) throw new Error('변동신고 학생조회 화면 진입을 확인하지 못했습니다.');

  return {
    tabId,
    windowId: fresh.windowId,
    closedTabCount: fresh.closedTabCount,
    alreadyLoggedIn: !loginFrame,
    message: `새 FIMS 창 로그인 후 변동신고 화면 진입 완료 (기존 FIMS 탭 ${fresh.closedTabCount}개 종료)`
  };
}

async function ensureSearchFrame(tabId) {
  let frame = await waitForFrame(tabId, (state) => state.hasSearchForm, 5000);
  if (frame) return frame;

  const menuFrames = (await inspectAll(tabId)).filter((item) => item.state?.hasChangeMenu);
  for (const menuFrame of menuFrames) {
    const clicked = await sendAction(tabId, menuFrame.frameId, 'CLICK_CHANGE_MENU');
    if (clicked.ok) break;
  }

  frame = await waitForFrame(tabId, (state) => state.hasSearchForm, 30000);
  if (!frame) throw new Error('변동신고 학생조회 화면을 찾지 못했습니다.');
  return frame;
}

async function waitTargetSearchCheckbox(tabId, student, timeoutMs = 30000, previousDocumentToken = '') {
  const started = Date.now();
  let last = null;
  let foundToken = '';
  let foundReads = 0;
  let nonMatchSignature = '';
  let nonMatchSince = 0;
  while (Date.now() - started < timeoutMs) {
    const frame = await waitForFrame(
      tabId,
      (state) => state.isSearchResultsFrame === true || state.hasSearchResults === true,
      3000
    );
    if (frame) {
      const response = await sendAction(tabId, frame.frameId, 'READ_TARGET_SEARCH_CHECKBOX', student);
      if (response.ok) {
        last = { frame, data: response.data };
        const data = response.data || {};
        const documentToken = String(data.documentToken || frame.state?.documentToken || '');
        const refreshed = !previousDocumentToken || (documentToken && documentToken !== previousDocumentToken);
        const elapsed = Date.now() - started;
        if (data.state === 'FOUND') {
          const token = String(data.token || '');
          foundReads = token && token === foundToken ? foundReads + 1 : 1;
          foundToken = token;
          if (foundReads >= 2) return last;
        } else {
          foundToken = '';
          foundReads = 0;
        }
        // 조회 직후 chgIntlStudFrame에는 직전 학생의 빈 결과가 잠시 남을 수 있다.
        // 새 문서가 확인되거나 최소 대기시간이 지난 뒤에만 NONE/AMBIGUOUS를 확정한다.
        if (data.state === 'NONE' || data.state === 'AMBIGUOUS') {
          if (refreshed || elapsed >= 2500) return last;
          await sleep(250);
          continue;
        }

        if (data.criteriaMatch && data.candidateCount > 0) {
          const signature = String(data.signature || '');
          if (signature !== nonMatchSignature) {
            nonMatchSignature = signature;
            nonMatchSince = Date.now();
          } else if (Date.now() - started >= 6000 && Date.now() - nonMatchSince >= 1200) {
            return { frame, data: { ...data, state: 'NOT_FOUND' } };
          }
        }
      }
    }
    await sleep(450);
  }
  return {
    frame: last?.frame || null,
    data: { ...(last?.data || {}), state: 'TIMEOUT' }
  };
}

async function readPending(tabId, timeoutMs = 10000) {
  const frame = await waitForFrame(tabId, (state) => state.hasPendingTable, timeoutMs);
  if (!frame) return { frame: null, rows: [] };
  const response = await sendAction(tabId, frame.frameId, 'READ_PENDING_ROWS');
  return { frame, rows: response?.data?.rows || [] };
}

async function waitPendingContains(tabId, student, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const pending = await readPending(tabId, 3000);
    const found = pending.rows.find((row) =>
      normalizeName(row.name) === normalizeName(student.name) &&
      normalizeStudentNo(row.studentNo) === normalizeStudentNo(student.studentNo)
    );
    if (found) return { ...pending, found };
    await sleep(550);
  }
  return null;
}

async function checkPendingStudent({ tabId, student }) {
  if (!tabId || !student?.name || !student?.studentNo) {
    throw new Error('대기명단 확인 대상 정보가 올바르지 않습니다.');
  }

  const pending = await readPending(tabId, 15000);
  if (!pending.frame) {
    return {
      visible: false,
      found: false,
      ambiguous: false,
      message: '유학생신고 대기명단을 찾지 못해 중단 당시 처리 여부를 판정할 수 없습니다.'
    };
  }

  const matches = pending.rows.filter((row) =>
    normalizeName(row.name) === normalizeName(student.name) &&
    normalizeStudentNo(row.studentNo) === normalizeStudentNo(student.studentNo)
  );

  return {
    visible: true,
    found: matches.length === 1,
    ambiguous: matches.length > 1,
    matchCount: matches.length,
    row: matches.length === 1 ? matches[0] : null,
    message: matches.length === 1
      ? 'FIMS 유학생신고 대기명단에서 대상자를 확인했습니다.'
      : matches.length > 1
        ? `동일한 성명·학번이 대기명단에 ${matches.length}건 있어 자동 판정을 중단했습니다.`
        : 'FIMS 유학생신고 대기명단에서 대상자를 찾지 못했습니다.'
  };
}

async function processStudent({ tabId, student }) {
  if (!tabId || !student?.name || !student?.studentNo) throw new Error('학생 처리 정보가 올바르지 않습니다.');

  // 담당자가 수동으로 먼저 보냈거나 이전 실행에서 시트 기록 전에 중단됐을 수 있다.
  // 대기명단에 현재 시트 학생이 정확히 1건 있으면 중복 전송하지 않고 이번 실행 대상으로 인계한다.
  const existingPending = await readPending(tabId, 5000);
  if (existingPending.frame) {
    const existingMatches = existingPending.rows.filter((row) =>
      normalizeName(row.name) === normalizeName(student.name) &&
      normalizeStudentNo(row.studentNo) === normalizeStudentNo(student.studentNo)
    );
    if (existingMatches.length === 1) {
      return {
        code: 'ALREADY_PENDING',
        result: '보내기 완료',
        detail: 'FIMS 유학생신고 대기명단에 이미 성명·학번 정확 일치 1건이 있어 중복 보내기 없이 인계'
      };
    }
    if (existingMatches.length > 1) {
      return {
        code: 'PENDING_AMBIGUOUS',
        result: '보내기 처리 실패',
        detail: `FIMS 대기명단에 동일한 성명·학번이 ${existingMatches.length}건 있어 자동 선택하지 않았습니다.`
      };
    }
  }

  const searchFrame = await ensureSearchFrame(tabId);

  const beforeFrames = await inspectAll(tabId);
  const beforeResultFrame = beforeFrames.find((frame) =>
    frame.state?.isSearchResultsFrame === true || frame.state?.hasSearchResults === true
  );
  const previousDocumentToken = String(beforeResultFrame?.state?.documentToken || '');

  const search = await sendAction(tabId, searchFrame.frameId, 'PREPARE_STUDENT_SEARCH', {
    name: student.name,
    studentNo: student.studentNo
  });
  if (!search.ok) {
    return { code: 'SEARCH_FAILED', result: '조회 처리 실패', detail: search.message || '조회 실행 실패' };
  }

  const result = await waitTargetSearchCheckbox(tabId, student, 30000, previousDocumentToken);
  if (!result.frame || result.data?.state === 'TIMEOUT' || result.data?.state === 'WAIT') {
    const observed = (result.data?.availableTitles || []).join(', ');
    return {
      code: 'SEARCH_TIMEOUT',
      result: '조회 결과 확인 실패',
      detail: observed
        ? `30초 동안 '${student.name}' title 체크박스를 찾지 못했습니다. 보이는 title: ${observed}`
        : `30초 동안 '${student.name}' title 체크박스가 생성되지 않았습니다.`
    };
  }

  if (result.data.state === 'NONE' || result.data.state === 'NOT_FOUND') {
    const foundSummary = (result.data?.availableTitles || []).join(', ');
    return {
      code: 'MISMATCH',
      result: '이름, 학번 불일치',
      detail: foundSummary ? `조회 결과의 checkbox title: ${foundSummary}` : '학생 정보가 조회되지 않았습니다.'
    };
  }

  if (result.data.state === 'AMBIGUOUS') {
    return {
      code: 'AMBIGUOUS',
      result: '이름, 학번 불일치',
      detail: `title이 '${student.name}'인 체크박스가 ${result.data.matchCount || result.data.titleMatchCount || 0}건이므로 자동 선택하지 않았습니다.`
    };
  }

  const selected = await sendAction(tabId, result.frame.frameId, 'SELECT_TARGET_SEARCH_CHECKBOX', {
    token: result.data.token,
    name: student.name,
    studentNo: student.studentNo
  });
  if (!selected.ok) {
    return { code: 'SELECT_FAILED', result: '보내기 처리 실패', detail: selected.message || '학생 체크박스 클릭 실패' };
  }

  const sendFrame = await waitMainActionFrame(tabId, 'hasSendButton', 5000) || searchFrame;
  // FIMS 공통 확인 함수가 top.confirm을 호출할 수 있으므로 mainFrame뿐 아니라
  // top/left/자식 프레임까지 모두 먼저 무장한 뒤 보내기를 클릭한다.
  const sendGuard = await setDialogModeAllFrames(tabId, { confirmValue: true, durationMs: 45000, clearLog: true });
  if (!dialogGuardReady(sendGuard, [0, sendFrame.frameId])) {
    return { code: 'DIALOG_GUARD_FAILED', result: '보내기 처리 실패', detail: '확인창 자동승인 준비에 실패하여 보내기 버튼을 누르지 않았습니다.' };
  }
  const sent = await sendAction(tabId, sendFrame.frameId, 'SEND_SELECTED');
  if (!sent.ok) {
    await clearDialogMode(tabId);
    return { code: 'SEND_FAILED', result: '보내기 처리 실패', detail: sent.message || 'mainFrame 보내기 버튼 클릭 실패' };
  }

  const verified = await waitPendingContains(tabId, student, 30000);
  const logs = await getDialogLogs(tabId);
  await clearDialogMode(tabId);

  if (!verified) {
    const lastAlert = logs.filter((item) => item.kind === 'alert').at(-1)?.message;
    return {
      code: 'SEND_NOT_VERIFIED',
      result: '보내기 처리 실패',
      detail: lastAlert || '유학생신고 목록에서 대상자를 재확인하지 못했습니다.'
    };
  }

  return { code: 'SENT', result: '보내기 완료', detail: '성명·학번 정확 일치 및 유학생신고 목록 이동 확인' };
}

function targetKey(item) {
  return `${normalizeName(item.name)}|${normalizeStudentNo(item.studentNo)}`;
}

function comparePendingRows(expectedTargets, actualRows) {
  const expectedMap = new Map(expectedTargets.map((item) => [targetKey(item), item]));
  const actualGroups = new Map();
  for (const row of actualRows) {
    const key = targetKey(row);
    if (!actualGroups.has(key)) actualGroups.set(key, []);
    actualGroups.get(key).push(row);
  }
  const missing = [...expectedMap.entries()]
    .filter(([key]) => !actualGroups.has(key))
    .map(([, value]) => value);
  const duplicates = [...expectedMap.entries()]
    .filter(([key]) => (actualGroups.get(key) || []).length > 1)
    .map(([key, value]) => ({ ...value, count: actualGroups.get(key).length }));
  const extras = actualRows.filter((row) => !expectedMap.has(targetKey(row)));
  const matchedRows = [...expectedMap.keys()].flatMap((key) => actualGroups.get(key) || []);
  return {
    ok: expectedTargets.length > 0 && missing.length === 0 && duplicates.length === 0,
    expectedCount: expectedTargets.length,
    actualCount: actualRows.length,
    matchedCount: matchedRows.length,
    missing,
    duplicates,
    extras,
    matchedRows
  };
}

async function auditPending({ tabId, expectedTargets }) {
  const pending = await readPending(tabId, 15000);
  if (!pending.frame) {
    return { ok: false, message: '유학생신고 목록을 찾지 못했습니다.', rows: [], comparison: null };
  }
  const comparison = comparePendingRows(expectedTargets || [], pending.rows);
  return {
    ok: comparison.ok,
    message: comparison.ok
      ? `이번 실행 대상 ${comparison.expectedCount}건 확인 완료${comparison.extras.length ? ` / 기존 대기 ${comparison.extras.length}건은 제외` : ''}`
      : `이번 실행 대상 확인 실패: 예상 ${comparison.expectedCount}건 / 확인 ${comparison.matchedCount}건`,
    rows: comparison.matchedRows,
    allRows: pending.rows,
    comparison,
    frameId: pending.frame.frameId
  };
}

async function findBatchPopup(mainTabId, beforeTabIds, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const tabs = await getFimsTabs();
    const ordered = [
      ...tabs.filter((tab) => tab.id !== mainTabId && !beforeTabIds.has(tab.id)),
      ...tabs.filter((tab) => tab.id !== mainTabId && beforeTabIds.has(tab.id)),
      ...tabs.filter((tab) => tab.id === mainTabId)
    ];
    for (const tab of ordered) {
      if (!tab.id) continue;
      const frame = await waitForFrame(tab.id, (state) => state.hasBatchPopup, 1500, 250);
      if (frame) return { tab, frame };
    }
    await sleep(350);
  }
  return null;
}

async function waitPopupSaved(popupTabId, mainTabId, timeoutMs = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (popupTabId !== mainTabId) {
      try {
        await chrome.tabs.get(popupTabId);
      } catch (_) {
        return true;
      }
    }
    const frames = await inspectAll(popupTabId).catch(() => []);
    if (!frames.some((frame) => frame.state?.hasBatchPopup)) return true;
    await sleep(400);
  }
  return false;
}

async function applyBatch({ tabId, expectedTargets, config }) {
  const audit = await auditPending({ tabId, expectedTargets });
  if (!audit.ok) {
    const missing = audit.comparison?.missing?.map((item) => `${item.name}/${item.studentNo}`).join(', ');
    const duplicates = audit.comparison?.duplicates?.map((item) => `${item.name}/${item.studentNo}(${item.count}건)`).join(', ');
    throw new Error([
      audit.message,
      missing ? `누락: ${missing}` : '',
      duplicates ? `중복: ${duplicates}` : ''
    ].filter(Boolean).join(' / '));
  }

  const selected = await sendAction(tabId, audit.frameId, 'SELECT_PENDING_TARGETS', { targets: expectedTargets });
  if (!selected.ok || selected.checked !== expectedTargets.length) {
    throw new Error(selected.message || `이번 실행 대상 선택 검증 실패: ${selected.checked || 0}/${expectedTargets.length}건`);
  }

  // 이번 엑셀 대상 선택은 notiListFrame, 일괄입력 버튼은 mainFrame에 있다.
  const batchFrame = await waitMainActionFrame(tabId, 'hasBatchButton', 5000);
  if (!batchFrame) throw new Error('mainFrame에서 신고내용일괄입력 버튼을 찾지 못했습니다.');

  const beforeTabs = new Set((await getFimsTabs()).map((tab) => tab.id));
  const opened = await sendAction(tabId, batchFrame.frameId, 'OPEN_BATCH_POPUP');
  if (!opened.ok) throw new Error(opened.message || '신고내용일괄입력 팝업 열기 실패');

  const popup = await findBatchPopup(tabId, beforeTabs, 30000);
  if (!popup?.tab?.id || !popup.frame) throw new Error('신고내용 일괄입력 팝업을 찾지 못했습니다.');

  await focusTab(popup.tab);
  const filled = await sendAction(popup.tab.id, popup.frame.frameId, 'FILL_BATCH_POPUP', {
    reasonDate: config.reasonDate,
    reportTypeValue: config.reportTypeValue,
    reportTypeText: config.reportTypeText,
    reportText: config.reportText
  });
  if (!filled.ok) throw new Error(filled.message || '신고내용 일괄입력 실패');

  const verified = filled.values || {};
  if (normalizeDate(verified.reasonDate) !== normalizeDate(config.reasonDate) ||
      String(verified.reportTypeValue) !== String(config.reportTypeValue) ||
      String(verified.reportText) !== String(config.reportText)) {
    throw new Error('팝업 입력값 재검증에 실패했습니다. 저장하지 않았습니다.');
  }

  const saveGuard = await setDialogModeAllFrames(popup.tab.id, { confirmValue: true, durationMs: 45000, clearLog: true });
  if (!dialogGuardReady(saveGuard, [0, popup.frame.frameId])) {
    throw new Error('팝업 저장 알림 처리 준비에 실패하여 저장 버튼을 누르지 않았습니다.');
  }
  const saved = await sendAction(popup.tab.id, popup.frame.frameId, 'SAVE_BATCH_POPUP');
  if (!saved.ok) throw new Error(saved.message || '팝업 저장 버튼 클릭 실패');

  const closed = await waitPopupSaved(popup.tab.id, tabId, 30000);
  const popupLogs = await getDialogLogs(popup.tab.id).catch(() => []);
  await clearDialogMode(popup.tab.id).catch(() => {});
  if (!closed) {
    const lastAlert = popupLogs.filter((item) => item.kind === 'alert').at(-1)?.message;
    throw new Error(lastAlert || '신고내용 저장 후 팝업이 닫히지 않았습니다.');
  }

  await focusTab(await chrome.tabs.get(tabId));
  const after = await auditPending({ tabId, expectedTargets });
  if (!after.ok) throw new Error(`신고내용 저장 후 ${after.message}`);

  const wrongRows = after.rows.filter((row) => {
    const dateOk = !row.reasonDate || normalizeDate(row.reasonDate) === normalizeDate(config.reasonDate);
    const typeOk = !row.reportTypeValue || row.reportTypeValue === config.reportTypeValue;
    return !dateOk || !typeOk;
  });
  if (wrongRows.length) {
    throw new Error(`저장 후 사유발생일 또는 신고구분이 다른 대상자가 ${wrongRows.length}건 있습니다.`);
  }

  return {
    ok: true,
    message: `${expectedTargets.length}건 신고내용 일괄입력 완료`,
    rows: after.rows,
    verifiedValues: filled.values
  };
}

async function finalizeReport({ tabId, expectedTargets }) {
  const audit = await auditPending({ tabId, expectedTargets });
  if (!audit.ok) throw new Error(audit.message);

  const selected = await sendAction(tabId, audit.frameId, 'SELECT_PENDING_TARGETS', { targets: expectedTargets });
  if (!selected.ok || selected.checked !== expectedTargets.length) {
    throw new Error(selected.message || `최종 대상 선택 검증 실패: ${selected.checked || 0}/${expectedTargets.length}건`);
  }

  // 최종 대상 재선택은 notiListFrame, 신고처리 버튼과 confirm/alert는 mainFrame에 있다.
  const finalFrame = await waitMainActionFrame(tabId, 'hasFinalButton', 5000);
  if (!finalFrame) throw new Error('mainFrame에서 신고처리 버튼을 찾지 못했습니다.');

  const finalGuard = await setDialogModeAllFrames(tabId, { confirmValue: true, durationMs: 120000, clearLog: true });
  if (!dialogGuardReady(finalGuard, [0, finalFrame.frameId])) {
    throw new Error('최종 확인창 자동승인 준비에 실패하여 신고처리 버튼을 누르지 않았습니다.');
  }
  const clicked = await sendAction(tabId, finalFrame.frameId, 'CLICK_FINAL_REPORT');
  if (!clicked.ok) {
    await clearDialogMode(tabId);
    throw new Error(clicked.message || '신고처리 버튼 클릭 실패');
  }

  const started = Date.now();
  let logs = [];
  let successMessage = '';
  let successCount = null;
  while (Date.now() - started < 90000) {
    logs = await getDialogLogs(tabId);
    const success = logs.find((item) => /정상적으로\s*신고처리\s*되었습니다/i.test(String(item.message || '')));
    if (success) {
      successMessage = String(success.message || '');
      const match = successMessage.match(/\[\s*(\d+)\s*건\s*\]/);
      successCount = match ? Number(match[1]) : null;
      break;
    }
    await sleep(500);
  }

  await clearDialogMode(tabId);
  const confirmEntry = logs.find((item) => item.kind === 'confirm' && /신고처리/.test(String(item.message || '')));

  if (!successMessage) {
    const alerts = logs.filter((item) => item.kind === 'alert').map((item) => item.message).filter(Boolean);
    return {
      ok: false,
      code: 'SUCCESS_NOT_CONFIRMED',
      message: alerts.at(-1) || '정상 처리 완료 알림을 확인하지 못했습니다.',
      logs
    };
  }

  if (successCount === null) {
    return {
      ok: false,
      code: 'COUNT_NOT_FOUND',
      message: `완료 알림에서 신고 건수를 읽지 못했습니다: ${successMessage}`,
      logs
    };
  }

  if (successCount !== expectedTargets.length) {
    return {
      ok: false,
      code: 'COUNT_MISMATCH',
      message: `완료 알림 ${successCount}건 / 예상 ${expectedTargets.length}건으로 일치하지 않습니다.`,
      successCount,
      logs
    };
  }

  return {
    ok: true,
    code: 'COMPLETED',
    message: successMessage,
    successCount,
    confirmMessage: confirmEntry?.message || '',
    logs
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'FIMS_GRAD_RPA_COMMAND') return;

  (async () => {
    try {
      let result;
      switch (message.command) {
        case 'OPEN_OR_LOGIN':
          result = await loginAndOpenChangeReport(message.payload || {});
          break;
        case 'PROCESS_STUDENT':
          result = await processStudent(message.payload || {});
          break;
        case 'CHECK_PENDING_STUDENT':
          result = await checkPendingStudent(message.payload || {});
          break;
        case 'AUDIT_PENDING':
          result = await auditPending(message.payload || {});
          break;
        case 'APPLY_BATCH':
          result = await applyBatch(message.payload || {});
          break;
        case 'FINALIZE':
          result = await finalizeReport(message.payload || {});
          break;
        case 'OPEN_FIMS': {
          const fresh = await openFreshFimsWindow();
          result = {
            tabId: fresh.tab.id,
            windowId: fresh.windowId,
            closedTabCount: fresh.closedTabCount,
            message: `새 FIMS 전용 창을 열었습니다. (기존 FIMS 탭 ${fresh.closedTabCount}개 종료)`
          };
          break;
        }
        default:
          throw new Error(`지원하지 않는 명령: ${message.command}`);
      }
      sendResponse({ ok: true, result });
    } catch (error) {
      sendResponse({ ok: false, error: error?.message || String(error) });
    }
  })();

  return true;
});
