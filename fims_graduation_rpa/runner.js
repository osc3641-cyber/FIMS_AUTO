/* global FimsXlsx */
const elements = {
  fileInput: document.getElementById('workbookFile'),
  fileDrop: document.getElementById('fileDrop'),
  fileName: document.getElementById('fileName'),
  userId: document.getElementById('userId'),
  password: document.getElementById('password'),
  fileSummary: document.getElementById('fileSummary'),
  validateButton: document.getElementById('validateButton'),
  prepareButton: document.getElementById('prepareButton'),
  reviewPanel: document.getElementById('reviewPanel'),
  finalConsent: document.getElementById('finalConsent'),
  inspectButton: document.getElementById('inspectButton'),
  finalizeButton: document.getElementById('finalizeButton'),
  downloadButton: document.getElementById('downloadButton'),
  resultsBody: document.getElementById('resultsBody'),
  resultCounts: document.getElementById('resultCounts'),
  runBadge: document.getElementById('runBadge'),
  logOutput: document.getElementById('logOutput'),
  clearLogButton: document.getElementById('clearLogButton'),
  toast: document.getElementById('toast')
};

const state = {
  workbook: null,
  results: [],
  sentTargets: [],
  tabId: null,
  prepared: false,
  busy: false,
  logLines: []
};

function nowKst() {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(new Date());
}

