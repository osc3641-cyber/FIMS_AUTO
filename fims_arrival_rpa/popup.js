// 버전은 manifest 한 곳에서만 관리한다. 예전에는 화면에 하드코딩돼 있어
// manifest를 올려도 화면은 v1.0.4로 남아 있었다.
const versionLabel = document.getElementById('appVersion');
if (versionLabel) versionLabel.textContent = `v${chrome.runtime.getManifest().version}`;

document.getElementById('openRunner').addEventListener('click', async () => {
  const url = chrome.runtime.getURL('runner.html');
  const tabs = await chrome.tabs.query({ url });
  if (tabs.length && tabs[0].id) {
    await chrome.tabs.update(tabs[0].id, { active: true });
    if (tabs[0].windowId) await chrome.windows.update(tabs[0].windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
  window.close();
});
