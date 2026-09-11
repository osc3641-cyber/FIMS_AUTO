/* global FimsXlsx */
const elements = {
  fileInput: document.getElementById('workbookFile'),
  fileDrop: document.getElementById('fileDrop'),
  fileName: document.getElementById('fileName'),
  userId: document.getElementById('userId'),
  password: document.getElementById('password'),
  fileSummary: document.getElementById('fileSummary'),
  validateButton: document.getElementById('validateButton'),
  loginButton: document.getElementById('loginButton'),
  diagnoseButton: document.getElementById('diagnoseButton'),
  diagnoseReportButton: document.getElementById('diagnoseReportButton'),
  startButton: document.getElementById('startButton'),
  focusButton: document.getElementById('focusButton'),
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
  tabId: null,
  busy: false,
  logLines: [],
  diagnostics: null
};

// 진단 리포트는 개발자에게 전달되므로 개인 식별 정보를 남기지 않는다.
// 다만 이름 길이·쉼표 위치·자릿수는 검색 실패 원인 분석에 필요하므로 형태는 보존한다.
// 예: "SURNAME, GIVEN NAME" → "XXXXXXX, XXXXX XXXX"
function maskStructure(value) {
  return String(value ?? '').replace(/\p{L}/gu, 'X').replace(/\d/g, '#');
}

// 안전 기본값: 조금이라도 사람을 가리킬 수 있는 키는 전부 가린다.
// 과하게 가리는 편이 새는 것보다 낫다. 진단에 꼭 필요한 키만 예외로 둔다.
const MASK_EXEMPT_KEYS = new Set([
  'windowName',   // 프레임 이름 (mainFrame 등)
  'fileName',     // 엑셀 파일명
  'userAgent',
  'matchStrategy',
  'selectedText', // 입국여부 콤보 표시값 (선택/미입국/입국)
  'optionTexts',  // 콤보 옵션 목록
  'label',        // 진단 항목 이름
  'selector'
]);
const MASK_KEY_PATTERN = /name|nm$|birth|schol|stud|pass|fgnreg|tel|email|addr|title|signature/i;

function maskDeep(value, key = '') {
  if (Array.isArray(value)) return value.map((item) => maskDeep(item, key));
  if (value && typeof value === 'object') {
    const output = {};
    for (const [childKey, childValue] of Object.entries(value)) output[childKey] = maskDeep(childValue, childKey);
    return output;
  }
  if (typeof value !== 'string' || !value) return value;
  if (MASK_EXEMPT_KEYS.has(key)) return value;
  return MASK_KEY_PATTERN.test(key) ? maskStructure(value) : value;
}

function nowKst() {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).format(new Date());
}

function fileTimestamp() {
  return nowKst().replace(/[-: ]/g, '').slice(0, 14);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function log(message, kind = 'INFO') {
  const line = `[${nowKst().slice(11)}] [${kind}] ${String(message)}`;
  state.logLines.push(line);
  elements.logOutput.textContent = state.logLines.slice(-500).join('\n');
  elements.logOutput.scrollTop = elements.logOutput.scrollHeight;
}

let toastTimer;
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
  const hasWorkbook = Boolean(state.workbook);
  const hasCredentials = Boolean(elements.userId.value.trim() && elements.password.value);
  elements.validateButton.disabled = state.busy;
  elements.loginButton.disabled = state.busy || !hasCredentials;
  elements.startButton.disabled = state.busy || !hasWorkbook || !hasCredentials;
  elements.focusButton.disabled = state.busy || !state.tabId;
  elements.diagnoseButton.disabled = state.busy || !hasWorkbook || !hasCredentials;
  elements.diagnoseReportButton.disabled = state.busy || !state.diagnostics;
  elements.downloadButton.disabled = state.busy || !hasWorkbook || !state.results.length;
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
  if (result === '입국신고 완료') return 'status-complete';
  if (result === '대기' || result === '처리 중') return 'status-pending';
  return 'status-failed';
}

