// MembIsiLogin.isi를 GET으로 바로 열면 FIMS가 빈 로그인 요청으로 판단해
// "ID를 확인해주세요"를 띄운다. 공식 frameset 진입점에서 bodyFrame의
// login.jsp가 안정된 뒤 실제 로그인 버튼(Button2 → membLogin)을 누른다.
const FIMS_ENTRY_URL = 'https://fims.hikorea.go.kr/isi/index.html';
const FIMS_HOST_PATTERNS = [
  'https://www.hikorea.go.kr/isi/*',
  'https://fims.hikorea.go.kr/*'
];
const FIMS_NAME_MAX_LENGTH = 38;
const LOGIN_PAGE_SETTLE_MS = 2500;
const LOGIN_INPUT_SETTLE_MS = 350;
const POST_LOGIN_MENU_SETTLE_MS = 1800;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const normalizeText = (value) => String(value ?? '').normalize('NFKC').replace(/\s+/g, ' ').trim();
const normalizeName = (value) => normalizeText(value)
  .replace(/[,，]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .toUpperCase();
const normalizeFimsName = (value) => normalizeName(value).slice(0, FIMS_NAME_MAX_LENGTH).trim();
const normalizeStudentNo = (value) => String(value ?? '').replace(/\D/g, '');
const normalizeDate = (value) => String(value ?? '').replace(/\D/g, '');

function sameFimsName(left, right) {
  const a = normalizeFimsName(left);
  const b = normalizeFimsName(right);
  return Boolean(a && b && a === b);
}

function formatDate(value) {
  const digits = normalizeDate(value);
  return /^\d{8}$/.test(digits)
    ? `${digits.slice(0, 4)}.${digits.slice(4, 6)}.${digits.slice(6, 8)}`
    : normalizeText(value);
}

async function withTimeout(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function getFimsTabs() {
  return chrome.tabs.query({ url: FIMS_HOST_PATTERNS });
}

async function focusTab(tab) {
  if (!tab?.id) return;
  await chrome.tabs.update(tab.id, { active: true });
  if (Number.isInteger(tab.windowId)) {
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

async function clearFimsCookies() {
  if (!chrome.cookies?.getAll || !chrome.cookies?.remove) {
    throw new Error('FIMS 새 로그인에 필요한 쿠키 삭제 권한을 사용할 수 없습니다. 확장프로그램을 다시 설치하세요.');
  }
  const cookies = await chrome.cookies.getAll({ domain: 'fims.hikorea.go.kr' });
  let clearedCookieCount = 0;
  for (const cookie of cookies) {
    const host = String(cookie.domain || 'fims.hikorea.go.kr').replace(/^\./, '');
    const path = String(cookie.path || '/').startsWith('/') ? String(cookie.path || '/') : `/${cookie.path}`;
    const removal = {
      url: `https://${host}${path}`,
      name: cookie.name
    };
    if (cookie.storeId) removal.storeId = cookie.storeId;
    if (cookie.partitionKey) removal.partitionKey = cookie.partitionKey;
    const removed = await chrome.cookies.remove(removal);
    if (removed) clearedCookieCount += 1;
  }
  return clearedCookieCount;
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

async function openFreshFimsWindow() {
  const closedTabCount = await closeExistingFimsTabs();
  const clearedCookieCount = await clearFimsCookies();
  await sleep(350);
  const createdWindow = await chrome.windows.create({
    url: FIMS_ENTRY_URL,
    focused: true,
    type: 'popup',
    width: 1280,
    height: 900
  });
  let tab = Array.isArray(createdWindow?.tabs) ? createdWindow.tabs[0] : null;
  if (!tab?.id && Number.isInteger(createdWindow?.id)) {
    const tabs = await chrome.tabs.query({ windowId: createdWindow.id });
    tab = tabs[0] || null;
  }
  if (!tab?.id) throw new Error('새 FIMS 전용 창을 열지 못했습니다.');
  await waitForTabReady(tab.id, 30000);
  await focusTab(tab);
  return {
    tab,
    windowId: createdWindow?.id ?? tab.windowId,
    closedTabCount,
    clearedCookieCount
  };
}

async function getFrames(tabId) {
  try {
    const frames = await chrome.webNavigation.getAllFrames({ tabId });
    return Array.isArray(frames) && frames.length
      ? frames
      : [{ frameId: 0, parentFrameId: -1, url: '' }];
  } catch (_) {
    return [{ frameId: 0, parentFrameId: -1, url: '' }];
  }
}

async function ensureContentScript(tabId, frameId) {
  try {
    const response = await chrome.tabs.sendMessage(
      tabId,
      { type: 'FIMS_ARRIVAL_RPA_ACTION', action: 'INSPECT' },
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
        { type: 'FIMS_ARRIVAL_RPA_ACTION', action: 'INSPECT' },
        { frameId: frame.frameId }
      );
      return response?.ok ? { ...frame, state: response.data } : null;
    } catch (_) {
      return null;
    }
  }));
  return inspected.filter(Boolean);
}

async function waitForFrame(tabId, predicate, timeoutMs = 30000, intervalMs = 400) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const frames = await inspectAll(tabId);
    const found = frames.find((frame) => {
      try { return predicate(frame.state || {}, frame); } catch (_) { return false; }
    });
    if (found) return found;
    await sleep(intervalMs);
  }
  return null;
}

async function sendAction(tabId, frameId, action, payload = {}) {
  try {
    const response = await chrome.tabs.sendMessage(
      tabId,
      { type: 'FIMS_ARRIVAL_RPA_ACTION', action, payload },
      { frameId }
    );
    return response || { ok: false, message: '응답 없음' };
  } catch (error) {
    return { ok: false, message: error?.message || String(error) };
  }
}

