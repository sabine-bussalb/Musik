/* Musik – Klavier, Stimmgerät, Metronom */
(() => {
  "use strict";

  // ---------------------------------------------------------------- Hilfen
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

  const store = {
    get(k, d) { try { const v = localStorage.getItem("musik." + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem("musik." + k, JSON.stringify(v)); } catch { /* egal */ } },
  };

  const fmt1 = new Intl.NumberFormat("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 1, useGrouping: false });
  const MINUS = "−";

  // Deutsche Notennamen
  const PC_NAMES = ["C", "Cis", "D", "Dis", "E", "F", "Fis", "G", "Gis", "A", "Ais", "H"];
  const SUP = ["", "¹", "²", "³", "⁴", "⁵", "⁶"];
  const SUB = ["", "₁", "₂"];
  const isBlack = (m) => [1, 3, 6, 8, 10].includes(((m % 12) + 12) % 12);
  const pcName = (m) => PC_NAMES[((m % 12) + 12) % 12];
  const sciOct = (m) => Math.floor(m / 12) - 1;
  /** Helmholtz-Schreibweise: C₁, C, c, c¹, c² … */
  function helmholtz(m) {
    const name = pcName(m), o = sciOct(m);
    if (o >= 3) return name.toLowerCase() + (SUP[o - 3] || "");
    if (o === 2) return name;
    return name + (SUB[2 - o] || "");
  }

  let a4 = clamp(store.get("a4", 440), 430, 450);
  const midiToHz = (m) => a4 * Math.pow(2, (m - 69) / 12);

  // ---------------------------------------------------------------- Audio
  const AC = window.AudioContext || window.webkitAudioContext;
  const setSession = (type) => { try { if (navigator.audioSession) navigator.audioSession.type = type; } catch { /* nicht unterstützt */ } };
  setSession("playback");

  // Wiedergabe (Klavier + Metronom). Das Stimmgerät hat einen eigenen Audio-Kontext,
  // weil iOS nach Mikrofonbenutzung den Wiedergabe-Kontext sonst oft stumm schaltet.
  let running = false; // Metronom läuft
  const voices = new Map(); // Klavier: midi -> {src, gain}
  let ctx, master, pianoBus, metroBus, unlocked = false, needsRebuild = false;
  function buildAudio() {
    ctx = new AC({ latencyHint: "interactive" });
    master = ctx.createDynamicsCompressor();
    master.threshold.value = -10; master.knee.value = 12; master.ratio.value = 4;
    master.attack.value = 0.003; master.release.value = 0.25;
    master.connect(ctx.destination);
    pianoBus = ctx.createGain(); pianoBus.gain.value = 0.9; pianoBus.connect(master);
    metroBus = ctx.createGain(); metroBus.gain.value = 0.9; metroBus.connect(master);
    unlocked = false;
    needsRebuild = false;
    clickBufs = makeClicks(ctx);
  }

  // Metronom-Klicks einmal vorberechnen (leichter als Oszillatoren pro Schlag)
  let clickBufs = null;
  function makeClicks(c) {
    const sr = c.sampleRate;
    return [[1760, 1.0, 0.075], [1320, 0.75, 0.055], [1000, 0.6, 0.055]].map(([f, peak, len]) => {
      const n = Math.floor(sr * (len + 0.01));
      const b = c.createBuffer(1, n, sr);
      const d = b.getChannelData(0);
      const atk = sr * 0.0015, k = Math.log(peak / 0.0008) / (sr * len);
      for (let i = 0; i < n; i++) {
        const env = i < atk ? (i / atk) * peak : peak * Math.exp(-k * (i - atk));
        d[i] = Math.sin(2 * Math.PI * f * i / sr) * env;
      }
      return b;
    });
  }
  buildAudio();

  let lastRebuild = -Infinity;
  function rebuildAudio() {
    const now = performance.now();
    if (now - lastRebuild < 3000) return; // nie in schneller Folge neu aufbauen
    lastRebuild = now;
    voices.clear();
    const old = ctx;
    buildAudio();
    try { const p = old.close(); if (p && p.catch) p.catch(() => {}); } catch { /* */ }
  }

  /** Bei jeder Berührung aufrufen: hält die Tonausgabe am Leben (iOS). */
  function unlockAudio() {
    // Neu aufbauen nur nach Mikrofonbenutzung oder wenn der Kontext geschlossen ist –
    // und nie, während das Metronom läuft.
    if ((needsRebuild || ctx.state === "closed") && !running) rebuildAudio();
    if (ctx.state !== "running") ctx.resume().catch(() => {});
    if (!unlocked) {
      unlocked = true;
      const b = ctx.createBuffer(1, 1, ctx.sampleRate);
      const s = ctx.createBufferSource(); s.buffer = b; s.connect(ctx.destination); s.start(0);
    }
  }
  ["pointerdown", "touchend", "keydown"].forEach((ev) =>
    window.addEventListener(ev, unlockAudio, { capture: true, passive: true }));

  // Eigener Kontext nur zum Dekodieren – unabhängig vom Neuaufbau der Wiedergabe
  const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  let decoder = null;
  try { decoder = new OAC(2, 1, 44100); } catch { decoder = null; }
  const decode = (ab) => new Promise((res, rej) => {
    const p = (decoder || ctx).decodeAudioData(ab, res, rej);
    if (p && p.then) p.then(res, rej);
  });

  // ================================================================ KLAVIER
  const SAMPLE_PCS = { C: 0, Ds: 3, Fs: 6, A: 9 };
  const sampleList = [{ name: "A0", midi: 21 }];
  for (let o = 1; o <= 7; o++) for (const [n, pc] of Object.entries(SAMPLE_PCS)) sampleList.push({ name: n + o, midi: (o + 1) * 12 + pc });
  sampleList.push({ name: "C8", midi: 108 });

  const samples = new Map(); // midi -> {buf, offset}

  async function loadSample(s) {
    if (samples.has(s.midi)) return;
    try {
      const r = await fetch("samples/" + s.name + ".mp3");
      if (!r.ok) return;
      const buf = await decode(await r.arrayBuffer());
      // führende Stille (Encoder-Verzögerung) überspringen
      const d = buf.getChannelData(0);
      let i = 0; while (i < d.length && Math.abs(d[i]) < 0.002) i++;
      samples.set(s.midi, { buf, offset: Math.max(0, i - 32) / buf.sampleRate });
    } catch { /* Ersatzklang wird verwendet */ }
  }
  async function loadSamplesNear(center) {
    const sorted = sampleList.slice().sort((a, b) => Math.abs(a.midi - center) - Math.abs(b.midi - center));
    for (const s of sorted) await loadSample(s);
  }

  function nearestSample(m) {
    let best = null, bd = 1e9;
    for (const [sm, v] of samples) { const d = Math.abs(sm - m); if (d < bd) { bd = d; best = { midi: sm, ...v }; } }
    return bd <= 6 ? best : null;
  }

  function noteOn(m) {
    noteOff(m, 0.02);
    const t = ctx.currentTime;
    const g = ctx.createGain();
    g.connect(pianoBus);
    const s = nearestSample(m);
    let src;
    if (s) {
      src = ctx.createBufferSource();
      src.buffer = s.buf;
      src.playbackRate.value = Math.pow(2, (m - s.midi) / 12) * (a4 / 440);
      g.gain.value = 0.85;
      src.connect(g);
      src.start(t, s.offset);
    } else {
      // Ersatzklang, solange die Samples noch laden
      src = ctx.createOscillator();
      src.type = "triangle";
      src.frequency.value = midiToHz(m);
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.4, t + 0.005);
      g.gain.setTargetAtTime(0.0, t + 0.01, 0.6);
      src.connect(g);
      src.start(t);
    }
    voices.set(m, { src, gain: g });
  }
  function noteOff(m, tc) {
    const v = voices.get(m);
    if (!v) return;
    voices.delete(m);
    const t = ctx.currentTime;
    const timeConst = tc ?? (m >= 89 ? 0.5 : 0.09); // ganz oben keine Dämpfer
    try {
      v.gain.gain.cancelScheduledValues(t);
      v.gain.gain.setValueAtTime(v.gain.gain.value, t);
      v.gain.gain.setTargetAtTime(0, t, timeConst);
      v.src.stop(t + timeConst * 8 + 0.05);
    } catch { /* schon gestoppt */ }
    setTimeout(() => { try { v.gain.disconnect(); } catch { /* */ } }, (timeConst * 8 + 0.2) * 1000);
  }

  // Tastatur
  const keyboardEl = $("#keyboard");
  const noteEl = $("#piano-note");
  const rangeEl = $("#piano-range");
  let startOct = clamp(store.get("octave", 3), 1, 6);
  let keyEls = new Map();
  const BLACK_SHIFT = { 1: -0.08, 3: 0.08, 6: -0.1, 8: 0, 10: 0.1 };

  function buildKeyboard() {
    releaseAll();
    const first = (startOct + 1) * 12, last = first + 24;
    const whites = [];
    for (let m = first; m <= last; m++) if (!isBlack(m)) whites.push(m);
    const w = 100 / whites.length;
    const bw = w * 0.6;
    const wrap = document.createElement("div");
    wrap.className = "keys";
    keyEls = new Map();
    let wi = -1;
    for (let m = first; m <= last; m++) {
      const k = document.createElement("div");
      k.dataset.midi = m;
      const black = isBlack(m);
      k.className = "key " + (black ? "black" : "white");
      if (black) {
        const shift = BLACK_SHIFT[m % 12] * w;
        k.style.left = ((wi + 1) * w - bw / 2 + shift) + "%";
        k.style.width = bw + "%";
      } else {
        wi++;
        k.style.left = (wi * w) + "%";
        k.style.width = w + "%";
      }
      if (m === 60) { const d = document.createElement("span"); d.className = "mid-c"; d.title = "Mittleres C"; k.appendChild(d); }
      const l = document.createElement("span"); l.className = "label"; l.textContent = pcName(m);
      k.appendChild(l);
      wrap.appendChild(k);
      keyEls.set(m, k);
    }
    keyboardEl.replaceChildren(wrap);
    rangeEl.textContent = `C${startOct}–C${startOct + 2}`;
    $("#oct-down").disabled = startOct <= 1;
    $("#oct-up").disabled = startOct >= 6;
  }

  const held = new Map(); // pointerId -> midi
  function holders(m) { let n = 0; for (const v of held.values()) if (v === m) n++; return n; }
  function press(m) {
    noteOn(m);
    keyEls.get(m)?.classList.add("down");
    noteEl.innerHTML = `${helmholtz(m)} <span class="hz">· ${fmt1.format(midiToHz(m))} Hz</span>`;
  }
  function release(m) {
    if (holders(m) > 0) return;
    noteOff(m);
    keyEls.get(m)?.classList.remove("down");
  }
  function releaseAll() {
    for (const m of [...held.values()]) { held.clear(); release(m); }
    held.clear();
    for (const m of [...voices.keys()]) noteOff(m);
    keyEls.forEach((k) => k.classList.remove("down"));
  }
  function keyAt(x, y) {
    const el = document.elementFromPoint(x, y);
    const k = el && el.closest(".key");
    return k && keyboardEl.contains(k) ? +k.dataset.midi : null;
  }
  keyboardEl.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    unlockAudio();
    try { keyboardEl.setPointerCapture(e.pointerId); } catch { /* */ }
    const m = keyAt(e.clientX, e.clientY);
    if (m === null) return;
    const already = holders(m) > 0;
    held.set(e.pointerId, m);
    if (!already) press(m);
  });
  keyboardEl.addEventListener("pointermove", (e) => {
    if (!held.has(e.pointerId)) return;
    const m = keyAt(e.clientX, e.clientY);
    const old = held.get(e.pointerId);
    if (m === old) return;
    if (m === null) { held.delete(e.pointerId); release(old); return; }
    held.set(e.pointerId, m);
    release(old);
    if (holders(m) === 1) press(m);
  });
  const endPointer = (e) => {
    if (!held.has(e.pointerId)) return;
    const m = held.get(e.pointerId);
    held.delete(e.pointerId);
    release(m);
  };
  ["pointerup", "pointercancel", "lostpointercapture"].forEach((ev) => keyboardEl.addEventListener(ev, endPointer));
  keyboardEl.addEventListener("contextmenu", (e) => e.preventDefault());

  $("#oct-down").addEventListener("click", () => { startOct = clamp(startOct - 1, 1, 6); store.set("octave", startOct); buildKeyboard(); });
  $("#oct-up").addEventListener("click", () => { startOct = clamp(startOct + 1, 1, 6); store.set("octave", startOct); buildKeyboard(); });

  let namesOn = store.get("names", true);
  const namesBtn = $("#toggle-names");
  function applyNames() { document.body.classList.toggle("names-off", !namesOn); namesBtn.setAttribute("aria-pressed", String(namesOn)); }
  namesBtn.addEventListener("click", () => { namesOn = !namesOn; store.set("names", namesOn); applyNames(); });

  buildKeyboard();
  applyNames();
  loadSamplesNear((startOct + 2) * 12);

  // ================================================================ STIMMGERÄT
  const tunerEl = $(".tuner");
  const tNote = $("#tuner-note"), tFreq = $("#tuner-freq"), tStatus = $("#tuner-status");
  const micBtn = $("#mic-start");
  const needle = $("#needle");
  const a4Val = $("#a4-value");

  // Skala zeichnen
  (function drawGauge() {
    const cx = 150, cy = 150;
    const pt = (c, r) => { const a = (c / 50) * (Math.PI / 2); return [cx + r * Math.sin(a), cy - r * Math.cos(a)]; };
    let html = "";
    for (let c = -50; c <= 50; c += 5) {
      const major = c % 25 === 0;
      const [x1, y1] = pt(c, major ? 100 : 110);
      const [x2, y2] = pt(c, 120);
      html += `<line class="tick ${major ? "major" : "minor"}" x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"/>`;
      if (major) {
        const [lx, ly] = pt(c, 136);
        const txt = c === 0 ? "0" : (c < 0 ? MINUS + Math.abs(c) : "+" + c);
        html += `<text class="tick-label" x="${lx.toFixed(1)}" y="${(ly + 4).toFixed(1)}">${txt}</text>`;
      }
    }
    $("#gauge-ticks").innerHTML = html;
    const [zx1, zy1] = pt(-5, 113), [zx2, zy2] = pt(5, 113);
    $("#gauge-zone").setAttribute("d", `M${zx1.toFixed(1)} ${zy1.toFixed(1)} A113 113 0 0 1 ${zx2.toFixed(1)} ${zy2.toFixed(1)}`);
  })();

  let micCtx = null, micStream = null, micSource = null, analyser = null, tBuf = null, tunerRAF = 0, micStarting = false;

  function setStatus(text, cls) {
    if (tStatus.textContent !== text) tStatus.textContent = text;
    tunerEl.classList.toggle("ok", cls === "ok");
    tunerEl.classList.toggle("warn", cls === "warn");
    tunerEl.classList.toggle("off", cls === "off");
  }

  async function startMic() {
    unlockAudio();
    if (micStream || micStarting) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setStatus("Mikrofon nicht verfügbar", "off"); micBtn.hidden = true; return;
    }
    micStarting = true;
    micBtn.hidden = true;
    // eigener Kontext, im Tipp-Ereignis erzeugt, damit iOS ihn starten lässt
    if (!micCtx || micCtx.state === "closed") micCtx = new AC();
    micCtx.resume().catch(() => {});
    setStatus("Mikrofon wird gestartet …", "off");
    try {
      setSession("play-and-record");
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      if (currentView !== "stimmgeraet") { stream.getTracks().forEach((t) => t.stop()); closeMicCtx(); return; }
      micStream = stream;
      if (micCtx.state !== "running") await micCtx.resume().catch(() => {});
      micSource = micCtx.createMediaStreamSource(stream);
      analyser = micCtx.createAnalyser();
      analyser.fftSize = 4096;
      tBuf = new Float32Array(analyser.fftSize);
      micSource.connect(analyser);
      resetTuner();
      setStatus("Spiel einen Ton", "off");
      tunerRAF = requestAnimationFrame(tunerLoop);
      if (micCtx.state !== "running") { micBtn.hidden = false; micBtn.textContent = "Zum Starten tippen"; }
    } catch (err) {
      closeMicCtx();
      const denied = err && (err.name === "NotAllowedError" || err.name === "SecurityError");
      setStatus(denied ? "Kein Zugriff aufs Mikrofon" : "Mikrofon nicht verfügbar", "off");
      micBtn.textContent = "Mikrofon starten";
      micBtn.hidden = false;
    } finally {
      micStarting = false;
    }
  }
  function stopMic() {
    cancelAnimationFrame(tunerRAF); tunerRAF = 0;
    if (micSource) { try { micSource.disconnect(); } catch { /* */ } micSource = null; }
    if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
    analyser = null;
    closeMicCtx();
  }
  function closeMicCtx() {
    if (micCtx) {
      try { micCtx.close(); } catch { /* */ }
      micCtx = null;
      setSession("playback");
      // iOS hat die Tonausgabe umgestellt – Wiedergabe beim nächsten Antippen frisch aufbauen
      needsRebuild = true;
    }
  }
  micBtn.addEventListener("click", () => {
    unlockAudio();
    if (micStream) { micCtx && micCtx.resume().catch(() => {}); micBtn.hidden = true; return; }
    startMic();
  });

  // YIN-Tonhöhenerkennung
  let yinD = null;
  function detectPitch(buf, sr) {
    let rms = 0;
    for (let i = 0; i < buf.length; i++) rms += buf[i] * buf[i];
    rms = Math.sqrt(rms / buf.length);
    if (rms < 0.006) return -1;
    const tauMin = Math.floor(sr / 2000);
    const tauMax = Math.min(Math.floor(sr / 38), Math.floor(buf.length / 2));
    const W = buf.length - tauMax;
    if (!yinD || yinD.length !== tauMax + 1) yinD = new Float32Array(tauMax + 1);
    const d = yinD;
    d[0] = 1;
    let running = 0;
    for (let tau = 1; tau <= tauMax; tau++) {
      let s = 0;
      for (let i = 0; i < W; i++) { const x = buf[i] - buf[i + tau]; s += x * x; }
      running += s;
      d[tau] = running > 0 ? (s * tau) / running : 1;
    }
    let tau = -1;
    for (let t = tauMin; t <= tauMax; t++) {
      if (d[t] < 0.13) {
        while (t + 1 <= tauMax && d[t + 1] < d[t]) t++;
        tau = t; break;
      }
    }
    if (tau < 0) return -1;
    let better = tau;
    if (tau > 1 && tau < tauMax) {
      const a = d[tau - 1], b = d[tau], c = d[tau + 1];
      const den = a + c - 2 * b;
      if (den !== 0) better = tau + (a - c) / (2 * den);
    }
    return sr / better;
  }

  // Glättung
  const median = (arr) => { const s = arr.slice().sort((a, b) => a - b); return s[s.length >> 1]; };
  let sm = null, shownNote = null, recent = [], jumpBuf = [], lastHeard = 0, lastDetect = 0;
  let needlePos = 0, needleVel = 0, lastFrame = 0;
  function resetTuner() {
    sm = null; shownNote = null; recent = []; jumpBuf = []; lastHeard = 0;
    tNote.textContent = "–"; tFreq.innerHTML = "&nbsp;";
  }

  function feed(freq, now) {
    const m = 69 + 12 * Math.log2(freq / a4);
    if (sm === null) {
      jumpBuf.push(m);
      if (jumpBuf.length > 4) jumpBuf.shift();
      if (jumpBuf.length >= 3) {
        const md = median(jumpBuf);
        if (jumpBuf.every((v) => Math.abs(v - md) < 0.4)) { sm = md; recent = [md]; jumpBuf = []; }
      }
    } else if (Math.abs(m - sm) > 0.7) {
      // möglicher neuer Ton (oder Oktavfehler) – nur nach Bestätigung übernehmen
      jumpBuf.push(m);
      if (jumpBuf.length > 5) jumpBuf.shift();
      if (jumpBuf.length >= 4) {
        const md = median(jumpBuf);
        if (jumpBuf.slice(-4).every((v) => Math.abs(v - md) < 0.35)) { sm = md; recent = [md]; jumpBuf = []; }
      }
      return;
    } else {
      jumpBuf = [];
      recent.push(m);
      if (recent.length > 7) recent.shift();
      const target = median(recent);
      sm += (target - sm) * 0.12;
    }
    if (sm !== null) lastHeard = now;
  }

  function tunerLoop(now) {
    tunerRAF = requestAnimationFrame(tunerLoop);
    if (!analyser || !micCtx) return;
    const dt = Math.min(0.05, lastFrame ? (now - lastFrame) / 1000 : 0.016);
    lastFrame = now;

    if (now - lastDetect >= 30) {
      lastDetect = now;
      analyser.getFloatTimeDomainData(tBuf);
      const f = detectPitch(tBuf, micCtx.sampleRate);
      if (f > 0) feed(f, now);
    }

    const active = sm !== null && now - lastHeard < 1200;
    if (sm !== null && now - lastHeard > 4000) { resetTuner(); }

    let targetCents = 0;
    if (sm !== null) {
      if (shownNote === null || Math.abs(sm - shownNote) > 0.55) shownNote = Math.round(sm);
      const cents = clamp((sm - shownNote) * 100, -50, 50);
      const name = pcName(shownNote);
      if (tNote.textContent !== name) tNote.textContent = name;
      const fl = `${helmholtz(shownNote)} · ${fmt1.format(a4 * Math.pow(2, (sm - 69) / 12))} Hz`;
      if (tFreq.textContent !== fl) tFreq.textContent = fl;
      if (active) {
        targetCents = cents;
        const rc = Math.round(cents);
        if (Math.abs(cents) <= 5) setStatus("Stimmt", "ok");
        else setStatus(`${rc < 0 ? MINUS : "+"}${Math.abs(rc)} Cent · ${rc < 0 ? "zu tief" : "zu hoch"}`, "warn");
      } else {
        setStatus("Spiel einen Ton", "off");
      }
    } else if (micStream) {
      setStatus("Spiel einen Ton", "off");
    }

    // Zeiger: kritisch gedämpfte Feder – ruhiges Schwenken
    const k = active ? 28 : 6;
    const c = 2 * Math.sqrt(k);
    const acc = k * (targetCents - needlePos) - c * needleVel;
    needleVel += acc * dt;
    needlePos += needleVel * dt;
    needle.setAttribute("transform", `rotate(${(needlePos / 50 * 90).toFixed(2)} 150 150)`);
  }

  function showA4() { a4Val.textContent = a4 + " Hz"; }
  function stepA4(d) {
    a4 = clamp(a4 + d, 430, 450); store.set("a4", a4); showA4();
    $("#a4-down").disabled = a4 <= 430; $("#a4-up").disabled = a4 >= 450;
  }
  showA4(); stepA4(0);

  // ================================================================ METRONOM
  const bpmEl = $("#bpm"), slider = $("#bpm-slider"), tempoEl = $("#tempo-name"), dotsEl = $("#dots");
  const ssBtn = $("#startstop"), ssLabel = $("#startstop-label");
  let bpm = clamp(store.get("bpm", 100), 30, 240);
  let meter = [2, 3, 4, 6].includes(store.get("meter", 4)) ? store.get("meter", 4) : 4;
  let nextTime = 0, beat = 0, queue = [], metroRAF = 0, resetBeat = false;

  const TEMPI = [[59, "Largo"], [65, "Larghetto"], [75, "Adagio"], [107, "Andante"], [119, "Moderato"], [155, "Allegro"], [175, "Vivace"], [240, "Presto"]];
  const tempoName = (b) => TEMPI.find(([max]) => b <= max)[1];

  function setBpm(v) {
    bpm = clamp(Math.round(v), 30, 240);
    bpmEl.textContent = bpm;
    slider.value = bpm;
    slider.style.setProperty("--fill", ((bpm - 30) / 210 * 100) + "%");
    tempoEl.textContent = tempoName(bpm);
    store.set("bpm", bpm);
  }

  function buildDots() {
    dotsEl.replaceChildren(...Array.from({ length: meter }, (_, i) => {
      const d = document.createElement("span"); d.className = "dot" + (i === 0 ? " first" : ""); return d;
    }));
    $$(".seg").forEach((b) => b.setAttribute("aria-checked", String(+b.dataset.meter === meter)));
  }
  $$(".seg").forEach((b) => {
    b.setAttribute("role", "radio");
    b.addEventListener("click", () => { meter = +b.dataset.meter; store.set("meter", meter); buildDots(); resetBeat = true; });
  });

  let pending = []; // geplante, evtl. noch nicht gespielte Klicks
  function click(t, kind) {
    const s = ctx.createBufferSource();
    s.buffer = clickBufs[kind];
    s.connect(metroBus);
    s.start(t);
    pending.push(s);
    s.onended = () => { const i = pending.indexOf(s); if (i >= 0) pending.splice(i, 1); try { s.disconnect(); } catch { /* */ } };
  }

  function schedule() {
    if (!running) return;
    const now = ctx.currentTime;
    // Hinkt der Zeitplan hinterher (App war blockiert/im Hintergrund), nicht nachholen,
    // sondern ab jetzt weiterzählen – sonst gäbe es eine Klick-Lawine.
    if (nextTime < now - 0.05) nextTime = now + 0.05;
    const ahead = now + 0.12;
    let guard = 0;
    while (nextTime < ahead && guard++ < 4) {
      if (resetBeat) { beat = 0; resetBeat = false; }
      const kind = beat === 0 ? 0 : (meter === 6 && beat === 3) ? 1 : 2;
      click(nextTime, kind);
      queue.push({ t: nextTime, beat, dur: 60 / bpm });
      if (queue.length > 16) queue.shift();
      nextTime += 60 / bpm;
      beat = (beat + 1) % meter;
    }
  }

  // Taktgeber in einem Worker, damit er nicht vom Bildaufbau ausgebremst wird
  let ticker = null;
  try {
    const src = "let id=0;onmessage=e=>{clearInterval(id);if(e.data==='start')id=setInterval(()=>postMessage(0),25)}";
    ticker = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
    ticker.onmessage = schedule;
  } catch {
    let id = 0;
    ticker = { postMessage: (m) => { clearInterval(id); if (m === "start") id = setInterval(schedule, 25); } };
  }

  let offTimer = 0;
  function metroDraw() {
    metroRAF = requestAnimationFrame(metroDraw);
    const heard = ctx.currentTime - (ctx.outputLatency || 0);
    let ev = null;
    while (queue.length && queue[0].t <= heard) ev = queue.shift();
    if (ev) {
      const dots = dotsEl.children;
      for (let i = 0; i < dots.length; i++) dots[i].classList.toggle("on", i === ev.beat);
      clearTimeout(offTimer);
      const d = dots[ev.beat];
      offTimer = setTimeout(() => d && d.classList.remove("on"), Math.min(160, ev.dur * 500));
    }
  }

  function startMetro() {
    unlockAudio();
    if (running) return;
    running = true;
    beat = 0; resetBeat = false; queue = [];
    nextTime = ctx.currentTime + 0.06;
    schedule();
    ticker.postMessage("start");
    metroRAF = requestAnimationFrame(metroDraw);
    ssBtn.setAttribute("aria-pressed", "true"); ssLabel.textContent = "Stopp";
  }
  function stopMetro() {
    running = false;
    ticker.postMessage("stop");
    // schon geplante Klicks sofort abbrechen
    for (const s of pending) { try { s.stop(0); s.disconnect(); } catch { /* */ } }
    pending = [];
    cancelAnimationFrame(metroRAF);
    queue = [];
    $$(".dot", dotsEl).forEach((d) => d.classList.remove("on"));
    ssBtn.setAttribute("aria-pressed", "false"); ssLabel.textContent = "Start";
  }
  ssBtn.addEventListener("click", () => (running ? stopMetro() : startMetro()));

  slider.addEventListener("input", () => setBpm(+slider.value));

  // Tap-Tempo
  let taps = [];
  const tapBtn = $("#tap");
  tapBtn.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    const now = performance.now();
    if (taps.length && now - taps[taps.length - 1] > 2000) taps = [];
    taps.push(now);
    if (taps.length > 6) taps.shift();
    if (taps.length >= 2) {
      const avg = (taps[taps.length - 1] - taps[0]) / (taps.length - 1);
      setBpm(60000 / avg);
    }
    tapBtn.classList.add("flash");
    setTimeout(() => tapBtn.classList.remove("flash"), 90);
  });

  // Gedrückt halten = wiederholen
  function repeatButton(btn, fn) {
    let t1 = 0, t2 = 0;
    const stop = () => { clearTimeout(t1); clearInterval(t2); btn.classList.remove("pressed"); };
    btn.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      btn.classList.add("pressed");
      fn();
      t1 = setTimeout(() => { t2 = setInterval(fn, 70); }, 420);
    });
    ["pointerup", "pointerleave", "pointercancel"].forEach((ev) => btn.addEventListener(ev, stop));
    btn.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fn(); } });
  }
  repeatButton($("#bpm-down"), () => setBpm(bpm - 1));
  repeatButton($("#bpm-up"), () => setBpm(bpm + 1));
  repeatButton($("#a4-down"), () => stepA4(-1));
  repeatButton($("#a4-up"), () => stepA4(+1));

  setBpm(bpm);
  buildDots();

  // ================================================================ ANSICHTEN
  const THEMES = { klavier: ["blau", "#E7F1FB"], stimmgeraet: ["flieder", "#F3EEFB"], metronom: ["petrol", "#E6F1F3"] };
  let currentView = null;
  function showView(name, fromGesture) {
    if (!THEMES[name]) name = "klavier";
    currentView = name;
    for (const v of $$(".view")) v.hidden = v.id !== "view-" + name;
    for (const t of $$(".tab")) {
      if (t.dataset.tab === name) t.setAttribute("aria-current", "page"); else t.removeAttribute("aria-current");
    }
    const [theme, color] = THEMES[name];
    document.body.dataset.theme = theme;
    document.body.dataset.view = name;
    $('meta[name="theme-color"]').setAttribute("content", color);
    store.set("tab", name);
    if (name !== "klavier") releaseAll();
    if (name === "stimmgeraet") {
      if (fromGesture) startMic();
      else if (!micStream) { setStatus("Bereit", "off"); micBtn.textContent = "Mikrofon starten"; micBtn.hidden = false; }
    } else {
      stopMic();
    }
  }
  $$(".tab").forEach((t) => t.addEventListener("click", () => { unlockAudio(); showView(t.dataset.tab, true); }));

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      releaseAll();
      if (micStream) { stopMic(); }
    } else if (ctx.state === "interrupted" || ctx.state === "closed") {
      needsRebuild = true;
    }
    if (!document.hidden && currentView === "stimmgeraet" && !micStream) {
      setStatus("Bereit", "off"); micBtn.textContent = "Mikrofon starten"; micBtn.hidden = false;
    }
  });

  showView(store.get("tab", "klavier"), false);

  // ================================================================ DREHEN
  // Beim Drehen hängende Tasten lösen und eine evtl. iOS-Vergrößerung zurücksetzen
  const vpMeta = $('meta[name="viewport"]');
  const VP = vpMeta.getAttribute("content");
  function onRotate() {
    releaseAll();
    vpMeta.setAttribute("content", VP + ", minimum-scale=1");
    setTimeout(() => { vpMeta.setAttribute("content", VP); window.scrollTo(0, 0); }, 50);
  }
  window.addEventListener("orientationchange", onRotate);
  if (screen.orientation) screen.orientation.addEventListener("change", onRotate);

  // ================================================================ OFFLINE
  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).then((reg) => {
        // bei jedem Zurückkehren in die App nach einer neuen Version schauen
        document.addEventListener("visibilitychange", () => { if (!document.hidden) reg.update().catch(() => {}); });
      }).catch(() => {});
    });
    // Neue Version aktiv → einmal neu laden (nicht, während das Metronom läuft)
    const hadController = !!navigator.serviceWorker.controller;
    let reloaded = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (!hadController || reloaded) return;
      reloaded = true;
      if (!running) location.reload();
    });
  }
})();
