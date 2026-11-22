// Speech capture — shared listener and letter-name scorer (Vision §5.4 SR-1..SR-10; Pedagogy §6 R-1..R-12).
// Spec: "Speech Capture Module Spec" (reviewed by Otto 2026-11-22).
//
//  * The recognizer is the browser's Web Speech API (cloud). Audio is never stored by the page (SR-10, PL-9).
//  * Default turn-taking is half-duplex: the recognizer is OFF while narration plays, and starts the moment the
//    prompt ends, so nothing is thrown away by timing.
//  * A correct answer is accepted from interim or final results, at any rank.
//  * "Incorrect" needs the same wrong answer on both attempts (R-1, R-2); everything else unclear is `uncertain`.
//  * No separate held microphone stream by default; `holdStream` exists for hosts that re-ask on every start.
//  * attemptLegacy() reproduces ORT-22's listen-through-narration flow for the speech bench comparison ONLY.

const now = () => performance.now();

// ---------------------------------------------------------------- lexicon

export async function loadLetterNames(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`letter-name variants: HTTP ${res.status}`);
  return compileLexicon(await res.json());
}

export function compileLexicon(data) {
  const tokenToLetter = new Map(), tokenToSound = new Map(), dup = [];
  for (const [ch, toks] of Object.entries(data.names)) for (const t of toks) {
    if (tokenToLetter.has(t) && tokenToLetter.get(t) !== ch) dup.push(t);
    tokenToLetter.set(t, ch);
  }
  for (const [ch, toks] of Object.entries(data.sounds || {})) for (const t of toks) {
    if (tokenToLetter.has(t) || (tokenToSound.has(t) && tokenToSound.get(t) !== ch)) dup.push(t);
    tokenToSound.set(t, ch);
  }
  const weak = new Map(Object.entries(data.weak || {}));
  for (const t of weak.keys()) if (tokenToLetter.has(t) || tokenToSound.has(t)) dup.push(t);
  if (dup.length) throw new Error("letter-name variants: a token belongs to two entries: " + dup.join(", "));
  const familyOf = {};
  for (const [fam, s] of Object.entries(data.families || {})) for (const ch of s) familyOf[ch] = fam;
  return { tokenToLetter, tokenToSound, weak, fillers: new Set(data.fillers || []), phrases: data.phrases || {}, familyOf, names: data.names };
}

