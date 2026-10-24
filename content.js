/* Job Copilot content script: detects applications, autofills, learns answers, hosts the assistant panel. */
(() => {
  if (window.__jobCopilotLoaded) return;
  window.__jobCopilotLoaded = true;

  const store = browser.storage.local;
  const isTop = window === window.top;
  const state = { profile: null, answers: {}, settings: {}, resume: null, coverLetter: '', tailored: null, job: null };

  // ───────────────────────── utilities ─────────────────────────
  const clean = (s) => (s || '').replace(/[*✱]/g, ' ').replace(/\s+/g, ' ').trim();
  const norm = (s) => clean(s).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const STOP = new Set('the a an of to you your do does are is will would please for in this that and or be we our with on if any have has can as at by it me my i'.split(' '));
  const qkey = (s) => norm(s).split(' ').filter((w) => w && !STOP.has(w)).join(' ');
  const splitCamel = (s) => (s || '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_\-\[\].]+/g, ' ');
  function sim(a, b) {
    const A = new Set(a.split(' ')), B = new Set(b.split(' '));
    let i = 0;
    A.forEach((w) => B.has(w) && i++);
    return i / (A.size + B.size - i || 1);
  }
  const US = { AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming', DC: 'District of Columbia' };

  function visible(el) {
    if (!el.getClientRects().length) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  }

  async function loadState() {
    const d = await store.get(['profile', 'answers', 'settings', 'resume']);
    state.profile = d.profile || null;
    state.answers = d.answers || {};
    state.settings = d.settings || {};
    state.resume = d.resume || null;
  }

  // ───────────────────────── labels & questions ─────────────────────────
  function textOfLabel(l) {
    const c = l.cloneNode(true);
    c.querySelectorAll('input,select,textarea,button,script,style').forEach((n) => n.remove());
    return clean(c.textContent);
  }

  // Nearest meaningful text node that precedes `el` inside its closest wrapper ancestors.
  function preText(el, levels, maxInputs) {
    let node = el;
    for (let i = 0; i < levels; i++) {
      node = node.parentElement;
      if (!node || node === document.body) break;
      if (node.querySelectorAll('input,select,textarea').length > maxInputs) break;
      const tw = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
      let last = '';
      while (tw.nextNode()) {
        const t = tw.currentNode;
        if (el.compareDocumentPosition(t) & Node.DOCUMENT_POSITION_FOLLOWING) break;
        if (el.contains(t) || t.parentElement.closest('script,style,option,button')) continue;
        const txt = clean(t.nodeValue);
        if (txt.length > 1) last = txt;
      }
      if (last) return last.slice(0, 250);
    }
    return '';
  }

  function labelOf(el) {
    const ids = el.getAttribute('aria-labelledby');
    if (ids) {
      const t = clean(ids.split(/\s+/).map((id) => (document.getElementById(id) || {}).textContent || '').join(' '));
      if (t) return t;
    }
    if (el.labels && el.labels.length) {
      const t = clean([...el.labels].map(textOfLabel).join(' '));
      if (t) return t;
    }
    const al = el.getAttribute('aria-label');
    if (al && clean(al)) return clean(al);
    const wrap = el.closest('label');
    if (wrap) { const t = textOfLabel(wrap); if (t) return t; }
    const pre = preText(el, 3, 1);
    if (pre) return pre;
    return clean(el.getAttribute('placeholder') || el.getAttribute('title') || '');
  }

  function optionLabel(el) {
    if (el.labels && el.labels.length) { const t = textOfLabel(el.labels[0]); if (t) return t; }
    const wrap = el.closest('label');
    if (wrap) { const t = textOfLabel(wrap); if (t) return t; }
    const n = el.nextSibling;
    if (n && n.nodeType === 3 && clean(n.nodeValue)) return clean(n.nodeValue);
    if (el.nextElementSibling && clean(el.nextElementSibling.textContent).length < 80) return clean(el.nextElementSibling.textContent);
    return clean(el.getAttribute('aria-label') || el.value || '');
  }

  function groupQuestion(els) {
    const el = els[0];
    const fs = el.closest('fieldset');
    const leg = fs && fs.querySelector('legend');
    if (leg && clean(leg.textContent)) return clean(leg.textContent);
    const grp = el.closest('[role=radiogroup],[role=group]');
    if (grp) {
      const ids = grp.getAttribute('aria-labelledby');
      const t = ids ? clean(ids.split(/\s+/).map((id) => (document.getElementById(id) || {}).textContent || '').join(' ')) : clean(grp.getAttribute('aria-label'));
      if (t) return t;
    }
    return preText(el, 6, els.length + 1);
  }

  // ───────────────────────── field model ─────────────────────────
  function yesNoGroups() {
    const byParent = new Map();
    document.querySelectorAll('button').forEach((b) => {
      if (b.closest('#jc-host') || b.disabled) return;
      const t = clean(b.textContent).toLowerCase();
      if (t !== 'yes' && t !== 'no') return;
      const p = b.parentElement;
      if (!byParent.has(p)) byParent.set(p, {});
      byParent.get(p)[t] = b;
    });
    const out = [];
    byParent.forEach((g) => { if (g.yes && g.no && g.yes.getClientRects().length) out.push({ kind: 'yesno', els: [g.yes, g.no] }); });
    return out;
  }
  const btnOn = (b) => b.getAttribute('aria-pressed') === 'true' || b.getAttribute('aria-checked') === 'true' || /(^|[\s_-])(active|selected|checked|pressed)/i.test(b.className || '');
  const isCombo = (el) => el.getAttribute('role') === 'combobox' || /select__input|react-select/.test(el.className || '') || el.getAttribute('aria-haspopup') === 'listbox';
  function collectFields() {
    const all = [...document.querySelectorAll('input,textarea,select')].filter((el) => {
      if (el.disabled) return false;
      const t = (el.type || '').toLowerCase();
      if (['hidden', 'submit', 'button', 'image', 'reset', 'password', 'search', 'range', 'color'].includes(t)) return false;
      if (['radio', 'checkbox', 'file'].includes(t)) return true;
      if (el.readOnly && !isCombo(el)) return false; // readonly inputs are often custom dropdown triggers
      if (el.getAttribute('aria-hidden') === 'true') return false; // react-select's hidden validation twin
      return visible(el);
    });
    const seen = new Set();
    const fields = [];
    fields.push(...yesNoGroups());
    for (const el of all) {
      const t = (el.type || '').toLowerCase();
      if (t === 'radio') {
        const grp = el.name ? all.filter((e) => e.type === 'radio' && e.name === el.name && e.form === el.form) : [el];
        const key = (el.name || '') + '|' + (el.form ? [...document.forms].indexOf(el.form) : -1);
        if (el.name) { if (seen.has(key)) continue; seen.add(key); }
        fields.push({ kind: 'radio', els: grp });
      } else if (t === 'checkbox') {
        if (el.tabIndex === -1 && el.parentElement && el.parentElement.querySelector('button')) continue; // hidden twin of a yes/no button pair
        const same = el.name ? all.filter((e) => e.type === 'checkbox' && e.name === el.name && e.form === el.form) : [el];
        if (same.length > 1) continue; // multi-select groups are left to the user
        fields.push({ kind: 'checkbox', els: [el] });
      } else if (t === 'file') fields.push({ kind: 'file', els: [el] });
      else if (el.tagName === 'SELECT') fields.push({ kind: 'select', els: [el] });
      else if (el.tagName === 'TEXTAREA') fields.push({ kind: 'textarea', els: [el] });
      else if (isCombo(el)) fields.push({ kind: 'combo', els: [el] });
      else fields.push({ kind: 'text', els: [el] });
    }
    // non-input dropdown triggers (button / div role=combobox, Workday, MUI, Radix...)
    document.querySelectorAll('button[aria-haspopup],[role=combobox]:not(input):not(select),[aria-haspopup=listbox]:not(input):not(select)').forEach((el) => {
      if (el.closest('#jc-host') || el.disabled || el.getAttribute('aria-disabled') === 'true') return;
      if (el.getAttribute('aria-haspopup') === 'dialog' || el.getAttribute('aria-haspopup') === 'menu' && !/select|choose|option/i.test(el.textContent)) return;
      if (!el.getClientRects().length || el.querySelector('input:not([type=hidden])')) return;
      if (fields.some((f) => f.els.some((e) => e === el || e.contains(el) || el.contains(e)))) return;
      fields.push({ kind: 'combo', els: [el] });
    });
    return fields;
  }

  function describe(f) {
    const el = f.els[0];
    let question, extra = '';
    if (f.kind === 'yesno') { const q = preText(el, 6, 100); return { question: clean(q), sig: norm(q), nameSig: '', label: norm(q), ac: '' }; }
    if (f.kind === 'yesno') question = preText(f.els[0], 6, 100);
    else if (f.kind === 'radio') question = groupQuestion(f.els);
    else question = labelOf(el);
    if (f.kind === 'yesno') extra = '';
    else if (f.kind !== 'radio') extra = [el.getAttribute('autocomplete'), el.getAttribute('placeholder'), splitCamel(el.name), splitCamel(el.id), el.getAttribute('aria-label')].join(' ');
    else extra = splitCamel(el.name);
    const sig = norm(question + ' ' + extra);
    const nameSig = norm(splitCamel(el.name) + ' ' + splitCamel(el.id));
    return { question: clean(question), sig, nameSig, label: norm(question), ac: (el.getAttribute('autocomplete') || '').toLowerCase() };
  }

  function required(f) {
    const el = f.els[0];
    return f.els.some((e) => e.required || e.getAttribute('aria-required') === 'true') || /\*/.test(el.labels && el.labels[0] ? el.labels[0].textContent : '');
  }

  // ───────────────────────── matching profile fields ─────────────────────────
  const AC = { 'given-name': 'firstName', 'family-name': 'lastName', name: 'fullName', email: 'email', tel: 'phone', 'tel-national': 'phone', 'postal-code': 'zip', 'address-level2': 'city', 'address-level1': 'state', country: 'country', 'country-name': 'country', 'street-address': 'address', 'address-line1': 'address', organization: 'currentCompany', 'organization-title': 'currentTitle', url: 'website' };
  // [key, regex, shortOnly]  — order matters (specific → generic)
  const RULES = [
    ['authorizedToWork', /(authori[sz]ed|eligible|permitted|allowed|legally) (to )?work|work authori[sz]ation|right to work/],
    ['requiresSponsorship', /sponsor|\bvisa\b/],
    ['willingToRelocate', /relocat/],
    ['gender', /\bgender\b|\bsex\b/],
    ['pronouns', /pronoun/],
    ['ethnicity', /\brace\b|ethnic|hispanic|latino/],
    ['veteran', /veteran|military/],
    ['disability', /disabilit/],
    ['salaryExpectation', /salary|compensation|pay expectation|desired pay|expected (pay|base)|remuneration/],
    ['noticePeriod', /notice period|earliest.*start|available to start|when (can|could) you (start|join)|start date/],
    ['yearsExperience', /years? of (\w+ ){0,2}experience|how many years|total experience|experience in years/],
    ['coverLetterText', /cover letter/],
    ['linkedin', /linked ?in/],
    ['github', /git ?hub/],
    ['website', /portfolio|personal (web ?)?site|website|web site|\bblog\b|other url|\burl\b|homepage/, true],
    ['email', /e ?-?mail/, true],
    ['phone', /phone|mobile|\bcell\b|telephone|\btel\b/, true],
    ['firstName', /\b(first|given|fore) ?name\b|^first$|preferred (first )?name|nickname/, true],
    ['lastName', /\b(last|family|sur) ?name\b|^last$/, true],
    ['fullName', /\bfull ?name\b|\blegal name\b|^(your |candidate )?name$/, true],
    ['currentCompany', /current (company|employer|organi[sz]ation)|present employer|most recent (company|employer)|employer name/, true],
    ['currentTitle', /current (job )?(title|position|role)|job title|most recent (job )?(title|position)/, true],
    ['location', /current location|where (are you|do you) (located|live|based)|^location|city.*state|location \(city\)/, true],
    ['city', /\bcity\b|\btown\b/, true],
    ['zip', /\bzip\b|postal|post code/, true],
    ['country', /\bcountry\b/, true], // before state so "Country/Region" isn't read as state
    ['state', /\b(state|province|region)\b/, true],
    ['address', /street|address ?(line)? ?1?|mailing address|home address/, true],
    ['school', /school|university|college|institution/, true],
    ['degree', /\bdegree\b/, true],
    ['fieldOfStudy', /\bmajor\b|field of study|discipline|area of study/, true],
    ['gpa', /\bgpa\b|grade point/, true],
    ['gradYear', /graduat|year of completion/, true]
  ];

  function profileKeyFor(f, d) {
    if (f.kind === 'file' || f.kind === 'checkbox') return null;
    if (f.kind === 'yesno') { for (const [k, re] of RULES.slice(0, 3)) if (re.test(d.sig)) return k; return null; }
    if (d.ac && AC[d.ac.split(' ').pop()]) return AC[d.ac.split(' ').pop()];
    const longLabel = d.label.length > 70;
    for (const [key, re, shortOnly] of RULES) {
      if (shortOnly && longLabel && !re.test(d.nameSig || '')) continue;
      // anchored rules (^first$, ^name$ ...) must also be tried on the bare label, since sig has name/id/placeholder appended
      if (re.test(d.sig) || re.test(d.label)) return key;
    }
    return null;
  }

  function profileValue(key) {
    const p = state.profile;
    if (!p) return '';
    const P = p.personal || {}, W = p.work || {}, E = p.eeo || {}, ed = (p.education || [])[0] || {};
    switch (key) {
      case 'fullName': return [P.firstName, P.lastName].filter(Boolean).join(' ');
      case 'location': return [P.city, P.state].filter(Boolean).join(', ');
      case 'school': return ed.school || '';
      case 'degree': return ed.degree || '';
      case 'fieldOfStudy': return ed.field || '';
      case 'gpa': return ed.gpa || '';
      case 'gradYear': return (String(ed.end || '').match(/\d{4}/) || [''])[0];
      case 'coverLetterText': return state.coverLetter || '';
      default: return P[key] || W[key] || E[key] || '';
    }
  }

  function findSaved(question) {
    const k = qkey(question);
    if (!k) return null;
    let best = null, bs = 0;
    for (const a of Object.values(state.answers)) {
      const s = sim(k, qkey(a.question));
      if (s > bs) { bs = s; best = a; }
    }
    return bs >= 0.72 ? best : null;
  }

  // ───────────────────────── filling ─────────────────────────
  function fire(el, types) {
    for (const t of types) el.dispatchEvent(new Event(t, { bubbles: true }));
  }
  function setNative(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, value);
  }

  function matchOption(texts, value) {
    let v = norm(value);
    if (!v) return -1;
    const T = texts.map(norm);
    const tryFind = (fn) => T.findIndex((t, i) => t && fn(t, i));
    let i = tryFind((t) => t === v);
    if (i >= 0) return i;
    if (/^(yes|true|y)$/.test(v)) { i = tryFind((t) => /^yes\b/.test(t)); if (i >= 0) return i; }
    if (/^(no|false|n)$/.test(v)) { i = tryFind((t) => /^no\b/.test(t)); if (i >= 0) return i; }
    if (/^(decline|prefer not|i don t wish|not specified)/.test(v)) {
      i = tryFind((t) => /decline|prefer not|do not wish|don t wish|not (want|wish) to|choose not|not disclose/.test(t));
      if (i >= 0) return i;
    }
    if (/^(us|usa|u s a?|united states( of america)?|america)$/.test(v)) { i = tryFind((t) => /^(us|usa|united states( of america)?)\b/.test(t)); if (i >= 0) return i; }
    if (/^(uk|gb|great britain|united kingdom)$/.test(v)) { i = tryFind((t) => /^(uk|united kingdom|great britain)\b/.test(t)); if (i >= 0) return i; }
    const up = value.trim().toUpperCase();
    if (US[up]) { i = tryFind((t) => t === norm(US[up])); if (i >= 0) return i; }
    for (const [ab, full] of Object.entries(US)) if (norm(full) === v) { i = tryFind((t) => t === ab.toLowerCase()); if (i >= 0) return i; }
    i = tryFind((t) => t.startsWith(v) || v.startsWith(t));
    if (i >= 0) return i;
    i = tryFind((t) => t.includes(v) || (t.length > 3 && v.includes(t)));
    return i;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const mouse = (el, type) => el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, button: 0 }));
  const key = (el, k, code) => el.dispatchEvent(new KeyboardEvent('keydown', { key: k, code: code || k, bubbles: true, cancelable: true }));

  function comboRoot(el) {
    return el.closest('[class*="select__control"]') ? el.closest('[class*="select__control"]').parentElement : (el.closest('[class*="container"],[class*="select"]') || el.parentElement);
  }
  const PLACEHOLDER = /^(select|choose|please|pick|--|—|search)/i;
  function comboValue(el) {
    if (el.tagName !== 'INPUT') { const t = clean(el.textContent); return t && !PLACEHOLDER.test(t) ? t : ''; }
    const r = comboRoot(el);
    if (!r) return '';
    const v = r.querySelector('[class*="single-value"],[class*="multi-value__label"],[class*="singleValue"]');
    return v ? clean(v.textContent) : (el.readOnly && el.value && !PLACEHOLDER.test(el.value) ? el.value : '');
  }
  function visibleOptions(el) {
    const lbId = el.getAttribute('aria-controls') || el.getAttribute('aria-owns');
    let scope = lbId && document.getElementById(lbId);
    let opts = scope ? [...scope.querySelectorAll('[role=option]')] : [];
    if (!opts.length) {
      const r = comboRoot(el);
      opts = [...((r && r.querySelectorAll('[role=option],[class*="option"]')) || [])];
    }
    if (!opts.length) opts = [...document.querySelectorAll('[role=listbox] [role=option],[role=listbox] li,[role=option],[role=menuitem],[role=menuitemradio],[class*="select__menu"] [class*="select__option"]')];
    return opts.filter((o) => o.getClientRects().length && clean(o.textContent));
  }
  async function fillCombo(el, value) {
    el.focus();
    const ctl = el.closest('[class*="select__control"]') || el.parentElement || el;
    const open = async () => {
      mouse(ctl, 'mousedown'); mouse(ctl, 'mouseup');
      if (el.tagName !== 'INPUT' || el.readOnly) el.click();
      key(el, 'ArrowDown', 'ArrowDown');
      for (let i = 0; i < 12; i++) { await sleep(60); if (visibleOptions(el).length) return true; }
      return false;
    };
    const choose = () => {
      const opts = visibleOptions(el);
      const idx = matchOption(opts.map((o) => clean(o.textContent)), value);
      if (idx < 0) return false;
      const o = opts[idx];
      mouse(o, 'mouseover'); mouse(o, 'mousemove'); mouse(o, 'mousedown'); mouse(o, 'mouseup'); mouse(o, 'click');
      return true;
    };
    let ok = false;
    if (await open() && choose()) ok = true;
    if (!ok && el.tagName === 'INPUT' && !el.readOnly) {
      // large lists (country, school...) need typing to filter
      setNative(el, String(value));
      fire(el, ['input']);
      for (let i = 0; i < 12 && !ok; i++) { await sleep(80); if (visibleOptions(el).length && choose()) ok = true; }
    }
    await sleep(60);
    if (!ok) { if (el.tagName === 'INPUT' && !el.readOnly) { setNative(el, ''); fire(el, ['input']); } key(el, 'Escape', 'Escape'); }
    el.blur();
    return ok;
  }

  async function pickSuggestion(el) {
    for (let i = 0; i < 10; i++) {
      await sleep(120);
      const o = [...document.querySelectorAll('[role=option], [class*="dropdown-results"] > *, .dropdown-location, [class*="autocomplete"] li, [class*="suggest"] li, .pac-item')]
        .find((n) => n.getClientRects().length && clean(n.textContent) && !/no location found/i.test(n.textContent));
      if (o) { mouse(o, 'mousedown'); mouse(o, 'mouseup'); mouse(o, 'click'); return; }
    }
  }

  async function fillField(f, value, keepFocus) {
    const el = f.els[0];
    value = String(value);
    if (f.kind === 'combo') return fillCombo(el, value);
    if (f.kind === 'yesno') {
      const idx = matchOption(['yes', 'no'], value);
      if (idx < 0) return false;
      if (!btnOn(f.els[idx])) f.els[idx].click();
      return true;
    }
    if (f.kind === 'text' || f.kind === 'textarea') {
      if (el.type === 'number') value = value.replace(/[^\d.]/g, '');
      if (!value) return false;
      el.focus();
      setNative(el, value);
      try { el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value })); } catch (e) { fire(el, ['input']); }
      fire(el, ['change']);
      if (keepFocus) { el.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true })); el.dispatchEvent(new KeyboardEvent('keyup', { key: 'a', bubbles: true })); }
      // frameworks (React/Vue) can discard or re-render away a programmatic value: verify, then retry as real typed input
      await sleep(50);
      if (el.value !== value && !keepFocus) {
        el.focus();
        try { el.select(); document.execCommand('insertText', false, value); } catch (e) { /* ignore */ }
        if (el.value !== value) { setNative(el, value); fire(el, ['input', 'change']); }
      }
      if (!keepFocus) el.blur();
      return true;
    }
    if (f.kind === 'select') {
      const opts = [...el.options];
      const idx = matchOption(opts.map((o) => o.textContent), value);
      const alt = idx >= 0 ? idx : opts.findIndex((o) => o.value && norm(o.value) === norm(value));
      if (alt < 0) return false;
      setNative(el, opts[alt].value);
      fire(el, ['input', 'change']);
      return true;
    }
    if (f.kind === 'radio') {
      const idx = matchOption(f.els.map(optionLabel), value);
      if (idx < 0) return false;
      const r = f.els[idx];
      r.click();
      if (!r.checked) { r.checked = true; fire(r, ['input', 'change']); }
      return true;
    }
    if (f.kind === 'checkbox') {
      const want = /^(yes|true|y|checked|1)$/i.test(value.trim());
      if (el.checked !== want) el.click();
      return true;
    }
    return false;
  }

  function hasValue(f) {
    const el = f.els[0];
    if (f.kind === 'radio') return f.els.some((r) => r.checked);
    if (f.kind === 'checkbox') return el.checked;
    if (f.kind === 'select') return el.selectedIndex > 0 && !!el.value;
    if (f.kind === 'combo') return !!comboValue(el);
    if (f.kind === 'yesno') return f.els.some(btnOn);
    return !!el.value.trim();
  }

  function b64ToFile(b64, name, type) {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new File([arr], name, { type: type || 'application/pdf' });
  }
  function attachFile(input, file) {
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    fire(input, ['input', 'change']);
  }
  function resumeInputs() {
    return collectFields().filter((f) => {
      if (f.kind !== 'file') return false;
      const d = describe(f);
      const s = d.sig + ' ' + norm(f.els[0].name + ' ' + f.els[0].id);
      if (/cover/.test(s)) return false;
      return true;
    });
  }
  function attachResume(which) {
    const src = which === 'tailored' && state.tailored
      ? { name: state.tailored.filename, b64: state.tailored.pdfB64, type: 'application/pdf' }
      : state.resume;
    if (!src) return 0;
    let n = 0;
    for (const f of resumeInputs()) {
      if (f.els[0].files && f.els[0].files.length) continue;
      try { attachFile(f.els[0], b64ToFile(src.b64, src.name, src.type)); n++; } catch (e) { /* page rejected it */ }
    }
    return n;
  }

  // ───────────────────────── autofill ─────────────────────────
  let lastUnknown = [];
  function markUnknown(f, on) {
    const t = f.kind === 'radio' ? f.els[0].closest('fieldset,[role=radiogroup],div') || f.els[0] : f.els[0];
    if (on) { t.dataset.jcPrevOutline = t.style.outline; t.style.outline = '2px solid #f5a623'; t.style.outlineOffset = '2px'; }
    else if (t.dataset.jcPrevOutline !== undefined) { t.style.outline = t.dataset.jcPrevOutline; delete t.dataset.jcPrevOutline; }
  }

  async function autofill(opts) {
    opts = opts || {};
    const res = { filled: 0, saved: 0, unknown: [], attached: 0 };
    lastUnknown.forEach((u) => markUnknown(u.f, false));
    lastUnknown = [];
    const written = [];
    for (const f of collectFields()) {
      if (f.kind === 'file') continue;
      const d = describe(f);
      if (opts.only && profileKeyFor(f, d) !== opts.only) continue;
      if (hasValue(f) && !opts.overwrite) continue;
      let value = '';
      const key = profileKeyFor(f, d);
      if (key) value = profileValue(key);
      let from = value ? 'profile' : '';
      if (!value && d.question.length >= 3) {
        const saved = findSaved(d.question);
        if (saved) { value = saved.answer; from = 'saved'; }
      }
      const auto = key === 'location' || key === 'city';
      if (value && await fillField(f, value, auto)) {
        if (auto) { await pickSuggestion(f.els[0]); f.els[0].blur(); }
        if (from === 'saved') res.saved++; else res.filled++;
        written.push({ f, value, from });
        continue;
      }
      if (opts.only) continue;
      // never guess: unmatched questions (incl. consent checkboxes) are listed for the user to answer once
      if (d.question.length >= 3) lastUnknown.push({ f, d });
    }
    // second pass: re-apply anything the page wiped after we filled it (late re-render / state reset)
    await sleep(400);
    for (const r of written) {
      if (hasValue(r.f)) continue;
      if (await fillField(r.f, r.value, false) && hasValue(r.f)) continue;
      res[r.from === 'saved' ? 'saved' : 'filled']--;
    }
    lastUnknown.sort((a, b) => required(b.f) - required(a.f));
    lastUnknown.forEach((u) => markUnknown(u.f, true));
    res.unknown = lastUnknown;
    if (!opts.only && opts.attach !== false) res.attached = attachResume(state.tailored ? 'tailored' : 'base');
    return res;
  }

  // ───────────────────────── learning ─────────────────────────
  document.addEventListener('click', (e) => {
    if (!e.isTrusted || !(e.target instanceof Element)) return;
    const b = e.target.closest('button');
    if (!b || b.closest('#jc-host')) return;
    const t = clean(b.textContent).toLowerCase();
    if (t !== 'yes' && t !== 'no') return;
    const g = yesNoGroups().find((x) => x.els.includes(b));
    if (!g) return;
    const d = describe(g);
    if (d.question.length < 3 || d.question.length > 300 || profileKeyFor(g, d)) return;
    remember(d.question, t === 'yes' ? 'Yes' : 'No', 'yesno');
  }, true);
  document.addEventListener('focusout', (e) => {
    const el = e.target;
    if (!e.isTrusted || !(el instanceof HTMLInputElement) || !isCombo(el)) return;
    setTimeout(() => {
      const f = { kind: 'combo', els: [el] };
      const d = describe(f);
      const ans = comboValue(el);
      if (!ans || d.question.length < 3 || d.question.length > 300 || profileKeyFor(f, d)) return;
      remember(d.question, ans, 'combo');
    }, 250);
  }, true);

  function fieldFromElement(el) {
    const t = (el.type || '').toLowerCase();
    if (t === 'radio') {
      const grp = el.name ? [...document.querySelectorAll('input[type=radio]')].filter((e) => e.name === el.name && e.form === el.form) : [el];
      return { kind: 'radio', els: grp };
    }
    if (t === 'checkbox') return { kind: 'checkbox', els: [el] };
    if (['file', 'password', 'hidden', 'submit', 'button'].includes(t)) return null;
    return { kind: el.tagName === 'SELECT' ? 'select' : el.tagName === 'TEXTAREA' ? 'textarea' : 'text', els: [el] };
  }
  function currentAnswer(f) {
    const el = f.els[0];
    if (f.kind === 'radio') { const r = f.els.find((x) => x.checked); return r ? optionLabel(r) : ''; }
    if (f.kind === 'checkbox') return el.checked ? 'Yes' : 'No';
    if (f.kind === 'select') return el.selectedIndex > 0 ? clean(el.options[el.selectedIndex].textContent) : '';
    return el.value.trim();
  }
  async function remember(question, answer, kind) {
    const k = qkey(question);
    if (!k || !answer) return;
    await loadState();
    state.answers[k] = { question: clean(question).slice(0, 300), answer, kind: kind || 'text', ts: Date.now() };
    await store.set({ answers: state.answers });
    flashLearned();
  }
  document.addEventListener('change', (e) => {
    if (!e.isTrusted || !(e.target instanceof HTMLElement) || !/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    const f = fieldFromElement(e.target);
    if (!f) return;
    const d = describe(f);
    if (d.question.length < 3 || d.question.length > 300) return;
    if (profileKeyFor(f, d)) return; // profile is the source of truth for these
    if (/^(email|tel|url)$/.test(e.target.type)) return;
    const ans = currentAnswer(f);
    if (!ans || ans.length > 3000) return;
    remember(d.question, ans, f.kind);
    // if this answers an item in the unknown list, drop it
    lastUnknown = lastUnknown.filter((u) => { if (u.f.els[0] === f.els[0]) { markUnknown(u.f, false); return false; } return true; });
    renderUnknown();
  }, true);

  // ───────────────────────── job scraping & detection ─────────────────────────
  const ATS = /(greenhouse\.io|lever\.co|myworkdayjobs\.com|myworkdaysite\.com|workday\.com|ashbyhq\.com|smartrecruiters\.com|workable\.com|icims\.com|jobvite\.com|bamboohr\.com|taleo\.net|successfactors\.(com|eu)|recruitee\.com|breezy\.hr|jazz(hr)?\.com|applytojob\.com|teamtailor\.com|pinpointhq\.com|dayforcehiring|paylocity\.com|paycomonline|eightfold\.ai|avature\.net|ultipro\.com|oraclecloud\.com|rippling\.com)/i;

  function htmlToText(html) {
    return String(html || '').replace(/<\s*(br|\/p|\/li|\/div|\/h\d)\s*\/?>/gi, '\n').replace(/<li[^>]*>/gi, '- ').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\n{3,}/g, '\n\n').trim();
  }
  const tidy = (t) => String(t || '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

  function jsonLdJob() {
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const j = JSON.parse(s.textContent);
        const arr = Array.isArray(j) ? j : j['@graph'] || [j];
        for (const o of arr) {
          if (o && [].concat(o['@type'] || []).join(',').includes('JobPosting')) {
            return { title: o.title || '', company: (o.hiringOrganization && o.hiringOrganization.name) || '', description: htmlToText(o.description) };
          }
        }
      } catch (e) { /* ignore */ }
    }
    return null;
  }

  function guessCompany() {
    const m = document.querySelector('meta[property="og:site_name"]');
    const seg = location.pathname.split('/').filter(Boolean)[0];
    if (/greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|smartrecruiters\.com|recruitee\.com|breezy\.hr/.test(location.hostname) && seg) return seg.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    if (/myworkdayjobs\.com/.test(location.hostname)) return location.hostname.split('.')[0].replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    if (m && m.content) return m.content.trim();
    const parts = document.title.split(/\s[-|–—@]\s|\sat\s/i);
    return parts.length > 1 ? parts[parts.length - 1].trim() : '';
  }

  function jobCacheKey() {
    return location.origin + location.pathname.replace(/\/(apply|application)(\/.*)?$/i, '').replace(/\/$/, '');
  }

  function scrapeJob() {
    const ld = jsonLdJob();
    let title = (ld && ld.title) || '', company = (ld && ld.company) || '', desc = (ld && ld.description) || '';
    if (!desc) {
      const sels = ['[data-automation-id="jobPostingDescription"]', '#job-description', '.job-description', '[class*="job-description"]', '[class*="jobDescription"]', '[class*="job_description"]', '.posting-page', '.posting', '#content', '[class*="description"]', 'article', 'main'];
      for (const s of sels) {
        const n = document.querySelector(s);
        if (n && !n.querySelector('form input[type=text]') && n.innerText && n.innerText.length > 400) { desc = n.innerText; break; }
      }
    }
    if (!title) {
      const h1 = document.querySelector('h1');
      title = h1 ? clean(h1.textContent) : document.title.split(/\s[-|–—]\s/)[0].trim();
    }
    if (!company) company = guessCompany();
    return { title: title.slice(0, 160), company: company.slice(0, 120), description: tidy(desc).slice(0, 15000) };
  }

  async function cachedJob() {
    const { jdCache } = await store.get('jdCache');
    return (jdCache || {})[jobCacheKey()] || null;
  }
  async function cacheJob(job) {
    if (!job.description || job.description.length < 500) return;
    const { jdCache } = await store.get('jdCache');
    const c = jdCache || {};
    c[jobCacheKey()] = Object.assign({ ts: Date.now() }, job);
    const keys = Object.keys(c).sort((a, b) => c[b].ts - c[a].ts);
    keys.slice(30).forEach((k) => delete c[k]);
    await store.set({ jdCache: c });
  }

  function detect() {
    const fields = collectFields();
    const nonFile = fields.filter((f) => f.kind !== 'file');
    const personal = new Set();
    for (const f of nonFile) {
      const k = profileKeyFor(f, describe(f));
      if (['firstName', 'lastName', 'fullName', 'email', 'phone'].includes(k)) personal.add(k === 'fullName' ? 'firstName' : k);
    }
    const hasResumeFile = fields.some((f) => f.kind === 'file');
    const ctx = (location.href + ' ' + document.title).toLowerCase();
    const jobWords = /(job|career|position|role|resume|apply|application|opening|vacanc|recruit)/.test(ctx);
    const onAts = ATS.test(location.hostname);
    const isApplication =
      (personal.size >= 2 && (hasResumeFile || onAts || jobWords) && nonFile.length >= 3) ||
      (hasResumeFile && nonFile.length >= 3 && (onAts || jobWords)) ||
      (onAts && nonFile.length >= 4);
    const isPosting = !!jsonLdJob() || (onAts && /\b(responsibilities|requirements|qualifications|about the (role|job))\b/i.test((document.body.innerText || '').slice(0, 20000)));
    return { isApplication, isPosting };
  }

  // ───────────────────────── panel UI ─────────────────────────
  let host = null, root = null;
  const $ = (id) => root.getElementById(id);
  function h(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

  const CSS = `
  :host{all:initial}
  *{box-sizing:border-box;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color-scheme:dark}
  .card{width:372px;max-height:82vh;display:flex;flex-direction:column;background:#1f2025;color:#ececf1;border:1px solid #3a3c46;border-radius:14px;box-shadow:0 12px 44px rgba(0,0,0,.55);font-size:13px;line-height:1.4;overflow:hidden}
  header{display:flex;align-items:center;gap:8px;padding:10px 12px;background:#2b2d36;color:#fff;cursor:grab;user-select:none;touch-action:none;border-bottom:1px solid #3a3c46}
  header.drag{cursor:grabbing}
  header b{flex:1;font-size:14px;color:#fff}
  header .grip{color:#7d8294;letter-spacing:-2px;font-size:15px}
  header button{background:transparent;border:0;color:#c9cdda;font-size:16px;cursor:pointer;padding:0 4px}
  header button:hover{color:#fff}
  .tabs{display:flex;border-bottom:1px solid #3a3c46;background:#1f2025}
  .tab{flex:1;padding:9px 4px;background:none;border:0;border-bottom:2px solid transparent;cursor:pointer;font-size:12.5px;color:#a9adbb}
  .tab:hover{color:#fff}
  .tab.on{color:#8fa8ff;border-bottom-color:#8fa8ff;font-weight:600}
  .body{padding:12px;overflow:auto;flex:1;color:#ececf1}
  .hidden{display:none!important}
  button.primary{width:100%;padding:10px;border:0;border-radius:9px;background:#4a6cf7;color:#fff;font-size:13.5px;font-weight:600;cursor:pointer}
  button.primary:hover{background:#5d7bf9}
  button.primary:disabled{opacity:.6;cursor:wait}
  button.sec{padding:7px 10px;border:1px solid #454856;border-radius:8px;background:#2a2c34;cursor:pointer;font-size:12.5px;color:#ececf1}
  button.sec:hover{background:#343742}
  .row{display:flex;gap:8px;margin-top:8px;flex-wrap:wrap}
  label.chk{display:flex;gap:6px;align-items:center;margin-top:8px;font-size:12.5px;color:#ececf1}
  input[type=text],select,textarea{width:100%;padding:6px 8px;border:1px solid #454856;border-radius:7px;font-size:12.5px;margin-top:3px;background:#2a2c34;color:#ececf1}
  input::placeholder,textarea::placeholder{color:#868a9a}
  textarea{resize:vertical}
  a{color:#8fa8ff}
  .muted{color:#a2a6b5;font-size:12px}
  .status{margin-top:8px;font-size:12.5px;color:#ececf1}
  .err{color:#ff8a80}.ok{color:#5fe08f}
  .q{border:1px solid #3a3c46;border-radius:9px;padding:8px;margin-top:8px;background:#25272e}
  .q .t{font-weight:600;cursor:pointer;color:#fff}.req{color:#ff8a80}
  .box{background:#2a2c34;border-radius:9px;padding:8px 10px;margin-top:8px;font-size:12.5px;color:#ececf1}
  .box b{color:#fff}
  .score{font-size:22px;font-weight:700;color:#8fa8ff}
  ul{margin:4px 0 0;padding-left:18px}
  details{margin-bottom:10px}summary{cursor:pointer;font-weight:600;font-size:12.5px;color:#fff}
  .chip{display:inline-block;background:#2f3a66;color:#c3d0ff;border-radius:10px;padding:1px 7px;margin:2px 3px 0 0;font-size:11.5px}
  .chip.miss{background:#4a3520;color:#ffc58a}
  .toast{position:absolute;left:12px;right:12px;bottom:10px;background:#1f8f4f;color:#fff;padding:7px 10px;border-radius:8px;font-size:12.5px;text-align:center}
  .wrap{position:relative}`;

  function buildPanel() {
    if (host) { host.style.display = ''; return; }
    host = document.createElement('div');
    host.id = 'jc-host';
    host.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;';
    root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<style>${CSS}</style>
    <div class="card wrap" id="card">
      <header id="hdr" title="Drag to move"><span class="grip">⋮⋮</span><b>Job Copilot</b><button id="min" title="Minimise">–</button><button id="close" title="Close">✕</button></header>
      <div id="main">
      <div class="tabs"><button class="tab on" data-t="fill">Autofill</button><button class="tab" data-t="cover">Cover letter</button><button class="tab" data-t="tailor">Tailor resume</button></div>
      <div class="body">
        <div id="t-fill">
          <div id="setup" class="box hidden">Your profile is empty. <a href="#" id="openSetup">Open settings</a> and import your resume.</div>
          <button class="primary" id="fillBtn">⚡ Autofill this application</button>
          <label class="chk"><input type="checkbox" id="optAttach" checked> Attach resume file</label>
          <label class="chk"><input type="checkbox" id="optOver"> Overwrite fields that already have a value</label>
          <div class="status" id="fillStatus"></div>
          <div id="unknown"></div>
          <div class="muted status" id="learned"></div>
        </div>
        <div id="t-cover" class="hidden">
          <details id="jobBox" open><summary>Role details (auto-detected — edit if wrong)</summary>
            <input type="text" id="jt" placeholder="Job title"><input type="text" id="jc" placeholder="Company">
            <textarea id="jd" rows="5" placeholder="Job description — paste it here if it wasn't detected"></textarea>
          </details>
          <button class="primary" id="coverBtn">Analyse role &amp; write cover letter</button>
          <div class="status" id="coverStatus"></div>
          <div id="coverOut"></div>
        </div>
        <div id="t-tailor" class="hidden">
          <div class="muted">Rewrites your resume for this role (nothing invented — employers, titles and dates are locked to your profile) and builds a PDF. Uses the role details from the Cover letter tab.</div>
          <div class="row"><button class="primary" id="tailorBtn">Tailor resume to this role (PDF)</button></div>
          <div class="status" id="tailorStatus"></div>
          <div id="tailorOut"></div>
        </div>
      </div></div>
    </div>`;
    document.documentElement.appendChild(host);

    root.querySelectorAll('.tab').forEach((b) => (b.onclick = () => switchTab(b.dataset.t)));
    $('close').onclick = () => { host.style.display = 'none'; try { sessionStorage.setItem('jc-dismissed', location.href); } catch (e) { /* ignore */ } };
    $('min').onclick = () => $('main').classList.toggle('hidden');
    $('openSetup').onclick = (e) => { e.preventDefault(); browser.runtime.sendMessage({ type: 'openOptions' }); };
    $('fillBtn').onclick = onFill;
    $('coverBtn').onclick = onCover;
    $('tailorBtn').onclick = onTailor;
    enableDrag();
    refreshPanelState();
    initJob();
  }

  // Drag the panel by its header; position is remembered across pages.
  function placeHost(x, y) {
    const r = host.getBoundingClientRect();
    const nx = Math.max(0, Math.min(x, window.innerWidth - Math.min(r.width, window.innerWidth)));
    const ny = Math.max(0, Math.min(y, window.innerHeight - 40));
    host.style.left = nx + 'px';
    host.style.top = ny + 'px';
    host.style.right = 'auto';
    host.style.bottom = 'auto';
    return { x: nx, y: ny };
  }
  function enableDrag() {
    const hdr = $('hdr');
    store.get('panelPos').then((d) => { if (d.panelPos) placeHost(d.panelPos.x, d.panelPos.y); });
    let off = null;
    hdr.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button')) return;
      const r = host.getBoundingClientRect();
      off = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      hdr.setPointerCapture(e.pointerId);
      hdr.classList.add('drag');
      e.preventDefault();
    });
    hdr.addEventListener('pointermove', (e) => { if (off) placeHost(e.clientX - off.dx, e.clientY - off.dy); });
    const end = () => {
      if (!off) return;
      off = null;
      hdr.classList.remove('drag');
      const r = host.getBoundingClientRect();
      store.set({ panelPos: { x: r.left, y: r.top } });
    };
    hdr.addEventListener('pointerup', end);
    hdr.addEventListener('pointercancel', end);
    window.addEventListener('resize', () => { const r = host.getBoundingClientRect(); if (host.style.left) placeHost(r.left, r.top); });
  }

  function switchTab(t) {
    root.querySelectorAll('.tab').forEach((b) => b.classList.toggle('on', b.dataset.t === t));
    ['fill', 'cover', 'tailor'].forEach((x) => $('t-' + x).classList.toggle('hidden', x !== t));
    // The role details box lives in the cover tab; the tailor tab reuses it.
    if (t === 'tailor') $('t-tailor').prepend($('jobBox'));
    if (t === 'cover') $('t-cover').prepend($('jobBox'));
  }

  async function refreshPanelState() {
    await loadState();
    const empty = !state.profile || !(state.profile.personal && (state.profile.personal.firstName || state.profile.personal.email));
    $('setup').classList.toggle('hidden', !empty);
    const n = Object.keys(state.answers).length;
    $('learned').textContent = n ? `I remember ${n} answer${n === 1 ? '' : 's'} from past applications.` : 'Answers you type for unfamiliar questions are remembered automatically.';
  }

  function say(id, msg, cls) { const e = $(id); e.textContent = msg; e.className = 'status ' + (cls || ''); }
  function flashLearned() {
    if (!root) return;
    const t = h('div', 'toast', '✓ Answer remembered for next time');
    $('card').appendChild(t);
    setTimeout(() => t.remove(), 1800);
    refreshPanelState();
  }

  async function initJob() {
    let job = scrapeJob();
    if (job.description.length < 400) {
      const c = await cachedJob();
      if (c && c.description) job = { title: job.title && job.title.length < 100 ? c.title || job.title : c.title, company: c.company || job.company, description: c.description };
    }
    state.job = job;
    $('jt').value = job.title;
    $('jc').value = job.company;
    $('jd').value = job.description;
  }
  const currentJob = () => ({ title: $('jt').value.trim(), company: $('jc').value.trim(), description: $('jd').value.trim(), url: location.href });

  // — autofill tab
  async function onFill() {
    await loadState();
    const b = $('fillBtn');
    b.disabled = true;
    try {
      const r = await autofill({ overwrite: $('optOver').checked, attach: $('optAttach').checked });
      const bits = [`Filled ${r.filled} from your profile`];
      if (r.saved) bits.push(`${r.saved} from remembered answers`);
      if (r.attached) bits.push('attached resume');
      say('fillStatus', bits.join(', ') + '.', 'ok');
      renderUnknown();
    } catch (e) { say('fillStatus', 'Autofill failed: ' + e.message, 'err'); }
    b.disabled = false;
  }

  function optionsOf(f) {
    let o = [];
    if (f.kind === 'select') o = [...f.els[0].options].map((x) => clean(x.textContent));
    else if (f.kind === 'radio') o = f.els.map(optionLabel);
    else if (f.kind === 'yesno' || f.kind === 'checkbox') o = ['Yes', 'No'];
    o = o.filter((x) => x && !/^(select|choose|please select)/i.test(x));
    return o.length && o.length <= 80 ? o : undefined;
  }
  const qType = (f) => (f.kind === 'textarea' ? 'textarea' : f.kind === 'select' || f.kind === 'radio' || f.kind === 'combo' ? 'choice' : f.kind === 'yesno' ? 'yesno' : f.kind === 'checkbox' ? 'checkbox' : 'text');

  async function onDraft(btn) {
    btn.disabled = true;
    btn.textContent = 'Thinking…';
    const items = lastUnknown.slice(0, 25);
    const questions = items.map((u, i) => ({ id: i, question: u.d.question, type: qType(u.f), required: required(u.f), options: optionsOf(u.f) }));
    const r = await browser.runtime.sendMessage({ type: 'answer', job: currentJob(), questions });
    if (!r || r.error) { btn.disabled = false; btn.textContent = '✨ Draft answers with AI'; say('fillStatus', (r && r.error) || 'No response from the extension background.', 'err'); return; }
    (r.answers || []).forEach((a) => { const u = items[a.id]; if (u) u.draft = { answer: String(a.answer || '').trim(), needs: !!a.needs_user || !String(a.answer || '').trim(), reason: a.reason || '' }; });
    renderUnknown();
  }

  function renderUnknown() {
    if (!root) return;
    const box = $('unknown');
    box.textContent = '';
    if (!lastUnknown.length) return;
    const draftBtn = h('button', 'sec', lastUnknown.some((u) => u.draft) ? '✨ Redraft with AI' : '✨ Draft answers with AI');
    draftBtn.onclick = () => onDraft(draftBtn);
    const ready = lastUnknown.filter((u) => u.draft && !u.draft.needs);
    const row0 = h('div', 'row');
    row0.appendChild(draftBtn);
    if (ready.length) {
      const all = h('button', 'primary', `Fill ${ready.length} AI draft${ready.length === 1 ? '' : 's'} (review first)`);
      all.style.width = 'auto'; all.style.flex = '1';
      all.onclick = async () => {
        all.disabled = true;
        for (const u of ready) { if (await fillField(u.f, u.draft.answer)) { markUnknown(u.f, false); lastUnknown = lastUnknown.filter((x) => x !== u); } }
        renderUnknown();
      };
      row0.appendChild(all);
    }
    box.appendChild(row0);
    box.appendChild(h('div', 'muted', `${lastUnknown.length} question${lastUnknown.length === 1 ? '' : 's'} I don't know yet (outlined in orange). Answer here or on the page — I'll remember.`));
    lastUnknown.slice(0, 25).forEach((u) => {
      const q = h('div', 'q');
      const t = h('div', 't', u.d.question);
      if (required(u.f)) t.appendChild(h('span', 'req', ' *'));
      t.onclick = () => u.f.els[0].scrollIntoView({ block: 'center', behavior: 'smooth' });
      q.appendChild(t);
      let input;
      if (u.f.kind === 'select' || u.f.kind === 'radio') {
        input = document.createElement('select');
        const texts = u.f.kind === 'select' ? [...u.f.els[0].options].map((o) => clean(o.textContent)) : u.f.els.map(optionLabel);
        input.appendChild(new Option('Choose…', ''));
        texts.forEach((x) => { if (x) input.appendChild(new Option(x, x)); });
      } else if (u.f.kind === 'textarea') { input = document.createElement('textarea'); input.rows = 3; }
      else if (u.f.kind === 'checkbox' || u.f.kind === 'yesno') { input = document.createElement('select'); input.appendChild(new Option('Choose…', '')); input.appendChild(new Option('Yes', 'Yes')); input.appendChild(new Option('No', 'No')); }
      else { input = document.createElement('input'); input.type = 'text'; }
      if (u.draft && u.draft.answer) {
        if (input.tagName === 'SELECT') { const idx = [...input.options].findIndex((o) => norm(o.value) === norm(u.draft.answer)); if (idx >= 0) input.selectedIndex = idx; else input.appendChild(new Option(u.draft.answer, u.draft.answer, true, true)); }
        else input.value = u.draft.answer;
        q.appendChild(h('div', 'muted', '✨ AI draft — review before using'));
      } else if (u.draft) q.appendChild(h('div', 'muted', 'Needs you: ' + (u.draft.reason || "can't be answered from your profile")));
      q.appendChild(input);
      const row = h('div', 'row');
      const save = h('button', 'sec', 'Fill & remember');
      save.onclick = async () => {
        const v = input.value.trim();
        if (!v) return;
        if (await fillField(u.f, v)) {
          await remember(u.d.question, v, u.f.kind);
          markUnknown(u.f, false);
          lastUnknown = lastUnknown.filter((x) => x !== u);
          renderUnknown();
        } else save.textContent = "Couldn't fill — answer on the page";
      };
      const once = h('button', 'sec', 'Fill once');
      once.title = "Fill this application only; don't remember the answer";
      once.onclick = async () => {
        const v = input.value.trim();
        if (!v) return;
        if (await fillField(u.f, v)) { markUnknown(u.f, false); lastUnknown = lastUnknown.filter((x) => x !== u); renderUnknown(); }
        else once.textContent = "Couldn't fill — answer on the page";
      };
      row.appendChild(save);
      row.appendChild(once);
      q.appendChild(row);
      box.appendChild(q);
    });
  }

  // — cover letter tab
  async function onCover() {
    const job = currentJob();
    if (job.description.length < 80) { say('coverStatus', 'Paste the job description first (open the role details).', 'err'); return; }
    const b = $('coverBtn');
    b.disabled = true;
    say('coverStatus', 'Reading the role like a recruiter… (10-20s)');
    $('coverOut').textContent = '';
    const r = await browser.runtime.sendMessage({ type: 'cover', job });
    b.disabled = false;
    if (!r || r.error) { say('coverStatus', (r && r.error) || 'No response from the extension background.', 'err'); return; }
    say('coverStatus', '');
    state.coverLetter = r.cover_letter || '';
    const out = $('coverOut');
    const fit = r.fit || {}, rr = r.role_read || {};
    const top = h('div', 'box');
    top.appendChild(h('div', 'score', `Fit ${fit.score != null ? fit.score : '?'}/100`));
    if (fit.positioning) top.appendChild(h('div', '', fit.positioning));
    out.appendChild(top);
    const sec = (title, items, cls) => {
      if (!items || !items.length) return;
      const bx = h('div', 'box');
      bx.appendChild(h('b', '', title));
      const ul = h('ul');
      items.forEach((i) => ul.appendChild(h('li', cls, i)));
      bx.appendChild(ul);
      out.appendChild(bx);
    };
    if (rr.summary) { const bx = h('div', 'box'); bx.appendChild(h('b', '', 'What this role really needs')); bx.appendChild(h('div', '', rr.summary)); out.appendChild(bx); }
    sec('Strengths to lead with', fit.strengths);
    sec('Gaps to be ready for', fit.gaps);
    if ((rr.keywords || []).length) {
      const bx = h('div', 'box');
      bx.appendChild(h('b', '', 'ATS keywords'));
      bx.appendChild(h('div'));
      rr.keywords.forEach((k) => bx.lastChild.appendChild(h('span', 'chip', k)));
      out.appendChild(bx);
    }
    const ta = document.createElement('textarea');
    ta.id = 'coverText'; ta.rows = 14; ta.value = state.coverLetter;
    ta.oninput = () => { state.coverLetter = ta.value; };
    out.appendChild(ta);
    const row = h('div', 'row');
    const copy = h('button', 'primary', 'Copy cover letter');
    copy.style.width = 'auto'; copy.style.flex = '1';
    copy.onclick = async () => {
      ta.select();
      try { await navigator.clipboard.writeText(ta.value); } catch (e) { document.execCommand('copy'); }
      copy.textContent = '✓ Copied';
      setTimeout(() => (copy.textContent = 'Copy cover letter'), 1500);
    };
    const ins = h('button', 'sec', 'Insert into form');
    ins.onclick = async () => {
      const n = await autofill({ only: 'coverLetterText', overwrite: true });
      ins.textContent = n.filled ? '✓ Inserted' : 'No cover-letter box found';
      setTimeout(() => (ins.textContent = 'Insert into form'), 1800);
    };
    row.appendChild(copy); row.appendChild(ins);
    out.appendChild(row);
  }

  // — tailor tab
  async function onTailor() {
    const job = currentJob();
    if (job.description.length < 80) { switchTab('cover'); say('coverStatus', 'Paste the job description first.', 'err'); return; }
    const b = $('tailorBtn');
    b.disabled = true;
    say('tailorStatus', 'Tailoring your resume… (15-30s)');
    $('tailorOut').textContent = '';
    const r = await browser.runtime.sendMessage({ type: 'tailor', job });
    b.disabled = false;
    if (!r || r.error) { say('tailorStatus', (r && r.error) || 'No response from the extension background.', 'err'); return; }
    state.tailored = r;
    say('tailorStatus', `Created ${r.filename}`, 'ok');
    const out = $('tailorOut');
    const row = h('div', 'row');
    const dl = h('button', 'primary', 'Download PDF');
    dl.style.width = 'auto'; dl.style.flex = '1';
    dl.onclick = () => {
      const bin = atob(r.pdfB64), arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([arr], { type: 'application/pdf' }));
      a.download = r.filename;
      document.body.appendChild(a); a.click(); a.remove();
    };
    const at = h('button', 'sec', 'Attach to application');
    at.onclick = () => {
      const n = attachResume('tailored');
      at.textContent = n ? `✓ Attached to ${n} upload field${n > 1 ? 's' : ''}` : 'No empty upload field found';
    };
    row.appendChild(dl); row.appendChild(at);
    out.appendChild(row);
    const chips = (title, arr, cls) => {
      if (!arr || !arr.length) return;
      const bx = h('div', 'box');
      bx.appendChild(h('b', '', title));
      const d = h('div');
      arr.forEach((k) => d.appendChild(h('span', 'chip ' + (cls || ''), k)));
      bx.appendChild(d);
      out.appendChild(bx);
    };
    chips('Keywords matched', r.matched);
    chips('Posting keywords you lack (not added)', r.missing, 'miss');
    if ((r.changes || []).length) {
      const bx = h('div', 'box');
      bx.appendChild(h('b', '', 'What I changed'));
      const ul = h('ul');
      r.changes.forEach((c) => ul.appendChild(h('li', '', c)));
      bx.appendChild(ul);
      out.appendChild(bx);
    }
  }

  // ───────────────────────── bootstrap ─────────────────────────
  let shown = false;
  async function maybeShow(force) {
    if (shown && !force) return;
    await loadState();
    if (!force) {
      if (state.settings.autoPopup === false) return;
      try { if (sessionStorage.getItem('jc-dismissed') === location.href) return; } catch (e) { /* ignore */ }
    }
    const r = detect();
    if (r.isPosting && !r.isApplication) cacheJob(scrapeJob()); // remember the JD for the /apply page
    if (!force && !r.isApplication && !(r.isPosting && isTop)) return;
    shown = true;
    buildPanel();
    // job posting (not the form): show only the header bar as a launcher; click – / drag to use
    if (!force && !r.isApplication) $('main').classList.add('hidden');
  }

  browser.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'showPanel') {
      if (!isTop && !detect().isApplication) return undefined;
      shown = true;
      buildPanel();
      if (host) host.style.display = '';
      return Promise.resolve({ shown: true });
    }
    return undefined;
  });
  browser.storage.onChanged.addListener(() => { if (root) refreshPanelState(); });

  let timer = null;
  const schedule = () => { clearTimeout(timer); timer = setTimeout(() => maybeShow(false), 1200); };
  new MutationObserver(() => { if (!shown) schedule(); }).observe(document.documentElement, { childList: true, subtree: true });
  let lastHref = location.href;
  setInterval(() => { if (location.href !== lastHref) { lastHref = location.href; shown = false; if (host) { host.remove(); host = null; root = null; } schedule(); } }, 1000);
  schedule();
})();