function renderResults() {
  elements.resultsBody.replaceChildren();
  if (!state.results.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 10;
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
      result.sequence, result.name, result.birthDate, result.studentNo,
      result.stage, result.result, result.arrivalDate, result.note,
      result.detail, result.processedAt
    ];
    values.forEach((value, index) => {
      const cell = document.createElement('td');
      cell.textContent = value ?? '';
      if (index === 5) cell.className = resultClass(String(value || ''));
      row.appendChild(cell);
    });
    elements.resultsBody.appendChild(row);
  }

  const complete = state.results.filter((item) => item.result === '입국신고 완료').length;
  const attention = state.results.filter((item) => !['대기', '처리 중', '입국신고 완료'].includes(item.result)).length;
  elements.resultCounts.textContent = `대상 ${state.results.length} · 완료 ${complete} · 확인 필요 ${attention}`;
}

async function persistRunState() {
  if (!state.workbook) return;
  try {
    await chrome.storage.local.set({
      lastFimsArrivalRun: {
        fileName: state.workbook.fileName,
        config: state.workbook.config,
        results: state.results,
        tabId: state.tabId,
        updatedAt: new Date().toISOString()
      }
    });
  } catch (_) {}
}

function initializeResults(students) {
  state.results = students.map((student) => ({
    sequence: student.sequence,
    name: student.name,
    birthDate: student.birthDate,
    studentNo: student.studentNo,
    stage: '대기',
    result: '대기',
    arrivalDate: '',
    note: student.note || '',
    detail: '',
    processedAt: ''
  }));
  state.tabId = null;
  renderResults();
}

function updateResult(student, patch) {
  const result = state.results.find((item) => item.sequence === student.sequence);
  if (!result) return;
  Object.assign(result, patch);
  renderResults();
  void persistRunState();
}

function renderFileSummary() {
  const { config, students } = state.workbook;
  elements.fileSummary.classList.remove('hidden');
  elements.fileSummary.innerHTML = [
    `<strong>처리대상 ${students.length}명</strong>`,
    `입학(복학)일자: ${escapeHtml(config.admissionDate)}`,
    '검색조건: 성명(앞 38자 기준) + 생년월일 + 유사 체크',
    '저장값: 학번 + 입국(N) + 입학(복학)일자'
  ].join('<br>');
}

async function command(commandName, payload) {
  const response = await chrome.runtime.sendMessage({
    type: 'FIMS_ARRIVAL_RPA_COMMAND',
    command: commandName,
    payload
  });
  if (!response?.ok) throw new Error(response?.error || '확장 프로그램 명령 실행 실패');
  return response.result;
}

async function validateWorkbook() {
  const file = elements.fileInput.files?.[0];
  if (!file) {
    toast('입국신고 엑셀 파일을 선택하세요.', 'error');
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
    log(`파일 검사 완료: 대상 ${workbook.students.length}명`, 'OK');
    log(`입학(복학)일자 ${workbook.config.admissionDate}`, 'OK');
    setBadge('파일 정상', 'success');
    toast('엑셀 구조와 입력값 검사가 완료되었습니다.', 'success');
    await persistRunState();
  } catch (error) {
    state.workbook = null;
    state.results = [];
    state.tabId = null;
    elements.fileSummary.classList.add('hidden');
    renderResults();
    log(error.message, 'ERROR');
    setBadge('파일 오류', 'error');
    toast(error.message, 'error');
  } finally {
    setBusy(false);
  }
}

async function openLoginOnly() {
  const userId = elements.userId.value.trim();
  const password = elements.password.value;
  if (!userId || !password || state.busy) return;
  setBusy(true, '로그인 점검');
  try {
    log('기존 FIMS 탭을 닫고 세션 쿠키를 지운 뒤 확장프로그램 전용 FIMS 팝업 창을 엽니다.');
    log('브라우저 자동입력 값을 지우고, 아래에 입력한 ID·비밀번호를 로그인 직전에 다시 덮어씁니다.');
    const login = await command('OPEN_OR_LOGIN', { userId, password });
    state.tabId = login.tabId;
    log(login.message, 'OK');
    setBadge('메뉴 진입 완료', 'success');
    toast('유학생정보관리 → 유학생기본정보 진입을 확인했습니다.', 'success');
  } catch (error) {
    log(error.message, 'ERROR');
    setBadge('로그인 오류', 'error');
    toast(error.message, 'error');
  } finally {
    setBusy(false);
  }
}

