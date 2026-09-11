import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const manifest = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8'));
assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.version, '1.2.0');
assert.equal(manifest.name, 'FIMS 입국신고 자동화 (Excel)');
assert.ok(!manifest.permissions.includes('debugger'), '로그인과 저장 처리에 Chrome debugger 권한을 사용하면 안 됩니다.');
assert.ok(manifest.permissions.includes('cookies'), '새 FIMS 로그인 전에 세션 쿠키를 지울 권한이 필요합니다.');
assert.ok(!manifest.host_permissions?.some((item) => /script\.google/.test(item)), 'Excel 전용판에 Apps Script 권한이 남아 있으면 안 됩니다.');

for (const file of [
  'service-worker.js', 'content.js', 'dialog-bridge.js', 'runner.js', 'runner.html',
  'xlsx-lite.js', 'vendor/jszip.min.js', 'popup.js', 'popup.html'
]) await fs.access(path.join(root, file));

const worker = await fs.readFile(path.join(root, 'service-worker.js'), 'utf8');
const content = await fs.readFile(path.join(root, 'content.js'), 'utf8');
const runner = await fs.readFile(path.join(root, 'runner.js'), 'utf8');
const runnerHtml = await fs.readFile(path.join(root, 'runner.html'), 'utf8');
const xlsx = await fs.readFile(path.join(root, 'xlsx-lite.js'), 'utf8');

