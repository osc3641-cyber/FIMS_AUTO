import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../dialog-bridge.js', import.meta.url), 'utf8');
const stored = new Map();
let nativeConfirmCalls = 0;
let nativeAlertCalls = 0;

const context = vm.createContext({
  console,
  Date,
  JSON,
  location: { href: 'https://fims.hikorea.go.kr/isi/IntlStudBaInfoDtlRU.xec' },
  localStorage: {
    getItem: (key) => stored.has(key) ? stored.get(key) : null,
    setItem: (key, value) => stored.set(key, String(value)),
    removeItem: (key) => stored.delete(key)
  },
  confirm: () => {
    nativeConfirmCalls += 1;
    return false;
  },
  alert: () => {
    nativeAlertCalls += 1;
  }
});
context.window = context;

vm.runInContext(source, context, { filename: 'dialog-bridge.js' });
context.__FIMS_ARRIVAL_RPA_SET_DIALOG_MODE__({ confirmValue: true, durationMs: 45000, clearLog: true });

assert.equal(context.confirm('해당정보를 저장하시겠습니까?'), true);
assert.equal(nativeConfirmCalls, 0, '자동화 중에는 브라우저 native confirm을 열면 안 됩니다.');
const logs = context.__FIMS_ARRIVAL_RPA_GET_DIALOG_LOG__();
assert.equal(logs.length, 1);
assert.equal(logs[0].kind, 'confirm');
assert.equal(logs[0].answer, true);

context.alert('정상적으로 저장되었습니다.');
assert.equal(nativeAlertCalls, 0, '자동화 중 완료 alert도 차단하고 로그로 남겨야 합니다.');
assert.equal(context.__FIMS_ARRIVAL_RPA_GET_DIALOG_LOG__().length, 2);

context.__FIMS_ARRIVAL_RPA_CLEAR_DIALOG_MODE__();
assert.equal(context.confirm('수동 확인'), false);
assert.equal(nativeConfirmCalls, 1, '자동화 해제 후에는 원래 confirm을 복구해야 합니다.');

// 로그인 뒤 새로 생성되는 frame/document도 같은 origin의 localStorage 모드를
// document_start에서 읽어 선택적 안내 alert를 자동 확인할 수 있어야 한다.
stored.set('FIMS_ARRIVAL_RPA_DIALOG_MODE', JSON.stringify({
  active: true,
  confirmValue: true,
  until: Date.now() + 45000
}));
stored.set('FIMS_ARRIVAL_RPA_DIALOG_LOG', '[]');
let nextFrameNativeAlertCalls = 0;
const nextFrame = vm.createContext({
  console,
  Date,
  JSON,
  location: { href: 'https://fims.hikorea.go.kr/isi/MainR.isi' },
  localStorage: {
    getItem: (key) => stored.has(key) ? stored.get(key) : null,
    setItem: (key, value) => stored.set(key, String(value)),
    removeItem: (key) => stored.delete(key)
  },
  confirm: () => false,
  alert: () => { nextFrameNativeAlertCalls += 1; }
});
nextFrame.window = nextFrame;
vm.runInContext(source, nextFrame, { filename: 'dialog-bridge-new-frame.js' });
nextFrame.alert('아래 유학생현황을 확인 후 처리바랍니다. 변동신고반려처리건수 : 44');
assert.equal(nextFrameNativeAlertCalls, 0);
assert.equal(nextFrame.__FIMS_ARRIVAL_RPA_GET_DIALOG_LOG__().at(-1).kind, 'alert');

console.log('dialog bridge tests passed');