async function startRun() {
  if (!state.workbook || state.busy) return;
  const userId = elements.userId.value.trim();
  const password = elements.password.value;
  if (!userId || !password) {
    toast('FIMS 사용자 ID와 비밀번호를 입력하세요.', 'error');
    return;
  }

  setBusy(true, '입국신고 처리 중');
  initializeResults(state.workbook.students);
  try {
    log('기존 FIMS 탭을 닫고 세션 쿠키를 지운 뒤 확장프로그램 전용 FIMS 팝업 창을 엽니다.');
    log('브라우저 자동입력 값을 지우고, 아래에 입력한 ID·비밀번호를 로그인 직전에 다시 덮어씁니다.');
    log('새 창에서 로그인 후 유학생정보관리 → 유학생기본정보로 진입합니다.');
    const login = await command('OPEN_OR_LOGIN', { userId, password });
    state.tabId = login.tabId;
    log(login.message, 'OK');

    const total = state.workbook.students.length;
    for (let index = 0; index < total; index += 1) {
      const student = state.workbook.students[index];
      setBadge(`${index + 1}/${total} 처리`, 'running');
      updateResult(student, {
        stage: '조회/수정/저장', result: '처리 중', arrivalDate: '',
        note: student.note || '', detail: '', processedAt: nowKst()
      });
      log(`[${index + 1}/${total}] ${student.name} / ${student.birthDate} / ${student.studentNo} 조회`);
      try {
        const outcome = await command('PROCESS_STUDENT', {
          tabId: state.tabId,
          student,
          config: state.workbook.config
        });
        const combinedNote = [student.note, outcome.note].filter(Boolean).join(' / ');
        updateResult(student, {
          stage: outcome.code === 'COMPLETED' || outcome.code === 'ARRIVAL_DATE_MISSING' ? '저장 후 검증' : '처리 중단',
          result: outcome.result,
          arrivalDate: outcome.arrivalDate || '',
          note: combinedNote,
          detail: outcome.detail || '',
          processedAt: nowKst()
        });
        const kind = outcome.code === 'COMPLETED' ? 'OK' : 'WARN';
        log(`[${index + 1}/${total}] ${outcome.result}: ${student.name}${outcome.arrivalDate ? ` / ${outcome.arrivalDate}` : ''}${outcome.detail ? ` / ${outcome.detail}` : ''}`, kind);
      } catch (error) {
        updateResult(student, {
          stage: '처리 중단', result: '자동화 오류', arrivalDate: '',
          note: [student.note, '별도 확인 필요'].filter(Boolean).join(' / '),
          detail: error.message, processedAt: nowKst()
        });
        log(`[${index + 1}/${total}] 자동화 오류: ${student.name} / ${error.message}`, 'ERROR');
      }
    }

    const complete = state.results.filter((item) => item.result === '입국신고 완료').length;
    const missing = state.results.filter((item) => item.result === '입국일자 미확인').length;
    const failed = total - complete - missing;
    log(`전체 처리 종료: 완료 ${complete}명 / 입국일자 미확인 ${missing}명 / 기타 확인 필요 ${failed}명`, failed || missing ? 'WARN' : 'OK');
    setBadge(failed || missing ? '처리 종료 · 확인 필요' : '처리 완료', failed || missing ? 'error' : 'success');
    toast(`처리 종료: 완료 ${complete}명, 확인 필요 ${missing + failed}명`, failed || missing ? 'error' : 'success');
    await persistRunState();
  } catch (error) {
    log(error.message, 'ERROR');
    setBadge('실행 오류', 'error');
    toast(error.message, 'error');
  } finally {
    setBusy(false);
  }
}

async function focusFims() {
  if (!state.tabId || state.busy) return;
  try {
    const outcome = await command('FOCUS_FIMS', { tabId: state.tabId });
    toast(outcome.message || 'FIMS 창으로 이동했습니다.', 'success');
  } catch (error) {
    log(error.message, 'ERROR');
    toast(error.message, 'error');
  }
}

