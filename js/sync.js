/* Синхронизация прогресса между устройствами.
 *
 * 1. Напрямую по WebRTC (канал данных шифруется DTLS), когда устройства открыты
 *    одновременно. Сигнальный сервер только знакомит устройства: он видит хеш
 *    комнаты и зашифрованные служебные сообщения.
 * 2. Через зашифрованную копию на сервере: устройства не обязаны быть открыты
 *    одновременно. Ключ выводится из секрета пары, сервер данные прочитать не может.
 *
 * GSync.start({ secret, getState, onData, onStatus }) -> { broadcast(obj), close() }
 * GSync.cloud({ secret, getState, onData, onStatus }) -> { markDirty(), syncNow(), wipe(), close() }
 * GSync.newSecret() -> случайный секрет пары
 */
(function () {
  "use strict";

  const SIGNAL_URL = "wss://82-70-254-98.sslip.io";
  const ICE_SERVERS = [{ urls: ["stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"] }];
  const CHUNK = 8000; // символов; Safari ограничивает размер сообщения в канале
  const CONNECT_TIMEOUT = 25000;

  const te = new TextEncoder();
  const td = new TextDecoder();
  const b64u = {
    enc(buf) {
      let s = "";
      new Uint8Array(buf).forEach((b) => { s += String.fromCharCode(b); });
      return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    },
    dec(str) {
      str = str.replace(/-/g, "+").replace(/_/g, "/");
      const s = atob(str + "===".slice((str.length + 3) % 4));
      return Uint8Array.from(s, (c) => c.charCodeAt(0));
    },
  };
  const rand = (n) => crypto.getRandomValues(new Uint8Array(n));
  const sha256 = (text) => crypto.subtle.digest("SHA-256", te.encode(text));
  const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");

  async function derive(secret) {
    const topic = hex(await sha256("greek-sync/topic/" + secret));
    const raw = await sha256("greek-sync/key/" + secret);
    const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
    return { topic, key };
  }
  async function seal(key, obj) {
    const iv = rand(12);
    const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, te.encode(JSON.stringify(obj)));
    return { iv: b64u.enc(iv), ct: b64u.enc(ct) };
  }
  async function unseal(key, box) {
    try {
      const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64u.dec(box.iv) }, key, b64u.dec(box.ct));
      return JSON.parse(td.decode(pt));
    } catch (e) {
      return null; // чужое или повреждённое сообщение
    }
  }

  function start({ secret, getState, onData, onStatus }) {
    const me = b64u.enc(rand(9));
    const peers = new Map(); // id -> { pc, dc, pending, chunks, timer }
    let ws = null, topic = "", key = null, closed = false, retry = 0, retryTimer = null;

    const openPeers = () => Array.from(peers.values()).filter((p) => p.dc && p.dc.readyState === "open").length;
    function status(s) {
      const n = openPeers();
      onStatus(s || (n ? "connected" : ws && ws.readyState === 1 ? "waiting" : "connecting"), n);
    }

    derive(secret).then((d) => { topic = d.topic; key = d.key; connect(); });

    function connect() {
      if (closed) return;
      clearTimeout(retryTimer);
      status("connecting");
      try { ws = new WebSocket(SIGNAL_URL); } catch (e) { scheduleRetry(); return; }
      ws.onopen = () => {
        retry = 0;
        ws.send(JSON.stringify({ type: "subscribe", topics: [topic] }));
        signal({ kind: "hello" });
        status();
      };
      ws.onmessage = async (e) => {
        let m;
        try { m = JSON.parse(e.data); } catch (err) { return; }
        if (m.type !== "publish" || m.topic !== topic || !m.data) return;
        const d = await unseal(key, m.data);
        if (!d || d.from === me || (d.to && d.to !== me)) return;
        handleSignal(d).catch(() => {});
      };
      ws.onclose = () => { if (!closed) { status(openPeers() ? null : "offline"); scheduleRetry(); } };
      ws.onerror = () => {};
    }
    function scheduleRetry() {
      clearTimeout(retryTimer);
      retryTimer = setTimeout(connect, Math.min(30000, 1000 * 2 ** retry++));
    }
    async function signal(msg) {
      if (!ws || ws.readyState !== 1) return;
      msg.from = me;
      ws.send(JSON.stringify({ type: "publish", topic, data: await seal(key, msg) }));
    }

    async function handleSignal(d) {
      if (d.kind === "hello") {
        const p = peers.get(d.from);
        if (p && !["failed", "closed"].includes(p.pc.connectionState)) return;
        if (p) dropPeer(d.from);
        // Предложение соединения делает устройство с меньшим id, чтобы не было встречных offer.
        if (me < d.from) await startPeer(d.from, true);
        else signal({ kind: "hello", to: d.from });
      } else if (d.kind === "offer") {
        if (peers.has(d.from)) dropPeer(d.from);
        const p = await startPeer(d.from, false);
        await p.pc.setRemoteDescription(d.sdp);
        await p.pc.setLocalDescription(await p.pc.createAnswer());
        signal({ kind: "answer", to: d.from, sdp: p.pc.localDescription.toJSON() });
        flushCandidates(p);
      } else if (d.kind === "answer") {
        const p = peers.get(d.from);
        if (p && p.pc.signalingState === "have-local-offer") {
          await p.pc.setRemoteDescription(d.sdp);
          flushCandidates(p);
        }
      } else if (d.kind === "ice") {
        const p = peers.get(d.from);
        if (!p) return;
        if (p.pc.remoteDescription) p.pc.addIceCandidate(d.c).catch(() => {});
        else p.pending.push(d.c);
      }
    }
    function flushCandidates(p) {
      p.pending.splice(0).forEach((c) => p.pc.addIceCandidate(c).catch(() => {}));
    }

    async function startPeer(id, initiator) {
      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      const p = { pc, dc: null, pending: [], chunks: new Map(), timer: null };
      peers.set(id, p);
      pc.onicecandidate = (e) => { if (e.candidate) signal({ kind: "ice", to: id, c: e.candidate.toJSON() }); };
      pc.onconnectionstatechange = () => {
        if (["failed", "closed"].includes(pc.connectionState)) {
          const wasOpen = p.dc && p.dc.readyState === "open";
          dropPeer(id);
          status(wasOpen ? null : "nodirect");
        }
      };
      p.timer = setTimeout(() => {
        if (!p.dc || p.dc.readyState !== "open") { dropPeer(id); status("nodirect"); }
      }, CONNECT_TIMEOUT);
      if (initiator) {
        setupChannel(id, p, pc.createDataChannel("sync", { ordered: true }));
        await pc.setLocalDescription(await pc.createOffer());
        signal({ kind: "offer", to: id, sdp: pc.localDescription.toJSON() });
      } else {
        pc.ondatachannel = (e) => setupChannel(id, p, e.channel);
      }
      return p;
    }
    function setupChannel(id, p, dc) {
      p.dc = dc;
      dc.onopen = () => {
        clearTimeout(p.timer);
        send(dc, Object.assign({ t: "state", v: 1 }, getState()));
        status();
      };
      dc.onmessage = (e) => receive(p, e.data);
      dc.onclose = () => { dropPeer(id); status(); };
    }
    function dropPeer(id) {
      const p = peers.get(id);
      if (!p) return;
      peers.delete(id);
      clearTimeout(p.timer);
      try { if (p.dc) p.dc.close(); } catch (e) { /* уже закрыт */ }
      try { p.pc.close(); } catch (e) { /* уже закрыт */ }
    }

    function send(dc, obj) {
      if (dc.readyState !== "open") return;
      const s = JSON.stringify(obj);
      if (s.length <= CHUNK) { dc.send(s); return; }
      const mid = b64u.enc(rand(6));
      const n = Math.ceil(s.length / CHUNK);
      for (let i = 0; i < n; i++) dc.send(JSON.stringify({ t: "chunk", id: mid, i, n, d: s.slice(i * CHUNK, (i + 1) * CHUNK) }));
    }
    function receive(p, data) {
      let m;
      try { m = JSON.parse(data); } catch (e) { return; }
      if (m.t === "chunk") {
        if (typeof m.n !== "number" || m.n > 2000) return;
        const c = p.chunks.get(m.id) || { parts: [], got: 0 };
        if (c.parts[m.i] === undefined) { c.parts[m.i] = m.d; c.got++; }
        p.chunks.set(m.id, c);
        if (c.got < m.n) return;
        p.chunks.delete(m.id);
        try { m = JSON.parse(c.parts.join("")); } catch (e) { return; }
      }
      onData(m);
    }

    function onVisible() {
      if (document.visibilityState !== "visible" || closed) return;
      if (!ws || ws.readyState > 1) { retry = 0; connect(); } else signal({ kind: "hello" });
    }
    document.addEventListener("visibilitychange", onVisible);

    return {
      broadcast(obj) { peers.forEach((p) => { if (p.dc) send(p.dc, obj); }); },
      close() {
        closed = true;
        clearTimeout(retryTimer);
        document.removeEventListener("visibilitychange", onVisible);
        Array.from(peers.keys()).forEach(dropPeer);
        if (ws) ws.close();
      },
    };
  }

  /* ---------- Копия прогресса на сервере ----------
   * Прогресс сжимается (gzip) и шифруется AES-GCM на устройстве. Сервер хранит
   * нечитаемый блок, id и токен записи выводятся из секрета пары. Конфликты
   * решаются версиями: при 409 скачиваем свежую копию, объединяем и пишем снова.
   */
  const API = SIGNAL_URL.replace(/^wss:/, "https:").replace(/^ws:/, "http:") + "/v1/blob/";

  async function deriveCloud(secret) {
    const id = hex(await sha256("greek-sync/blob/" + secret));
    const token = hex(await sha256("greek-sync/auth/" + secret));
    const raw = await sha256("greek-sync/data/" + secret);
    const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
    return { id, token, key };
  }
  const canZip = typeof CompressionStream === "function" && typeof DecompressionStream === "function";
  const pipe = (bytes, stream) => new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer();
  // Формат: [1 байт: 1 = gzip, 0 = без сжатия] [12 байт iv] [шифротекст]
  async function pack(key, obj) {
    let body = te.encode(JSON.stringify(obj));
    const zip = canZip ? 1 : 0;
    if (zip) body = new Uint8Array(await pipe(body, new CompressionStream("gzip")));
    const iv = rand(12);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, body));
    const out = new Uint8Array(1 + 12 + ct.length);
    out[0] = zip; out.set(iv, 1); out.set(ct, 13);
    return out;
  }
  async function unpack(key, buf) {
    const b = new Uint8Array(buf);
    if (b.length < 14) return null;
    try {
      let pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b.slice(1, 13) }, key, b.slice(13));
      if (b[0] === 1) pt = await pipe(pt, new DecompressionStream("gzip"));
      return JSON.parse(td.decode(pt));
    } catch (e) {
      return null;
    }
  }
  const verOf = (res) => parseInt((res.headers.get("ETag") || "").replace(/\D/g, ""), 10) || 0;

  function cloud({ secret, getState, onData, onStatus }) {
    let c = null, ver = 0, dirty = true, busy = false, again = false, closed = false, timer = null, poll = null;
    const ready = deriveCloud(secret).then((d) => { c = d; });

    async function pull() {
      const res = await fetch(API + c.id, { cache: "no-store" });
      if (res.status === 404) { ver = 0; return; }
      if (!res.ok) throw new Error("GET " + res.status);
      ver = verOf(res);
      const data = await unpack(c.key, await res.arrayBuffer());
      if (data) onData(Object.assign({}, data, { t: "state" }));
    }
    async function push(keepalive) {
      for (let attempt = 0; attempt < 4; attempt++) {
        const body = await pack(c.key, getState());
        const res = await fetch(API + c.id, {
          method: "PUT", body, keepalive: !!keepalive && body.length < 60000,
          headers: { Authorization: "Bearer " + c.token, "If-Match": `"${ver}"`, "Content-Type": "application/octet-stream" },
        });
        if (res.ok) { ver = verOf(res); return true; }
        if (res.status !== 409 || keepalive) throw new Error("PUT " + res.status);
        await pull(); // кто-то записал раньше нас: объединяем и пробуем снова
      }
      throw new Error("PUT conflict");
    }
    async function run() {
      if (closed) return;
      if (busy) { again = true; return; }
      busy = true;
      try {
        await ready;
        onStatus("saving");
        await pull();
        if (dirty) { dirty = false; await push(); }
        onStatus("saved", Date.now());
      } catch (e) {
        dirty = true;
        onStatus("error");
      } finally {
        busy = false;
        if (again) { again = false; run(); }
      }
    }
    const onVisible = () => { if (document.visibilityState === "visible") run(); };
    const onHide = () => { if (dirty && c && !busy) { dirty = false; push(true).catch(() => { dirty = true; }); } };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pagehide", onHide);
    poll = setInterval(() => { if (document.visibilityState === "visible") run(); }, 60000);
    run();

    return {
      markDirty() { dirty = true; clearTimeout(timer); timer = setTimeout(run, 4000); },
      syncNow: run,
      async wipe() {
        await ready;
        const res = await fetch(API + c.id, { method: "DELETE", headers: { Authorization: "Bearer " + c.token } });
        if (!res.ok && res.status !== 404) throw new Error("DELETE " + res.status);
      },
      close() {
        closed = true;
        clearTimeout(timer); clearInterval(poll);
        document.removeEventListener("visibilitychange", onVisible);
        window.removeEventListener("pagehide", onHide);
      },
    };
  }

  window.GSync = {
    start,
    cloud,
    newSecret: () => b64u.enc(rand(16)),
    supported: () => "RTCPeerConnection" in window && "WebSocket" in window && !!(window.crypto && crypto.subtle),
  };
})();