async function setDialogMode(tabId, frameId, options = {}) {
  try {
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      world: 'MAIN',
      args: [{
        confirmValue: options.confirmValue === true,
        durationMs: Number(options.durationMs || 60000),
        clearLog: options.clearLog !== false
      }],
      func: (modeOptions) => {
        if (typeof window.__FIMS_ARRIVAL_RPA_SET_DIALOG_MODE__ === 'function') {
          return window.__FIMS_ARRIVAL_RPA_SET_DIALOG_MODE__(modeOptions);
        }
        const flagKey = 'FIMS_ARRIVAL_RPA_DIALOG_MODE';
        const logKey = 'FIMS_ARRIVAL_RPA_DIALOG_LOG';
        const nativeDialogs = window.__FIMS_ARRIVAL_RPA_NATIVE_DIALOGS__ || {
          alert: window.alert.bind(window),
          confirm: window.confirm.bind(window)
        };
        window.__FIMS_ARRIVAL_RPA_NATIVE_DIALOGS__ = nativeDialogs;
        const mode = {
          active: true,
          confirmValue: modeOptions.confirmValue === true,
          until: Date.now() + Math.max(1000, Number(modeOptions.durationMs || 60000))
        };
        const readMode = () => {
          try {
            const current = JSON.parse(localStorage.getItem(flagKey) || 'null');
            return current?.active === true && Number(current.until || 0) >= Date.now() ? current : null;
          } catch (_) { return null; }
        };
        const writeLog = (kind, message, answer = null) => {
          try {
            const log = JSON.parse(localStorage.getItem(logKey) || '[]');
            log.push({ kind, message: String(message ?? ''), answer, at: new Date().toISOString() });
            localStorage.setItem(logKey, JSON.stringify(log.slice(-30)));
          } catch (_) {}
        };
        localStorage.setItem(flagKey, JSON.stringify(mode));
        if (modeOptions.clearLog !== false) localStorage.setItem(logKey, '[]');
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
        return mode;
      }
    });
    return result;
  } catch (_) {
    return null;
  }
}

