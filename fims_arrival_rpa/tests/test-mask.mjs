// 진단 리포트가 개인 식별 정보를 흘리지 않는지 검증한다.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../runner.js', import.meta.url), 'utf8');
// runner.js는 DOM에 의존하므로 마스킹 함수 정의부만 떼어 평가한다.
const start = source.indexOf('function maskStructure');
const end = source.indexOf('function nowKst');
assert.ok(start > 0 && end > start, 'runner.js에서 마스킹 함수 영역을 찾지 못했습니다.');
const context = vm.createContext({});
vm.runInContext(source.slice(start, end), context, { filename: 'mask.js' });
const { maskStructure, maskDeep } = context;

// 형태는 남고 신원은 사라진다
assert.equal(maskStructure('SURNAME, GIVEN MIDDLE'), 'XXXXXXX, XXXXX XXXXXX');
assert.equal(maskStructure('20000304'), '########');
assert.equal(maskStructure('2000.03.04'), '####.##.##');
assert.equal(maskStructure('홍길동'), 'XXX');

// 실제 진단 리포트에 등장하는 키들이 전부 가려지는지
const report = maskDeep({
  criteria: { name: 'SURNAME GIVEN', birthDate: '2000.03.04', similarChecked: true },
  targetName: 'SURNAME GIVEN',
  availableNames: ['SURNAME GIVEN', 'OTHER PERSON'],
  detailLinkNames: ['SURNAME GIVEN'],
  signature: 'FOUND|0|name-match|SURNAME GIVEN',
  studentNo: '9900000001',
  scholNo: '9900000001',
  passNo: 'M12345678',
  data: { name: 'SURNAME GIVEN', birthYmd: '2000.03.04' },
  windowName: 'mainFrame',
  selectedText: '입국',
  optionTexts: ['선택', '미입국', '입국'],
  matchStrategy: 'name-match',
  url: 'https://fims.hikorea.go.kr/isi/IntlStudBaInfoDtlRU.xec',
  valueLength: 13,
  visible: true
});

const flat = JSON.stringify(report);
for (const leaked of ['SURNAME', 'GIVEN', 'OTHER PERSON', '9900000001', 'M12345678', '2000.03.04']) {
  assert.ok(!flat.includes(leaked), `진단 리포트에 ${leaked} 이(가) 남으면 안 됩니다.`);
}

// 진단에 필요한 정보는 살아 있어야 한다
assert.equal(report.windowName, 'mainFrame');
assert.equal(report.selectedText, '입국');
assert.deepEqual(report.optionTexts, ['선택', '미입국', '입국']);
assert.equal(report.matchStrategy, 'name-match');
assert.match(report.url, /IntlStudBaInfoDtlRU\.xec/);
assert.equal(report.valueLength, 13);
assert.equal(report.visible, true);
assert.equal(report.criteria.similarChecked, true);
// 형태 보존 확인: 길이와 공백 위치가 그대로여야 원인 분석이 가능하다
assert.equal(report.criteria.name, 'XXXXXXX XXXXX');
assert.equal(report.criteria.birthDate, '####.##.##');

console.log('mask tests passed');
