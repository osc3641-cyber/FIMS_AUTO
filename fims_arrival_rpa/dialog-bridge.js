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

  window.__FIMS_ARRIVAL_RPA_GET_DIALOG_LOG__ = () => readJson(LOG_KEY, []);
  window.__FIMS_ARRIVAL_RPA_CLEAR_DIALOG_MODE__ = clear;

  install();
})();
