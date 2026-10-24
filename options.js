const FIELDS = {
  personal: [
    ['firstName', 'First name'], ['lastName', 'Last name'], ['email', 'Email'], ['phone', 'Phone'],
    ['address', 'Street address'], ['city', 'City'], ['state', 'State / Province'], ['zip', 'ZIP / Postal code'],
    ['country', 'Country'], ['linkedin', 'LinkedIn URL'], ['github', 'GitHub URL'], ['website', 'Website / Portfolio']
  ],
  work: [
    ['currentCompany', 'Current / most recent company'], ['currentTitle', 'Current / most recent title'],
    ['yearsExperience', 'Years of experience'], ['salaryExpectation', 'Salary expectation'],
    ['noticePeriod', 'Notice period / start date'],
    ['authorizedToWork', 'Authorized to work?', ['', 'Yes', 'No']],
    ['requiresSponsorship', 'Require visa sponsorship?', ['', 'Yes', 'No']],
    ['willingToRelocate', 'Willing to relocate?', ['', 'Yes', 'No']]
  ],
  eeo: [
    ['gender', 'Gender'], ['pronouns', 'Pronouns'], ['ethnicity', 'Race / ethnicity'],
    ['veteran', 'Veteran status'], ['disability', 'Disability status']
  ]
};

const SETTING_IDS = ['provider', 'geminiKey', 'geminiModel', 'ollamaUrl', 'ollamaModel'];
function readSettings() {
  const s = { autoPopup: $('autoPopup').checked };
  for (const k of SETTING_IDS) s[k] = $(k).value.trim() || JobAI.DEFAULTS[k] || '';
  if (!$('geminiKey').value.trim()) s.geminiKey = '';
  return s;
}
function syncProvider() {
  const p = $('provider').value;
  $('gemini-box').classList.toggle('hidden', p !== 'gemini');
  $('ollama-box').classList.toggle('hidden', p !== 'ollama');
}
const $ = (id) => document.getElementById(id);
const status = (m, cls) => { const s = $('status'); s.textContent = m; s.className = cls || ''; };
let profile = {};
let resumeFile = null;
let answers = {};

function buildForm() {
  for (const [sec, defs] of Object.entries(FIELDS)) {
    const box = $('f-' + sec);
    box.textContent = '';
    for (const [key, label, opts] of defs) {
      const l = document.createElement('label');
      l.textContent = label;
      let inp;
      if (opts) {
        inp = document.createElement('select');
        opts.forEach((o) => { const op = document.createElement('option'); op.value = o; op.textContent = o || '(ask me)'; inp.appendChild(op); });
      } else inp = document.createElement('input');
      inp.dataset.path = sec + '.' + key;
      inp.value = (profile[sec] && profile[sec][key]) || '';
      l.appendChild(inp);
      box.appendChild(l);
    }
  }
  const rest = {};
  ['summary', 'experience', 'education', 'skills', 'projects', 'certifications'].forEach((k) => {
    rest[k] = profile[k] !== undefined ? profile[k] : (k === 'summary' ? '' : []);
  });
  $('resumeJson').value = JSON.stringify(rest, null, 2);
}

function renderAnswers() {
  const t = $('answers');
  t.textContent = '';
  const keys = Object.keys(answers);
  if (!keys.length) {
    const tr = t.insertRow(); const td = tr.insertCell(); td.className = 'hint';
    td.textContent = 'Nothing yet — answers you give to unfamiliar questions will show up here.';
  }
  keys.forEach((k) => {
    const a = answers[k];
    const tr = t.insertRow();
    const q = tr.insertCell(); q.className = 'q'; q.textContent = a.question;
    const v = tr.insertCell(); const inp = document.createElement('input'); inp.value = a.answer;
    inp.oninput = () => { a.answer = inp.value; };
    v.appendChild(inp);
    const x = tr.insertCell(); x.className = 'x';
    const b = document.createElement('button'); b.textContent = '✕';
    b.onclick = () => { delete answers[k]; renderAnswers(); };
    x.appendChild(b);
  });
}

function setPath(obj, path, val) {
  const [a, b] = path.split('.');
  obj[a] = obj[a] || {};
  obj[a][b] = val;
}

function collect() {
  const p = {};
  document.querySelectorAll('[data-path]').forEach((el) => setPath(p, el.dataset.path, el.value.trim()));
  let rest;
  try { rest = JSON.parse($('resumeJson').value || '{}'); }
  catch (e) { throw new Error('Resume content JSON is invalid: ' + e.message); }
  return Object.assign(p, rest);
}

