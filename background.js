/* Background: runs AI calls and builds the tailored PDF for the content script. */
const safe = (s) => String(s || '').replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '');
const stripProto = (u) => String(u || '').replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '');

async function getProfile() {
  const { profile } = await browser.storage.local.get('profile');
  if (!profile || !profile.personal || !(profile.personal.firstName || profile.personal.email)) {
    throw new Error('Your profile is empty. Open the extension settings and import your resume first.');
  }
  return profile;
}

function buildResumeData(profile, ai) {
  const P = profile.personal || {};
  const contact = [
    [P.city, P.state].filter(Boolean).join(', '),
    P.email, P.phone, stripProto(P.linkedin), stripProto(P.github), stripProto(P.website)
  ].filter(Boolean);

  // Employers, titles, dates, schools and degrees always come from the profile, never from the model.
  const experience = (ai.experience || []).map((x) => {
    const src = (profile.experience || [])[x.source_index];
    if (!src) return null;
    return {
      title: src.title, company: src.company, location: src.location,
      start: src.start, end: src.end,
      bullets: (x.bullets && x.bullets.length ? x.bullets : src.bullets) || []
    };
  }).filter(Boolean);

  const projects = (ai.projects || []).map((x) => {
    const src = (profile.projects || [])[x.source_index];
    if (!src) return null;
    return {
      name: src.name, link: src.link,
      description: x.description || src.description,
      bullets: (x.bullets && x.bullets.length ? x.bullets : src.bullets) || []
    };
  }).filter(Boolean);

  return {
    name: [P.firstName, P.lastName].filter(Boolean).join(' '),
    contact,
    summary: ai.summary || profile.summary || '',
    skills: ai.skills && ai.skills.length ? ai.skills : profile.skills || [],
    experience: experience.length ? experience : profile.experience || [],
    projects,
    education: profile.education || [],
    certifications: profile.certifications || []
  };
}

async function handle(msg) {
  switch (msg.type) {
    case 'cover': {
      const profile = await getProfile();
      return JobAI.coverLetter(profile, msg.job);
    }
    case 'tailor': {
      const profile = await getProfile();
      const ai = await JobAI.tailor(profile, msg.job);
      const data = buildResumeData(profile, ai);
      const bytes = JobPDF.renderResume(data);
      const P = profile.personal || {};
      const filename = [safe(P.firstName), safe(P.lastName), 'Resume', safe(msg.job.company) || 'Tailored']
        .filter(Boolean).join('_') + '.pdf';
      return {
        pdfB64: JobPDF.toBase64(bytes),
        filename,
        matched: ai.ats_keywords_matched || [],
        missing: ai.keywords_missing || [],
        changes: ai.changes || []
      };
    }
    case 'answer': {
      const profile = await getProfile();
      const { answers } = await browser.storage.local.get('answers');
      return JobAI.answerQuestions(profile, msg.job, answers, msg.questions);
    }
    case 'openOptions':
      await browser.runtime.openOptionsPage();
      return { ok: true };
    default:
      return undefined;
  }
}

browser.runtime.onMessage.addListener((msg) => {
  if (!msg || !['cover', 'tailor', 'answer', 'openOptions'].includes(msg.type)) return undefined;
  return handle(msg).catch((e) => ({ error: e.message || String(e) }));
});

browser.commands.onCommand.addListener(async (cmd) => {
  if (cmd !== 'toggle-panel') return;
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab) browser.tabs.sendMessage(tab.id, { type: 'showPanel' }).catch(() => {});
});

// Ollama rejects requests whose Origin is moz-extension://... unless OLLAMA_ORIGINS is configured.
// Drop the Origin header on this extension's own requests to localhost so it works out of the box.
browser.webRequest.onBeforeSendHeaders.addListener(
  (d) => {
    const from = d.originUrl || d.documentUrl || '';
    if (!from.startsWith('moz-extension://')) return {};
    return { requestHeaders: d.requestHeaders.filter((h) => h.name.toLowerCase() !== 'origin') };
  },
  { urls: ['http://localhost/*', 'http://127.0.0.1/*', 'http://[::1]/*'] },
  ['blocking', 'requestHeaders']
);
