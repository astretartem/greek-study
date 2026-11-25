(function () {
  "use strict";

  /* ================= Утилиты ================= */
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const h = (html) => { const t = document.createElement("template"); t.innerHTML = html.trim(); return t.content.firstElementChild; };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const rnd = (a) => a[Math.floor(Math.random() * a.length)];
  const shuffle = (a) => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const pad = (n) => String(n).padStart(2, "0");
  const dayKey = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const DAY = 864e5;

  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* приватный режим */ } },
  };

  const S = Object.assign({ level: "A2", strict: true, latin: true, autoSpeak: false, rate: 0.9, newPerSession: 20 }, store.get("gr.settings", {}));
  const UI = Object.assign({ deck: "all", topic: "", dir: "gr-ru", mode: "srs", spellTab: "dictation", spellDeck: "all", verbTab: "trainer", tenses: null, group: "all", examOnly: false }, store.get("gr.ui", {}));
  let P = store.get("gr.progress", {});
  let LOG = store.get("gr.log", {});
  const saveS = () => store.set("gr.settings", S);
  const saveUI = () => store.set("gr.ui", UI);
  const saveP = () => store.set("gr.progress", P);
  const saveLog = () => store.set("gr.log", LOG);

  function logAnswer(ok, kind) {
    const t = dayKey();
    const e = LOG[t] || (LOG[t] = { n: 0, ok: 0 });
    e.n++; if (ok) e.ok++;
    e[kind] = (e[kind] || 0) + 1;
    saveLog();
  }

  const lvlOk = (l) => S.level === "B1" || l !== "B1";

  /* ================= Данные ================= */
  // результаты сверки с образцами экзаменов ΚΕΓ
  const EXAM = window.EXAM_DATA || {};
  window.VERBS.forEach((v) => { const e = EXAM["verbs:" + v.v]; if (e) { v.ex = e.ex; if (e.lvl) v.lvl = e.lvl; } });
  window.VOCAB.forEach((it) => { const e = EXAM[it.id]; if (e) { it.ex = e.ex; it.exN = e.n; if (e.lvl) it.lvl = e.lvl; } });
  const VERB_ITEMS = window.VERBS.map((v) => ({ id: "verbs:" + v.v, kind: "verbs", topic: "Глаголы", gr: v.v, ru: v.ru, lvl: v.lvl, word: v.v, verb: v, ex: v.ex }));
  const ALL = VERB_ITEMS.concat(window.VOCAB);
  const DECKS = [
    { id: "all", name: "Все слова" },
    { id: "verbs", name: "Глаголы" },
    { id: "nouns", name: "Существительные" },
    { id: "adjectives", name: "Прилагательные" },
    { id: "words", name: "Наречия, связки, числа" },
    { id: "phrases", name: "Фразы" },
  ];
  const items = (deck = "all", topic = "", examOnly = false) => ALL.filter((i) => lvlOk(i.lvl) && (deck === "all" || i.kind === deck) && (!topic || i.topic === topic) && (!examOnly || i.ex));
  const REAL_WORDS = new Set(ALL.flatMap((i) => (i.kind === "nouns" ? i.gr.split("/").map((x) => x.split(" ").slice(1).join(" ")) : i.gr.split("/").map((x) => x.split(" ")[0]))));
  const GENDER_NAME = { м: "мужской род", ж: "женский род", ср: "средний род" };
  const GENDER_CLS = { м: "m", ж: "f", ср: "n" };

  const gcls = (it) => (it.gender ? "art-" + GENDER_CLS[it.gender] : "art-pl");
  function grHTML(it) {
    const hint = it.hint ? ` <span class="muted" style="font-size:.6em">(${esc(it.hint)})</span>` : "";
    if (it.kind !== "nouns") return esc(it.gr).replace(/\//g, " / ") + hint;
    return it.gr.split("/").map((alt) => {
      const sp = alt.indexOf(" ");
      return `<span class="${gcls(it)}">${esc(alt.slice(0, sp))}</span> ${esc(alt.slice(sp + 1))}`;
    }).join(" / ") + hint;
  }

  /* ================= Озвучка ================= */
  let voice = null, warnedVoice = false;
  const hasTTS = "speechSynthesis" in window;
  function pickVoice() {
    if (!hasTTS) return;
    const vs = speechSynthesis.getVoices();
    voice = vs.find((v) => v.lang === "el-GR") || vs.find((v) => (v.lang || "").toLowerCase().startsWith("el")) || null;
  }
  if (hasTTS) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }
  function speak(text, slow) {
    if (!hasTTS) { toast("Браузер не поддерживает озвучку"); return; }
    if (!voice) pickVoice();
    if (!voice && !warnedVoice) {
      warnedVoice = true;
      toast("Греческий голос не найден. macOS: Системные настройки → Универсальный доступ → Устная речь → Системный голос → Управлять голосами → Ελληνικά", 6000);
    }
    speechSynthesis.cancel();
    const clean = String(text).split("/")[0].replace(/\.\.\./g, "").replace(/\s-\S+/g, "");
    const u = new SpeechSynthesisUtterance(clean);
    u.lang = "el-GR";
    if (voice) u.voice = voice;
    u.rate = slow ? 0.6 : Number(S.rate) || 0.9;
    speechSynthesis.speak(u);
  }

  let toastTimer;
  function toast(msg, ms = 2200) {
    const t = $("#toast");
    t.textContent = msg; t.classList.add("show");
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove("show"), ms);
  }

  /* ================= Ввод греческого ================= */
  function attachGreek(input, onEnter) {
    let dead = null;
    input.setAttribute("autocomplete", "off");
    input.setAttribute("autocapitalize", "off");
    input.setAttribute("autocorrect", "off");
    input.setAttribute("spellcheck", "false");
    input.setAttribute("lang", "el");
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); onEnter && onEnter(); return; }
      if (e.metaKey || e.ctrlKey || e.altKey || !S.latin) return;
      if (e.key === ";") { e.preventDefault(); dead = dead === "dia" ? "both" : "tonos"; return; }
      if (e.key === ":") { e.preventDefault(); dead = dead === "tonos" ? "both" : "dia"; return; }
      if (e.key.length !== 1) return;
      let g = GR.latinToGreek(e.key);
      if (g === ";") g = null;
      if (g || dead) {
        e.preventDefault();
        let out = g || e.key;
        if (dead) { out = GR.applyDead(dead, out); dead = null; }
        insertText(input, out);
      }
    });
  }
  function insertText(input, t) {
    const s = input.selectionStart ?? input.value.length, e = input.selectionEnd ?? s;
    input.setRangeText(t, s, e, "end");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }
  function greekInput(onEnter, placeholder = "пишите по-гречески…") {
    const wrap = h(`<div style="flex:1;max-width:380px">
      <input class="gr-input" placeholder="${esc(placeholder)}">
      <div class="accents"></div></div>`);
    const input = $("input", wrap);
    attachGreek(input, onEnter);
    const bar = $(".accents", wrap);
    ["´", "ά", "έ", "ή", "ί", "ό", "ύ", "ώ", "ϊ", "ϋ", "ΐ", "ς"].forEach((ch) => {
      const b = h(`<button type="button" title="${ch === "´" ? "Поставить ударение на предыдущую букву" : ch}">${ch}</button>`);
      b.addEventListener("mousedown", (e) => e.preventDefault());
      b.addEventListener("click", () => {
        if (ch === "´") {
          const pos = input.selectionStart;
          const prev = input.value[pos - 1];
          if (prev && GR.isVowel(prev)) {
            input.setRangeText(GR.addTonos(GR.stripTonos(prev)), pos - 1, pos, "end");
          }
        } else insertText(input, ch);
        input.focus();
      });
      bar.appendChild(b);
    });
    return { wrap, input };
  }

  /* ================= Интервальное повторение (Лейтнер) ================= */
  const INT = [0, 0, 1, 3, 7, 16, 35]; // дни для коробок 1..6
  function review(id, q) {
    const p = P[id] || { b: 0, r: 0, w: 0 };
    const now = Date.now();
    if (q === 0) { p.b = 1; p.due = now + 5 * 60e3; p.w++; }
    else if (q === 1) { p.b = Math.max(1, p.b); p.due = now + Math.max(INT[p.b], 0.5) * DAY; p.r++; }
    else { p.b = Math.min(6, Math.max(2, p.b + 1)); p.due = now + INT[p.b] * DAY; p.r++; }
    p.last = now;
    P[id] = p; saveP();
  }
  const isDue = (it) => P[it.id] && P[it.id].due <= Date.now();

  /* ================= Роутер ================= */
  const app = $("#app");
  let keyHandler = null;
  document.addEventListener("keydown", (e) => {
    if (!keyHandler) return;
    const tag = (e.target.tagName || "").toLowerCase();
    if ((tag === "input" || tag === "select" || tag === "textarea") && e.key !== "Escape") return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if ($("#settings").open || $("#dict").open) return;
    keyHandler(e);
  });

  const views = {};
  function route() {
    const [name, sub] = (location.hash.slice(1) || "home").split("/");
    keyHandler = null;
    if (hasTTS) speechSynthesis.cancel();
    $$("#nav a").forEach((a) => a.classList.toggle("active", a.getAttribute("href") === "#" + name));
    $$(".level button").forEach((b) => b.classList.toggle("on", b.dataset.level === S.level));
    app.innerHTML = "";
    (views[name] || views.home)(app, sub);
  }
  window.addEventListener("hashchange", () => { route(); window.scrollTo(0, 0); });

  $$(".level button").forEach((b) => b.addEventListener("click", () => {
    S.level = b.dataset.level; saveS();
    toast(S.level === "A2" ? "Уровень A2: слова A1–A2, 4 времени" : "Уровень B1: все слова и 6 времён");
    route();
  }));

  // Настройки
  const dlg = $("#settings");
  $("#settingsBtn").addEventListener("click", () => {
    const f = $("form", dlg);
    f.strict.checked = S.strict; f.latin.checked = S.latin; f.autoSpeak.checked = S.autoSpeak;
    f.rate.value = S.rate; f.newPerSession.value = S.newPerSession;
    dlg.showModal();
  });
  dlg.addEventListener("close", () => {
    const f = $("form", dlg);
    S.strict = f.strict.checked; S.latin = f.latin.checked; S.autoSpeak = f.autoSpeak.checked;
    S.rate = Number(f.rate.value); S.newPerSession = Math.max(5, Number(f.newPerSession.value) || 20);
    saveS();
  });

  /* ================= Главная ================= */
  function streak() {
    let n = 0; const d = new Date();
    if (!LOG[dayKey(d)]) d.setDate(d.getDate() - 1);
    while (LOG[dayKey(d)] && LOG[dayKey(d)].n > 0) { n++; d.setDate(d.getDate() - 1); }
    return n;
  }

  views.home = (root) => {
    const all = items();
    const due = all.filter(isDue).length;
    const fresh = all.filter((i) => !P[i.id]).length;
    const learned = all.filter((i) => P[i.id] && P[i.id].b >= 4).length;
    const verbs = window.VERBS.filter((v) => lvlOk(v.lvl)).length;
    const tenses = GR.TENSES.filter((t) => lvlOk(t.lvl)).length;
    const t = LOG[dayKey()] || { n: 0, ok: 0 };
    root.appendChild(h(`<div class="stack">
      <div class="card hero">
        <div>
          <h1>Καλώς ήρθες!</h1>
          <p class="muted" style="margin:0">Уровень <b>${S.level}</b> · ${all.length} слов и фраз · ${verbs} глаголов · ${tenses} ${tenses > 4 ? "времён" : "времени"}</p>
        </div>
        <div class="big">Γεια σου!</div>
      </div>
      <div class="kpis">
        <div class="kpi"><b>${due}</b><span>к повторению</span></div>
        <div class="kpi"><b>${fresh}</b><span>новых карточек</span></div>
        <div class="kpi"><b>${learned}</b><span>выучено</span></div>
        <div class="kpi"><b>${t.n ? Math.round((t.ok / t.n) * 100) + "%" : "—"}</b><span>точность сегодня (${t.n})</span></div>
        <div class="kpi"><b>${streak()}</b><span>дней подряд</span></div>
      </div>
      <div class="grid">
        <a class="card tile" href="#cards"><div class="ico">🃏</div><h3>Карточки</h3><p>${due ? due + " к повторению · " : ""}интервальное повторение слов, глаголов и фраз</p></a>
        <a class="card tile" href="#verbs"><div class="ico">🔁</div><h3>Спряжение</h3><p>${verbs} глаголов, времена: ${GR.TENSES.filter((x) => lvlOk(x.lvl)).map((x) => x.gr.split(" ")[0]).join(", ")}</p></a>
        <a class="card tile" href="#spelling/dictation"><div class="ico">🎧</div><h3>Диктант</h3><p>Слушайте и пишите по-гречески</p></a>
        <a class="card tile" href="#spelling/choice"><div class="ico">✍️</div><h3>Правописание</h3><p>ι / η / υ / ει / οι, ο / ω, ε / αι, двойные согласные</p></a>
        <a class="card tile" href="#spelling/accent"><div class="ico">🎯</div><h3>Ударения</h3><p>Куда ставить τόνο</p></a>
        <a class="card tile" href="#spelling/gender"><div class="ico">🧩</div><h3>Род: ο / η / το</h3><p>Артикли и окончания существительных</p></a>
        <a class="card tile" href="#grammar"><div class="ico">📘</div><h3>Справочник</h3><p>Алфавит, правила орфографии, таблицы</p></a>
        <a class="card tile" href="#stats"><div class="ico">📈</div><h3>Прогресс</h3><p>Статистика, экспорт и импорт</p></a>
      </div>
      <p class="muted" style="font-size:14px">Совет: включите в Настройках ⚙︎ «Печатать греческим с латинской раскладки» — тогда не нужна греческая клавиатура. Ударение: <kbd>;</kbd> + гласная.</p>
    </div>`));
  };

  /* ================= Словарь: форма → слово ================= */
  const formKey = (w) => GR.stripAll(String(w).toLowerCase()).replace(/ς/g, "σ");
  const ARTICLES = {
    ο: "артикль м.р.", η: "артикль ж.р. / мн.ч.", το: "артикль ср.р.; его, это (местоим.)", οι: "артикль мн.ч. м./ж.р.", τα: "артикль мн.ч. ср.р.; их (местоим.)",
    του: "артикль, род. п. м./ср.р.; его, ему", της: "артикль, род. п. ж.р.; её, ей", των: "артикль, род. п. мн.ч.",
    τον: "артикль, вин. п. м.р.; его", την: "артикль, вин. п. ж.р.; её", τη: "артикль, вин. п. ж.р.", τους: "артикль, вин. п. мн.ч. м.р.; их, им", τις: "артикль, вин. п. мн.ч. ж.р.; их",
    στο: "σε + το: в, на", στη: "σε + τη: в, на", στην: "σε + την: в, на", στον: "σε + τον: в, на", στα: "σε + τα: в, на", στους: "σε + τους: в, на", στις: "σε + τις: в, на", στης: "σε + της",
    ένας: "один; неопр. артикль м.р.", μια: "одна; неопр. артикль ж.р.", μία: "одна", έναν: "один (вин. п.)", ενός: "одного (род. п.)", μιας: "одной (род. п.)",
  };
  const NEND = { "ος": ["ος", "ου", "ο", "ε", "οι", "ων", "ους", "η"], "ας": ["ας", "α", "ες", "ων", "αδες", "αδων"], "ης": ["ης", "η", "ες", "ων", "ηδες", "εις", "εων"],
    "μα": ["μα", "ματος", "ματα", "ματων"], "ια": ["ια", "ιας", "ιες", "ιων"], "α": ["α", "ας", "ες", "ων", "ατα", "ατος", "ατων"], "η": ["η", "ης", "ες", "εις", "ων", "εων"],
    "ο": ["ο", "ου", "α", "ων"], "ι": ["ι", "ιου", "ια", "ιων"], "ους": ["ους", "ου", "ουδες", "ουδων"], "ου": ["ου", "ουδες", "ουδων"], "ες": ["ες", "ων"] };
  const NORDER = ["μα", "ους", "ος", "ας", "ης", "ια", "α", "η", "ο", "ι", "ου", "ες"];
  const ADJ_END = ["ος", "ου", "ο", "ε", "οι", "ων", "ους", "η", "ης", "ες", "α", "ας", "υς", "ια", "ιας", "ιες", "ιων", "υ", "ιου", "ιοι", "ιους", "ους", "ης", "εις", "ουσα", "ον", "οντα"];
  let FORM_INDEX = null;
  function formIndex() {
    if (FORM_INDEX) return FORM_INDEX;
    const m = new Map();
    const add = (f, it) => { const k = formKey(f); if (!k) return; let a = m.get(k); if (!a) m.set(k, (a = [])); if (!a.includes(it)) a.push(it); };
    VERB_ITEMS.forEach((it) => {
      const v = it.verb;
      add(v.v, it);
      GR.TENSES.forEach((t) => {
        const c = GR.conjugate(v, t.id); if (!c) return;
        c.forms.forEach((f) => add(f.split(" ").pop(), it));
        c.alts.flat().forEach((f) => add(f, it));
      });
      const d = GR.conjugate(v, "fut");
      if (d && !v.futF) { const st = d.forms[0].slice(0, -1); add(st + "ε", it); add(st + "τε", it); } // повелительное
    });
    window.VOCAB.forEach((it) => {
      if (it.kind === "nouns") {
        it.gr.split("/").forEach((alt) => {
          const ws = alt.split(" ").slice(1);
          if (ws.length !== 1) return;
          const w = formKey(ws[0]); add(w, it);
          const e = NORDER.find((x) => w.endsWith(formKey(x)));
          if (e) NEND[e].forEach((x) => add(w.slice(0, -formKey(e).length) + formKey(x), it));
        });
      } else if (it.kind === "adjectives") {
        const toks = it.gr.split(" ");
        const w = formKey(toks[0]); add(w, it);
        const st = w.replace(/(οσ|υσ|ησ|ων)$/, "");
        if (st !== w) ADJ_END.forEach((x) => add(st + formKey(x), it));
        toks.slice(1).forEach((tk) => {
          if (tk.startsWith("-")) { add(st + formKey(tk.slice(1)), it); return; }
          const k = formKey(tk); add(k, it);
          const st2 = k.replace(/[αηοιυ]$/, "");
          if (st2 !== k) ADJ_END.forEach((x) => add(st2 + formKey(x), it));
        });
      } else if (it.kind === "words") {
        it.gr.split("/").forEach((alt) => { if (!/\s/.test(alt.trim())) add(alt.trim(), it); });
      }
    });
    return (FORM_INDEX = m);
  }

  // для отладки в консоли: lookupForm("πήγαμε")
  window.lookupForm = (w) => (formIndex().get(formKey(w)) || []).map((i) => i.gr);

  const dict = document.createElement("dialog");
  dict.id = "dict";
  document.body.appendChild(dict);
  dict.addEventListener("click", (e) => {
    if (e.target === dict) { dict.close(); return; }
    const say = e.target.closest("[data-say]"); if (say) speak(say.dataset.say);
    const go = e.target.closest("[data-dict]"); if (go) openDict(go.dataset.dict);
    if (e.target.closest("[data-close]")) dict.close();
  });

  function verbEntryHTML(it, mk) {
    const v = it.verb;
    return `<div class="dict-entry">
      <div class="row"><h2 class="gr" style="margin:0">${esc(v.v)}</h2><button class="speak sm" data-say="${esc(v.v)}">🔊</button>
        ${v.ex ? `<span class="badge ex">ΚΕΓ</span>` : ""}<span class="badge ${v.lvl}">${v.lvl}</span></div>
      <p style="margin:4px 0 0">${esc(v.ru)} · <span class="muted">${GR.TYPE_NAMES[v.p]}</span></p>
      ${v.note ? `<p class="muted" style="margin:4px 0 0;font-size:14px">${esc(v.note)}</p>` : ""}
      <div class="tables" style="margin-top:12px">${GR.TENSES.map((t) => `<div class="card" style="padding:14px"><h3>${esc(t.ru)} ${t.lvl === "B1" ? `<span class="badge B1">B1</span>` : ""}</h3>
        <div class="grn gr">${esc(t.gr)}</div>${conjTable(v, t.id, -1, mk)}</div>`).join("")}</div></div>`;
  }
  function wordEntryHTML(it, token) {
    const base = it.kind === "nouns" ? it.word : it.word || it.gr;
    const isForm = token && formKey(token) !== formKey(base) && !it.gr.split("/").some((a) => formKey(a.split(" ").pop()) === formKey(token));
    const kindName = { nouns: "существительное", adjectives: "прилагательное", words: "служебное слово / наречие" }[it.kind] || "";
    return `<div class="dict-entry card" style="padding:16px">
      <div class="row"><span class="gr" style="font-size:1.5rem">${grHTML(it)}</span><button class="speak sm" data-say="${esc(it.gr)}">🔊</button>
        ${it.ex ? `<span class="badge ex">ΚΕΓ</span>` : ""}<span class="badge ${it.lvl}">${it.lvl}</span></div>
      <p style="margin:6px 0 0;font-size:1.1rem">${esc(it.ru)}</p>
      <p class="muted" style="margin:4px 0 0;font-size:14px">${kindName}${it.kind === "nouns" ? " · " + (it.gender ? GENDER_NAME[it.gender] : "множественное число") : ""} · ${esc(it.topic)}
        ${isForm ? `<br>«${esc(token)}» — форма этого слова` : ""}</p></div>`;
  }
  function openDict(token, preferVerb) {
    const clean = String(token).replace(/^[«"(]+|[.,!;:?…»");]+$/g, "");
    const mk = formKey(clean);
    let hits = formIndex().get(mk) || [];
    if (preferVerb) hits = [preferVerb].concat(hits.filter((h) => h !== preferVerb));
    const art = ARTICLES[mk] || ARTICLES[clean.toLowerCase()];
    const verbs = hits.filter((h) => h.kind === "verbs"), other = hits.filter((h) => h.kind !== "verbs");
    let body = "";
    if (art) body += `<div class="card" style="padding:14px"><b class="gr">${esc(clean)}</b> — ${esc(art)}</div>`;
    body += other.map((it) => wordEntryHTML(it, clean)).join("");
    body += verbs.map((it) => verbEntryHTML(it, mk)).join("");
    if (!body) body = `<div class="card empty" style="padding:24px">Слова «<span class="gr">${esc(clean)}</span>» пока нет в словаре сайта.<br>
      <button class="speak" data-say="${esc(clean)}">🔊</button></div>`;
    dict.innerHTML = `<div class="dict-head"><span class="muted">Словарь</span><b class="gr" style="font-size:1.2rem">${esc(clean)}</b>
      <span class="spacer"></span><button class="icon-btn" data-close aria-label="Закрыть">✕</button></div>
      <div class="stack">${body}</div>`;
    if (!dict.open) dict.showModal();
    dict.scrollTop = 0;
  }

  /** Греческий текст, где каждое слово открывает словарь */
  function clickableGreek(text) {
    return String(text).split(/(\s+|\/)/).map((tok) => {
      if (!tok || /^\s+$/.test(tok) || tok === "/") return tok === "/" ? " / " : tok;
      const m = tok.match(/^([«"(]*)(.*?)([.,!;:?…»");]*)$/);
      if (!m || !m[2]) return esc(tok);
      return `${esc(m[1])}<button class="w" data-word="${esc(m[2])}">${esc(m[2])}</button>${esc(m[3])}`;
    }).join("");
  }

  /* ================= Карточки ================= */
  views.cards = (root) => {
    const bar = h(`<div class="toolbar">
      <label>Набор <select id="deck">${DECKS.map((d) => `<option value="${d.id}">${d.name}</option>`).join("")}</select></label>
      <label id="topicWrap">Тема <select id="topic"></select></label>
      <label>Направление <select id="dir">
        <option value="gr-ru">Греческий → русский</option>
        <option value="ru-gr">Русский → греческий</option>
        <option value="mix">Вперемешку</option></select></label>
      <label class="chip ${UI.examOnly ? "on" : ""}" title="Слова, которые встречаются в образцах экзаменов ΚΕΓ"><input type="checkbox" id="exOnly" ${UI.examOnly ? "checked" : ""}>Только из экзаменов</label>
      <label>Режим <select id="mode">
        <option value="srs">Интервальное повторение</option>
        <option value="all">Все подряд</option></select></label>
    </div>`);
    root.appendChild(bar);
    const area = h(`<div></div>`);
    root.appendChild(area);

    const deckSel = $("#deck", bar), topicSel = $("#topic", bar);
    deckSel.value = UI.deck; $("#dir", bar).value = UI.dir; $("#mode", bar).value = UI.mode;
    function fillTopics() {
      const topics = [...new Set(items(UI.deck).map((i) => i.topic))];
      topicSel.innerHTML = `<option value="">Все темы</option>` + topics.map((t) => `<option>${esc(t)}</option>`).join("");
      if (!topics.includes(UI.topic)) UI.topic = "";
      topicSel.value = UI.topic;
      $("#topicWrap", bar).style.display = topics.length > 1 ? "" : "none";
    }
    fillTopics();
    bar.addEventListener("change", (e) => {
      UI.deck = deckSel.value; UI.dir = $("#dir", bar).value; UI.mode = $("#mode", bar).value;
      UI.examOnly = $("#exOnly", bar).checked; $("#exOnly", bar).parentElement.classList.toggle("on", UI.examOnly);
      if (e.target === deckSel) UI.topic = ""; else UI.topic = topicSel.value;
      saveUI(); fillTopics(); start();
    });

    let queue = [], idx = 0, flipped = false, tally = [0, 0, 0];

    function start(forceAll) {
      const pool = items(UI.deck, UI.topic, UI.examOnly);
      tally = [0, 0, 0]; idx = 0;
      if (UI.mode === "all" || forceAll) queue = shuffle(pool);
      else {
        const due = pool.filter(isDue).sort((a, b) => P[a.id].due - P[b.id].due);
        const fresh = shuffle(pool.filter((i) => !P[i.id])).slice(0, S.newPerSession);
        queue = shuffle(due).concat(fresh);
      }
      queue = queue.map((it) => ({ it, dir: UI.dir === "mix" ? (Math.random() < 0.5 ? "gr-ru" : "ru-gr") : UI.dir }));
      if (!queue.length) return emptyState(pool);
      render();
    }

    function emptyState(pool) {
      const next = pool.filter((i) => P[i.id]).map((i) => P[i.id].due).sort((a, b) => a - b)[0];
      area.innerHTML = "";
      const el = h(`<div class="card empty"><div class="big">🎉</div>
        <h2>На сегодня всё повторено</h2>
        <p>${next ? "Следующее повторение: " + new Date(next).toLocaleString("ru-RU", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }) : "В этом наборе нет карточек."}</p>
        <button class="btn primary">Пройти все карточки набора</button></div>`);
      $("button", el).addEventListener("click", () => start(true));
      area.appendChild(el);
      keyHandler = null;
    }

    function extras(it) {
      if (it.kind === "verbs") {
        const pp = GR.principalParts(it.verb);
        return `<div class="parts">${pp.map((x) => `<span>${esc(x)}</span>`).join("")}</div>
          <button class="btn small" data-verbdict style="margin-top:10px">📖 Все времена и лица</button>
          <div class="sub" style="font-size:13px">${GR.TYPE_NAMES[it.verb.p]}${it.verb.note ? " · " + esc(it.verb.note) : ""}</div>`;
      }
      if (it.kind === "nouns") return `<div class="sub ${gcls(it)}" style="font-size:14px">${it.gender ? GENDER_NAME[it.gender] : "множественное число"}</div>`;
      return "";
    }

    function render() {
      if (idx >= queue.length) return summary();
      flipped = false;
      const { it, dir } = queue[idx];
      const multi = (it.kind === "phrases" || it.kind === "words") && /\s/.test(it.gr.trim());
      const grSide = multi
        ? `<div class="main gr phrase">${clickableGreek(it.gr)}</div><div class="sub" style="font-size:13px">нажмите на слово — откроется словарь</div>`
        : `<div class="main gr">${grHTML(it)}</div>`;
      const ruSide = `<div class="main">${esc(it.ru)}</div>`;
      const meta = `<div class="meta"><span>${esc(it.topic)}</span><span>${it.ex ? `<span class="badge ex" title="Встречается в образцах экзаменов ΚΕΓ (${it.ex})">ΚΕΓ</span> ` : ""}<span class="badge ${it.lvl}">${it.lvl}</span></span></div>`;
      const speakBtn = `<button class="speak" data-say title="Произнести (S)">🔊</button>`;
      const front = dir === "gr-ru" ? grSide + speakBtn : ruSide + `<div class="sub">как это по-гречески?</div>`;
      const back = dir === "gr-ru"
        ? ruSide + `<div class="sub gr">${multi ? clickableGreek(it.gr) : esc(it.gr.replace(/\//g, " / "))}</div>` + extras(it)
        : grSide + extras(it) + speakBtn + `<div class="sub">${esc(it.ru)}</div>`;
      area.innerHTML = "";
      const pct = Math.round((idx / queue.length) * 100);
      area.appendChild(h(`<div>
        <div class="counter">${idx + 1} / ${queue.length} · ${P[it.id] ? "повторение (коробка " + P[it.id].b + ")" : "новая карточка"}</div>
        <div class="progressbar"><i style="width:${pct}%"></i></div>
        <div class="flash-wrap"><div class="flash">
          <div class="face front">${meta}${front}</div>
          <div class="face back">${meta}${back}</div>
        </div></div>
        <div class="grade" id="grade">
          <button class="btn primary" data-flip>Показать ответ <kbd>пробел</kbd></button>
        </div></div>`));
      const card = $(".flash", area);
      card.addEventListener("click", (e) => {
        const wbtn = e.target.closest("[data-word]");
        if (wbtn) { e.stopPropagation(); openDict(wbtn.dataset.word); return; }
        if (e.target.closest("[data-verbdict]")) { e.stopPropagation(); openDict(it.verb.v, it); return; }
        if (e.target.closest("[data-say]")) { e.stopPropagation(); speak(it.gr); return; }
        flip();
      });
      $("[data-flip]", area).addEventListener("click", flip);
      if (dir === "gr-ru" && S.autoSpeak) speak(it.gr);
    }

    function flip() {
      const card = $(".flash", area);
      flipped = !flipped;
      card.classList.toggle("flipped", flipped);
      const g = $("#grade", area);
      if (flipped && !g.dataset.ready) {
        g.dataset.ready = "1";
        g.innerHTML = `<button class="btn bad" data-q="0">Не помню <kbd>1</kbd></button>
          <button class="btn warn" data-q="1">Трудно <kbd>2</kbd></button>
          <button class="btn ok" data-q="2">Знаю <kbd>3</kbd></button>`;
        $$("[data-q]", g).forEach((b) => b.addEventListener("click", () => grade(Number(b.dataset.q))));
        if (queue[idx].dir === "ru-gr" && S.autoSpeak) speak(queue[idx].it.gr);
      }
    }

    function grade(q) {
      const entry = queue[idx];
      review(entry.it.id, q);
      logAnswer(q > 0, "cards");
      tally[q]++;
      if (q === 0) queue.splice(Math.min(idx + 4, queue.length), 0, { ...entry });
      idx++;
      render();
    }

    function summary() {
      area.innerHTML = "";
      const el = h(`<div class="card empty"><div class="big">✅</div>
        <h2>Сессия завершена</h2>
        <p>Знаю: <b>${tally[2]}</b> · Трудно: <b>${tally[1]}</b> · Не помню: <b>${tally[0]}</b></p>
        <div class="row" style="justify-content:center"><button class="btn primary" data-again>Ещё сессия</button>
        <a class="btn" href="#spelling/translate">Закрепить письмом</a></div></div>`);
      $("[data-again]", el).addEventListener("click", () => start());
      area.appendChild(el);
    }

    keyHandler = (e) => {
      if (!queue.length || idx >= queue.length) return;
      if (e.key === " " || e.key === "Enter") { e.preventDefault(); flip(); }
      else if (flipped && ["1", "2", "3"].includes(e.key)) grade(Number(e.key) - 1);
      else if (e.key.toLowerCase() === "s" || e.key.toLowerCase() === "ы") speak(queue[idx].it.gr);
    };
    start();
  };

  /* ================= Глаголы ================= */
  const levelTenses = () => GR.TENSES.filter((t) => lvlOk(t.lvl));
  const GROUPS = [
    { id: "all", name: "Все глаголы", f: () => true },
    { id: "irr", name: "Неправильные", f: (v) => v.p === "X" || !!v.futF || !!v.aorF },
    { id: "A", name: "Группа A (-ω)", f: (v) => v.p === "A" },
    { id: "B", name: "Группы B1/B2 (-άω, -ώ)", f: (v) => v.p === "B1" || v.p === "B2" },
    { id: "M", name: "На -ομαι / -άμαι", f: (v) => v.p === "M" || v.p === "MA" },
    { id: "new", name: "Только слова этого уровня", f: (v) => v.lvl === S.level },
  ];
  const verbPool = () => {
    const g = GROUPS.find((x) => x.id === UI.group) || GROUPS[0];
    return window.VERBS.filter((v) => lvlOk(v.lvl) && g.f(v));
  };
  function selectedTenses() {
    const avail = levelTenses().map((t) => t.id);
    let sel = (UI.tenses || avail).filter((t) => avail.includes(t));
    if (!sel.length) sel = avail;
    return sel;
  }
  function pickVerbTask() {
    const pool = verbPool(), tenses = selectedTenses();
    for (let k = 0; k < 100; k++) {
      const v = rnd(pool), t = rnd(tenses), c = GR.conjugate(v, t);
      if (c) return { v, t: GR.tenseInfo(t), c };
    }
    return null;
  }
  function conjTable(v, tid, hl = -1, matchKey = "") {
    const c = GR.conjugate(v, tid);
    if (!c) return `<p class="muted">—</p>`;
    const t = GR.tenseInfo(tid);
    const hit = (i) => matchKey && [c.forms[i]].concat(c.alts[i]).some((f) => formKey(f.split(" ").pop()) === matchKey);
    return `<table class="conj">${c.forms.map((f, i) => `<tr class="${i === hl || hit(i) ? "hl" : ""}"><td class="p">${GR.PRONOUNS[i]}</td>
      <td data-say="${esc((t.prefix ? t.prefix + " " : "") + f)}" style="cursor:pointer">${t.prefix ? `<span class="muted">${t.prefix}</span> ` : ""}${esc(f)}${c.alts[i].length ? ` <span class="muted" style="font-size:.85em">(${c.alts[i].map(esc).join(", ")})</span>` : ""}</td></tr>`).join("")}</table>`;
  }
  function bindSay(el) {
    el.addEventListener("click", (e) => { const s = e.target.closest("[data-say]"); if (s) speak(s.dataset.say); });
  }

  views.verbs = (root, sub) => {
    if (sub) UI.verbTab = sub;
    const tabs = h(`<div class="tabs">
      <button data-t="trainer">Тренажёр форм</button>
      <button data-t="fill">Заполни таблицу</button>
      <button data-t="tables">Таблицы глаголов</button></div>`);
    root.appendChild(tabs);
    const opts = h(`<div class="toolbar"></div>`);
    root.appendChild(opts);
    const area = h(`<div></div>`);
    root.appendChild(area);
    bindSay(area);

    function drawOpts() {
      if (UI.verbTab === "tables") { opts.innerHTML = ""; return; }
      const sel = selectedTenses();
      opts.innerHTML = levelTenses().map((t) => `<label class="chip ${sel.includes(t.id) ? "on" : ""}" title="${esc(t.gr)}"><input type="checkbox" value="${t.id}" ${sel.includes(t.id) ? "checked" : ""}>${esc(t.ru)}</label>`).join("")
        + `<span class="spacer"></span><select id="grp">${GROUPS.map((g) => `<option value="${g.id}">${g.name}</option>`).join("")}</select>`;
      $("#grp", opts).value = UI.group;
      opts.onchange = () => {
        UI.tenses = $$("input:checked", opts).map((i) => i.value);
        UI.group = $("#grp", opts).value; saveUI(); drawOpts(); show();
      };
    }
    function show() {
      $$("button", tabs).forEach((b) => b.classList.toggle("on", b.dataset.t === UI.verbTab));
      drawOpts();
      area.innerHTML = "";
      keyHandler = null;
      if (!verbPool().length) { area.innerHTML = `<div class="card empty">Нет глаголов для этого фильтра.</div>`; return; }
      ({ trainer: trainer, fill: fill, tables: tables })[UI.verbTab](area);
    }
    tabs.addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; UI.verbTab = b.dataset.t; saveUI(); show(); });

    const sc = { ok: 0, n: 0, streak: 0 };

    function trainer(area) {
      const task = pickVerbTask();
      if (!task) return;
      const p = Math.floor(Math.random() * 6);
      const { v, t, c } = task;
      const el = h(`<div class="card ex">
        <div class="score">Верно: <b>${sc.ok}</b> из <b>${sc.n}</b> · серия: <b>${sc.streak}</b></div>
        <div class="label">Глагол</div>
        <div class="prompt gr">${esc(v.v)} <button class="speak sm" data-say="${esc(v.v)}">🔊</button></div>
        <div class="muted">${esc(v.ru)}</div>
        <div class="tense">${esc(t.ru)} · <span class="gr">${esc(t.gr)}</span></div>
        <div class="answer-row"><div class="pron">${GR.PRONOUNS[p]}</div>${t.prefix ? `<div class="prefix">${t.prefix}</div>` : ""}</div>
        <div class="row" style="justify-content:center;margin-top:14px">
          <button class="btn primary" data-check>Проверить <kbd>⏎</kbd></button>
          <button class="btn" data-skip>Не знаю</button></div>
        <div class="feedback"></div></div>`);
      const { wrap, input } = greekInput(() => (answered ? next() : check()), GR.PERSONS_RU[p] + "…");
      $(".answer-row", el).appendChild(wrap);
      area.appendChild(el);
      input.focus();
      let answered = false;
      const next = () => show();
      function check(giveUp) {
        if (answered) return;
        if (!giveUp && !input.value.trim()) { input.focus(); return; }
        answered = true;
        const answers = [c.forms[p]].concat(c.alts[p]);
        const res = giveUp ? { ok: false } : GR.check(input.value, answers, { strict: S.strict, dropPrefix: t.prefix });
        sc.n++; if (res.ok) { sc.ok++; sc.streak++; } else sc.streak = 0;
        logAnswer(res.ok, "verbs");
        const full = (t.prefix ? t.prefix + " " : "") + c.forms[p];
        input.classList.add(res.ok && !res.accentOnly ? "ok" : res.accentOnly ? "acc" : "bad");
        input.readOnly = true;
        let msg;
        if (res.ok && !res.accentOnly) msg = `<div class="msg ok">Верно! ✓</div>`;
        else if (res.accentOnly) msg = `<div class="msg acc">${res.ok ? "Верно, но проверьте ударение" : "Ошибка в ударении"}</div><div class="correct">${GR.diffHTML(input.value, c.forms[p])}</div>`;
        else msg = `<div class="msg bad">${giveUp ? "Правильный ответ" : "Неверно"}</div><div class="correct">${t.prefix ? `<span class="muted">${t.prefix}</span> ` : ""}${giveUp ? esc(c.forms[p]) : GR.diffHTML(input.value, c.forms[p])}</div>`;
        $(".feedback", el).innerHTML = msg + `<div style="max-width:380px;margin:14px auto 0;text-align:left">${conjTable(v, t.id, p)}</div>
          ${v.note ? `<p class="muted" style="font-size:14px">${esc(v.note)}</p>` : ""}
          <button class="btn primary" data-next style="margin-top:10px">Дальше <kbd>⏎</kbd></button>`;
        $("[data-next]", el).addEventListener("click", next);
        $("[data-check]", el).style.display = "none"; $("[data-skip]", el).style.display = "none";
        if (S.autoSpeak || !res.ok) speak(full);
        input.focus();
      }
      $("[data-check]", el).addEventListener("click", () => check());
      $("[data-skip]", el).addEventListener("click", () => check(true));
    }

    function fill(area) {
      const task = pickVerbTask();
      if (!task) return;
      const { v, t, c } = task;
      const el = h(`<div class="card ex">
        <div class="label">Проспрягайте</div>
        <div class="prompt gr">${esc(v.v)} <button class="speak sm" data-say="${esc(v.v)}">🔊</button></div>
        <div class="muted">${esc(v.ru)}</div>
        <div class="tense">${esc(t.ru)} · <span class="gr">${esc(t.gr)}</span></div>
        <table class="conj fill" style="max-width:460px;margin:0 auto">${GR.PRONOUNS.map((pr, i) => `<tr><td class="p">${pr}</td>
          <td>${t.prefix ? `<span class="muted gr">${t.prefix}</span>` : ""}</td><td><input data-i="${i}"><div class="fix"></div></td></tr>`).join("")}</table>
        <div class="row" style="justify-content:center;margin-top:16px">
          <button class="btn primary" data-check>Проверить</button>
          <button class="btn" data-next>Другой глагол</button></div>
        <div class="feedback"></div></div>`);
      area.appendChild(el);
      const inputs = $$("input", el);
      let checked = false;
      inputs.forEach((inp, i) => attachGreek(inp, () => {
        if (checked) return show();
        if (i < 5) inputs[i + 1].focus(); else check();
      }));
      inputs[0].focus();
      function check() {
        if (checked) return;
        checked = true;
        let good = 0;
        inputs.forEach((inp, i) => {
          const res = GR.check(inp.value, [c.forms[i]].concat(c.alts[i]), { strict: S.strict, dropPrefix: t.prefix });
          inp.readOnly = true;
          inp.classList.add(res.ok && !res.accentOnly ? "ok" : res.accentOnly ? "acc" : "bad");
          if (res.ok) good++;
          else inp.nextElementSibling.innerHTML = inp.value.trim() ? GR.diffHTML(inp.value, c.forms[i]) : esc(c.forms[i]);
          if (res.ok && res.accentOnly) inp.nextElementSibling.innerHTML = GR.diffHTML(inp.value, c.forms[i]);
          logAnswer(res.ok, "verbs");
        });
        $(".feedback", el).innerHTML = `<div class="msg ${good === 6 ? "ok" : good >= 4 ? "acc" : "bad"}">${good} из 6 ${good === 6 ? "— отлично! 🎉" : ""}</div>
          ${v.note ? `<p class="muted" style="font-size:14px">${esc(v.note)}</p>` : ""}`;
        $("[data-check]", el).style.display = "none";
        $("[data-next]", el).textContent = "Следующий глагол ⏎";
        inputs[5].focus();
      }
      $("[data-check]", el).addEventListener("click", check);
      $("[data-next]", el).addEventListener("click", () => show());
    }

    function tables(area) {
      const wrap = h(`<div class="stack">
        <input class="search" placeholder="Поиск: γράφω или «писать»">
        <div class="verb-list"></div></div>`);
      area.appendChild(wrap);
      const list = $(".verb-list", wrap), q = $("input", wrap);
      attachGreek(q);
      const draw = () => {
        const s = GR.stripAll(q.value.trim().toLowerCase());
        const vs = window.VERBS.filter((v) => lvlOk(v.lvl) && (!s || GR.stripAll(v.v).includes(s) || v.ru.toLowerCase().includes(s)));
        list.innerHTML = vs.map((v) => `<button data-v="${esc(v.v)}"><span class="gr">${esc(v.v)}</span><small>${esc(v.ru)} · ${v.lvl}</small></button>`).join("") || `<p class="muted">Ничего не найдено</p>`;
      };
      q.addEventListener("input", draw);
      draw();
      list.addEventListener("click", (e) => {
        const b = e.target.closest("[data-v]"); if (!b) return;
        detail(window.VERBS.find((v) => v.v === b.dataset.v));
      });
      function detail(v) {
        area.innerHTML = "";
        const el = h(`<div class="stack">
          <div class="row"><button class="btn small" data-back>← Все глаголы</button></div>
          <div class="card"><div class="row">
            <h1 class="gr" style="margin:0">${esc(v.v)}</h1><button class="speak sm" data-say="${esc(v.v)}">🔊</button>
            <span class="badge ${v.lvl}">${v.lvl}</span></div>
            <p style="margin:6px 0 0">${esc(v.ru)} · <span class="muted">${GR.TYPE_NAMES[v.p]}</span></p>
            ${v.note ? `<p class="muted" style="margin:6px 0 0">${esc(v.note)}</p>` : ""}
            <p class="muted" style="margin:6px 0 0;font-size:13px">Нажмите на форму, чтобы услышать её.</p></div>
          <div class="tables">${levelTenses().map((t) => `<div class="card"><h3>${esc(t.ru)}</h3><div class="grn gr">${esc(t.gr)}</div>${conjTable(v, t.id)}</div>`).join("")}</div>
        </div>`);
        $("[data-back]", el).addEventListener("click", show);
        area.appendChild(el);
        window.scrollTo(0, 0);
      }
    }

    show();
  };

  /* ================= Правописание ================= */
  function checkVocab(it, value) {
    // у прилагательных проверяем только мужской род: «κρύος -α -ο» → «κρύος»
    let res = GR.check(value, it.kind === "adjectives" ? it.word : it.gr, { strict: S.strict });
    if (!res.ok && !res.accentOnly && it.kind === "nouns") {
      const bare = it.gr.split("/").map((x) => x.split(" ").slice(1).join(" "));
      const r2 = GR.check(value, bare, { strict: S.strict });
      if (r2.ok || r2.accentOnly) { r2.noArticle = true; r2.best = it.gr.split("/")[bare.indexOf(r2.best)] || it.gr.split("/")[0]; return r2; }
    }
    return res;
  }
  function feedbackHTML(res, value, it) {
    const best = res.best || it.gr.split("/")[0];
    let html;
    if (res.ok && !res.accentOnly) html = `<div class="msg ok">Верно! ✓</div>`;
    else if (res.accentOnly) html = `<div class="msg acc">${res.ok ? "Верно, но проверьте ударение" : "Ошибка в ударении"}</div><div class="correct">${GR.diffHTML(value, res.noArticle ? best.split(" ").slice(1).join(" ") : best)}</div>`;
    else html = `<div class="msg bad">${value.trim() ? "Неверно" : "Ответ"}</div><div class="correct">${value.trim() ? GR.diffHTML(value, best) : esc(best)}</div>`;
    if (res.noArticle) html += `<p class="muted">Учите вместе с артиклем: <b class="gr ${gcls(it)}">${esc(it.gr.split("/")[0])}</b></p>`;
    if (it.kind === "nouns" && it.gender && !res.noArticle && !(res.ok && !res.accentOnly)) html += `<p class="muted">${GENDER_NAME[it.gender]}</p>`;
    return html;
  }

  function genderHint(it) {
    const w = GR.stripTonos(it.word);
    let exp = null, end = "";
    if (/ος$/.test(w)) { exp = "м"; end = "-ος"; }
    else if (/(ας|ης|ες)$/.test(w)) { exp = "м"; end = "-" + w.slice(-2); }
    else if (/μα$/.test(w)) { exp = "ср"; end = "-μα"; }
    else if (/[αη]$/.test(w)) { exp = "ж"; end = "-" + w.slice(-1); }
    else if (/(ο|ι)$/.test(w)) { exp = "ср"; end = "-" + w.slice(-1); }
    if (!exp) return "Несклоняемые заимствования (на -ου, -ε, -ι и т.п.) обычно среднего рода.";
    if (exp === it.gender) return `Окончание <b class="gr">${end}</b> → ${GENDER_NAME[exp]}.`;
    return `<b>Исключение!</b> Окончание <b class="gr">${end}</b> обычно даёт ${GENDER_NAME[exp]}, а это слово — ${GENDER_NAME[it.gender]}.`;
  }

  views.spelling = (root, sub) => {
    if (sub) UI.spellTab = sub;
    const TABS = [
      ["dictation", "🎧 Диктант"], ["translate", "📝 Перевод"], ["choice", "✍️ Выбери написание"],
      ["accent", "🎯 Ударение"], ["gender", "🧩 Род ο/η/το"],
    ];
    const tabs = h(`<div class="tabs">${TABS.map(([id, n]) => `<button data-t="${id}">${n}</button>`).join("")}</div>`);
    root.appendChild(tabs);
    const bar = h(`<div class="toolbar"><label>Слова <select id="sdeck">${DECKS.map((d) => `<option value="${d.id}">${d.name}</option>`).join("")}</select></label>
      <label class="chip ${UI.examOnly ? "on" : ""}"><input type="checkbox" id="sExOnly" ${UI.examOnly ? "checked" : ""}>Только из экзаменов</label>
      <span class="spacer"></span><span class="muted" style="font-size:13px" id="poolInfo"></span></div>`);
    root.appendChild(bar);
    const area = h(`<div></div>`);
    root.appendChild(area);
    bindSay(area);
    $("#sdeck", bar).value = UI.spellDeck;
    $("#sdeck", bar).addEventListener("change", (e) => { UI.spellDeck = e.target.value; saveUI(); show(); });
    $("#sExOnly", bar).addEventListener("change", (e) => { UI.examOnly = e.target.checked; e.target.parentElement.classList.toggle("on", UI.examOnly); saveUI(); show(); });
    tabs.addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; UI.spellTab = b.dataset.t; saveUI(); history.replaceState(null, "", "#spelling/" + UI.spellTab); show(); });

    const sc = { ok: 0, n: 0 };
    let last = null;
    const pickFrom = (pool) => { let it; for (let k = 0; k < 6; k++) { it = rnd(pool); if (it !== last) break; } last = it; return it; };
    const scoreHTML = () => `<div class="score">Верно: <b>${sc.ok}</b> из <b>${sc.n}</b></div>`;
    const single = (it) => !/\s/.test(it.word) && it.kind !== "phrases";

    function pool() {
      const base = items(UI.spellDeck, "", UI.examOnly);
      switch (UI.spellTab) {
        case "choice": return base.filter(single);
        case "accent": return base.filter((i) => single(i) && GR.accentTask(i.word));
        case "gender": return items("nouns").filter((i) => i.gender);
        default: return base;
      }
    }

    function show() {
      $$("button", tabs).forEach((b) => b.classList.toggle("on", b.dataset.t === UI.spellTab));
      bar.style.display = UI.spellTab === "gender" ? "none" : "";
      area.innerHTML = ""; keyHandler = null;
      const p = pool();
      $("#poolInfo", bar).textContent = p.length + " слов";
      if (!p.length) { area.innerHTML = `<div class="card empty">В этом наборе нет подходящих слов — выберите другой.</div>`; return; }
      ({ dictation: () => typing(p, true), translate: () => typing(p, false), choice: () => choice(p), accent: () => accent(p), gender: () => gender(p) })[UI.spellTab]();
    }

    function typing(p, dictation) {
      const it = pickFrom(p);
      const noVoice = dictation && (!hasTTS || !voice);
      const el = h(`<div class="card ex">${scoreHTML()}
        ${dictation ? `<div class="label">Послушайте и напишите</div>
          <div class="row" style="justify-content:center;margin:10px 0">
            <button class="btn primary" data-play>🔊 Ещё раз</button><button class="btn" data-slow>🐢 Медленно</button>
            <button class="btn" data-hint>Подсказка</button></div>
          <div class="muted" data-hinttext style="min-height:24px">${noVoice ? esc(it.ru) : ""}</div>
          ${noVoice ? `<p class="muted" style="font-size:13px">Греческий голос не найден — показываю перевод. Установите голос «Ελληνικά» в настройках системы.</p>` : ""}`
        : `<div class="label">Напишите по-гречески</div><div class="prompt">${esc(it.ru)}</div>
          <div class="muted" style="font-size:14px">${esc(it.topic)}${it.kind === "nouns" ? " · с артиклем" : ""}</div>`}
        <div class="answer-row"></div>
        <div class="row" style="justify-content:center;margin-top:14px">
          <button class="btn primary" data-check>Проверить <kbd>⏎</kbd></button><button class="btn" data-skip>Не знаю</button></div>
        <div class="feedback"></div></div>`);
      const { wrap, input } = greekInput(() => (answered ? show() : check()));
      $(".answer-row", el).appendChild(wrap);
      area.appendChild(el);
      input.focus();
      let answered = false;
      if (dictation) {
        setTimeout(() => speak(it.gr), 250);
        $("[data-play]", el).addEventListener("click", () => { speak(it.gr); input.focus(); });
        $("[data-slow]", el).addEventListener("click", () => { speak(it.gr, true); input.focus(); });
        $("[data-hint]", el).addEventListener("click", () => { $("[data-hinttext]", el).textContent = it.ru; input.focus(); });
      }
      function check(giveUp) {
        if (answered) return;
        if (!giveUp && !input.value.trim()) { input.focus(); return; }
        answered = true;
        const res = giveUp ? { ok: false } : checkVocab(it, input.value);
        sc.n++; if (res.ok) sc.ok++;
        logAnswer(res.ok, "spelling");
        if (P[it.id] || res.ok === false) review(it.id, res.ok ? 2 : 0);
        input.readOnly = true;
        input.classList.add(res.ok && !res.accentOnly ? "ok" : res.accentOnly ? "acc" : "bad");
        $(".feedback", el).innerHTML = feedbackHTML(res, giveUp ? "" : input.value, it)
          + `<p><span class="gr">${grHTML(it)}</span> — ${esc(it.ru)} <button class="speak sm" data-say="${esc(it.gr)}">🔊</button></p>
          <button class="btn primary" data-next>Дальше <kbd>⏎</kbd></button>`;
        $("[data-next]", el).addEventListener("click", show);
        $("[data-check]", el).style.display = "none"; $("[data-skip]", el).style.display = "none";
        if (!dictation) speak(it.gr);
        input.focus();
      }
      $("[data-check]", el).addEventListener("click", () => check());
      $("[data-skip]", el).addEventListener("click", () => check(true));
    }

    function choice(p) {
      let it, wrong;
      for (let k = 0; k < 30; k++) {
        it = pickFrom(p);
        wrong = shuffle(GR.misspellings(it.word, REAL_WORDS)).slice(0, 3);
        if (wrong.length === 3) break;
      }
      const correct = it.word;
      const opts = shuffle([correct].concat(wrong));
      const pre = it.kind === "nouns" ? it.art + " " : "";
      const el = h(`<div class="card ex">${scoreHTML()}
        <div class="label">Выберите правильное написание</div>
        <div class="prompt">${esc(it.ru)}</div>
        <button class="speak" data-say="${esc(it.gr)}">🔊</button>
        <div class="options">${opts.map((o, i) => `<button data-o="${esc(o)}"><span class="k">${i + 1}</span>${esc(pre + o)}</button>`).join("")}</div>
        <div class="feedback"></div></div>`);
      area.appendChild(el);
      let done = false;
      function answer(o) {
        if (done) return; done = true;
        const ok = o === correct;
        sc.n++; if (ok) sc.ok++;
        logAnswer(ok, "spelling");
        $$("[data-o]", el).forEach((b) => {
          b.disabled = true;
          if (b.dataset.o === correct) b.classList.add("ok");
          else if (b.dataset.o === o) b.classList.add("bad");
        });
        $(".feedback", el).innerHTML = `<div class="msg ${ok ? "ok" : "bad"}">${ok ? "Верно! ✓" : "Неверно"}</div>
          ${ok ? "" : `<div class="correct">${GR.diffHTML(o, correct)}</div>`}
          <button class="btn primary" data-next style="margin-top:10px">Дальше <kbd>⏎</kbd></button>`;
        $("[data-next]", el).addEventListener("click", show);
        speak(it.gr);
      }
      $$("[data-o]", el).forEach((b) => b.addEventListener("click", () => answer(b.dataset.o)));
      keyHandler = (e) => {
        if (done && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); show(); }
        else if (!done && ["1", "2", "3", "4"].includes(e.key)) answer(opts[Number(e.key) - 1]);
      };
    }

    function accent(p) {
      const it = pickFrom(p);
      const task = GR.accentTask(it.word);
      const el = h(`<div class="card ex">${scoreHTML()}
        <div class="label">Нажмите на гласную под ударением</div>
        <div class="prompt" style="font-size:1.3rem">${esc(it.ru)}</div>
        <div class="letters">${task.units.map((u, i) => (task.vowel[i] ? `<button data-i="${i}">${esc(u)}</button>` : `<span>${esc(u)}</span>`)).join("")}</div>
        <div class="feedback"></div></div>`);
      area.appendChild(el);
      let done = false;
      $$("[data-i]", el).forEach((b) => b.addEventListener("click", () => {
        if (done) return; done = true;
        const i = Number(b.dataset.i), ok = i === task.answer;
        sc.n++; if (ok) sc.ok++;
        logAnswer(ok, "spelling");
        $$("[data-i]", el).forEach((x) => { x.disabled = true; if (Number(x.dataset.i) === task.answer) x.classList.add("ok"); });
        if (!ok) b.classList.add("bad");
        $(".feedback", el).innerHTML = `<div class="msg ${ok ? "ok" : "bad"}">${ok ? "Верно! ✓" : "Неверно"}</div>
          <div class="correct">${grHTML(it)} <button class="speak sm" data-say="${esc(it.gr)}">🔊</button></div>
          <button class="btn primary" data-next style="margin-top:10px">Дальше <kbd>⏎</kbd></button>`;
        $("[data-next]", el).addEventListener("click", show);
        speak(it.gr);
      }));
      keyHandler = (e) => { if (done && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); show(); } };
    }

    function gender(p) {
      const it = pickFrom(p);
      const OPTS = [["ο", "м"], ["η", "ж"], ["το", "ср"]];
      const el = h(`<div class="card ex">${scoreHTML()}
        <div class="label">Какой артикль?</div>
        <div class="prompt gr">… ${esc(it.word)}</div>
        <div class="muted">${esc(it.ru)}</div>
        <div class="options three">${OPTS.map(([a, g], i) => `<button data-g="${g}" class="gr"><span class="k">${i + 1}</span><span class="art-${GENDER_CLS[g]}">${a}</span></button>`).join("")}</div>
        <div class="feedback"></div></div>`);
      area.appendChild(el);
      let done = false;
      function answer(g) {
        if (done) return; done = true;
        const ok = g === it.gender;
        sc.n++; if (ok) sc.ok++;
        logAnswer(ok, "gender");
        $$("[data-g]", el).forEach((b) => { b.disabled = true; if (b.dataset.g === it.gender) b.classList.add("ok"); else if (b.dataset.g === g) b.classList.add("bad"); });
        $(".feedback", el).innerHTML = `<div class="msg ${ok ? "ok" : "bad"}">${ok ? "Верно! ✓" : "Неверно"}</div>
          <div class="correct">${grHTML(it)} <button class="speak sm" data-say="${esc(it.gr)}">🔊</button></div>
          <p class="muted">${genderHint(it)}</p>
          <button class="btn primary" data-next>Дальше <kbd>⏎</kbd></button>`;
        $("[data-next]", el).addEventListener("click", show);
        speak(it.gr);
      }
      $$("[data-g]", el).forEach((b) => b.addEventListener("click", () => answer(b.dataset.g)));
      keyHandler = (e) => {
        if (done && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); show(); }
        else if (!done && ["1", "2", "3"].includes(e.key)) answer(OPTS[Number(e.key) - 1][1]);
      };
    }

    show();
  };

  /* ================= Справочник ================= */
  const ALPHABET = [
    ["Α α", "άλφα", "а"], ["Β β", "βήτα", "в"], ["Γ γ", "γάμμα", "фрикативное г; перед е/и — й"], ["Δ δ", "δέλτα", "ð — как англ. th в this"],
    ["Ε ε", "έψιλον", "э"], ["Ζ ζ", "ζήτα", "з"], ["Η η", "ήτα", "и"], ["Θ θ", "θήτα", "θ — как англ. th в think"],
    ["Ι ι", "γιώτα", "и"], ["Κ κ", "κάππα", "к"], ["Λ λ", "λάμδα", "л"], ["Μ μ", "μι", "м"],
    ["Ν ν", "νι", "н"], ["Ξ ξ", "ξι", "кс"], ["Ο ο", "όμικρον", "о"], ["Π π", "πι", "п"],
    ["Ρ ρ", "ρο", "р"], ["Σ σ ς", "σίγμα", "с"], ["Τ τ", "ταυ", "т"], ["Υ υ", "ύψιλον", "и"],
    ["Φ φ", "φι", "ф"], ["Χ χ", "χι", "х"], ["Ψ ψ", "ψι", "пс"], ["Ω ω", "ωμέγα", "о"],
  ];
  views.grammar = (root) => {
    root.appendChild(h(`<h1>Справочник</h1>`));
    const alpha = h(`<details class="ref-sec"><summary>🔤 Алфавит и произношение</summary><div class="body">
      <table class="ref">${ALPHABET.map(([l, n, p]) => `<tr><td class="gr" style="font-size:1.2rem;width:80px">${l}</td><td class="gr" data-say="${n}" style="cursor:pointer">${n} 🔊</td><td>[${p}]</td></tr>`).join("")}</table>
      </div></details>`);
    bindSay(alpha);
    root.appendChild(alpha);
    let group = "";
    window.REFERENCE.filter((r) => lvlOk(r.lvl)).forEach((r, i) => {
      if (r.group !== group) { group = r.group; root.appendChild(h(`<div class="ref-group">${esc(group)}</div>`)); }
      root.appendChild(h(`<details class="ref-sec" ${i === 0 ? "open" : ""}><summary>${esc(r.title)} ${r.lvl === "B1" ? `<span class="badge B1">B1</span>` : ""}</summary><div class="body">${r.html}</div></details>`));
    });
  };

  /* ================= Прогресс ================= */
  views.stats = (root) => {
    const all = items();
    const tot = Object.values(LOG).reduce((a, e) => ({ n: a.n + e.n, ok: a.ok + e.ok }), { n: 0, ok: 0 });
    const boxes = [0, 0, 0, 0, 0, 0, 0];
    all.forEach((i) => boxes[P[i.id] ? P[i.id].b : 0]++);
    const max = Math.max(...boxes, 1);
    const days = [];
    for (let k = 29; k >= 0; k--) { const d = new Date(); d.setDate(d.getDate() - k); days.push(LOG[dayKey(d)] || { n: 0 }); }
    const dmax = Math.max(...days.map((d) => d.n), 1);
    const rows = DECKS.slice(1).map((d) => {
      const its = items(d.id);
      return `<tr><td>${d.name}</td><td>${its.length}</td><td>${its.filter((i) => P[i.id]).length}</td><td>${its.filter((i) => P[i.id] && P[i.id].b >= 4).length}</td><td>${its.filter(isDue).length}</td></tr>`;
    }).join("");
    const el = h(`<div class="stack">
      <h1>Прогресс <span class="badge">${S.level}</span></h1>
      <div class="kpis">
        <div class="kpi"><b>${tot.n}</b><span>всего ответов</span></div>
        <div class="kpi"><b>${tot.n ? Math.round((tot.ok / tot.n) * 100) + "%" : "—"}</b><span>точность</span></div>
        <div class="kpi"><b>${streak()}</b><span>дней подряд</span></div>
        <div class="kpi"><b>${all.filter((i) => P[i.id]).length}</b><span>карточек в работе</span></div>
        <div class="kpi"><b>${all.filter((i) => P[i.id] && P[i.id].b >= 4).length}</b><span>выучено (коробка 4+)</span></div>
      </div>
      <div class="card"><h2>Коробки Лейтнера</h2>
        <p class="muted" style="margin-top:0;font-size:14px">Чем правее, тем реже карточка повторяется: 1 → сегодня, 2 → через день, 3 → 3 дня, 4 → неделя, 5 → 16 дней, 6 → месяц.</p>
        <div class="boxes" style="margin-top:28px">${boxes.map((b) => `<div style="height:${(b / max) * 100}%"><span>${b}</span></div>`).join("")}</div>
        <div class="box-labels"><span>новые</span><span>1</span><span>2</span><span>3</span><span>4</span><span>5</span><span>6</span></div></div>
      <div class="card"><h2>Активность за 30 дней</h2>
        <div class="heat">${days.map((d) => `<i title="${d.n} ответов" style="${d.n ? `background:var(--blue);opacity:${0.25 + 0.75 * (d.n / dmax)}` : ""}"></i>`).join("")}</div></div>
      <div class="card"><h2>По наборам</h2>
        <table class="ref"><tr><th>Набор</th><th>Всего</th><th>В работе</th><th>Выучено</th><th>К повторению</th></tr>${rows}</table></div>
      <div class="card"><h2>Данные</h2>
        <p class="muted" style="margin-top:0;font-size:14px">Прогресс хранится только в этом браузере (localStorage). Сохраните копию, чтобы перенести его.</p>
        <div class="row"><button class="btn" data-export>Скопировать прогресс</button>
          <button class="btn" data-file>Скачать файл</button>
          <label class="btn">Загрузить файл<input type="file" accept="application/json,.json" hidden data-import></label>
          <span class="spacer"></span><button class="btn bad" data-reset>Сбросить прогресс</button></div>
        <textarea data-json rows="4" placeholder="Сюда можно вставить скопированный прогресс с другого устройства" style="width:100%;margin-top:12px;font:13px ui-monospace,monospace;padding:10px;border-radius:10px;border:1px solid var(--border);background:var(--surface-2);color:var(--text)"></textarea>
        <div class="row" style="margin-top:8px"><button class="btn small" data-paste>Загрузить из текста</button></div></div>
    </div>`);
    const dump = () => JSON.stringify({ progress: P, log: LOG, settings: S });
    function applyData(text) {
      try {
        const data = JSON.parse(text);
        if (!data.progress && !data.log) throw new Error("empty");
        if (data.progress) { P = data.progress; saveP(); }
        if (data.log) { LOG = data.log; saveLog(); }
        toast("Прогресс загружен"); route();
      } catch (err) { toast("Не удалось прочитать данные"); }
    }
    $("[data-export]", el).addEventListener("click", async () => {
      const ta = $("[data-json]", el);
      ta.value = dump();
      try { await navigator.clipboard.writeText(ta.value); toast("Скопировано. Вставьте этот текст на другом устройстве."); }
      catch (err) { ta.select(); toast("Текст в поле ниже — скопируйте его вручную"); }
    });
    $("[data-file]", el).addEventListener("click", () => {
      try {
        const blob = new Blob([dump()], { type: "application/json" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob); a.download = `greek-progress-${dayKey()}.json`; a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      } catch (err) { toast("Скачивание недоступно — используйте «Скопировать прогресс»"); }
    });
    $("[data-import]", el).addEventListener("change", async (e) => {
      const f = e.target.files[0]; if (f) applyData(await f.text());
    });
    $("[data-paste]", el).addEventListener("click", () => applyData($("[data-json]", el).value));
    let armed = false;
    $("[data-reset]", el).addEventListener("click", (e) => {
      if (!armed) { armed = true; e.target.textContent = "Точно удалить всё? Нажмите ещё раз"; setTimeout(() => { armed = false; e.target.textContent = "Сбросить прогресс"; }, 4000); return; }
      P = {}; LOG = {}; saveP(); saveLog(); toast("Прогресс сброшен"); route();
    });
    root.appendChild(el);
  };

  route();
})();
