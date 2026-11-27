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
  // Счётчики ответов хранятся отдельно для каждого устройства и при синхронизации складываются,
  // поэтому ответы, данные на двух устройствах в один день, не теряются.
  const DEV = store.get("gr.device", null) || (() => { const id = Math.random().toString(36).slice(2, 10) + Date.now().toString(36); store.set("gr.device", id); return id; })();
  let LOGS = store.get("gr.logs", null) || { [DEV]: store.get("gr.log", {}) };
  const sumLogs = (L) => {
    const out = {};
    Object.values(L).forEach((days) => Object.entries(days || {}).forEach(([day, e]) => {
      const o = out[day] || (out[day] = { n: 0, ok: 0 });
      Object.entries(e).forEach(([k, v]) => { if (typeof v === "number") o[k] = (o[k] || 0) + v; });
    }));
    return out;
  };
  let LOG = sumLogs(LOGS);
  const saveS = () => store.set("gr.settings", S);
  const saveUI = () => store.set("gr.ui", UI);
  const saveP = () => store.set("gr.progress", P);
  const saveLog = () => { LOG = sumLogs(LOGS); store.set("gr.logs", LOGS); };

  let SYNC = null; // активная синхронизация (js/sync.js)
  const syncSend = (obj) => { if (SYNC) SYNC.broadcast(obj); };

  function logAnswer(ok, kind) {
    const t = dayKey();
    const mine = LOGS[DEV] || (LOGS[DEV] = {});
    const e = mine[t] || (mine[t] = { n: 0, ok: 0 });
    e.n++; if (ok) e.ok++;
    e[kind] = (e[kind] || 0) + 1;
    saveLog();
    syncSend({ t: "delta", logs: { [DEV]: { [t]: e } } });
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
    syncSend({ t: "delta", P: { [id]: p } });
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
    const dd = $("#dict"); if (dd && dd.open) dd.close();
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
        <a class="card tile" href="#morph"><div class="ico">🌳</div><h3>Словообразование</h3><p>Приставки, суффиксы и семьи слов: одно правило — десятки слов</p></a>
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
    const keys = new Set([mk].concat(hits.map((it) => formKey(it.kind === "verbs" ? it.verb.v : it.word || it.gr))));
    const mo = morphHTML(keys);
    if (mo && !hits.length) body += mo;
    body += verbs.map((it) => verbEntryHTML(it, mk)).join("");
    if (mo && hits.length) body += mo;
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

  /* ================= Словообразование: данные и словарь ================= */
  const MORPH = window.MORPH || { groups: [], families: [] };
  const MORPH_ITEMS = MORPH.groups.flatMap((g) => g.items.map((it) => Object.assign(it, { gtitle: g.title })));
  MORPH_ITEMS.forEach((it) => it.ex.forEach((e) => { e.aff = it; }));
  const MORPH_EX = MORPH_ITEMS.flatMap((it) => it.ex);
  let MORPH_IDX = null;
  function morphIndex() {
    if (MORPH_IDX) return MORPH_IDX;
    const d = new Map(), b = new Map(), f = new Map();
    const push = (m, k, v) => { k = formKey(k); let a = m.get(k); if (!a) m.set(k, (a = [])); if (!a.includes(v)) a.push(v); };
    MORPH_EX.forEach((e) => { push(d, e.w, e); e.base.split("+").forEach((x) => x.trim() && push(b, x.trim(), e)); });
    MORPH.families.forEach((fam) => fam.w.forEach((x) => push(f, x.w, fam)));
    return (MORPH_IDX = { d, b, f });
  }
  // варианты аффикса: «συν- / συμ-» → приставки, «-ση / -ψη» → суффиксы
  function affixParts(aff) {
    if (aff.parts) return aff.parts;
    const pre = [], suf = [];
    (aff.a.match(/[(]?[Ͱ-Ͽἀ-῿()]*-[Ͱ-Ͽἀ-῿()]*[)]?/g) || []).forEach((t) => {
      t = t.replace(/^\((.*)\)$/, "$1");
      const vs = /\(/.test(t) ? [t.replace(/[()]/g, ""), t.replace(/\(.*?\)/g, "")] : [t];
      vs.forEach((v) => {
        if (v.startsWith("-") && v.endsWith("-")) return;
        if (v.endsWith("-")) { const x = formKey(v.slice(0, -1)); pre.push(x); if (/[αεοι]$/.test(x)) pre.push(x.slice(0, -1)); }
        else if (v.startsWith("-")) suf.push(formKey(v.slice(1)));
      });
    });
    return (aff.parts = { pre: pre.filter(Boolean).sort((a, b) => b.length - a.length), suf: suf.filter(Boolean).sort((a, b) => b.length - a.length) });
  }
  /** Слово с подсвеченной приставкой или суффиксом */
  function affHL(w, aff) {
    const k = formKey(w), { pre, suf } = affixParts(aff);
    const p = pre.find((x) => k.startsWith(x) && k.length > x.length + 1);
    if (p) return `<b class="aff-hl">${esc(w.slice(0, p.length))}</b>${esc(w.slice(p.length))}`;
    const s = suf.find((x) => k.endsWith(x) && k.length > x.length + 1);
    if (s) return `${esc(w.slice(0, w.length - s.length))}<b class="aff-hl">${esc(w.slice(w.length - s.length))}</b>`;
    return esc(w);
  }
  const wordBtn = (w) => `<button class="w gr" data-dict="${esc(w)}">${esc(w)}</button>`;
  function morphHTML(keys) {
    const { d, b, f } = morphIndex();
    const der = [], from = [], fams = [];
    keys.forEach((k) => {
      (d.get(k) || []).forEach((e) => der.includes(e) || der.push(e));
      (b.get(k) || []).forEach((e) => from.includes(e) || from.push(e));
      (f.get(k) || []).forEach((x) => fams.includes(x) || fams.push(x));
    });
    if (!der.length && !from.length && !fams.length) return "";
    let html = `<div class="card morph-card" style="padding:16px"><h3 style="margin:0 0 8px">🧩 Словообразование</h3>`;
    der.forEach((e) => {
      html += `<p style="margin:0 0 8px"><span class="gr" style="font-size:1.25rem">${affHL(e.w, e.aff)}</span>
        <button class="speak sm" data-say="${esc(e.w)}">🔊</button> — ${esc(e.ru)}<br>
        <span class="muted" style="font-size:14px"><b class="gr aff-hl">${esc(e.aff.a)}</b> ${esc(e.aff.ru)}${e.base ? ` + ${e.base.split("+").map((x) => wordBtn(x.trim())).join(" + ")} (${esc(e.baseRu)})` : ""}</span></p>`;
    });
    const fromOnly = from.filter((e) => !der.includes(e));
    if (fromOnly.length) html += `<p style="margin:0 0 8px"><span class="muted">Образованные слова:</span> ${fromOnly.map((e) => `${wordBtn(e.w)} <span class="muted" style="font-size:13px">${esc(e.ru)}</span>`).join(" · ")}</p>`;
    fams.forEach((fam) => {
      html += `<p style="margin:0 0 6px"><span class="muted">Семья</span> <b class="gr">${esc(fam.root)}</b> <span class="muted">(${esc(fam.ru)}):</span>
        ${fam.w.map((x) => wordBtn(x.w)).join(" · ")}</p>`;
    });
    return html + `</div>`;
  }
  const hasMorph = (k) => { const { d, b, f } = morphIndex(); k = formKey(k); return d.has(k) || b.has(k) || f.has(k); };

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
          <button class="btn small" data-verbdict style="margin-top:10px">📖 Все времена и лица</button>${hasMorph(it.verb.v) ? ` <button class="btn small" data-morphdict style="margin-top:10px">🧩 Однокоренные</button>` : ""}
          <div class="sub" style="font-size:13px">${GR.TYPE_NAMES[it.verb.p]}${it.verb.note ? " · " + esc(it.verb.note) : ""}</div>`;
      }
      const mb = hasMorph(it.word || it.gr) ? `<button class="btn small" data-morphdict style="margin-top:10px">🧩 Состав и однокоренные</button>` : "";
      if (it.kind === "nouns") return `<div class="sub ${gcls(it)}" style="font-size:14px">${it.gender ? GENDER_NAME[it.gender] : "множественное число"}</div>${mb}`;
      return mb;
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
        if (e.target.closest("[data-morphdict]")) { e.stopPropagation(); openDict(it.word || it.gr, it); return; }
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

  /* ================= Словообразование: раздел ================= */
  views.morph = (root, sub) => {
    if (sub) UI.morphTab = sub;
    if (!UI.morphTab) UI.morphTab = "learn";
    if (!UI.morphGroup) UI.morphGroup = "all";
    const TABS = [["learn", "📚 Правила"], ["meaning", "🤔 Угадай значение"], ["affix", "🧩 Какой аффикс?"],
      ["build", "✏️ Образуй слово"], ["family", "🌳 Семьи слов"], ["odd", "🔍 Лишнее слово"]];
    root.appendChild(h(`<div><h1 style="margin-bottom:4px">Словообразование</h1>
      <p class="muted" style="margin-top:0">Зная одну приставку или суффикс, вы понимаете десятки новых слов: <span class="gr">γράφω</span> → <span class="gr">ξαναγράφω, υπογράφω, περιγραφή, γραφείο…</span></p></div>`));
    const tabs = h(`<div class="tabs">${TABS.map(([id, n]) => `<button data-t="${id}">${n}</button>`).join("")}</div>`);
    root.appendChild(tabs);
    const bar = h(`<div class="toolbar"><label>Группа <select id="mgroup"><option value="all">Все группы</option>
      ${MORPH.groups.map((g) => `<option value="${g.id}">${esc(g.title)}</option>`).join("")}</select></label>
      <span class="spacer"></span><span class="muted" style="font-size:13px" id="mInfo"></span></div>`);
    root.appendChild(bar);
    const area = h(`<div></div>`);
    root.appendChild(area);
    bindSay(area);
    area.addEventListener("click", (e) => {
      const w = e.target.closest("[data-dict]");
      if (w && !w.closest("[data-o]")) openDict(w.dataset.dict);
    });
    $("#mgroup", bar).value = UI.morphGroup;
    $("#mgroup", bar).addEventListener("change", (e) => { UI.morphGroup = e.target.value; saveUI(); show(); });
    tabs.addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; UI.morphTab = b.dataset.t; saveUI(); history.replaceState(null, "", "#morph/" + UI.morphTab); show(); });

    const sc = { ok: 0, n: 0 };
    let last = null;
    const pickFrom = (pool) => { let it; for (let k = 0; k < 8; k++) { it = rnd(pool); if (it !== last) break; } last = it; return it; };
    const scoreHTML = () => `<div class="score">Верно: <b>${sc.ok}</b> из <b>${sc.n}</b></div>`;
    const affs = () => MORPH_ITEMS.filter((a) => lvlOk(a.lvl) && (UI.morphGroup === "all" || a.group === UI.morphGroup));
    const exPool = () => affs().flatMap((a) => a.ex).filter((e) => e.base);
    const fams = () => MORPH.families;
    const baseHTML = (e) => `${e.base.split("+").map((x) => `<span class="gr">${esc(x.trim())}</span>`).join(" + ")} <span class="muted">(${esc(e.baseRu)})</span>`;
    const nextBtn = `<button class="btn primary" data-next style="margin-top:10px">Дальше <kbd>⏎</kbd></button>`;

    function show() {
      $$("button", tabs).forEach((b) => b.classList.toggle("on", b.dataset.t === UI.morphTab));
      const famTab = UI.morphTab === "family" || UI.morphTab === "odd";
      $("#mgroup", bar).parentElement.style.display = famTab ? "none" : "";
      area.innerHTML = ""; keyHandler = null;
      const info = $("#mInfo", bar);
      if (famTab) info.textContent = `${fams().length} семей · ${fams().reduce((a, f) => a + f.w.length, 0)} слов`;
      else info.textContent = `${affs().length} аффиксов · ${affs().reduce((a, x) => a + x.ex.length, 0)} слов`;
      if (!famTab && !affs().length) { area.innerHTML = `<div class="card empty">В этой группе на уровне ${S.level} ничего нет — переключите уровень на B1 или выберите другую группу.</div>`; return; }
      ({ learn, meaning, affix, build, family, odd })[UI.morphTab]();
    }

    function learn() {
      let g = "";
      affs().forEach((a) => {
        if (a.group !== g) { g = a.group; area.appendChild(h(`<div class="ref-group">${esc(a.gtitle)}</div>`)); }
        area.appendChild(h(`<details class="ref-sec morph-sec"><summary><span class="gr aff-hl">${esc(a.a)}</span> <span>${esc(a.ru)}</span>
            ${a.lvl === "B1" ? `<span class="badge B1">B1</span>` : ""} <span class="muted" style="font-size:13px;font-weight:400">· ${a.ex.length}</span></summary>
          <div class="body">${a.note ? `<p class="muted" style="margin-top:0">${esc(a.note)}</p>` : ""}
          <table class="ref morph-ex">${a.ex.map((e) => `<tr>
            <td class="gr"><button class="w" data-dict="${esc(e.w)}">${affHL(e.w, a)}</button> <button class="speak sm" data-say="${esc(e.w)}">🔊</button></td>
            <td>${esc(e.ru)}</td>
            <td class="muted" style="font-size:14px">${e.base ? `← ${e.base.split("+").map((x) => `<span class="gr">${esc(x.trim())}</span>`).join(" + ")} <span>${esc(e.baseRu)}</span>` : ""}</td></tr>`).join("")}</table></div></details>`));
      });
      const first = $("details", area); if (first) first.open = true;
    }

    function choiceTask({ label, prompt, opts, correct, render, onDone }) {
      const el = h(`<div class="card ex">${scoreHTML()}
        <div class="label">${label}</div>${prompt}
        <div class="options">${opts.map((o, i) => `<button data-o="${i}"><span class="k">${i + 1}</span>${render(o)}</button>`).join("")}</div>
        <div class="feedback"></div></div>`);
      area.appendChild(el);
      let done = false;
      function answer(i) {
        if (done) return; done = true;
        const ok = opts[i] === correct;
        sc.n++; if (ok) sc.ok++;
        logAnswer(ok, "morph");
        $$("[data-o]", el).forEach((b) => {
          b.disabled = true;
          const o = opts[Number(b.dataset.o)];
          if (o === correct) b.classList.add("ok"); else if (Number(b.dataset.o) === i) b.classList.add("bad");
        });
        $(".feedback", el).innerHTML = `<div class="msg ${ok ? "ok" : "bad"}">${ok ? "Верно! ✓" : "Неверно"}</div>${onDone()}${nextBtn}`;
        $("[data-next]", el).addEventListener("click", show);
      }
      $$("[data-o]", el).forEach((b) => b.addEventListener("click", () => answer(Number(b.dataset.o))));
      keyHandler = (e) => {
        if (done && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); show(); }
        else if (!done && /^[1-4]$/.test(e.key) && opts[Number(e.key) - 1] !== undefined) answer(Number(e.key) - 1);
      };
    }
    const explain = (e) => `<div class="correct"><span class="gr">${affHL(e.w, e.aff)}</span> <button class="speak sm" data-say="${esc(e.w)}">🔊</button> — ${esc(e.ru)}</div>
      <p class="muted" style="margin:6px 0 0"><b class="gr aff-hl">${esc(e.aff.a)}</b> = ${esc(e.aff.ru)}${e.aff.note ? `<br><span style="font-size:14px">${esc(e.aff.note)}</span>` : ""}</p>`;

    function meaning() {
      const pool = exPool();
      const e = pickFrom(pool);
      const sameBase = shuffle(MORPH_EX.filter((x) => x !== e && x.base === e.base && x.ru !== e.ru));
      const sameAff = shuffle(e.aff.ex.filter((x) => x !== e));
      const any = shuffle(pool.filter((x) => x !== e));
      const opts = [e.ru];
      sameBase.concat(sameAff, any).forEach((x) => { if (opts.length < 4 && !opts.includes(x.ru)) opts.push(x.ru); });
      choiceTask({
        label: "Что означает слово? Разберите его на части",
        prompt: `<div class="prompt gr">${esc(e.w)} <button class="speak sm" data-say="${esc(e.w)}">🔊</button></div>
          <div style="margin-bottom:6px">исходное слово: ${baseHTML(e)}</div>`,
        opts: shuffle(opts), correct: e.ru, render: (o) => esc(o),
        onDone: () => { speak(e.w); return explain(e); },
      });
    }

    function affix() {
      const pool = exPool();
      const e = pickFrom(pool);
      const sameGroup = shuffle(MORPH_ITEMS.filter((a) => a !== e.aff && a.group === e.aff.group && lvlOk(a.lvl)));
      const other = shuffle(MORPH_ITEMS.filter((a) => a !== e.aff && a.group !== e.aff.group && lvlOk(a.lvl)));
      const opts = [e.aff].concat(sameGroup.concat(other).slice(0, 3));
      choiceTask({
        label: "Какая приставка или суффикс даёт это значение?",
        prompt: `<div class="prompt" style="font-size:1.4rem">${baseHTML(e)}</div>
          <div style="font-size:1.2rem;margin-bottom:6px">→ «${esc(e.ru)}»</div>`,
        opts: shuffle(opts), correct: e.aff, render: (a) => `<span class="gr">${esc(a.a)}</span>`,
        onDone: () => { speak(e.w); return explain(e); },
      });
    }

    function build() {
      const pool = exPool().filter((e) => !/\s/.test(e.w) && !e.base.includes("+"));
      if (!pool.length) { area.innerHTML = `<div class="card empty">Здесь нет подходящих слов — выберите другую группу.</div>`; return; }
      const e = pickFrom(pool);
      const el = h(`<div class="card ex">${scoreHTML()}
        <div class="label">Образуйте слово</div>
        <div class="prompt" style="font-size:1.4rem">${baseHTML(e)} + <span class="gr aff-hl">${esc(e.aff.a)}</span></div>
        <div class="muted" style="margin-bottom:4px">${esc(e.aff.ru)}</div>
        <div style="font-size:1.2rem">= «${esc(e.ru)}»</div>
        <div class="answer-row"></div>
        <div class="row" style="justify-content:center;margin-top:14px">
          <button class="btn primary" data-check>Проверить <kbd>⏎</kbd></button><button class="btn" data-skip>Не знаю</button></div>
        <div class="feedback"></div></div>`);
      const { wrap, input } = greekInput(() => (answered ? show() : check()));
      $(".answer-row", el).appendChild(wrap);
      area.appendChild(el);
      input.focus();
      let answered = false;
      function check(giveUp) {
        if (answered) return;
        if (!giveUp && !input.value.trim()) { input.focus(); return; }
        answered = true;
        const res = giveUp ? { ok: false } : GR.check(input.value, [e.w], { strict: S.strict });
        sc.n++; if (res.ok) sc.ok++;
        logAnswer(res.ok, "morph");
        input.readOnly = true;
        input.classList.add(res.ok && !res.accentOnly ? "ok" : res.accentOnly ? "acc" : "bad");
        $(".feedback", el).innerHTML = feedbackHTML(res, giveUp ? "" : input.value, { gr: e.w, kind: "morph" }) + explain(e) + nextBtn;
        $("[data-next]", el).addEventListener("click", show);
        $("[data-check]", el).style.display = "none"; $("[data-skip]", el).style.display = "none";
        speak(e.w);
        input.focus();
      }
      $("[data-check]", el).addEventListener("click", () => check());
      $("[data-skip]", el).addEventListener("click", () => check(true));
    }

    function family() {
      area.appendChild(h(`<p class="muted" style="margin-top:0">Один корень — много слов. Нажмите на слово, чтобы открыть его в словаре.</p>`));
      const grid = h(`<div class="fam-grid"></div>`);
      fams().forEach((f) => grid.appendChild(h(`<div class="card fam"><h3><span class="gr aff-hl">${esc(f.root)}</span> <span class="muted" style="font-weight:400">${esc(f.ru)}</span></h3>
        <ul>${f.w.map((x) => `<li><button class="w gr" data-dict="${esc(x.w)}">${esc(x.w)}</button> <button class="speak sm" data-say="${esc(x.w)}">🔊</button> <span class="muted">${esc(x.ru)}</span></li>`).join("")}</ul></div>`)));
      area.appendChild(grid);
    }

    function odd() {
      const all = fams();
      const f = pickFrom(all);
      const inF = new Set(f.w.map((x) => formKey(x.w)));
      const three = shuffle(f.w).slice(0, 3);
      const others = shuffle(all.filter((x) => x !== f).flatMap((x) => x.w.map((w) => ({ ...w, fam: x })))).filter((w) => !inF.has(formKey(w.w)));
      const intruder = others[0];
      const opts = shuffle(three.concat([intruder]));
      choiceTask({
        label: "Какое слово не из этой семьи?",
        prompt: `<div class="muted" style="margin-bottom:6px">Три слова однокоренные, одно — лишнее</div>`,
        opts, correct: intruder, render: (x) => `<span class="gr">${esc(x.w)}</span>`,
        onDone: () => {
          $$("[data-o]", area).forEach((b) => { const x = opts[Number(b.dataset.o)]; b.insertAdjacentHTML("beforeend", `<span class="muted" style="font-size:13px;margin-left:8px">${esc(x.ru)}</span>`); });
          return `<p style="margin:8px 0 0">Семья <b class="gr aff-hl">${esc(f.root)}</b> (${esc(f.ru)}): ${f.w.map((x) => wordBtn(x.w)).join(" · ")}</p>
            <p class="muted" style="margin:6px 0 0"><span class="gr">${esc(intruder.w)}</span> — из семьи <b class="gr">${esc(intruder.fam.root)}</b> (${esc(intruder.fam.ru)})</p>`;
        },
      });
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

  /* ================= Синхронизация устройств ================= */
  // Объединение без потерь: по карточке побеждает более свежее повторение (поле last),
  // счётчики ответов по каждому устройству и дню только растут, поэтому берётся больший.
  const isCard = (p) => p && typeof p === "object" && typeof p.b === "number" && typeof p.due === "number";
  function mergeRemote(data) {
    let changed = false;
    if (data.P && typeof data.P === "object") {
      Object.entries(data.P).forEach(([id, rp]) => {
        if (!isCard(rp)) return;
        const lp = P[id];
        if (!lp || (rp.last || 0) > (lp.last || 0)) { P[id] = rp; changed = true; }
      });
    }
    if (data.logs && typeof data.logs === "object") {
      Object.entries(data.logs).forEach(([dev, days]) => {
        if (!days || typeof days !== "object") return;
        const mine = LOGS[dev] || (LOGS[dev] = {});
        Object.entries(days).forEach(([day, e]) => {
          if (!e || typeof e.n !== "number" || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return;
          if (!mine[day] || e.n > mine[day].n) { mine[day] = e; changed = true; }
        });
      });
    }
    return changed;
  }

  const SY = { cfg: store.get("gr.sync", null), status: "off", peers: 0, last: 0, pending: null, showQR: false };
  const SYNC_TEXT = {
    off: "Не связано",
    connecting: "Подключаюсь…",
    waiting: "Жду другое устройство: откройте сайт на нём",
    connected: "Связано",
    offline: "Нет связи с сервером, повторю попытку…",
    nodirect: "Не удалось соединиться напрямую. Чаще всего помогает, если оба устройства в одной Wi-Fi-сети",
  };
  function syncStatusText() {
    let t = SYNC_TEXT[SY.status] || SY.status;
    if (SY.status === "connected") t += SY.peers > 1 ? ` с ${SY.peers} устройствами` : " с другим устройством";
    if (SY.last) { const d = new Date(SY.last); t += ` · синхронизировано в ${pad(d.getHours())}:${pad(d.getMinutes())}`; }
    return t;
  }
  function paintSyncStatus() {
    $$("[data-sync-status]").forEach((el) => { el.textContent = syncStatusText(); el.dataset.state = SY.status; });
  }
  function startSync() {
    if (SYNC) SYNC.close();
    if (!SY.cfg || !window.GSync || !GSync.supported()) return;
    SYNC = GSync.start({
      secret: SY.cfg.secret,
      getState: () => ({ P, logs: LOGS }),
      onData: (m) => {
        if (m.t !== "state" && m.t !== "delta") return;
        SY.last = Date.now();
        if (mergeRemote(m)) {
          saveP(); saveLog();
          if (m.t === "state") toast("Прогресс синхронизирован");
          const view = (location.hash.slice(1) || "home").split("/")[0];
          if (view === "home" || view === "stats") route();
        }
        paintSyncStatus();
      },
      onStatus: (s, n) => { SY.status = s; SY.peers = n; paintSyncStatus(); },
    });
  }
  function pairWith(secret) {
    SY.cfg = { secret, since: Date.now() };
    store.set("gr.sync", SY.cfg);
    startSync();
  }
  function unpair() {
    if (SYNC) SYNC.close();
    SYNC = null; SY.cfg = null; SY.status = "off"; SY.showQR = false; SY.last = 0;
    store.set("gr.sync", null);
  }
  const syncLink = () => location.origin + location.pathname + "#sync=" + SY.cfg.secret;
  function loadQR() {
    if (window.qrcode) return Promise.resolve();
    return new Promise((ok, fail) => {
      const s = document.createElement("script");
      s.src = "js/vendor/qrcode.js"; s.onload = ok; s.onerror = fail;
      document.head.appendChild(s);
    });
  }
  // Ссылка из QR-кода: #sync=<секрет>. Секрет сразу убирается из адресной строки.
  (function takeSyncLink() {
    const m = location.hash.match(/^#sync=([A-Za-z0-9_-]{16,64})$/);
    if (!m) return;
    history.replaceState(null, "", location.pathname + location.search + "#stats");
    if (SY.cfg && SY.cfg.secret === m[1]) return;
    SY.pending = m[1];
  })();

  function syncCard() {
    const el = h(`<div class="card sync-card"><h2>🔄 Синхронизация устройств</h2></div>`);
    const p = (html) => el.appendChild(h(`<p class="muted" style="margin-top:0;font-size:14px">${html}</p>`));
    if (!window.GSync || !GSync.supported()) {
      p("Этот браузер не поддерживает прямое соединение между устройствами. Перенесите прогресс через «Скопировать прогресс» ниже.");
      return el;
    }
    if (SY.pending) {
      p("Связать это устройство с другим? Прогресс двух устройств объединится: по каждой карточке останется самое свежее повторение, ответы сложатся.");
      const row = el.appendChild(h(`<div class="row"><button class="btn primary" data-sync-accept>Связать</button><button class="btn" data-sync-cancel>Отмена</button></div>`));
      $("[data-sync-accept]", row).addEventListener("click", () => { const s = SY.pending; SY.pending = null; pairWith(s); toast("Устройство связано"); route(); });
      $("[data-sync-cancel]", row).addEventListener("click", () => { SY.pending = null; route(); });
      return el;
    }
    if (!SY.cfg) {
      p("Свяжите телефон и компьютер, и прогресс будет объединяться напрямую между ними, когда сайт открыт на обоих. Прогресс не хранится ни на каком сервере.");
      const row = el.appendChild(h(`<div class="row"><button class="btn primary" data-sync-new>Связать устройства</button></div>`));
      $("[data-sync-new]", row).addEventListener("click", () => { pairWith(GSync.newSecret()); SY.showQR = true; route(); });
      return el;
    }
    el.appendChild(h(`<p class="sync-status" data-sync-status></p>`));
    if (SY.showQR) {
      const box = el.appendChild(h(`<div class="sync-qr">
        <div class="qr" data-qr></div>
        <div class="stack" style="gap:8px;flex:1;min-width:220px">
          <b>На другом устройстве отсканируйте QR-код камерой</b>
          <span class="muted" style="font-size:14px">или откройте на нём эту ссылку. Ссылка — ключ к вашему прогрессу, не публикуйте её.</span>
          <input readonly data-sync-link>
          <div class="row"><button class="btn small" data-sync-copy>Скопировать ссылку</button><button class="btn small" data-sync-hide>Скрыть</button></div>
        </div></div>`));
      $("[data-sync-link]", box).value = syncLink();
      loadQR().then(() => {
        const qr = qrcode(0, "M"); qr.addData(syncLink()); qr.make();
        $("[data-qr]", box).innerHTML = qr.createSvgTag({ cellSize: 5, margin: 2, scalable: true });
      }).catch(() => { $("[data-qr]", box).textContent = "QR-код не загрузился, используйте ссылку"; });
      $("[data-sync-copy]", box).addEventListener("click", async () => {
        try { await navigator.clipboard.writeText(syncLink()); toast("Ссылка скопирована"); }
        catch (e) { $("[data-sync-link]", box).select(); toast("Скопируйте ссылку вручную"); }
      });
      $("[data-sync-hide]", box).addEventListener("click", () => { SY.showQR = false; route(); });
    }
    p("Синхронизация идёт, пока сайт открыт на обоих устройствах. Сброс прогресса действует только на этом устройстве: связанные устройства вернут свои данные.");
    const row = el.appendChild(h(`<div class="row">${SY.showQR ? "" : `<button class="btn" data-sync-show>Добавить устройство (QR)</button>`}<span class="spacer"></span><button class="btn bad" data-sync-off>Отвязать это устройство</button></div>`));
    const show = $("[data-sync-show]", row);
    if (show) show.addEventListener("click", () => { SY.showQR = true; route(); });
    $("[data-sync-off]", row).addEventListener("click", () => { unpair(); toast("Синхронизация выключена"); route(); });
    setTimeout(paintSyncStatus);
    return el;
  }

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
        <p class="muted" style="margin-top:0;font-size:14px">Прогресс хранится в этом браузере (localStorage). Можно сохранить копию в файл или перенести текстом.</p>
        <div class="row"><button class="btn" data-export>Скопировать прогресс</button>
          <button class="btn" data-file>Скачать файл</button>
          <label class="btn">Загрузить файл<input type="file" accept="application/json,.json" hidden data-import></label>
          <span class="spacer"></span><button class="btn bad" data-reset>Сбросить прогресс</button></div>
        <textarea data-json rows="4" placeholder="Сюда можно вставить скопированный прогресс с другого устройства" style="width:100%;margin-top:12px;font:13px ui-monospace,monospace;padding:10px;border-radius:10px;border:1px solid var(--border);background:var(--surface-2);color:var(--text)"></textarea>
        <div class="row" style="margin-top:8px"><button class="btn small" data-paste>Загрузить из текста</button></div></div>
    </div>`);
    const sc = syncCard();
    if (SY.pending) el.insertBefore(sc, el.children[1]); else el.insertBefore(sc, el.lastElementChild);
    const dump = () => JSON.stringify({ progress: P, logs: LOGS, log: LOG, settings: S });
    function applyData(text) {
      try {
        const data = JSON.parse(text);
        if (!data.progress && !data.log && !data.logs) throw new Error("empty");
        if (data.progress) { P = data.progress; saveP(); }
        if (data.logs) { LOGS = data.logs; saveLog(); }
        else if (data.log) { LOGS = { [DEV]: data.log }; saveLog(); }
        syncSend(Object.assign({ t: "state", v: 1 }, { P, logs: LOGS }));
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
      P = {}; LOGS = {}; saveP(); saveLog(); toast("Прогресс сброшен"); route();
    });
    root.appendChild(el);
  };

  startSync();
  route();
})();
