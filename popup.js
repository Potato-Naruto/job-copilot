const msg = document.getElementById('msg');

(async () => {
  const { profile, settings } = await browser.storage.local.get(['profile', 'settings']);
  const issues = [];
  if (!profile || !(profile.personal && (profile.personal.firstName || profile.personal.email))) issues.push('Profile is empty — import your resume in Settings.');
  if (!settings || (settings.provider === 'ollama' ? !settings.ollamaModel : !settings.geminiKey)) issues.push('No AI provider configured — needed for cover letters and tailoring.');
  msg.textContent = issues.join(' ');
})();

document.getElementById('show').onclick = async () => {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  try {
    await browser.tabs.sendMessage(tab.id, { type: 'showPanel' });
    window.close();
  } catch (e) {
    msg.textContent = "Not available here. If this is a normal website, refresh the page (tabs opened before the extension was loaded/reloaded need a refresh). Browser-internal pages (about:, addons.mozilla.org) are blocked by Firefox.";
  }
};
document.getElementById('opts').onclick = () => { browser.runtime.openOptionsPage(); window.close(); };
