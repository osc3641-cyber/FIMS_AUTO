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