function fileTimestamp() {
  return nowKst().replace(/[-: ]/g, '').slice(0, 14);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function log(message, kind = 'INFO') {
  const line = `[${nowKst().slice(11)}] [${kind}] ${String(message)}`;
  state.logLines.push(line);
  elements.logOutput.textContent = state.logLines.slice(-500).join('\n');
  elements.logOutput.scrollTop = elements.logOutput.scrollHeight;
}

let toastTimer = null;
function toast(message, type = '') {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.className = `toast show ${type}`.trim();
  toastTimer = setTimeout(() => { elements.toast.className = 'toast'; }, 4500);
}

function setBadge(label, mode = 'idle') {
  elements.runBadge.textContent = label;
  elements.runBadge.className = `run-badge ${mode}`;
}

function updateButtons() {
  const valid = Boolean(state.workbook);
  const credentials = Boolean(elements.userId.value.trim() && elements.password.value);
  elements.validateButton.disabled = state.busy;
  elements.prepareButton.disabled = state.busy || !valid || !credentials;
  elements.inspectButton.disabled = state.busy || !state.prepared || !state.tabId;
  elements.finalConsent.disabled = state.busy || !state.prepared;
  elements.finalizeButton.disabled = state.busy || !state.prepared || !elements.finalConsent.checked;
  elements.downloadButton.disabled = state.busy || !valid || !state.results.length;
  elements.fileInput.disabled = state.busy;
  elements.userId.disabled = state.busy;
  elements.password.disabled = state.busy;
}

function setBusy(busy, label = '') {
  state.busy = busy;
  if (busy) setBadge(label || '실행 중', 'running');
  updateButtons();
}

function resultClass(result) {
  if (result === '졸업신고 완료') return 'status-complete';
  if (result === '대기' || result.includes('대기') || result.includes('처리 중') || result === '보내기 완료') return 'status-pending';
  return 'status-failed';
}

function renderResults() {
  elements.resultsBody.replaceChildren();
  if (!state.results.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 7;
    cell.className = 'empty';
    cell.textContent = '엑셀 파일을 불러오면 대상자가 표시됩니다.';
    row.appendChild(cell);
    elements.resultsBody.appendChild(row);
    elements.resultCounts.textContent = '대상 0 · 완료 0 · 확인 필요 0';
    return;
  }

  for (const result of state.results) {
    const row = document.createElement('tr');
    const values = [
      result.sequence,
      result.name,
      result.studentNo,
      result.stage,
      result.result,
      result.detail,
      result.processedAt
    ];
    values.forEach((value, index) => {
      const cell = document.createElement('td');
      cell.textContent = value ?? '';
      if (index === 4) cell.className = resultClass(String(value || ''));
      row.appendChild(cell);
    });
    elements.resultsBody.appendChild(row);
  }

  const complete = state.results.filter((item) => item.result === '졸업신고 완료').length;
  const attention = state.results.filter((item) => !['대기', '보내기 완료', '최종 신고 대기', '졸업신고 완료'].includes(item.result)).length;
  elements.resultCounts.textContent = `대상 ${state.results.length} · 완료 ${complete} · 확인 필요 ${attention}`;
}

function updateResult(student, patch) {
  const result = state.results.find((item) => item.sequence === student.sequence);
  if (!result) return;
  Object.assign(result, patch);
  renderResults();
  persistRunState();
}

async function persistRunState() {
  if (!state.workbook) return;
  try {
    await chrome.storage.local.set({
      lastFimsGraduationRun: {
        fileName: state.workbook.fileName,
        config: state.workbook.config,
        results: state.results,
        sentTargets: state.sentTargets,
        tabId: state.tabId,
        prepared: state.prepared,
        updatedAt: new Date().toISOString()
      }
    });
  } catch (_) {}
}

function initializeResults(students) {
  state.results = students.map((student) => ({
    sequence: student.sequence,
    name: student.name,
    studentNo: student.studentNo,
    stage: '대기',
    result: '대기',
    detail: '',
    processedAt: ''
  }));
  state.sentTargets = [];
  state.prepared = false;
  state.tabId = null;
  elements.finalConsent.checked = false;
  elements.finalConsent.disabled = true;
  elements.reviewPanel.className = 'review-panel muted';
  elements.reviewPanel.textContent = '일괄입력 단계가 완료되면 최종 검토 정보가 표시됩니다.';
  renderResults();
}

function daysFromReasonDate(reasonDate) {
  const digits = reasonDate.replace(/\D/g, '');
  const date = new Date(`${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}T00:00:00+09:00`);
  const today = new Date();
  const kstToday = new Date(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(today) + 'T00:00:00+09:00');
  return Math.floor((kstToday.getTime() - date.getTime()) / 86400000);
}

function renderFileSummary() {
  const { config, students } = state.workbook;
  const elapsed = daysFromReasonDate(config.reasonDate);
  let deadlineText;
  if (elapsed < 0) deadlineText = `사유발생일까지 ${Math.abs(elapsed)}일 남음`;
  else if (elapsed <= 15) deadlineText = `사유발생일로부터 ${elapsed}일 경과 · 15일 이내`;
  else deadlineText = `사유발생일로부터 ${elapsed}일 경과 · 15일 초과 확인 필요`;

  elements.fileSummary.classList.remove('hidden');
  elements.fileSummary.innerHTML = [
    `<strong>처리대상 ${students.length}명</strong>`,
    `사유발생일: ${escapeHtml(config.reasonDate)} (${escapeHtml(deadlineText)})`,
    `신고구분: ${escapeHtml(config.reportTypeText)} [${escapeHtml(config.reportTypeValue)}]`,
    `신고내용: ${escapeHtml(config.reportText)}`
  ].join('<br>');
}

function renderReviewPanel(rows = []) {
  const { config } = state.workbook;
  const names = state.sentTargets.slice(0, 8).map((item) => `${item.name}(${item.studentNo})`).join(', ');
  const remaining = state.sentTargets.length - Math.min(8, state.sentTargets.length);
  elements.reviewPanel.className = 'review-panel';
  elements.reviewPanel.innerHTML = [
    `<strong>최종 신고 대상 ${state.sentTargets.length}명</strong>`,
    `FIMS 대기명단 확인: ${rows.length}건`,
    `사유발생일: ${escapeHtml(config.reasonDate)}`,
    `신고구분: ${escapeHtml(config.reportTypeText)} [${escapeHtml(config.reportTypeValue)}]`,
    `신고내용: ${escapeHtml(config.reportText)}`,
    `대상자: ${escapeHtml(names)}${remaining > 0 ? ` 외 ${remaining}명` : ''}`
  ].join('<br>');
}

async function command(commandName, payload) {
  const response = await chrome.runtime.sendMessage({
    type: 'FIMS_GRAD_RPA_COMMAND',
    command: commandName,
    payload
  });
  if (!response?.ok) throw new Error(response?.error || '확장 프로그램 명령 실행 실패');
  return response.result;
}

async function validateWorkbook() {
  const file = elements.fileInput.files?.[0];
  if (!file) {
    toast('졸업신고 엑셀 파일을 선택하세요.', 'error');
    return;
  }

  setBusy(true, '파일 검사');
  try {
    log(`엑셀 파일 검사 시작: ${file.name}`);
    const workbook = await FimsXlsx.parseWorkbook(file);
    state.workbook = workbook;
    initializeResults(workbook.students);
    renderFileSummary();
    elements.fileName.textContent = file.name;
    log(`파일 검사 완료: 대상 ${workbook.students.length}명`);
    log(`사유발생일 ${workbook.config.reasonDate} / 신고구분 ${workbook.config.reportTypeText}`);
    setBadge('파일 정상', 'success');
    toast('엑셀 구조와 입력값 검사가 완료되었습니다.', 'success');
    await persistRunState();
  } catch (error) {
    state.workbook = null;
    state.results = [];
    state.sentTargets = [];
    state.prepared = false;
    elements.fileSummary.classList.add('hidden');
    renderResults();
    log(error.message, 'ERROR');
    setBadge('파일 오류', 'error');
    toast(error.message, 'error');
  } finally {
    setBusy(false);
  }
}

async function prepareRun() {
  if (!state.workbook || state.busy) return;
  const userId = elements.userId.value.trim();
  const password = elements.password.value;
  if (!userId || !password) {
    toast('FIMS 사용자 ID와 비밀번호를 입력하세요.', 'error');
    return;
  }

  setBusy(true, '명단 처리 중');
  state.prepared = false;
  state.sentTargets = [];
  elements.finalConsent.checked = false;
  renderResults();

  try {
    log('기존 FIMS 탭을 모두 닫고 새 전용 Chrome 창을 엽니다.');
    log('새 창에서 FIMS 로그인 및 변동신고 화면 진입을 시작합니다.');
    const login = await command('OPEN_OR_LOGIN', { userId, password });
    state.tabId = login.tabId;
    log(login.message, 'OK');

    const total = state.workbook.students.length;
    for (let index = 0; index < total; index += 1) {
      const student = state.workbook.students[index];
      setBadge(`${index + 1}/${total} 처리`, 'running');
      updateResult(student, {
        stage: '학생조회/보내기',
        result: '처리 중',
        detail: '',
        processedAt: nowKst()
      });
      log(`[${index + 1}/${total}] ${student.name} / ${student.studentNo} 조회`);

      try {
        const outcome = await command('PROCESS_STUDENT', { tabId: state.tabId, student });
        updateResult(student, {
          stage: '명단 보내기',
          result: outcome.result,
          detail: outcome.detail || '',
          processedAt: nowKst()
        });
        if (outcome.result === '보내기 완료') {
          state.sentTargets.push(student);
          log(`[${index + 1}/${total}] 보내기 완료: ${student.name}`, 'OK');
        } else {
          log(`[${index + 1}/${total}] ${outcome.result}: ${outcome.detail || ''}`, 'WARN');
        }
      } catch (error) {
        updateResult(student, {
          stage: '명단 보내기',
          result: '보내기 처리 실패',
          detail: error.message,
          processedAt: nowKst()
        });
        log(`[${index + 1}/${total}] 보내기 처리 실패: ${student.name} / ${error.message}`, 'ERROR');
      }
    }

    if (!state.sentTargets.length) {
      throw new Error('보내기 완료 대상자가 없어 일괄입력을 진행하지 않았습니다.');
    }

    log(`보내기 완료 ${state.sentTargets.length}명. FIMS 대기명단에서 이번 엑셀 대상만 확인합니다.`);
    const audit = await command('AUDIT_PENDING', {
      tabId: state.tabId,
      expectedTargets: state.sentTargets
    });
    if (!audit.ok) {
      const missing = audit.comparison?.missing?.map((item) => `${item.name}/${item.studentNo}`).join(', ');
      const duplicates = audit.comparison?.duplicates?.map((item) => `${item.name}/${item.studentNo}(${item.count}건)`).join(', ');
      throw new Error([audit.message, missing ? `누락: ${missing}` : '', duplicates ? `중복: ${duplicates}` : ''].filter(Boolean).join(' / '));
    }
    log(audit.message, 'OK');

    setBadge('일괄입력 중', 'running');
    log('신고내용 일괄입력 팝업을 열고 입력값을 검증합니다.');
    const batch = await command('APPLY_BATCH', {
      tabId: state.tabId,
      expectedTargets: state.sentTargets,
      config: state.workbook.config
    });
    log(batch.message, 'OK');

    for (const student of state.sentTargets) {
      updateResult(student, {
        stage: '신고내용 일괄입력',
        result: '최종 신고 대기',
        detail: `${state.workbook.config.reasonDate} / ${state.workbook.config.reportTypeText} / 신고내용 입력 완료`,
        processedAt: nowKst()
      });
    }

    state.prepared = true;
    renderReviewPanel(batch.rows || []);
    setBadge('최종 검토 대기', 'running');
    log('최종 신고 직전까지 완료했습니다. 화면의 검토 정보와 FIMS 명단을 확인하세요.', 'OK');
    toast('명단 보내기와 신고내용 일괄입력이 완료되었습니다. 최종 검토 후 신고처리를 실행하세요.', 'success');
    await persistRunState();
  } catch (error) {
    log(error.message, 'ERROR');
    const sentKeys = new Set(state.sentTargets.map((item) => item.sequence));
    for (const student of state.workbook.students) {
      if (!sentKeys.has(student.sequence)) continue;
      const current = state.results.find((item) => item.sequence === student.sequence);
      if (current?.result === '보내기 완료' || current?.result === '처리 중') {
        updateResult(student, {
          stage: '신고내용 일괄입력',
          result: '신고내용 입력 실패',
          detail: error.message,
          processedAt: nowKst()
        });
      }
    }
    state.prepared = false;
    setBadge('확인 필요', 'error');
    toast(error.message, 'error');
  } finally {
    setBusy(false);
  }
}

async function inspectPending() {
  if (!state.prepared || !state.tabId) return;
  setBusy(true, '대기명단 점검');
  try {
    const audit = await command('AUDIT_PENDING', {
      tabId: state.tabId,
      expectedTargets: state.sentTargets
    });
    if (!audit.ok) throw new Error(audit.message);
    renderReviewPanel(audit.rows || []);
    log(audit.message, 'OK');
    setBadge('명단 일치', 'success');
    toast(audit.message, 'success');
  } catch (error) {
    log(error.message, 'ERROR');
    setBadge('명단 불일치', 'error');
    toast(error.message, 'error');
  } finally {
    setBusy(false);
  }
}

async function finalizeRun() {
  if (!state.prepared || !state.tabId || !elements.finalConsent.checked || state.busy) return;
  setBusy(true, '최종 신고 중');
  try {
    log(`최종 신고처리 실행: 예상 ${state.sentTargets.length}건`, 'WARN');
    const outcome = await command('FINALIZE', {
      tabId: state.tabId,
      expectedTargets: state.sentTargets
    });

    if (!outcome.ok) {
      for (const student of state.sentTargets) {
        updateResult(student, {
          stage: '최종 신고처리',
          result: '신고처리 결과 확인 필요',
          detail: outcome.message || '정상 처리 완료 여부를 판정하지 못했습니다.',
          processedAt: nowKst()
        });
      }
      state.prepared = false;
      log(outcome.message, 'ERROR');
      setBadge('결과 확인 필요', 'error');
      toast(outcome.message, 'error');
      return;
    }

    for (const student of state.sentTargets) {
      updateResult(student, {
        stage: '최종 신고처리',
        result: '졸업신고 완료',
        detail: `${outcome.message} / 예상 건수와 일치`,
        processedAt: nowKst()
      });
    }
    state.prepared = false;
    elements.finalConsent.checked = false;
    log(`졸업신고 완료: ${outcome.successCount}건`, 'OK');
    setBadge('신고 완료', 'success');
    toast(`정상 신고처리 ${outcome.successCount}건을 확인했습니다.`, 'success');
    await persistRunState();
  } catch (error) {
    for (const student of state.sentTargets) {
      updateResult(student, {
        stage: '최종 신고처리',
        result: '신고처리 실패',
        detail: error.message,
        processedAt: nowKst()
      });
    }
    state.prepared = false;
    log(error.message, 'ERROR');
    setBadge('신고 실패', 'error');
    toast(error.message, 'error');
  } finally {
    setBusy(false);
  }
}

async function downloadResults() {
  if (!state.workbook || !state.results.length || state.busy) return;
  setBusy(true, '결과 저장');
  try {
    const blob = await FimsXlsx.exportResults(state.workbook.originalBytes, state.results);
    const base = state.workbook.fileName.replace(/\.xlsx$/i, '');
    const fileName = `${base}_처리결과_${fileTimestamp()}.xlsx`;
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    log(`처리결과 엑셀 저장: ${fileName}`, 'OK');
    setBadge('결과 저장', 'success');
    toast('세 번째 처리결과 탭이 채워진 엑셀을 저장했습니다.', 'success');
  } catch (error) {
    log(error.message, 'ERROR');
    setBadge('저장 실패', 'error');
    toast(error.message, 'error');
  } finally {
    setBusy(false);
  }
}

elements.fileInput.addEventListener('change', () => {
  const file = elements.fileInput.files?.[0];
  elements.fileName.textContent = file ? file.name : '졸업신고 엑셀 파일 선택';
  state.workbook = null;
  state.results = [];
  state.sentTargets = [];
  state.prepared = false;
  elements.fileSummary.classList.add('hidden');
  renderResults();
  setBadge('대기', 'idle');
  updateButtons();
});

for (const eventName of ['dragenter', 'dragover']) {
  elements.fileDrop.addEventListener(eventName, (event) => {
    event.preventDefault();
    elements.fileDrop.classList.add('dragging');
  });
}

for (const eventName of ['dragleave', 'drop']) {
  elements.fileDrop.addEventListener(eventName, (event) => {
    event.preventDefault();
    elements.fileDrop.classList.remove('dragging');
  });
}

elements.fileDrop.addEventListener('drop', (event) => {
  const file = [...event.dataTransfer.files].find((item) => /\.xlsx$/i.test(item.name));
  if (!file) {
    toast('.xlsx 파일만 사용할 수 있습니다.', 'error');
    return;
  }
  const transfer = new DataTransfer();
  transfer.items.add(file);
  elements.fileInput.files = transfer.files;
  elements.fileInput.dispatchEvent(new Event('change'));
});

elements.userId.addEventListener('input', updateButtons);
elements.password.addEventListener('input', updateButtons);
elements.finalConsent.addEventListener('change', updateButtons);
elements.validateButton.addEventListener('click', validateWorkbook);
elements.prepareButton.addEventListener('click', prepareRun);
elements.inspectButton.addEventListener('click', inspectPending);
elements.finalizeButton.addEventListener('click', finalizeRun);
elements.downloadButton.addEventListener('click', downloadResults);
elements.clearLogButton.addEventListener('click', () => {
  state.logLines = [];
  elements.logOutput.textContent = '로그를 지웠습니다.';
});

window.addEventListener('beforeunload', (event) => {
  if (!state.busy) return;
  event.preventDefault();
  event.returnValue = '';
});

renderResults();
updateButtons();
log('대기 중');