async function load() {
  const d = await browser.storage.local.get(['profile', 'settings', 'answers', 'resume']);
  profile = d.profile || {};
  answers = d.answers || {};
  resumeFile = d.resume || null;
  const s = Object.assign({}, JobAI.DEFAULTS, d.settings || {});
  for (const k of ['provider', 'geminiKey', 'geminiModel', 'ollamaUrl', 'ollamaModel']) $(k).value = s[k];
  syncProvider();
  $('autoPopup').checked = s.autoPopup !== false;
  buildForm();
  renderAnswers();
  showFile();
}

function showFile() {
  $('resumeFileName').textContent = resumeFile ? `Stored: ${resumeFile.name} (${Math.round(resumeFile.size / 1024)} KB)` : 'No file stored.';
}

$('save').onclick = async () => {
  try {
    const p = collect();
    // keep any answers the user is editing; drop blanks
    for (const k of Object.keys(answers)) if (!String(answers[k].answer).trim()) delete answers[k];
    await browser.storage.local.set({
      profile: p,
      answers,
      resume: resumeFile,
      settings: readSettings()
    });
    profile = p;
    status('Saved.', 'ok');
  } catch (e) { status(e.message, 'err'); }
};

$('parseBtn').onclick = async () => {
  const text = $('resumeText').value.trim();
  const ps = $('parseStatus');
  if (!text) { ps.textContent = 'Paste your resume text first.'; return; }
  // use the key currently typed, even if not saved yet
  await browser.storage.local.set({ settings: readSettings() });
  ps.textContent = 'Parsing...';
  $('parseBtn').disabled = true;
  try {
    const parsed = await JobAI.parseResume(text);
    const existing = collect();
    const merged = Object.assign({}, existing);
    for (const sec of ['personal', 'work']) {
      merged[sec] = Object.assign({}, existing[sec]);
      for (const [k, v] of Object.entries(parsed[sec] || {})) if (v) merged[sec][k] = v;
    }
    ['summary', 'experience', 'education', 'skills', 'projects', 'certifications'].forEach((k) => {
      if (parsed[k] && (typeof parsed[k] === 'string' ? parsed[k] : parsed[k].length)) merged[k] = parsed[k];
    });
    profile = merged;
    buildForm();
    ps.textContent = 'Done — review the sections below, then Save.';
  } catch (e) { ps.textContent = e.message; }
  $('parseBtn').disabled = false;
};

$('resumeFile').onchange = async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const bytes = new Uint8Array(await f.arrayBuffer());
  resumeFile = { name: f.name, type: f.type || 'application/pdf', size: f.size, b64: JobPDF.toBase64(bytes) };
  showFile();
};
$('resumeFileClear').onclick = () => { resumeFile = null; $('resumeFile').value = ''; showFile(); };

$('addAnswer').onclick = () => {
  const q = prompt('Question (as it appears on applications):');
  if (!q) return;
  const k = 'u' + Date.now();
  answers[k] = { question: q, answer: '', kind: 'text', ts: Date.now() };
  renderAnswers();
};

load();

$('provider').onchange = syncProvider;
$('ollamaRefresh').onclick = async () => {
  const ts = $('testStatus');
  try {
    const names = await JobAI.listOllamaModels($('ollamaUrl').value.trim());
    const dl = $('ollamaModels');
    dl.textContent = '';
    names.forEach((n) => { const op = document.createElement('option'); op.value = n; dl.appendChild(op); });
    if (names.length && !names.includes($('ollamaModel').value)) $('ollamaModel').value = names[0];
    ts.textContent = names.length ? `Found ${names.length} model(s).` : 'Connected, but no models installed — run: ollama pull llama3.1:8b';
  } catch (e) { ts.textContent = 'Could not reach Ollama: ' + e.message + ' — is it running? See the steps above.'; }
};
$('testBtn').onclick = async () => {
  const ts = $('testStatus');
  ts.textContent = 'Testing...';
  try {
    await browser.storage.local.set({ settings: readSettings() });
    const p = await JobAI.testConnection();
    ts.textContent = '✓ ' + (p === 'ollama' ? 'Ollama' : 'Gemini') + ' is working.';
  } catch (e) { ts.textContent = e.message; }
};