async function runDiagnosis() {
  if (!state.workbook || state.busy) return;
  const userId = elements.userId.value.trim();
  const password = elements.password.value;
  if (!userId || !password) {
    toast('FIMS 사용자 ID와 비밀번호를 입력하세요.', 'error');
    return;
  }
  const student = state.workbook.students[0];
  if (!student) {
    toast('엑셀 명단에 처리대상 학생이 없습니다.', 'error');
    return;
  }

  setBusy(true, '진단 중 (조회만)');
  try {
    log('진단 모드입니다. 수정화면까지 열어 입력을 재현하지만 저장 버튼은 누르지 않습니다.', 'INFO');
    log('저장하지 않으면 FIMS에 아무것도 반영되지 않습니다. 끝나면 열린 FIMS 창은 그냥 닫으세요.', 'INFO');
    const login = await command('OPEN_OR_LOGIN', { userId, password });
    state.tabId = login.tabId;
    log(login.message, 'OK');

    log(`진단 대상: 명단 첫 번째 학생 (${student.name})`);
    const report = await command('DIAGNOSE_STUDENT', {
      tabId: state.tabId,
      student: { ...student, admissionDate: state.workbook.config?.admissionDate || '' },
      depth: 'edit'
    });

    for (const step of report.steps) {
      log(`${step.ok ? '[OK] ' : '[WARN] '}${step.step}${step.detail ? ` — ${step.detail}` : ''}`, step.ok ? 'OK' : 'WARN');
    }
    state.diagnostics = {
      generatedAt: nowKst(),
      extensionVersion: chrome.runtime.getManifest().version,
      userAgent: navigator.userAgent,
      stoppedAt: report.stoppedAt,
      wroteToFims: report.wroteToFims === true,
      admissionDate: state.workbook.config?.admissionDate || '',
      steps: maskDeep(report.steps)
    };
    log(`진단 종료: ${report.stoppedAt}`, 'OK');
    log('“진단 리포트 저장”을 눌러 파일을 받은 뒤 전달하세요. 이름·생년월일·학번은 자동으로 가려집니다.', 'INFO');
    setBadge('진단 완료', 'success');
    toast('진단이 끝났습니다. 리포트를 저장하세요.', 'success');
  } catch (error) {
    log(error.message, 'ERROR');
    setBadge('진단 오류', 'error');
    toast(error.message, 'error');
  } finally {
    setBusy(false);
  }
}

function downloadDiagnosisReport() {
  if (!state.diagnostics) return;
  const header = [
    '# FIMS 입국신고 자동화 진단 리포트',
    '#',
    '# 이 파일에는 개인 식별 정보가 들어 있지 않습니다.',
    '# 성명·생년월일·학번은 길이와 형태만 남기고 가려져 있습니다.',
    '#   예: "SURNAME, GIVEN" -> "XXXXXXX, XXXXX"',
    '# FIMS 사용자 ID와 비밀번호는 애초에 수집하지 않습니다.',
    `# 이 진단은 조회까지만 실행했고 FIMS에 기록하지 않았습니다: wroteToFims=${state.diagnostics.wroteToFims}`,
    '',
    ''
  ].join('\n');
  const blob = new Blob([header + JSON.stringify(state.diagnostics, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `FIMS_입국신고_진단리포트_${fileTimestamp()}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
  toast('진단 리포트를 저장했습니다.', 'success');
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
  elements.fileName.textContent = file ? file.name : '입국신고 엑셀 파일 선택';
  state.workbook = null;
  state.results = [];
  state.tabId = null;
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
  if (!file) return toast('.xlsx 파일만 사용할 수 있습니다.', 'error');
  const transfer = new DataTransfer();
  transfer.items.add(file);
  elements.fileInput.files = transfer.files;
  elements.fileInput.dispatchEvent(new Event('change'));
});

elements.userId.addEventListener('input', updateButtons);
elements.password.addEventListener('input', updateButtons);
elements.validateButton.addEventListener('click', validateWorkbook);
elements.loginButton.addEventListener('click', openLoginOnly);
elements.startButton.addEventListener('click', startRun);
elements.focusButton.addEventListener('click', focusFims);
elements.diagnoseButton.addEventListener('click', runDiagnosis);
elements.diagnoseReportButton.addEventListener('click', downloadDiagnosisReport);
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
