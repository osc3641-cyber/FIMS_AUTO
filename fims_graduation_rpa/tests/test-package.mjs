import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve(new URL('..', import.meta.url).pathname);
const manifest = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8'));
assert.equal(manifest.manifest_version, 3);
assert.equal(manifest.version, '3.0.1');
assert.equal(manifest.name, 'FIMS 졸업신고 자동화 (Excel)');
assert.ok(!manifest.host_permissions?.some((item) => /script\.google/.test(item)),
  'Excel 전용판에 Apps Script 권한이 남아 있으면 안 됩니다.');

for (const file of [
  'service-worker.js', 'content.js', 'dialog-bridge.js', 'runner.js', 'runner.html',
  'xlsx-lite.js', 'vendor/jszip.min.js', 'popup.js', 'popup.html'
]) {
  await fs.access(path.join(root, file));
}

const worker = await fs.readFile(path.join(root, 'service-worker.js'), 'utf8');
const content = await fs.readFile(path.join(root, 'content.js'), 'utf8');
const runner = await fs.readFile(path.join(root, 'runner.js'), 'utf8');
const runnerHtml = await fs.readFile(path.join(root, 'runner.html'), 'utf8');

assert.match(worker, /setDialogModeAllFrames/);
assert.match(worker, /waitTargetSearchCheckbox/);
assert.match(worker, /ALREADY_PENDING/);
assert.match(worker, /SELECT_PENDING_TARGETS/);
assert.match(worker, /openFreshFimsWindow/);
assert.match(worker, /chrome\.tabs\.remove/);
assert.match(worker, /chrome\.windows\.create/);
assert.match(worker, /https:\/\/fims\.hikorea\.go\.kr\/isi\/MembIsiLogin\.isi/);
assert.doesNotMatch(worker, /https:\/\/www\.hikorea\.go\.kr\/isi\/index\.html/,
  '자동화 시작 주소로 공개 하이코리아 경유 페이지를 사용하면 안 됩니다.');
assert.doesNotMatch(worker, /OPEN_CHANGE_REPORT_DIRECT|FIMS_CHANGE_REPORT_URL/,
  '정상 동작했던 메뉴 클릭 방식 대신 URL 직접 이동을 사용하면 안 됩니다.');
assert.doesNotMatch(worker, /sendAction\(tabId, audit\.frameId, 'SELECT_ALL_PENDING'\)/,
  '기존 FIMS 대기명단의 다른 학생까지 전체선택하면 안 됩니다.');

assert.match(content, /#button2 > td > a/);
assert.match(content, /a\[onclick\*="fncReqMoveNotiList"\]/);
assert.match(content, /SELECT_PENDING_TARGETS/);
assert.match(content, /documentToken/);
assert.match(content, /document\.querySelector\('#nMenuTreeHome16'\)/);
assert.doesNotMatch(content, /querySelector\('#nMenuTreeHome15, #nMenuTreeHome16/,
  '상위 메뉴 토글과 실제 이동 링크를 같은 selector로 선택하면 안 됩니다.');
assert.doesNotMatch(content, /case 'SELECT_ALL_PENDING'/);

assert.match(runner, /FimsXlsx\.parseWorkbook/);
assert.match(runner, /FimsXlsx\.exportResults/);
assert.doesNotMatch(runner + runnerHtml, /Apps Script 웹앱 URL|apiToken|webAppUrl|FimsSheetsApi/);

const ids = [...runner.matchAll(/getElementById\('([^']+)'\)/g)].map((match) => match[1]);
for (const id of ids) {
  assert.match(runnerHtml, new RegExp(`id=["']${id}["']`), `runner.html is missing #${id}`);
}

console.log('Excel package integrity tests passed');
