/* Утилиты греческого языка: ударения, спряжение, проверка ответов, генерация ошибок. */
(function () {
  const TONOS = "́";
  const DIA = "̈";

  const nfc = (s) => s.normalize("NFC");
  const stripTonos = (s) => nfc(s.normalize("NFD").split(TONOS).join(""));
  const stripAll = (s) => nfc(s.normalize("NFD").replace(/[́̈]/g, ""));
  const hasTonos = (ch) => ch.normalize("NFD").includes(TONOS);
  const addTonos = (ch) => nfc(stripTonos(ch).normalize("NFD") + TONOS);

  /* ---------- Спряжение ---------- */
  const PRONOUNS = ["εγώ", "εσύ", "αυτός/-ή/-ό", "εμείς", "εσείς", "αυτοί/-ές/-ά"];
  const PERSONS_RU = ["я", "ты", "он/она/оно", "мы", "вы", "они"];
  const TENSES = [
    { id: "pres", gr: "Ενεστώτας", ru: "Настоящее", lvl: "A1" },
    { id: "aor", gr: "Αόριστος", ru: "Прошедшее простое (аорист)", lvl: "A1" },
    { id: "fut", gr: "Στιγμιαίος μέλλοντας", ru: "Будущее простое", lvl: "A2", prefix: "θα" },
    { id: "impf", gr: "Παρατατικός", ru: "Прошедшее длительное", lvl: "A2" },
    { id: "futc", gr: "Εξακολουθητικός μέλλοντας", ru: "Будущее длительное", lvl: "B1", prefix: "θα" },
    { id: "perf", gr: "Παρακείμενος", ru: "Перфект (έχω + …)", lvl: "B1" },
  ];
  const TYPE_NAMES = {
    A: "Группа A (-ω)", B1: "Группа B1 (-άω)", B2: "Группа B2 (-ώ)",
    M: "Средний залог (-ομαι)", MA: "Средний залог (-άμαι)", X: "Неправильный",
  };

  const map = (s, ends) => ends.map((e) => s + e);
  const END_A = ["ω", "εις", "ει", "ουμε", "ετε", "ουν"];
  const END_B = ["ώ", "είς", "εί", "ούμε", "είτε", "ούν"];

  function derivePast(pair) {
    const sg = pair[0];
    const pl = pair[1] || sg + "με";
    const b = sg.slice(0, -1);
    return [b + "α", b + "ες", b + "ε", pl, pl.slice(0, -3) + "ατε", b + "αν"];
  }

  function present(v) {
    switch (v.p) {
      case "X": return v.pres.slice();
      case "A": return map(v.v.slice(0, -1), END_A);
      case "B1": return map(v.v.slice(0, -2), ["άω", "άς", "άει", "άμε", "άτε", "άνε"]);
      case "B2": return map(v.v.slice(0, -1), END_B);
      case "M": {
        const s = v.v.slice(0, -4), u = stripTonos(s);
        return [s + "ομαι", s + "εσαι", s + "εται", u + "όμαστε", s + "εστε", s + "ονται"];
      }
      case "MA": {
        const s = v.v.slice(0, -4);
        return map(s, ["άμαι", "άσαι", "άται", "όμαστε", "άστε", "ούνται"]);
      }
    }
    return [];
  }

  // Допустимые варианты (разговорные/книжные) для группы B1
  function presentAlts(v) {
    if (v.p !== "B1") return [[], [], [], [], [], []];
    const s = v.v.slice(0, -2);
    return [[s + "ώ"], [], [s + "ά"], [s + "ούμε"], [], [s + "ούν", s + "άν"]];
  }

  function imperfect(v) {
    if (v.impfF) return v.impfF.slice();
    if (v.impf) return derivePast(v.impf);
    if (v.p === "M") {
      const s = v.v.slice(0, -4), u = stripTonos(s);
      return [u + "όμουν", u + "όσουν", u + "όταν", u + "όμασταν", u + "όσασταν", s + "ονταν"];
    }
    if (v.p === "MA") {
      const s = v.v.slice(0, -4);
      return map(s, ["όμουν", "όσουν", "όταν", "όμασταν", "όσασταν", "ούνταν"]);
    }
    return null;
  }

  function aorist(v) {
    if (v.aorF) return v.aorF.slice();
    if (v.aor) return derivePast(v.aor);
    return null;
  }

  function dependent(v) {
    if (v.futF) return v.futF.slice();
    if (!v.fut) return null;
    if (v.fut.endsWith("ώ")) return map(v.fut.slice(0, -1), END_B);
    return map(v.fut.slice(0, -1), END_A);
  }

  const ECHO = ["έχω", "έχεις", "έχει", "έχουμε", "έχετε", "έχουν"];

  /** Возвращает { forms:[6], alts:[[...]x6] } для времени или null */
  function conjugate(v, tense) {
    const none = [[], [], [], [], [], []];
    switch (tense) {
      case "pres": return { forms: present(v), alts: presentAlts(v) };
      case "aor": { const f = aorist(v); return f && { forms: f, alts: none }; }
      case "impf": { const f = imperfect(v); return f && { forms: f, alts: none }; }
      case "fut": { const f = dependent(v); return f && { forms: f, alts: none }; }
      case "futc": return { forms: present(v), alts: presentAlts(v) };
      case "perf": {
        if (v.noPerf) return null;
        const d = dependent(v);
        if (!d) return null;
        return { forms: ECHO.map((e) => e + " " + d[2]), alts: none };
      }
    }
    return null;
  }

  function tenseInfo(id) { return TENSES.find((t) => t.id === id); }

  /** Краткая форма для карточки: настоящее · аорист · будущее */
  function principalParts(v) {
    const a = aorist(v), f = dependent(v);
    return [v.v, a ? a[0] : "—", f ? "θα " + f[0] : "—"];
  }

  /* ---------- Нормализация и проверка ---------- */
  function normalize(s) {
    s = nfc(String(s || "")).toLowerCase().replace(/;/g, ";");
    s = s.replace(/[«»"“”…!.,;:?¿¡]/g, " ").replace(/\.\.\./g, " ");
    s = s.replace(/\s+/g, " ").trim();
    s = s.replace(/σ(?=\s|$)/g, "ς");
    return s;
  }

  /**
   * Проверка ответа. answers — строка (варианты через «/») или массив.
   * Возвращает { ok, accentOnly, exact, best }
   */
  function check(user, answers, { strict = true, dropPrefix = null } = {}) {
    let list = Array.isArray(answers) ? answers : String(answers).split("/");
    list = list.map((a) => a.trim()).filter(Boolean);
    let u = normalize(user);
    if (dropPrefix && u.startsWith(dropPrefix + " ")) u = u.slice(dropPrefix.length + 1);
    for (const a of list) if (normalize(a) === u) return { ok: true, exact: true, accentOnly: false, best: a };
    for (const a of list) {
      if (stripAll(normalize(a)) === stripAll(u)) return { ok: !strict, exact: false, accentOnly: true, best: a };
    }
    // ближайший вариант для подсветки
    let best = list[0], bd = Infinity;
    for (const a of list) { const d = lev(normalize(a), u); if (d < bd) { bd = d; best = a; } }
    return { ok: false, exact: false, accentOnly: false, best };
  }

  function lev(a, b) {
    const m = a.length, n = b.length;
    const d = Array.from({ length: m + 1 }, (_, i) => [i].concat(Array(n).fill(0)));
    for (let j = 1; j <= n; j++) d[0][j] = j;
    for (let i = 1; i <= m; i++)
      for (let j = 1; j <= n; j++)
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[m][n];
  }

  /** Посимвольное сравнение: возвращает HTML правильного ответа с подсветкой расхождений */
  function diffHTML(user, correct) {
    const PUNCT = /[«»"“”…!.,;:?;]/;
    const all = Array.from(nfc(correct));
    // пунктуацию выводим как есть, в сравнении не участвует
    const a = [], keep = [];
    all.forEach((c, k) => { if (PUNCT.test(c)) keep.push([a.length, c]); else a.push(c); });
    const b = Array.from(normalize(user));
    const al = a.map((c) => c.toLowerCase());
    const m = a.length, n = b.length;
    const L = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
    for (let i = m - 1; i >= 0; i--)
      for (let j = n - 1; j >= 0; j--)
        L[i][j] = al[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    let i = 0, j = 0, out = "";
    const flushPunct = () => { while (keep.length && keep[0][0] === i) out += esc(keep.shift()[1]); };
    while (i < m) {
      flushPunct();
      if (al[i] === " " && b[j] !== " ") { out += " "; i++; continue; }
      if (j < n && al[i] === b[j]) { out += esc(a[i]); i++; j++; }
      else if (j < n && L[i][j + 1] > L[i + 1][j]) { j++; }
      else {
        const accentHint = j < n && stripAll(al[i]) === stripAll(b[j]);
        out += `<mark class="${accentHint ? "acc" : "miss"}">${esc(a[i])}</mark>`;
        if (accentHint) j++;
        i++;
      }
    }
    while (keep.length) out += esc(keep.shift()[1]);
    return out;
  }
  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

  /* ---------- Звуковые единицы (для ошибок и ударения) ---------- */
  const VOWELS = "αεηιουωάέήίόύώϊϋΐΰ";
  const isVowel = (c) => VOWELS.includes(c.toLowerCase());

  /** Делит слово на единицы: диграфы ει/οι/αι/ου/αυ/ευ/υι + отдельные буквы */
  function units(word) {
    const ch = Array.from(nfc(word));
    const out = [];
    for (let i = 0; i < ch.length; i++) {
      const c = ch[i], n = ch[i + 1];
      const b = c.toLowerCase();
      if (n && !hasTonos(c)) {
        const nb = stripTonos(n.toLowerCase()); // «ϊ»/«ϋ» сохраняют диерезис и не образуют диграф
        if ((nb === "ι" && "αεου".includes(b)) || (nb === "υ" && "αεο".includes(b))) {
          out.push(c + n); i++; continue;
        }
      }
      out.push(c);
    }
    return out;
  }

  const SOUND_I = ["ι", "η", "υ", "ει", "οι"];
  const SOUND_E = ["ε", "αι"];
  const SOUND_O = ["ο", "ω"];
  function soundGroup(u) {
    const b = stripTonos(u.toLowerCase());
    if (SOUND_I.includes(b)) return SOUND_I;
    if (SOUND_E.includes(b)) return SOUND_E;
    if (SOUND_O.includes(b)) return SOUND_O;
    return null;
  }
  function accentUnit(base, accented) {
    if (!accented) return base;
    const arr = Array.from(base);
    arr[arr.length - 1] = addTonos(arr[arr.length - 1]);
    return arr.join("");
  }

  /** Генерирует правдоподобные ошибки написания */
  function misspellings(word, exclude = new Set()) {
    const us = units(word);
    const res = new Set();
    us.forEach((u, i) => {
      const g = soundGroup(u);
      if (!g) return;
      const acc = hasTonos(u);
      const b = stripTonos(u.toLowerCase());
      g.forEach((alt) => {
        if (alt === b) return;
        const copy = us.slice();
        copy[i] = accentUnit(alt, acc);
        res.add(copy.join(""));
      });
    });
    // удвоенные / одиночные согласные
    const s = nfc(word);
    s.replace(/([λσμπτνρκ])\1/g, (m, c, off) => { res.add(s.slice(0, off) + c + s.slice(off + 2)); return m; });
    for (let i = 1; i < s.length - 1; i++) {
      const c = s[i];
      if ("λμνρπτ".includes(c) && isVowel(s[i - 1]) && isVowel(s[i + 1]) && s[i - 1] !== c && s[i + 1] !== c)
        res.add(s.slice(0, i) + c + c + s.slice(i + 1));
    }
    // ударение на другом слоге
    const vIdx = us.map((u, i) => (isVowel(u[0]) ? i : -1)).filter((i) => i >= 0);
    const accIdx = us.findIndex((u) => hasTonos(u));
    if (accIdx >= 0 && vIdx.length > 1) {
      vIdx.forEach((i) => {
        if (i === accIdx) return;
        const copy = us.map((u) => stripTonos(u));
        copy[i] = accentUnit(copy[i], true);
        res.add(copy.join(""));
      });
    }
    res.delete(nfc(word));
    const final = [...res].map((w) => w.replace(/σ$/, "ς")).filter((w) => !exclude.has(w));
    return [...new Set(final)];
  }

  /** Данные для упражнения «поставь ударение» */
  function accentTask(word) {
    const us = units(word);
    const accIdx = us.findIndex((u) => hasTonos(u));
    if (accIdx < 0) return null;
    return { units: us.map((u) => stripTonos(u)), answer: accIdx, vowel: us.map((u) => isVowel(u[0])) };
  }

  /* ---------- Латиница → греческая раскладка ---------- */
  const LAT = {
    a: "α", b: "β", c: "ψ", d: "δ", e: "ε", f: "φ", g: "γ", h: "η", i: "ι", j: "ξ", k: "κ", l: "λ", m: "μ",
    n: "ν", o: "ο", p: "π", q: ";", r: "ρ", s: "σ", t: "τ", u: "θ", v: "ω", w: "ς", x: "χ", y: "υ", z: "ζ",
  };
  function latinToGreek(ch) {
    const lower = ch.toLowerCase();
    const g = LAT[lower];
    if (!g) return null;
    return ch === lower ? g : g.toUpperCase();
  }
  function applyDead(dead, ch) {
    if (dead === "tonos" && "αεηιουωΑΕΗΙΟΥΩ".includes(ch)) return addTonos(ch);
    if (dead === "dia" && "ιυΙΥ".includes(ch)) return nfc(ch.normalize("NFD") + DIA);
    if (dead === "both" && "ιυ".includes(ch)) return nfc(ch + DIA + TONOS);
    return ch;
  }

  window.GR = {
    PRONOUNS, PERSONS_RU, TENSES, TYPE_NAMES, conjugate, tenseInfo, principalParts,
    normalize, check, diffHTML, stripAll, stripTonos, units, misspellings, accentTask,
    latinToGreek, applyDead, addTonos, hasTonos, isVowel,
  };
})();
