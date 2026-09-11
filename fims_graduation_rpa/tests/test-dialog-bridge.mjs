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
  location: { href: 'https://www.hikorea.go.kr/isi/ChgIntlStudListR.isi?sRegStudYn=Y' },
  sessionStorage: {
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
context.__FIMS_GRAD_RPA_SET_DIALOG_MODE__({ confirmValue: true, durationMs: 45000, clearLog: true });

assert.equal(context.confirm('선택된 유학생을 이동 하시겠습니까?'), true);
assert.equal(nativeConfirmCalls, 0, '자동화 중에는 브라우저 native confirm을 열면 안 됩니다.');
const logs = context.__FIMS_GRAD_RPA_GET_DIALOG_LOG__();
assert.equal(logs.length, 1);
assert.equal(logs[0].kind, 'confirm');
assert.equal(logs[0].answer, true);

context.alert('정상적으로 처리되었습니다.');
assert.equal(nativeAlertCalls, 0, '자동화 중 완료 alert도 차단하고 로그로 남겨야 합니다.');
assert.equal(context.__FIMS_GRAD_RPA_GET_DIALOG_LOG__().length, 2);

context.__FIMS_GRAD_RPA_CLEAR_DIALOG_MODE__();
assert.equal(context.confirm('수동 확인'), false);
assert.equal(nativeConfirmCalls, 1, '자동화 해제 후에는 원래 confirm을 복구해야 합니다.');

console.log('dialog bridge tests passed');