async function setDialogModeAllFrames(tabId, options = {}) {
  const frames = await getFrames(tabId);
  const armedFrameIds = [];
  for (let index = 0; index < frames.length; index += 1) {
    // localStorage는 오리진별로 분리돼 있고 쿠키 삭제로도 지워지지 않는다.
    // frames[0](fims 오리진)만 지우면 www.hikorea.go.kr 프레임에 이전 실행의
    // alert가 남아 다음 로그인에서 "FIMS 로그인 실패"로 오탐된다. 전 프레임을 지운다.
    const result = await setDialogMode(tabId, frames[index].frameId, {
      ...options,
      clearLog: options.clearLog !== false
    });
    if (result?.active === true) armedFrameIds.push(frames[index].frameId);
  }
  return { armed: armedFrameIds.length, total: frames.length, armedFrameIds };
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
            if (typeof window.__FIMS_ARRIVAL_RPA_GET_DIALOG_LOG__ === 'function') {
              return window.__FIMS_ARRIVAL_RPA_GET_DIALOG_LOG__();
            }
            return JSON.parse(localStorage.getItem('FIMS_ARRIVAL_RPA_DIALOG_LOG') || '[]');
          } catch (_) { return []; }
        }
      });
      if (Array.isArray(result)) entries.push(...result.map((item) => ({ ...item, frameId: frame.frameId })));
    } catch (_) {}
  }));
  const seen = new Set();
  return entries.filter((entry) => {
    const key = `${entry.kind}|${entry.message}|${entry.at}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function clearDialogMode(tabId) {
  const frames = await getFrames(tabId);
  await Promise.all(frames.map(async (frame) => {
    try {
      await chrome.scripting.executeScript({
        target: { tabId, frameIds: [frame.frameId] },
        world: 'MAIN',
        func: () => {
          if (typeof window.__FIMS_ARRIVAL_RPA_CLEAR_DIALOG_MODE__ === 'function') {
            window.__FIMS_ARRIVAL_RPA_CLEAR_DIALOG_MODE__();
          } else {
            localStorage.removeItem('FIMS_ARRIVAL_RPA_DIALOG_MODE');
          }
        }
      });
    } catch (_) {}
  }));
}

function submitFimsLoginForm(credentials) {
  const id = document.querySelector('input#userId, input[name="userId"]');
  const passwordInput = document.querySelector('input#userPasswd, input[name="userPasswd"]');
  if (!id || !passwordInput) return { ok: false, message: '로그인 입력칸을 찾지 못했습니다.' };

  const userId = String(credentials?.userId ?? '').trim();
  const password = String(credentials?.password ?? '');
  if (!userId || !password) return { ok: false, message: 'FIMS 사용자 ID와 비밀번호를 입력하세요.' };
  if (id.maxLength > 0 && userId.length > id.maxLength) {
    return { ok: false, message: `FIMS 사용자 ID는 최대 ${id.maxLength}자입니다.` };
  }
  if (passwordInput.maxLength > 0 && password.length > passwordInput.maxLength) {
    return { ok: false, message: `FIMS 비밀번호는 최대 ${passwordInput.maxLength}자입니다.` };
  }

  const assign = (input, value, options = {}) => {
    if (options.focus !== false) input.focus?.();
    const prototype = Object.getPrototypeOf(input);
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    if (setter) setter.call(input, value);
    else input.value = value;
    if (options.notify !== false) {
      try {
        input.dispatchEvent(new InputEvent('input', {
          bubbles: true,
          inputType: 'insertText',
          data: value
        }));
      } catch (_) {
        try { input.dispatchEvent(new Event('input', { bubbles: true })); } catch (_) {}
      }
      try { input.dispatchEvent(new Event('change', { bubbles: true })); } catch (_) {}
    }
    if (options.blur === true) input.blur?.();
  };

  const hadBrowserFilledValue = Boolean(id.value || passwordInput.value);
  const loginForm = id.form || passwordInput.form;
  loginForm?.setAttribute?.('autocomplete', 'off');
  id.setAttribute?.('autocomplete', 'off');
  id.setAttribute?.('data-lpignore', 'true');
  passwordInput.setAttribute?.('autocomplete', 'new-password');
  passwordInput.setAttribute?.('data-lpignore', 'true');
  id.readOnly = true;
  passwordInput.readOnly = true;

  // Chrome 비밀번호 관리자가 값을 다시 채우지 못하도록 입력칸을 잠근 상태에서
  // 기존 값을 지운다. 잠금을 푸는 순간 사용자 입력값을 다시 넣고 즉시 클릭한다.
  assign(id, '', { focus: false, notify: true });
  assign(passwordInput, '', { focus: false, notify: true });
  assign(id, userId, { focus: false, notify: true });
  assign(passwordInput, password, { focus: false, notify: true });

  const loginButton = document.querySelector(
    'input[name="Button2"][onclick*="membLogin"], input[onclick*="membLogin"]'
  );
  if (!loginButton) return { ok: false, message: 'FIMS 실제 로그인 버튼(Button2)을 찾지 못했습니다.' };
  if (loginButton.disabled) return { ok: false, message: 'FIMS 로그인 버튼이 비활성화되어 있습니다.' };

  // 수집된 실제 요소 input[name="Button2"][onclick*="membLogin"]를 클릭한다.
  // FIMS 자체 membLogin()이 숨김값 설정과 POST를 담당하도록 둔다.
  setTimeout(() => {
    id.readOnly = false;
    passwordInput.readOnly = false;
    assign(id, userId, { focus: false, notify: false });
    assign(passwordInput, password, { focus: false, notify: false });
    if (id.value !== userId || passwordInput.value !== password) {
      globalThis.__FIMS_ARRIVAL_RPA_LOGIN_ERROR__ = '로그인 직전 ID·비밀번호 덮어쓰기에 실패했습니다.';
      return;
    }
    loginButton.click();
  }, Math.max(100, Number(credentials?.settleMs || 350)));
  return {
    ok: true,
    method: 'native-login-button',
    autofillReplaced: hadBrowserFilledValue,
    userIdLength: userId.length,
    passwordLength: password.length,
    selector: 'input[name="Button2"][onclick*="membLogin"]'
  };
}

async function readLoginError(tabId, frameId) {
  try {
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      world: 'MAIN',
      func: () => {
        const message = globalThis.__FIMS_ARRIVAL_RPA_LOGIN_ERROR__ || '';
        return String(message || '');
      }
    });
    return String(result || '');
  } catch (_) {
    return '';
  }
}

async function clearLoginError(tabId, frameId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      world: 'MAIN',
      func: () => { delete globalThis.__FIMS_ARRIVAL_RPA_LOGIN_ERROR__; }
    });
  } catch (_) {}
}

async function submitLoginInMainWorld(tabId, frameId, { userId, password }) {
  try {
    const [{ result } = {}] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      world: 'MAIN',
      args: [{
        userId: String(userId),
        password: String(password),
        settleMs: LOGIN_INPUT_SETTLE_MS
      }],
      func: submitFimsLoginForm
    });
    return result || { ok: false, message: '로그인 실행 결과가 없습니다.' };
  } catch (error) {
    return { ok: false, message: error?.message || String(error) };
  }
}

function isPostLoginStatusNotice(message) {
  const text = normalizeText(message);
  return Boolean(
    text &&
    (text.includes('유학생현황') || text.includes('확인 후 처리바랍니다')) &&
    (text.includes('변동신고반려처리건수') || text.includes('재학생정보수정대상자건수'))
  );
}

async function waitForLoginOutcome(tabId, timeoutMs = 60000, loginFrameId = null) {
  const started = Date.now();
  let menuFrame = null;
  let menuSeenAt = 0;
  let noticeMessage = '';
  while (Date.now() - started < timeoutMs) {
    // 로그인 버튼 클릭 직전 덮어쓰기가 실패하면 버튼이 아예 눌리지 않는다.
    // 예전에는 이 플래그를 아무도 읽지 않아 60초 뒤 엉뚱한 메시지가 떴다.
    if (Number.isInteger(loginFrameId)) {
      const clickError = await readLoginError(tabId, loginFrameId);
      if (clickError) {
        return { menuFrame: null, errorMessage: clickError, noticeMessage, noticeAcknowledged: Boolean(noticeMessage) };
      }
    }
    const logs = await getDialogLogs(tabId).catch(() => []);
    const alerts = logs
      .filter((item) => item.kind === 'alert')
      .map((item) => normalizeText(item.message))
      .filter(Boolean);
    noticeMessage = alerts.filter(isPostLoginStatusNotice).at(-1) || noticeMessage;
    const errorMessage = alerts.filter((message) => !isPostLoginStatusNotice(message)).at(-1);
    if (errorMessage) {
      return { menuFrame: null, errorMessage, noticeMessage, noticeAcknowledged: Boolean(noticeMessage) };
    }

    const frames = await inspectAll(tabId);
    const foundMenuFrame = frames.find((frame) =>
      frame.state?.hasStudentInfoParentMenu || frame.state?.hasStudentBasicMenu || frame.state?.hasBasicSearchForm
    );
    if (foundMenuFrame) {
      if (!menuFrame || menuFrame.frameId !== foundMenuFrame.frameId) {
        menuFrame = foundMenuFrame;
        menuSeenAt = Date.now();
      } else {
        menuFrame = foundMenuFrame;
      }
      // 메뉴가 먼저 그려지고 안내 alert가 조금 늦게 실행되는 경우까지 기다린다.
      // 안내창이 없는 로그인이라면 이 안정화 시간 뒤 바로 다음 단계로 진행한다.
      if (Date.now() - menuSeenAt >= POST_LOGIN_MENU_SETTLE_MS) {
        return { menuFrame, errorMessage: '', noticeMessage, noticeAcknowledged: Boolean(noticeMessage) };
      }
    } else {
      menuFrame = null;
      menuSeenAt = 0;
    }
    await sleep(350);
  }
  return { menuFrame: null, errorMessage: '', noticeMessage, noticeAcknowledged: Boolean(noticeMessage) };
}

async function openStudentBasicInfo(tabId) {
  let searchFrame = await waitForFrame(tabId, (state) => state.hasBasicSearchForm, 2500);
  if (searchFrame) return searchFrame;

  const menuFrame = await waitForFrame(
    tabId,
    (state) => state.hasStudentInfoParentMenu || state.hasStudentBasicMenu,
    30000
  );
  if (!menuFrame) throw new Error('좌측 메뉴에서 유학생정보관리를 찾지 못했습니다.');

  const expanded = await sendAction(tabId, menuFrame.frameId, 'EXPAND_STUDENT_INFO_MENU');
  if (!expanded.ok) throw new Error(expanded.message || '유학생정보관리 메뉴를 열지 못했습니다.');
  const childMenuFrame = await waitForFrame(tabId, (state) => state.hasStudentBasicMenu, 10000, 200);
  if (!childMenuFrame) throw new Error('유학생정보관리 하위의 유학생기본정보 메뉴가 나타나지 않았습니다.');

  const opened = await sendAction(tabId, childMenuFrame.frameId, 'CLICK_STUDENT_BASIC_MENU');
  if (!opened.ok) throw new Error(opened.message || '유학생기본정보 메뉴를 클릭하지 못했습니다.');

  searchFrame = await waitForFrame(tabId, (state) => state.hasBasicSearchForm, 60000);
  if (!searchFrame) throw new Error('유학생기본정보 조회 화면 진입을 확인하지 못했습니다.');
  return searchFrame;
}

async function loginAndOpenStudentBasic({ userId, password }) {
  if (!normalizeText(userId) || !password) throw new Error('FIMS 사용자 ID와 비밀번호를 입력하세요.');
  const fresh = await openFreshFimsWindow();
  const tabId = fresh.tab.id;
  let frames = await inspectAll(tabId);

  let loginFrame = frames.find((frame) => frame.state?.hasLogin === true);
  if (!loginFrame) {
    loginFrame = await waitForFrame(tabId, (state) => state.hasLogin === true, 30000);
  }
  if (!loginFrame) {
    throw new Error('FIMS 세션을 초기화했지만 새 로그인 화면을 찾지 못했습니다. 열린 FIMS 창을 닫고 다시 실행하세요.');
  }

  // login.jsp가 보이자마자 조작하면 FIMS 초기화 스크립트와 충돌할 수 있어 잠시 안정화한다.
  await sleep(LOGIN_PAGE_SETTLE_MS);
  const settledLoginFrame = await waitForFrame(tabId, (state) => state.hasLogin, 10000, 200);
  if (!settledLoginFrame) throw new Error('대기 후 FIMS 로그인 화면을 다시 확인하지 못했습니다.');
  loginFrame = settledLoginFrame;
  const guard = await setDialogModeAllFrames(tabId, { confirmValue: true, durationMs: 90000, clearLog: true });
  if (!guard.armedFrameIds.includes(loginFrame.frameId)) {
    throw new Error('로그인 결과 안내창 제어를 준비하지 못했습니다. 페이지를 새로고침한 뒤 다시 실행하세요.');
  }
  await clearLoginError(tabId, loginFrame.frameId);
  const submitted = await submitLoginInMainWorld(tabId, loginFrame.frameId, { userId, password });
  if (!submitted.ok) {
    await clearDialogMode(tabId);
    throw new Error(submitted.message || '로그인 실행 실패');
  }

  const loginOutcome = await waitForLoginOutcome(tabId, 60000, loginFrame.frameId);
  const menuFrame = loginOutcome.menuFrame;
  await clearDialogMode(tabId).catch(() => {});

  if (!menuFrame) {
    throw new Error(loginOutcome.errorMessage
      ? `FIMS 로그인 실패: ${loginOutcome.errorMessage}`
      : '로그인 후 좌측 메뉴가 나타나지 않았습니다.');
  }

  const searchFrame = menuFrame.state?.hasBasicSearchForm
    ? menuFrame
    : await openStudentBasicInfo(tabId);
  if (!searchFrame) throw new Error('유학생기본정보 화면을 열지 못했습니다.');

  return {
    tabId,
    windowId: fresh.windowId,
    closedTabCount: fresh.closedTabCount,
    clearedCookieCount: fresh.clearedCookieCount,
    message: `FIMS 세션 초기화 후 새 전용 창 로그인 → 유학생정보관리 → 유학생기본정보 진입 완료${loginOutcome.noticeAcknowledged ? ' / 유학생현황·반려처리 건수 안내 자동 확인' : ' / 로그인 후 별도 안내 없음'} (기존 FIMS 탭 ${fresh.closedTabCount}개 종료 / FIMS 쿠키 ${fresh.clearedCookieCount}개 삭제)`
  };
}

async function ensureBasicSearchFrame(tabId) {
  const existing = await waitForFrame(tabId, (state) => state.hasBasicSearchForm, 2500);
  if (existing) return existing;
  return openStudentBasicInfo(tabId);
}

async function waitArrivalSearchResult(tabId, student, previousDocumentToken, timeoutMs = 30000) {
  const started = Date.now();
  let last = null;
  let stableToken = '';
  let stableReads = 0;
  while (Date.now() - started < timeoutMs) {
    const frame = await waitForFrame(tabId, (state) => state.hasBasicSearchForm, 3000, 250);
    if (frame) {
      const response = await sendAction(tabId, frame.frameId, 'READ_ARRIVAL_SEARCH_RESULT', student);
      if (response.ok) {
        last = { frame, data: response.data || {} };
        const data = response.data || {};
        const token = String(data.documentToken || frame.state?.documentToken || '');
        const refreshed = !previousDocumentToken || (token && token !== previousDocumentToken);
        if (data.state === 'FOUND') {
          stableReads = token && token === stableToken ? stableReads + 1 : 1;
          stableToken = token;
          if (stableReads >= 2) return last;
        } else {
          stableReads = 0;
          stableToken = '';
        }
        if (refreshed && ['NONE', 'NOT_FOUND', 'AMBIGUOUS'].includes(data.state)) return last;
        if (Date.now() - started >= 3000 && ['NONE', 'NOT_FOUND', 'AMBIGUOUS'].includes(data.state)) return last;
      }
    }
    await sleep(350);
  }
  return { frame: last?.frame || null, data: { ...(last?.data || {}), state: 'TIMEOUT' } };
}

async function waitForDetailFrame(tabId, timeoutMs = 30000) {
  return waitForFrame(
    tabId,
    (state) => state.hasStudentDetailView === true && state.hasArrivalEditForm !== true,
    timeoutMs
  );
}

async function waitForEditFrame(tabId, timeoutMs = 30000) {
  return waitForFrame(tabId, (state) => state.hasArrivalEditForm === true, timeoutMs);
}

// 저장 직후 FIMS가 어느 화면으로 가는지는 고정되어 있지 않다.
//   - 읽기전용 상세(DtlR)로 가면 본문에 "YYYY.MM.DD (입국)"이 보이고
//   - 수정폼(DtlRU)에 그대로 남으면 #entrYN=N + 읽기전용 #eYmd 날짜로 확인된다.
// 예전 코드는 상세화면만 기다려서(hasArrivalEditForm !== true) 수정폼에 남는 경우
// 45초를 헛기다린 뒤 저장이 성공했는데도 '저장 결과 확인 실패'로 기록했다.
async function waitForArrivalVerification(tabId, student, timeoutMs = 45000) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    const frames = await inspectAll(tabId);
    const candidates = frames.filter((frame) => frame.state?.canVerifyArrival === true);
    for (const frame of candidates) {
      const response = await sendAction(tabId, frame.frameId, 'READ_ARRIVAL_VERIFICATION', student);
      if (!response.ok) continue;
      const data = response.data || {};
      if (!identityVerified(data, student)) continue;
      last = { frame, data };
      // 저장 전 수정폼에는 #eYmd가 비어 있으므로 arrivalConfirmed가 서지 않는다.
      // 즉 이 조건은 저장이 실제로 반영된 뒤에만 참이 된다.
      if (data.arrivalConfirmed === true) return last;
    }
    await sleep(400);
  }
  return last;
}

function identityVerified(data, student) {
  const nameOk = data?.nameMatches === true || sameFimsName(data?.name, student.name);
  const birthOk = data?.birthDateMatches === true || normalizeDate(data?.birthDate) === normalizeDate(student.birthDate);
  return nameOk && birthOk;
}

async function processArrivalStudent({ tabId, student, config }) {
  if (!tabId || !student?.name || !student?.birthDate || !student?.studentNo) {
    throw new Error('입국신고 대상 학생 정보가 올바르지 않습니다.');
  }
  if (!/^\d{8}$/.test(normalizeDate(config?.admissionDate))) {
    throw new Error('입학(복학)일자가 올바르지 않습니다.');
  }

  const searchFrame = await ensureBasicSearchFrame(tabId);
  const previousDocumentToken = String(searchFrame.state?.documentToken || '');
  const prepared = await sendAction(tabId, searchFrame.frameId, 'PREPARE_ARRIVAL_SEARCH', {
    name: student.name,
    birthDate: student.birthDate
  });
  if (!prepared.ok) {
    return { code: 'SEARCH_FAILED', result: '조회 처리 실패', detail: prepared.message || '조회 실행 실패' };
  }

  const searchResult = await waitArrivalSearchResult(tabId, student, previousDocumentToken, 30000);
  if (!searchResult.frame || ['TIMEOUT', 'WAIT'].includes(searchResult.data?.state)) {
    return {
      code: 'SEARCH_TIMEOUT',
      result: '조회 결과 확인 실패',
      detail: '30초 동안 성명·생년월일 조회 결과를 확정하지 못했습니다.'
    };
  }
  if (['NONE', 'NOT_FOUND'].includes(searchResult.data.state)) {
    return {
      code: 'NOT_FOUND',
      result: '이름, 생년월일 불일치',
      detail: searchResult.data.availableNames?.length
        ? `조회 결과 성명: ${searchResult.data.availableNames.join(', ')}`
        : '학생 정보가 조회되지 않았습니다.'
    };
  }
  if (searchResult.data.state === 'AMBIGUOUS') {
    return {
      code: 'AMBIGUOUS',
      result: '동일 학생 다중 조회',
      detail: `성명·생년월일 조건에서 상세조회 대상이 ${searchResult.data.matchCount || 0}건이므로 수정하지 않았습니다.`
    };
  }

  const opened = await sendAction(tabId, searchResult.frame.frameId, 'OPEN_ARRIVAL_DETAIL', student);
  if (!opened.ok) {
    return { code: 'DETAIL_OPEN_FAILED', result: '상세조회 실패', detail: opened.message || '상세조회 링크 클릭 실패' };
  }

  const detailFrame = await waitForDetailFrame(tabId, 30000);
  if (!detailFrame) {
    return { code: 'DETAIL_TIMEOUT', result: '상세조회 실패', detail: '학생 상세조회 화면 진입을 확인하지 못했습니다.' };
  }
  const identity = await sendAction(tabId, detailFrame.frameId, 'READ_DETAIL_IDENTITY', student);
  if (!identity.ok || !identityVerified(identity.data, student)) {
    return {
      code: 'IDENTITY_MISMATCH',
      result: '상세정보 불일치',
      detail: '상세화면의 성명·생년월일이 엑셀 대상과 일치하지 않아 수정하지 않았습니다.'
    };
  }

  const editClicked = await sendAction(tabId, detailFrame.frameId, 'CLICK_ARRIVAL_EDIT');
  if (!editClicked.ok) {
    return { code: 'EDIT_OPEN_FAILED', result: '수정화면 진입 실패', detail: editClicked.message || '수정 버튼 클릭 실패' };
  }
  const editFrame = await waitForEditFrame(tabId, 30000);
  if (!editFrame) {
    return { code: 'EDIT_TIMEOUT', result: '수정화면 진입 실패', detail: '유학생기본정보 수정 화면을 확인하지 못했습니다.' };
  }

  const filled = await sendAction(tabId, editFrame.frameId, 'FILL_ARRIVAL_EDIT', {
    name: student.name,
    birthDate: student.birthDate,
    studentNo: student.studentNo,
    admissionDate: config.admissionDate
  });
  if (!filled.ok) {
    return { code: 'FILL_FAILED', result: '입국정보 입력 실패', detail: filled.message || '입력값 검증 실패' };
  }

  const saveGuard = await setDialogModeAllFrames(tabId, { confirmValue: true, durationMs: 90000, clearLog: true });
  if (!saveGuard.armedFrameIds.includes(editFrame.frameId)) {
    return {
      code: 'SAVE_FAILED',
      result: '저장 결과 확인 실패',
      arrivalDate: '',
      note: '별도 확인 필요',
      detail: '저장 확인창 자동 처리를 준비하지 못해 저장 버튼을 누르지 않았습니다.'
    };
  }
  try {
    const saveResponse = await withTimeout(
      sendAction(tabId, editFrame.frameId, 'SAVE_ARRIVAL_EDIT'),
      15000,
      '저장 확인창 처리가 15초 안에 끝나지 않았습니다.'
    );
    if (!saveResponse.ok) throw new Error(saveResponse.message || '저장 버튼 클릭 실패');

    const verified = await waitForArrivalVerification(tabId, {
      name: student.name,
      birthDate: student.birthDate,
      studentNo: student.studentNo,
      admissionDate: config.admissionDate
    }, 45000);
    if (!verified) {
      throw new Error('저장 후 학생 화면에서 신원을 재검증하지 못했습니다.');
    }
    const verification = { ok: true, data: verified.data };

    const savedStudentNo = normalizeStudentNo(verification.data?.studentNo);
    if (savedStudentNo && savedStudentNo !== normalizeStudentNo(student.studentNo)) {
      throw new Error(`저장 후 학번이 다릅니다: ${verification.data.studentNo}`);
    }
    const savedAdmissionDate = normalizeDate(verification.data?.admissionDate);
    if (savedAdmissionDate && savedAdmissionDate !== normalizeDate(config.admissionDate)) {
      throw new Error(`저장 후 입학(복학)일자가 다릅니다: ${verification.data.admissionDate}`);
    }

    const pageLogs = await getDialogLogs(tabId).catch(() => []);
    const dialogMessages = pageLogs
      .map((item) => normalizeText(item.message))
      .filter(Boolean);
    const arrivalDate = formatDate(verification.data?.arrivalDate || '');
    if (arrivalDate && verification.data?.arrivalConfirmed === true) {
      return {
        code: 'COMPLETED',
        result: '입국신고 완료',
        arrivalDate,
        note: '',
        detail: `학번·입국·입학일자 저장 완료 / ${arrivalDate} (입국) 확인${verification.data?.arrivalMarked === true ? '' : ' (수정화면 입국일자 기준)'}${dialogMessages.length ? ` / 알림: ${dialogMessages.at(-1)}` : ''}`
      };
    }

    return {
      code: 'ARRIVAL_DATE_MISSING',
      result: '입국일자 미확인',
      arrivalDate: '',
      note: '상세화면에 입국일자가 표시되지 않아 별도 처리 필요',
      detail: `학번·입국·입학일자 저장은 완료됐으나 상세화면에서 날짜 (입국)을 확인하지 못했습니다.${dialogMessages.length ? ` 알림: ${dialogMessages.at(-1)}` : ''}`
    };
  } catch (error) {
    return {
      code: 'SAVE_FAILED',
      result: '저장 결과 확인 실패',
      arrivalDate: '',
      note: '별도 확인 필요',
      detail: error?.message || String(error)
    };
  } finally {
    await clearDialogMode(tabId).catch(() => {});
  }
}

// ── 진단 모드 (조회 전용) ───────────────────────────────────────────────
// 검색 → 조회결과 → 상세조회까지만 수행하고 수정·저장은 절대 호출하지 않는다.
// FIMS에 기록을 쓰지 않으므로 실제 계정으로 안전하게 돌려볼 수 있다.
async function collectFrameDiagnostics(tabId, student) {
  const frames = await getFrames(tabId);
  const collected = [];
  for (const frame of frames) {
    const ready = await ensureContentScript(tabId, frame.frameId);
    if (!ready) {
      collected.push({ frameId: frame.frameId, url: frame.url || '', contentScript: false });
      continue;
    }
    const response = await sendAction(tabId, frame.frameId, 'COLLECT_DIAGNOSTICS', student || {});
    collected.push({
      frameId: frame.frameId,
      parentFrameId: frame.parentFrameId,
      url: frame.url || '',
      contentScript: true,
      ok: response.ok === true,
      message: response.ok ? '' : (response.message || ''),
      data: response.ok ? response.data : null
    });
  }
  return collected;
}

async function diagnoseArrivalStudent({ tabId, student, depth = 'edit' }) {
  if (!tabId) throw new Error('먼저 로그인해 FIMS 창을 연 뒤 진단하세요.');
  if (!student?.name || !student?.birthDate) throw new Error('진단할 학생의 성명과 생년월일이 필요합니다.');

  const steps = [];
  const record = (step, ok, detail, data) => {
    steps.push({ step, ok, detail: detail || '', data: data ?? null, at: new Date().toISOString() });
  };

  const searchFrame = await ensureBasicSearchFrame(tabId);
  record('유학생기본정보 조회화면 진입', true, `frameId=${searchFrame.frameId}`);

  const before = await collectFrameDiagnostics(tabId, student);
  record('검색 전 화면 상태 수집', true, `프레임 ${before.length}개`, before);

  const previousDocumentToken = String(searchFrame.state?.documentToken || '');
  const prepared = await sendAction(tabId, searchFrame.frameId, 'PREPARE_ARRIVAL_SEARCH', {
    name: student.name,
    birthDate: student.birthDate
  });
  record('검색조건 입력 + 조회 클릭', prepared.ok === true, prepared.message || '', prepared.data || null);
  if (!prepared.ok) {
    return { stoppedAt: '검색조건 입력', steps, wroteToFims: false };
  }

  const searchResult = await waitArrivalSearchResult(tabId, student, previousDocumentToken, 30000);
  const searchState = searchResult.data?.state || 'UNKNOWN';
  record('조회 결과 판정', !['TIMEOUT', 'WAIT'].includes(searchState), `state=${searchState}`, searchResult.data || null);
  if (searchState !== 'FOUND') {
    const after = await collectFrameDiagnostics(tabId, student);
    record('조회 실패 시점 화면 상태', true, `프레임 ${after.length}개`, after);
    return { stoppedAt: `조회 결과 ${searchState}`, steps, wroteToFims: false };
  }

  const opened = await sendAction(tabId, searchResult.frame.frameId, 'OPEN_ARRIVAL_DETAIL', student);
  record('상세조회 링크 클릭', opened.ok === true, opened.message || '', { matchStrategy: opened.matchStrategy || '' });
  if (!opened.ok) {
    return { stoppedAt: '상세조회 클릭', steps, wroteToFims: false };
  }

  const detailFrame = await waitForDetailFrame(tabId, 30000);
  record('상세화면 진입', Boolean(detailFrame), detailFrame ? `frameId=${detailFrame.frameId}` : '상세화면을 확인하지 못했습니다.');
  if (!detailFrame) {
    const after = await collectFrameDiagnostics(tabId, student);
    record('상세화면 미확인 시점 상태', true, `프레임 ${after.length}개`, after);
    return { stoppedAt: '상세화면 진입', steps, wroteToFims: false };
  }

  const identity = await sendAction(tabId, detailFrame.frameId, 'READ_DETAIL_IDENTITY', student);
  const verified = identity.ok && identityVerified(identity.data, student);
  record('상세화면 신원 재검증', verified, verified ? '' : '성명·생년월일이 엑셀 대상과 일치하지 않습니다.', identity.data || null);

  const detailDiagnostics = await collectFrameDiagnostics(tabId, student);
  record('상세화면 상태 수집', true, `프레임 ${detailDiagnostics.length}개`, detailDiagnostics);

  if (depth !== 'edit') {
    record('진단 종료 (수정화면 미진입)', true, 'FIMS에 아무것도 기록하지 않았습니다.');
    return { stoppedAt: '상세화면 확인 완료', steps, wroteToFims: false };
  }

  // 수정화면까지 진단한다. 수정 버튼을 눌러 입력 폼을 열고 실제로 값을 넣어보되
  // 저장(SAVE_ARRIVAL_EDIT)은 절대 호출하지 않는다. 저장하지 않은 폼 입력은
  // 브라우저 화면에만 남고 FIMS에는 전혀 반영되지 않는다.
  const editClicked = await sendAction(tabId, detailFrame.frameId, 'CLICK_ARRIVAL_EDIT');
  record('수정화면 열기', editClicked.ok === true, editClicked.message || '');
  if (!editClicked.ok) {
    return { stoppedAt: '수정화면 열기', steps, wroteToFims: false };
  }

  const editFrame = await waitForEditFrame(tabId, 30000);
  record('수정화면 진입', Boolean(editFrame), editFrame ? `frameId=${editFrame.frameId}` : '수정화면을 확인하지 못했습니다.');
  if (!editFrame) {
    const after = await collectFrameDiagnostics(tabId, student);
    record('수정화면 미확인 시점 상태', true, `프레임 ${after.length}개`, after);
    return { stoppedAt: '수정화면 진입', steps, wroteToFims: false };
  }

  const beforeFill = await collectFrameDiagnostics(tabId, student);
  record('입력 전 수정화면 상태', true, '학번·입국여부·입학일자 칸의 잠금/길이/현재값 여부', beforeFill);

  // 실제 입력을 재현한다. 여기서 실패하면 실사용에서 실패하는 것과 같은 지점이다.
  const filled = await sendAction(tabId, editFrame.frameId, 'FILL_ARRIVAL_EDIT', {
    name: student.name,
    birthDate: student.birthDate,
    studentNo: student.studentNo,
    admissionDate: student.admissionDate || ''
  });
  record('입력 재현 (저장 안 함)', filled.ok === true, filled.message || '', filled.data || null);

  const afterFill = await collectFrameDiagnostics(tabId, student);
  record('입력 후 수정화면 상태', true, '입력값이 남아 있는지 / 되돌아갔는지', afterFill);

  // 저장은 호출하지 않는다. SAVE_ARRIVAL_EDIT 는 이 경로에 존재하지 않는다.
  record('진단 종료 (저장 미실행)', true, '저장 버튼을 누르지 않았으므로 FIMS에 반영되지 않았습니다. 열린 FIMS 창은 그냥 닫으세요.');
  return { stoppedAt: filled.ok ? '입력 재현 성공 (저장 안 함)' : `입력 재현 실패: ${filled.message || ''}`, steps, wroteToFims: false };
}


// ── 입국일자 미확인 학생 별도처리 ────────────────────────────────────────────
// 재학생정보 수정대상자 조회 및 수정(#nMenuTreeHome8) 화면에서 출입국 기록을
// 연결해 입국일자를 채운다. 정확성 우선 원칙:
//   - 성명·생년월일·학번이 모두 일치하는 행이 정확히 1건일 때만 진행한다.
//   - 팝업의 출입국 기록 중 입국일자가 있는 것이 정확히 1건일 때만 수정한다.
//   - 그 외에는 아무것도 누르지 않고 '별도 처리 필요'로 기록한다.
const ICRM_POPUP_URL_PATTERN = 'https://fims.hikorea.go.kr/isi/ICRMIntlStudInfoPopR.xec*';

async function findIcrmPopupTab(timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const tabs = await chrome.tabs.query({ url: [ICRM_POPUP_URL_PATTERN] });
      const ready = tabs.find((tab) => tab.status === 'complete') || tabs[0];
      if (ready?.id) return ready;
    } catch (_) {}
    await sleep(300);
  }
  return null;
}

async function closeTabQuietly(tabId) {
  if (!Number.isInteger(tabId)) return;
  try { await chrome.tabs.remove(tabId); } catch (_) {}
}

async function openModiObjScreen(tabId) {
  const existing = await waitForFrame(tabId, (state) => state.hasModiObjSearchForm === true, 2500);
  if (existing) return existing;

  const menuFrame = await waitForFrame(
    tabId,
    (state) => state.hasModiObjMenu === true || state.hasStudentInfoParentMenu === true,
    30000
  );
  if (!menuFrame) throw new Error('좌측 메뉴에서 재학생정보 수정대상자 메뉴를 찾지 못했습니다.');

  if (!menuFrame.state?.hasModiObjMenu) {
    const expanded = await sendAction(tabId, menuFrame.frameId, 'EXPAND_STUDENT_INFO_MENU');
    if (!expanded.ok) throw new Error(expanded.message || '유학생정보관리 메뉴를 열지 못했습니다.');
  }
  const withMenu = await waitForFrame(tabId, (state) => state.hasModiObjMenu === true, 10000, 200);
  if (!withMenu) throw new Error('재학생정보 수정대상자 메뉴(#nMenuTreeHome8)가 나타나지 않았습니다.');

  const clicked = await sendAction(tabId, withMenu.frameId, 'CLICK_MODIOBJ_MENU');
  if (!clicked.ok) throw new Error(clicked.message || '재학생정보 수정대상자 메뉴를 클릭하지 못했습니다.');

  const searchFrame = await waitForFrame(tabId, (state) => state.hasModiObjSearchForm === true, 60000);
  if (!searchFrame) throw new Error('재학생정보 수정대상자 조회화면 진입을 확인하지 못했습니다.');
  return searchFrame;
}

async function waitModiObjResult(tabId, student, timeoutMs = 30000) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    const frame = await waitForFrame(tabId, (state) => state.hasModiObjSearchForm === true || state.hasModiObjRows === true, 3000, 250);
    if (frame) {
      const response = await sendAction(tabId, frame.frameId, 'READ_MODIOBJ_RESULT', student);
      if (response.ok) {
        last = { frame, data: response.data || {} };
        if (['FOUND', 'AMBIGUOUS'].includes(last.data.state)) return last;
        if (last.data.state === 'NOT_FOUND' && Date.now() - started >= 3000) return last;
      }
    }
    await sleep(350);
  }
  return last || { frame: null, data: { state: 'TIMEOUT' } };
}

// ICRM 수정 후 유학생기본정보 상세화면에서 입국일자가 실제로 채워졌는지 읽기만 한다.
async function confirmArrivalAfterRecheck(tabId, student) {
  try {
    const searchFrame = await ensureBasicSearchFrame(tabId);
    const previousToken = String(searchFrame.state?.documentToken || '');
    const prepared = await sendAction(tabId, searchFrame.frameId, 'PREPARE_ARRIVAL_SEARCH', {
      name: student.name,
      birthDate: student.birthDate
    });
    if (!prepared.ok) return { ok: false, message: prepared.message || '' };
    const searchResult = await waitArrivalSearchResult(tabId, student, previousToken, 30000);
    if (searchResult.data?.state !== 'FOUND') return { ok: false, message: `조회 ${searchResult.data?.state || 'UNKNOWN'}` };
    const opened = await sendAction(tabId, searchResult.frame.frameId, 'OPEN_ARRIVAL_DETAIL', student);
    if (!opened.ok) return { ok: false, message: opened.message || '' };
    const verified = await waitForArrivalVerification(tabId, student, 30000);
    if (!verified) return { ok: false, message: '상세화면에서 신원을 재검증하지 못했습니다.' };
    return {
      ok: verified.data?.arrivalConfirmed === true,
      arrivalDate: formatDate(verified.data?.arrivalDate || ''),
      message: verified.data?.arrivalConfirmed === true ? '' : '상세화면에 입국일자가 여전히 표시되지 않습니다.'
    };
  } catch (error) {
    return { ok: false, message: error?.message || String(error) };
  }
}

async function recheckArrivalStudent({ tabId, student }) {
  if (!tabId) throw new Error('먼저 로그인해 FIMS 창을 연 뒤 별도처리를 실행하세요.');
  if (!student?.name || !student?.birthDate || !student?.studentNo) {
    throw new Error('별도처리 대상 학생의 성명·생년월일·학번이 모두 필요합니다.');
  }

  let popupTabId = null;
  try {
    // 메뉴 진입 시 안내창이 뜬다: "관서에 등록된 정보와 일치하지 않거나…"
    await setDialogModeAllFrames(tabId, { confirmValue: true, durationMs: 120000, clearLog: true });
    await openModiObjScreen(tabId);
    await setDialogModeAllFrames(tabId, { confirmValue: true, durationMs: 120000, clearLog: false });

    const searchFrame = await waitForFrame(tabId, (state) => state.hasModiObjSearchForm === true, 20000);
    if (!searchFrame) {
      return { code: 'MODIOBJ_SCREEN_FAILED', result: '별도 처리 필요', detail: '수정대상자 조회화면을 확인하지 못했습니다.' };
    }
    const prepared = await sendAction(tabId, searchFrame.frameId, 'PREPARE_MODIOBJ_SEARCH', student);
    if (!prepared.ok) {
      return { code: 'MODIOBJ_SEARCH_FAILED', result: '별도 처리 필요', detail: prepared.message || '수정대상자 조회 실행 실패' };
    }

    const found = await waitModiObjResult(tabId, student, 30000);
    const state = found.data?.state || 'TIMEOUT';
    if (state !== 'FOUND') {
      const reason = {
        NOT_FOUND: '수정대상자 목록에서 해당 학생을 찾지 못했습니다.',
        AMBIGUOUS: `수정대상자 목록에서 동일 조건이 ${found.data?.matchCount || 0}건이라 자동 처리하지 않았습니다.`,
        TIMEOUT: '수정대상자 조회 결과를 확정하지 못했습니다.'
      }[state] || `수정대상자 조회 상태 ${state}`;
      return { code: `MODIOBJ_${state}`, result: '별도 처리 필요', detail: reason };
    }

    const opened = await sendAction(tabId, found.frame.frameId, 'OPEN_MODIOBJ_ICRM', student);
    if (!opened.ok) {
      return { code: 'ICRM_OPEN_FAILED', result: '별도 처리 필요', detail: opened.message || '수정(새창열림) 클릭 실패' };
    }

    const popupTab = await findIcrmPopupTab(20000);
    if (!popupTab?.id) {
      return {
        code: 'ICRM_POPUP_NOT_FOUND',
        result: '별도 처리 필요',
        detail: '수정 팝업 창을 찾지 못했습니다. 브라우저 팝업 차단을 해제한 뒤 다시 시도하세요.'
      };
    }
    popupTabId = popupTab.id;
    await waitForTabReady(popupTabId, 20000);
    await setDialogModeAllFrames(popupTabId, { confirmValue: true, durationMs: 120000, clearLog: true });

    const popupFrame = await waitForFrame(popupTabId, (state) => state.hasIcrmPopup === true, 20000);
    if (!popupFrame) {
      return { code: 'ICRM_POPUP_EMPTY', result: '별도 처리 필요', detail: '수정 팝업에서 출입국 기록 목록을 확인하지 못했습니다.' };
    }

    const applied = await sendAction(popupTabId, popupFrame.frameId, 'APPLY_ICRM_UPDATE', student);
    if (!applied.ok) {
      return {
        code: `ICRM_${applied.code || 'FAILED'}`,
        result: '별도 처리 필요',
        detail: applied.message || '수정 팝업 처리 실패'
      };
    }

    // 팝업이 저장 후 닫힐 수 있다. 잠시 기다린 뒤 남아 있으면 정리한다.
    await sleep(2500);
    const popupLogs = await getDialogLogs(popupTabId).catch(() => []);
    const popupMessages = popupLogs.map((item) => normalizeText(item.message)).filter(Boolean);
    await closeTabQuietly(popupTabId);
    popupTabId = null;

    const appliedDate = formatDate(applied.data?.arrivalDate || '');
    const confirmed = await confirmArrivalAfterRecheck(tabId, student);
    if (confirmed.ok) {
      return {
        code: 'RECHECK_COMPLETED',
        result: '입국신고 완료',
        arrivalDate: confirmed.arrivalDate || appliedDate,
        note: '',
        detail: `수정대상자 화면에서 출입국 기록 연결 후 입국일자 ${confirmed.arrivalDate || appliedDate} 확인${popupMessages.length ? ` / 알림: ${popupMessages.at(-1)}` : ''}`
      };
    }
    return {
      code: 'RECHECK_UNVERIFIED',
      result: '별도 처리 필요',
      arrivalDate: appliedDate,
      note: '수정대상자 처리 후에도 입국일자를 확인하지 못했습니다.',
      detail: `출입국 기록 연결은 실행했으나 확인 실패: ${confirmed.message || ''}${popupMessages.length ? ` / 알림: ${popupMessages.at(-1)}` : ''}`
    };
  } finally {
    await closeTabQuietly(popupTabId);
    await clearDialogMode(tabId).catch(() => {});
  }
}

async function focusFims({ tabId }) {
  const tab = await chrome.tabs.get(tabId);
  await focusTab(tab);
  return { ok: true, message: 'FIMS 작업 창으로 이동했습니다.' };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'FIMS_ARRIVAL_RPA_COMMAND') return;
  (async () => {
    try {
      let result;
      switch (message.command) {
        case 'OPEN_OR_LOGIN':
          result = await loginAndOpenStudentBasic(message.payload || {});
          break;
        case 'PROCESS_STUDENT':
          result = await processArrivalStudent(message.payload || {});
          break;
        case 'DIAGNOSE_STUDENT':
          result = await diagnoseArrivalStudent(message.payload || {});
          break;
        case 'RECHECK_ARRIVAL':
          result = await recheckArrivalStudent(message.payload || {});
          break;
        case 'FOCUS_FIMS':
          result = await focusFims(message.payload || {});
          break;
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
