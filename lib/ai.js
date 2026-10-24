/* LLM client (Gemini / Ollama) + the "senior recruiter" prompts. Loaded by the background page and the options page. */
(function (root) {
  const DEFAULTS = {
    provider: 'gemini',
    geminiKey: '',
    geminiModel: 'gemini-3.8-flash',
    ollamaUrl: 'http://localhost:11434',
    ollamaModel: 'llama3.1:8b',
    autoPopup: true
  };

  async function getSettings() {
    const { settings } = await browser.storage.local.get('settings');
    const merged = Object.assign({}, DEFAULTS, settings || {});
    // Gemini 2.5 models are discontinued: auto-migrate any saved 2.5 choice to the current default
    if (/^gemini-2\.5/.test(merged.geminiModel)) merged.geminiModel = DEFAULTS.geminiModel;
    return merged;
  }

  async function post(url, headers, body, label) {
    let res;
    try {
      res = await fetch(url, { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, headers), body: JSON.stringify(body) });
    } catch (e) {
      throw new Error(`Could not reach ${label} (${e.message}).`);
    }
    if (!res.ok) {
      let detail = '';
      try { const j = await res.json(); detail = (j.error && (j.error.message || j.error)) || ''; } catch (e) { /* ignore */ }
      if (res.status === 403 && label === 'Ollama') detail = 'Origin blocked. Start Ollama with OLLAMA_ORIGINS=moz-extension://* (see Settings).';
      throw new Error(`${label} error ${res.status}${detail ? ': ' + detail : ''}`);
    }
    return res.json();
  }

  async function callGemini(s, { system, user, maxTokens }) {
    if (!s.geminiKey) throw new Error('No Gemini API key set. Open the extension settings and add one (free at aistudio.google.com/apikey).');
    const model = encodeURIComponent(s.geminiModel || DEFAULTS.geminiModel);
    const j = await post(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      { 'x-goog-api-key': s.geminiKey },
      {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        // extra headroom: Gemini "thinking" tokens count against this limit
        generationConfig: { maxOutputTokens: Math.max(maxTokens || 4000, 4000) + 8000, responseMimeType: 'application/json' }
      },
      'Gemini'
    );
    const c = j.candidates && j.candidates[0];
    if (!c || !c.content) throw new Error('Gemini returned no content' + (j.promptFeedback ? ' (blocked: ' + (j.promptFeedback.blockReason || '?') + ')' : '') + '.');
    return c.content.parts.map((p) => p.text || '').join('');
  }

  async function callOllama(s, { system, user, maxTokens }) {
    const base = (s.ollamaUrl || DEFAULTS.ollamaUrl).replace(/\/+$/, '');
    if (!s.ollamaModel) throw new Error('No Ollama model set in settings.');
    const j = await post(
      base + '/api/chat',
      {},
      {
        model: s.ollamaModel,
        stream: false,
        format: 'json',
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        // Ollama's default context window is tiny and would silently truncate the job description
        options: { num_ctx: 16384, num_predict: Math.max(maxTokens || 4000, 4000) }
      },
      'Ollama'
    );
    return (j.message && j.message.content) || '';
  }

  async function call(req) {
    const s = await getSettings();
    return s.provider === 'ollama' ? callOllama(s, req) : callGemini(s, req);
  }

  async function listOllamaModels(url) {
    const base = (url || DEFAULTS.ollamaUrl).replace(/\/+$/, '');
    const res = await fetch(base + '/api/tags');
    if (!res.ok) throw new Error('Ollama responded ' + res.status);
    const j = await res.json();
    return (j.models || []).map((m) => m.name);
  }

  async function testConnection() {
    const s = await getSettings();
    const t = await call({ system: 'Reply with JSON only.', user: 'Return {"ok":true}', maxTokens: 50 });
    extractJSON(t);
    return s.provider;
  }

  function extractJSON(text) {
    const a = text.indexOf('{'), b = text.lastIndexOf('}');
    if (a < 0 || b < a) throw new Error('The model did not return JSON. Try again.');
    try { return JSON.parse(text.slice(a, b + 1)); }
    catch (e) { throw new Error('Could not parse the model response. Try again.'); }
  }

  const RECRUITER = `You are a senior recruiter with 15+ years of experience placing candidates at companies from early-stage startups to large enterprises. You read a job posting the way a hiring manager and an ATS do: you separate true must-haves from nice-to-haves, work out what problem this hire is really meant to solve, notice seniority signals, and pick out the exact keywords that screening will key on. You are candid about fit and you never invent facts about the candidate. Use ONLY information present in the candidate profile.`;

  function jobBlock(job) {
    return `JOB POSTING
Title: ${job.title || '(unknown)'}
Company: ${job.company || '(unknown)'}
URL: ${job.url || ''}
Description:
${(job.description || '').slice(0, 14000)}`;
  }

  function profileForModel(profile) {
    const p = JSON.parse(JSON.stringify(profile || {}));
    delete p.eeo;
    if (p.work) delete p.work.salaryExpectation;
    if (Array.isArray(p.experience)) p.experience = p.experience.map((e, i) => Object.assign({ source_index: i }, e));
    if (Array.isArray(p.projects)) p.projects = p.projects.map((e, i) => Object.assign({ source_index: i }, e));
    return JSON.stringify(p, null, 1);
  }

  async function coverLetter(profile, job) {
    const user = `${jobBlock(job)}

CANDIDATE PROFILE (the only source of truth):
${profileForModel(profile)}

Do two things as the recruiter:
1. Read the role and assess the candidate's fit honestly.
2. Write a cover letter the candidate can paste into an application.

Cover letter rules:
- 250-330 words, 3-4 short paragraphs, plain text (no markdown), addressed "Dear Hiring Team," unless a hiring manager's name appears in the posting.
- Open with a specific, credible hook about the company or the problem the role solves. Never open with "I am writing to apply".
- Tie 2-3 concrete achievements or experiences from the profile directly to the role's must-haves. Use real numbers only if they are in the profile.
- Handle the biggest gap honestly through transferable experience; do not hide it, do not apologise.
- Close with a confident, specific call to action. Sign off with the candidate's full name.
- No clichés ("passionate", "team player", "fast-paced", "rockstar"), no bracketed placeholders, no invented facts, employers, tools or metrics.

Return ONLY a JSON object, no prose, with this shape:
{"role_read":{"summary":"2 sentences on what this hire must actually accomplish","must_haves":["..."],"keywords":["ATS keywords from the posting"]},
 "fit":{"score":0-100,"strengths":["..."],"gaps":["..."],"positioning":"1-2 sentences: the angle the candidate should lead with"},
 "cover_letter":"the full letter text with \\n line breaks"}`;
    const text = await call({ system: RECRUITER, user, maxTokens: 3500 });
    return extractJSON(text);
  }

  async function tailor(profile, job) {
    const user = `${jobBlock(job)}

CANDIDATE PROFILE (the only source of truth; entries carry a source_index):
${profileForModel(profile)}

Tailor the candidate's resume for this exact role, the way a senior recruiter would coach them.

Hard rules:
- NEVER invent or alter employers, job titles, dates, degrees, schools, certifications, tools, or metrics. You may reorder, reword, merge, trim and emphasise what is in the profile, and mirror the posting's terminology ONLY where it truthfully describes the candidate's work.
- Lead each role's bullets with the work that matters most for this posting. Strong verb first, outcome/impact next, numbers only if in the profile. 2-5 bullets per role (fewer for older roles). Keep bullets under ~28 words.
- Write a 2-3 sentence professional summary aimed at this role, grounded in the profile.
- Skills: group into 3-5 short categories, putting skills the posting asks for first. Only include skills evidenced in the profile.
- Include every experience entry from roughly the last 10 years, in the original order, referenced by source_index. Include only the most relevant projects (0-3) by source_index.
- Target one page.

Return ONLY a JSON object, no prose:
{"summary":"...",
 "skills":[{"category":"...","items":["..."]}],
 "experience":[{"source_index":0,"bullets":["..."]}],
 "projects":[{"source_index":0,"description":"optional one line","bullets":["..."]}],
 "ats_keywords_matched":["..."],
 "keywords_missing":["posting keywords the candidate genuinely lacks"],
 "changes":["short notes on what you emphasised or changed and why"]}`;
    const text = await call({ system: RECRUITER, user, maxTokens: 5000 });
    return extractJSON(text);
  }


  async function answerQuestions(profile, job, savedAnswers, questions) {
    const saved = Object.values(savedAnswers || {}).slice(0, 40).map((a) => ({ question: a.question, answer: a.answer }));
    const user = `You are completing a job application on behalf of the candidate, writing in the first person as them.

${jobBlock(job)}

CANDIDATE PROFILE (the only source of truth about the candidate):
${profileForModel(profile)}

ANSWERS THE CANDIDATE GAVE ON PREVIOUS APPLICATIONS (reuse their facts and tone):
${JSON.stringify(saved)}

QUESTIONS TO ANSWER:
${JSON.stringify(questions)}

Rules:
- Each question has an id, a type (text, textarea, choice, yesno, checkbox) and sometimes options. For choice questions the answer MUST be exactly one of the given options. For yesno answer exactly "Yes" or "No".
- Base every answer on the profile, previous answers and posting. NEVER invent facts, employers, numbers, credentials or experience. If a yes/no or factual answer cannot be determined from what you were given, set "needs_user": true, leave "answer" empty and give a short "reason".
- Always set "needs_user": true (empty answer) for: agreeing to legal terms, arbitration, consent, signatures, attestations, background-check or criminal-history questions, and anything about prior employment/interviews at this company that the profile does not state.
- Demographic / voluntary self-identification questions: answer only if the profile has the value; otherwise choose the "decline / prefer not to say" option if one exists.
- Free-text "why this company / role" questions: 70-140 words, specific to the posting, tied to 1-2 real strengths from the profile, no clichés, no placeholders. Short text fields: one line.
- Salary: only use the profile's value; if absent, needs_user.

Return ONLY JSON: {"answers":[{"id":0,"answer":"...","needs_user":false,"reason":""}]}`;
    const text = await call({ system: RECRUITER, user, maxTokens: 4000 });
    return extractJSON(text);
  }

  async function parseResume(resumeText) {
    const user = `Convert this resume into structured JSON. Copy facts faithfully; do not invent anything. Use "" or [] when something is not present. Keep each bullet as written (lightly cleaned). Dates as written (e.g. "Jan 2021", "Present").

RESUME TEXT:
${resumeText.slice(0, 30000)}

Return ONLY JSON of this shape:
{"personal":{"firstName":"","lastName":"","email":"","phone":"","city":"","state":"","zip":"","country":"","address":"","linkedin":"","github":"","website":""},
 "work":{"currentCompany":"","currentTitle":"","yearsExperience":""},
 "summary":"",
 "experience":[{"company":"","title":"","location":"","start":"","end":"","bullets":[""]}],
 "education":[{"school":"","degree":"","field":"","start":"","end":"","gpa":""}],
 "skills":[{"category":"","items":[""]}],
 "projects":[{"name":"","link":"","description":"","bullets":[""]}],
 "certifications":[""]}`;
    const text = await call({
      system: 'You are a precise resume parser. You output only valid JSON.',
      user,
      maxTokens: 8000
    });
    return extractJSON(text);
  }

  root.JobAI = { getSettings, DEFAULTS, listOllamaModels, testConnection, coverLetter, tailor, parseResume, answerQuestions };
})(typeof self !== 'undefined' ? self : globalThis);