assert.match(worker, /openFreshFimsWindow/);
assert.match(worker, /chrome\.tabs\.remove/);
assert.match(worker, /type: 'popup'/);
assert.match(worker, /width: 1280/);
assert.match(worker, /height: 900/);
assert.match(worker, /clearFimsCookies/);
assert.match(worker, /chrome\.cookies\.getAll/);
assert.match(worker, /chrome\.cookies\.remove/);
assert.match(worker, /FIMS_ENTRY_URL = 'https:\/\/fims\.hikorea\.go\.kr\/isi\/index\.html'/);
assert.match(worker, /native-login-button/);
assert.match(worker, /input\[name="Button2"\]\[onclick\*="membLogin"\]/);
assert.match(worker, /autofillReplaced/);
assert.match(worker, /id\.readOnly = true/);
assert.match(worker, /assign\(id, '', \{ focus: false, notify: true \}\)/);
assert.match(worker, /assign\(id, userId, \{ focus: false, notify: false \}\)/);
assert.match(worker, /isPostLoginStatusNotice/);
assert.match(worker, /POST_LOGIN_MENU_SETTLE_MS/);
assert.match(worker, /localStorage\.getItem/);
assert.match(worker, /EXPAND_STUDENT_INFO_MENU/);
assert.match(worker, /CLICK_STUDENT_BASIC_MENU/);
assert.match(worker, /PREPARE_ARRIVAL_SEARCH/);
assert.match(worker, /FILL_ARRIVAL_EDIT/);
assert.match(worker, /SAVE_ARRIVAL_EDIT/);
assert.match(worker, /setDialogModeAllFrames/);
assert.doesNotMatch(worker, /chrome\.debugger|startNativeDialogAutoAccept/);
assert.match(content, /document\.querySelector\('#nMenuTreeHome6'\)/);
assert.match(content, /document\.querySelector\('#nMenuTreeHome7'\)/);
assert.match(content, /#sEkNm/);
assert.match(content, /#sBirthYmd/);
assert.match(content, /#sLikeYn/);
assert.match(content, /a\[title="상세조회"\]/);
assert.match(content, /a\[onclick\*="fncGetDetail"\]/);
assert.match(content, /resolveDetailCandidate/);
assert.match(content, /single-detail-link/);
assert.match(content, /#entrYN/);
assert.match(content, /setNativeValue\(document\.querySelector\('#entrYN'\), 'N'\)/, '입국여부는 value N으로 설정해야 합니다.');
assert.match(content, /selectedText !== '입국'/, '입국여부 표시문자까지 검증해야 합니다.');
// 1.0.7: 입국여부 change 핸들러가 다른 칸을 되돌릴 수 있으므로 검증은 DOM 재조회로 한다
assert.match(content, /setNativeValueQuiet/, '값이 밀렸을 때 이벤트 없이 재시도해야 합니다.');
assert.match(content, /fieldReport/, '입력 실패 시 입력칸 상태를 남겨야 합니다.');

// 1.0.5 회귀 방지
assert.match(content, /IntlStudBaInfo\(\?:DtlRU\|DtlR\|U\)/, '수정화면 URL IntlStudBaInfoDtlRU.xec 를 인식해야 합니다.');
assert.match(content, /arrivalConfirmed/, '저장 성공 판정에 arrivalConfirmed가 필요합니다.');
assert.match(content, /canVerifyArrival/, 'inspect()가 저장 결과 확인 가능 여부를 알려야 합니다.');
assert.match(worker, /waitForArrivalVerification/, '저장 후 상세·수정 화면 양쪽에서 결과를 확인해야 합니다.');
assert.match(worker, /readLoginError/, '로그인 버튼 클릭 실패를 실제로 읽어야 합니다.');
assert.match(worker, /diagnoseArrivalStudent/, '조회 전용 진단 모드가 있어야 합니다.');
assert.match(runner, /maskStructure/, '진단 리포트는 개인정보를 가려야 합니다.');
assert.match(runner, /DIAGNOSE_STUDENT/, '실행 화면에 진단 실행 경로가 있어야 합니다.');

// 1.1.0: 입국일자 미확인 별도처리 (재학생정보 수정대상자)
assert.match(worker, /recheckArrivalStudent/, '별도처리 흐름이 있어야 합니다.');
assert.match(worker, /ICRMIntlStudInfoPopR/, '수정 팝업 탭을 찾는 경로가 필요합니다.');
assert.match(content, /nMenuTreeHome8/, '재학생정보 수정대상자 메뉴 셀렉터가 필요합니다.');
assert.match(content, /fncGetICRMDetail/, '수정(새창열림) 셀렉터가 필요합니다.');
assert.match(content, /fncSearchIntlStudInfo/, '수정대상자 조회 버튼 셀렉터가 필요합니다.');
assert.match(content, /applyIcrmUpdate/, '팝업 수정 적용 함수가 필요합니다.');
assert.match(runner, /RECHECK_ARRIVAL/, '실행 화면에 별도처리 실행 경로가 있어야 합니다.');
assert.match(runner, /recheckTargets/, '별도처리 대상 선별 로직이 필요합니다.');
assert.match(xlsx, /parsePriorResults/, '처리결과 탭을 다시 읽을 수 있어야 합니다.');

// 1.1.1: 저장은 증거가 있을 때만 '완료'로 인정한다
assert.match(worker, /waitForSaveOutcome/, '저장 결과를 증거로 판정해야 합니다.');
assert.match(worker, /isSaveSuccessMessage/, 'FIMS 저장 성공 알림을 판별해야 합니다.');
assert.match(worker, /SAVE_NOT_EXECUTED/, '저장이 실행되지 않은 경우를 구분해야 합니다.');
assert.match(worker, /SAVE_REJECTED/, 'FIMS가 저장을 거부한 경우를 구분해야 합니다.');
assert.doesNotMatch(worker, /학번·입국·입학일자 저장은 완료됐으나/, '증거 없이 저장 완료라고 쓰면 안 됩니다.');

// 1.2.0
assert.match(content, /rowSearchText/, '목록 행의 입력칸 값까지 읽어야 대상 학생을 찾습니다.');
assert.match(content, /sanitizeSchoolName/, '최종출신학교 특수문자 정리가 필요합니다.');
assert.match(content, /lastOriSchol/, '최종출신학교 필드 셀렉터가 필요합니다.');
assert.doesNotMatch(content, /const text = normalizeText\(row\?\.innerText/, '행 매칭에 innerText만 쓰면 입력칸 값을 놓칩니다.');

// 화면 버전은 manifest 에서 읽는다 (하드코딩 금지)
const runnerHtmlRaw = await fs.readFile(path.join(root, 'runner.html'), 'utf8');
const popupHtmlRaw = await fs.readFile(path.join(root, 'popup.html'), 'utf8');
assert.doesNotMatch(runnerHtmlRaw, /v\d+\.\d+\.\d+/, '실행 화면에 버전을 하드코딩하면 안 됩니다.');
assert.doesNotMatch(popupHtmlRaw, /v\d+\.\d+\.\d+/, '팝업 화면에 버전을 하드코딩하면 안 됩니다.');
assert.match(runner, /getManifest\(\)\.version/, '실행 화면 버전은 manifest에서 읽어야 합니다.');
assert.doesNotMatch(worker, /clearLog: index === 0/, '대화상자 로그는 전 프레임에서 지워야 합니다.');
assert.match(content, /IntlStudBaInfo\(\?:DtlRU\|DtlR\|U\)\\\.xec/, '상세·수정 화면 URL 판정에 DtlRU가 포함돼야 합니다.');
assert.match(content, /#admsnYmd/);
assert.match(content, /a\[onclick\*="fncSave"\]/);
assert.match(content, /\(\\s\*입국\\s\*\\\)/);
assert.match(runner, /FimsXlsx\.parseWorkbook/);
assert.match(runner, /FimsXlsx\.exportResults/);
assert.match(xlsx, /입국신고명단/);
assert.match(xlsx, /확인된 입국일자/);
assert.doesNotMatch(runner + runnerHtml + xlsx, /Apps Script 웹앱 URL|apiToken|webAppUrl|FimsSheetsApi/);

const ids = [...runner.matchAll(/getElementById\('([^']+)'\)/g)].map((match) => match[1]);
for (const id of ids) assert.match(runnerHtml, new RegExp(`id=["']${id}["']`), `runner.html is missing #${id}`);

console.log('arrival Excel package integrity tests passed');