/** Read one recognizer alternative. kind: letter | weak | sound | multi | fillers | none */
export function readAlternative(text, lex) {
  let s = String(text ?? "").toLowerCase().replace(/['’]/g, "").replace(/-/g, " ").replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  for (const [ph, tok] of Object.entries(lex.phrases)) s = s.split(ph).join(tok);
  const toks = s ? s.split(" ") : [];
  const letters = new Set(), sounds = new Set(), weak = [], unknown = [];
  let leadingUnknown = null;                     // ORT-22 stops scoring at the first unknown word
  for (const t of toks) {
    if (lex.fillers.has(t)) continue;
    if (lex.weak.has(t)) { weak.push(lex.weak.get(t)); continue; }
    if (leadingUnknown === null) leadingUnknown = !lex.tokenToLetter.has(t) && !lex.tokenToSound.has(t);
    if (lex.tokenToLetter.has(t)) { letters.add(lex.tokenToLetter.get(t)); continue; }
    if (lex.tokenToSound.has(t)) { sounds.add(lex.tokenToSound.get(t)); continue; }
    unknown.push(t);
  }
  const out = { text: s, letter: null, sound: null, kind: "none", unknown, leadingUnknown: !!leadingUnknown };
  if (!toks.length) return out;
  if (letters.size === 1 && !sounds.size) { out.kind = "letter"; out.letter = [...letters][0]; }
  else if (letters.size > 1 || (letters.size && sounds.size)) out.kind = "multi";
  else if (sounds.size === 1) { out.kind = "sound"; out.sound = [...sounds][0]; }
  else if (sounds.size > 1) out.kind = "multi";
  else if (weak.length === 1 && !unknown.length) { out.kind = "weak"; out.letter = weak[0]; }   // a sole "a", "oh", "the"
  else if (!unknown.length) out.kind = "fillers";
  return out;
}

// ---------------------------------------------------------------- scoring (spec: "Scoring a letter name")

/**
 * Score one attempt from all of its captures ({final, alts:[{transcript, confidence}]}).
 * Returns { score, heard, heard_sound, rank, confidence } with score one of:
 *   correct | different | same-family | sound | multi | no-letter | silence
 */
export function scoreLetterAttempt(captures, target, lex) {
  if (!captures.length) return { score: "silence", heard: null };
  for (const c of captures) {
    for (let i = 0; i < c.alts.length; i++) {
      const r = readAlternative(c.alts[i].transcript, lex);
      if ((r.kind === "letter" || r.kind === "weak") && r.letter === target)
        return { score: "correct", heard: target, rank: i + 1, from: c.final ? "final" : "interim", confidence: num(c.alts[i].confidence) };
    }
  }
  // Not correct: judge by the last final (or the last interim if no final came), best mapped alternative.
  const finals = captures.filter((c) => c.final);
  const c = finals.length ? finals[finals.length - 1] : captures[captures.length - 1];
  for (const a of c.alts) {
    const r = readAlternative(a.transcript, lex);
    if (r.kind === "letter" || (r.kind === "weak" && lex.familyOf[r.letter] === lex.familyOf[target])) {
      const same = lex.familyOf[r.letter] === lex.familyOf[target];
      return { score: same ? "same-family" : "different", heard: r.letter, confidence: num(a.confidence) };
    }
    if (r.kind === "sound") return { score: "sound", heard: null, heard_sound: r.sound, confidence: num(a.confidence) };
    if (r.kind === "multi") return { score: "multi", heard: null, confidence: num(a.confidence) };
  }
  return { score: "no-letter", heard: null, transcript: (c.alts[0]?.transcript || "").slice(0, 40) };
}

/** Item outcome from 1–2 attempt scores (spec: item flow steps 4–7). */
export function decideItem(attempts, target) {
  const [a1, a2] = attempts;
  if (a1?.score === "correct") return { outcome: "correct", attempt: 1 };
  if (!a2) return { outcome: "retry" };
  if (a2.score === "correct") return { outcome: "correct", attempt: 2 };
  if (a1.score === "different" && a2.score === "different" && a1.heard === a2.heard) return { outcome: "incorrect", heard: a2.heard, reason: "agreed" };
  if (a1.score === "sound" && a2.score === "sound" && a1.heard_sound === target && a2.heard_sound === target) return { outcome: "incorrect", reason: "sound-for-name" };
  if (a1.score === "silence" && a2.score === "silence") return { outcome: "no-response" };
  return { outcome: "uncertain", heard: a2.heard || a1.heard || null, next: "tap" };
}

/** ORT-22's rules (its scoreTranscript, without the unit-set rule), for bench comparison only. */
export function legacyScore(alts, target, lex) {
  const mapped = alts.map((a) => ({ r: readAlternative(a.transcript, lex), c: num(a.confidence) }))
    .filter((m) => !m.r.leadingUnknown).filter((m) => m.r.kind === "letter" || m.r.kind === "sound" || (m.r.kind === "weak" && (m.r.letter === target || lex.familyOf[m.r.letter] === lex.familyOf[target])));
  if (!mapped.length) return { score: "uncertain", reason: "no-letter" };
  const top = mapped[0];
  if (top.r.kind === "sound") return top.r.sound === target && top.c > 0 ? { score: "incorrect", reason: "sound-for-name" } : { score: "uncertain", reason: "sound" };
  const L = top.r.letter;
  if (L === target) return { score: "correct", reason: "match" };
  if (lex.familyOf[L] === lex.familyOf[target]) return { score: "uncertain", reason: "ambiguous-name", heard: L };
  if (mapped.some((m) => m.r.letter === target)) return { score: "uncertain", reason: "low-rank", heard: L };
  if (top.c != null && top.c >= 0.5) return { score: "incorrect", reason: "cross-family", heard: L };
  return { score: "uncertain", reason: "low-confidence", heard: L };
}

const num = (x) => (typeof x === "number" ? Math.round(x * 1000) / 1000 : null);

// ---------------------------------------------------------------- listener

export const SR = typeof window !== "undefined" ? window.SpeechRecognition || window.webkitSpeechRecognition || null : null;

export function speechSupported() { return !!SR && !!window.isSecureContext; }

export function phrasesSupported() {
  if (!SR || typeof window.SpeechRecognitionPhrase !== "function") return false;
  try { return "phrases" in new SR(); } catch { return false; }
}

/**
 * One recognizer that restarts itself while open (silence ends a session; the next one starts).
 * opts: { lang, continuous, holdStream, phrases: [string] | null, onEvent(ev) }
 * Events: { type: start|audiostart|speechstart|speechend|interim|final|error|end, t, alts?, error? }
 */
export class Listener {
  constructor({ lang = "en-US", continuous = false, holdStream = false, phrases = null, onEvent } = {}) {
    Object.assign(this, { lang, continuous, holdStream, phrases, onEvent: onEvent || (() => {}) });
    this.rec = null; this.wanted = false; this.active = false; this.gen = 0; this.stream = null;
    this.audioSource = null; this.phrasesApplied = false; this.ended = Promise.resolve();
  }

  /** Call inside the tap that starts a run. With holdStream, asks for the microphone once and keeps it. */
  async prepare() {
    if (!this.holdStream || this.stream) return { ok: true };
    try { this.stream = await navigator.mediaDevices.getUserMedia({ audio: true }); return { ok: true }; }
    catch (e) { return { ok: false, reason: e?.name || "error" }; }
  }

  /** Stop for good: later open() calls do nothing (a trial cut short cannot reopen the microphone). */
  dispose() { this.disposed = true; this.close(); this.release(); }

  release() { if (this.stream) { this.stream.getTracks().forEach((t) => t.stop()); this.stream = null; } }

  async open() {
    if (this.disposed) return;
    this.wanted = true;
    await this.ended;
    if (this.wanted && !this.active && !this.disposed) this._start();
  }

  close() {
    this.wanted = false;
    if (this.rec && this.active) { try { this.rec.abort(); } catch {} }
    return this.ended;
  }

  _emit(type, extra = {}) { this.onEvent({ type, t: now(), ...extra }); }

  _start() {
    const g = ++this.gen; const r = new SR();
    r.lang = this.lang; r.interimResults = true; r.maxAlternatives = 5; r.continuous = this.continuous;
    if (this.phrases && typeof window.SpeechRecognitionPhrase === "function") {
      try { r.phrases = this.phrases.map((p) => new window.SpeechRecognitionPhrase(p, 3.0)); this.phrasesApplied = true; }
      catch { this.phrasesApplied = false; }
    }
    let resolveEnded; this.ended = new Promise((res) => (resolveEnded = res));
    const mine = () => g === this.gen;
    r.onstart = () => mine() && this._emit("start");
    r.onaudiostart = () => mine() && this._emit("audiostart");
    r.onspeechstart = () => mine() && this._emit("speechstart");
    r.onspeechend = () => mine() && this._emit("speechend");
    r.onresult = (ev) => {
      if (!mine()) return;
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const res = ev.results[i]; const alts = [];
        for (let k = 0; k < res.length; k++) alts.push({ transcript: res[k].transcript, confidence: res[k].confidence });
        this._emit(res.isFinal ? "final" : "interim", { alts });
      }
    };
    r.onerror = (ev) => mine() && this._emit("error", { error: ev?.error || "unknown" });
    r.onend = () => {
      this.active = false; resolveEnded();
      if (!mine()) return;
      this._emit("end");
      if (this.wanted) setTimeout(() => { if (this.wanted && !this.active && mine()) this._start(); }, 60);
    };
    this.rec = r; this.active = true;
    const track = this.stream?.getAudioTracks()[0];
    try {
      if (track && track.readyState === "live") {
        try { r.start(track); this.audioSource = "held-stream-track"; }
        catch (e) { if (e?.name === "TypeError" || e?.name === "NotSupportedError") { r.start(); this.audioSource = "default-mic (track refused)"; } else throw e; }
      } else { r.start(); this.audioSource = "default-mic"; }
    } catch (e) { this.active = false; resolveEnded(); this._emit("error", { error: "start-failed:" + (e?.name || "") }); }
  }
}

// ---------------------------------------------------------------- one attempt

/**
 * New default (half-duplex). The listener must be closed; speak() plays the prompt with the mic off.
 * Resolves on a correct capture (interim or final), on the first final, or when the window ends.
 */
export async function attemptHalfDuplex({ listener, speak, windowMs = 6000, target, lex, log = () => {} }) {
  await listener.close();
  if (speak) await speak();
  return new Promise((resolve) => {
    const caps = []; let onset = null; let done = false; let extended = false; const t0 = now();
    const finish = (why) => {
      if (done) return; done = true; clearTimeout(timer); listener.onEvent = () => {}; listener.close();
      resolve({ captures: caps, onset_ms: onset == null ? null : Math.round(onset - t0), end: why, score: scoreLetterAttempt(caps, target, lex) });
    };
    const expire = () => { if (!extended && caps.length && !caps.some((c) => c.final)) { extended = true; timer = setTimeout(expire, 2000); return; } finish("window"); };
    let timer = setTimeout(expire, windowMs);
    listener.onEvent = (ev) => {
      log(ev);
      if ((ev.type === "speechstart" || ev.type === "interim") && onset == null) onset = ev.t;
      if (ev.type === "interim" || ev.type === "final") {
        caps.push({ final: ev.type === "final", alts: ev.alts, t_ms: Math.round(ev.t - t0) });
        if (scoreLetterAttempt([caps[caps.length - 1]], target, lex).score === "correct") return finish("correct");
        if (ev.type === "final") return finish("final");
      }
      if (ev.type === "error" && ev.error !== "no-speech" && ev.error !== "aborted") caps.length || finish("error:" + ev.error);
    };
    listener.open();
  });
}

/**
 * ORT-22's flow, for the bench only: the (continuous) listener is already open and stays open while speak()
 * plays; a final whose speech began during narration (or within 300 ms after) is discarded; only finals count.
 */
export function attemptLegacy({ listener, speak, windowMs = 6000, target, lex, log = () => {} }) {
  return new Promise((resolve) => {
    const caps = [], discarded = []; let kept = null, onset = null, onsetInNarr = false, narrating = false, narrEnd = 0, done = false, timer = null;
    const t0 = now();
    const inWindow = (t) => narrating || t - narrEnd < 300;
    const finish = (why, score) => {
      if (done) return; done = true; clearTimeout(timer); clearTimeout(watchdog); listener.onEvent = () => {};
      resolve({ captures: caps, discarded, onset_ms: kept == null ? null : Math.round(kept - t0), end: why, legacy: score || { score: "uncertain", reason: why }, score: scoreLetterAttempt(caps, target, lex) });
    };
    let watchdog = null;
    listener.onEvent = (ev) => {
      log(ev);
      if (done) return;
      if ((ev.type === "speechstart" || ev.type === "interim") && onset == null) {
        onset = ev.t; onsetInNarr = inWindow(ev.t); clearTimeout(timer);
        clearTimeout(watchdog); watchdog = setTimeout(() => finish("watchdog"), 8000);
      }
      if (ev.type === "final") {
        clearTimeout(watchdog);
        const cap = { final: true, alts: ev.alts, t_ms: Math.round(ev.t - t0) };
        if (onsetInNarr) { discarded.push(cap); onset = null; onsetInNarr = false; if (!narrating) arm(); return; }
        caps.push(cap); kept = onset; onset = null;
        const s = legacyScore(ev.alts, target, lex);
        return finish("final", s);
      }
    };
    const arm = () => { clearTimeout(timer); timer = setTimeout(() => finish("window"), windowMs); };
    (async () => {
      narrating = true;
      if (speak) await speak();
      narrating = false; narrEnd = now();
      if (onset == null) arm();
    })();
  });
}
