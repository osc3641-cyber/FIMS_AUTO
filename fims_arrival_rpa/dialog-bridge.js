(() => {
  const FLAG_KEY = 'FIMS_ARRIVAL_RPA_DIALOG_MODE';
  const LOG_KEY = 'FIMS_ARRIVAL_RPA_DIALOG_LOG';

  if (window.__FIMS_ARRIVAL_RPA_DIALOG_BRIDGE__) return;
  window.__FIMS_ARRIVAL_RPA_DIALOG_BRIDGE__ = true;

  const nativeAlert = window.alert.bind(window);
  const nativeConfirm = window.confirm.bind(window);
  let installed = false;

  function readJson(key, fallback) {
    try {
      const value = localStorage.getItem(key);
      return value ? JSON.parse(value) : fallback;
    } catch (_) {
      return fallback;
    }
  }

  function writeLog(kind, message, answer = null) {
    const log = readJson(LOG_KEY, []);
    log.push({
      kind,
      message: String(message ?? ''),
      answer,
      at: new Date().toISOString(),
      href: location.href
    });
    try {
      localStorage.setItem(LOG_KEY, JSON.stringify(log.slice(-30)));
    } catch (_) {}
  }

  function currentMode() {
    const mode = readJson(FLAG_KEY, null);
    if (!mode || mode.active !== true) return null;
    if (Number(mode.until || 0) < Date.now()) return null;
    return mode;
  }

  function install() {
    if (installed || !currentMode()) return;
    installed = true;

    window.alert = (message) => {
      const mode = currentMode();
      if (!mode) return nativeAlert(message);
      writeLog('alert', message);
      return undefined;
    };

    window.confirm = (message) => {
      const mode = currentMode();
      if (!mode) return nativeConfirm(message);
      const answer = mode.confirmValue === true;
      writeLog('confirm', message, answer);
      return answer;
    };
  }

  function clear() {
    try {
      localStorage.removeItem(FLAG_KEY);
    } catch (_) {}
    if (installed) {
      window.alert = nativeAlert;
      window.confirm = nativeConfirm;
      installed = false;
    }
  }

  window.__FIMS_ARRIVAL_RPA_SET_DIALOG_MODE__ = (options = {}) => {
    const durationMs = Math.min(Math.max(Number(options.durationMs || 60000), 1000), 180000);
    const mode = {
      active: true,
      confirmValue: options.confirmValue === true,
      until: Date.now() + durationMs
    };
    try {
      localStorage.setItem(FLAG_KEY, JSON.stringify(mode));
      if (options.clearLog !== false) localStorage.setItem(LOG_KEY, '[]');
    } catch (_) {}
    install();
    return mode;
  };

  // ── 페이지 함수 직접 호출 다리 ──────────────────────────────────────────
  // FIMS 링크 중 일부는 <a href="javascript:fnc...()"> 형태다.
  // 확장에서 element.click() 으로 누르면 브라우저가 그 javascript: URL 실행을
  // Content Security Policy 위반으로 차단해(The action has been blocked)
  // 클릭이 아무 일도 하지 않는다.
  // 대신 여기(MAIN world)에서 페이지의 전역 함수를 평범하게 호출한다.
  // eval 이나 inline script 가 아니므로 CSP에 걸리지 않는다.
  const INVOKE_EVENT = '__FIMS_ARRIVAL_RPA_INVOKE__';
  const INVOKE_RESULT_ATTR = 'data-fims-arrival-rpa-invoke';

  document.addEventListener(INVOKE_EVENT, (event) => {
    const detail = event?.detail || {};
    const name = String(detail.fn || '');
    const args = Array.isArray(detail.args) ? detail.args : [];
    let ok = false;
    let message = '';
    try {
      const fn = name && typeof window[name] === 'function' ? window[name] : null;
      if (!fn) message = `페이지 함수 ${name || '(이름 없음)'} 를 찾지 못했습니다.`;
      else { fn.apply(window, args); ok = true; }
    } catch (error) {
      message = error?.message || String(error);
    }
    try {
      document.documentElement.setAttribute(
        INVOKE_RESULT_ATTR,
        JSON.stringify({ token: detail.token || '', ok, message })
      );
    } catch (_) {}
  });

  window.__FIMS_ARRIVAL_RPA_GET_DIALOG_LOG__ = () => readJson(LOG_KEY, []);
  window.__FIMS_ARRIVAL_RPA_CLEAR_DIALOG_MODE__ = clear;

  install();
})();
