// Firebase backend for the Home Screen app.
// Signs in with email + password, then hands index.html a small db wrapper with the same shape as the
// claude.ai artifact db it was written for: db.doc(path).set/delete/onSnapshot, db.collection(path).onSnapshot.
// Everything lives under users/{uid}/..., and the Firestore rules only let that uid read or write it.
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut, sendPasswordResetEmail } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, doc, collection, setDoc, deleteDoc, onSnapshot, writeBatch } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const COLLECTIONS = ["settings", "sessions", "bench", "body"];
let gate = null;

injectStyles();

if (!firebaseConfig) {
  showGate({ title: "Almost ready", text: "Firebase isn't connected yet. Add the project config to firebase-config.js and redeploy.", form: false });
} else {
  const app = initializeApp(firebaseConfig);
  const auth = getAuth(app);
  // Offline-first: reads come from the on-device cache and writes queue in IndexedDB until there's signal.
  const fs = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });

  let resolved = false;
  onAuthStateChanged(auth, (user) => {
    if (user && !resolved) {
      resolved = true;
      hideGate();
      window.__waResolve(backendFor(fs, auth, user));
    } else if (!user) {
      if (resolved) { location.reload(); return; }
      showGate({ title: "Winter Arc", text: "Sign in to sync your training log.", form: true, auth });
    }
  });
}

function backendFor(fs, auth, user) {
  const segs = (path) => ["users", user.uid, ...path.split("/")];
  const api = {
    email: user.email,
    onWriteError: null,
    db: {
      doc: (path) => ({
        // Resolve once the write is on the device. Firestore sends it when there's a connection,
        // even if the app is closed and reopened in between.
        set: (data) => { setDoc(doc(fs, ...segs(path)), data).catch(fail); return Promise.resolve(); },
        delete: () => { deleteDoc(doc(fs, ...segs(path))).catch(fail); return Promise.resolve(); },
        onSnapshot: (cb, err) => onSnapshot(doc(fs, ...segs(path)), (s) => cb({ exists: s.exists(), data: () => s.data(), metadata: s.metadata }), err)
      }),
      collection: (path) => ({
        onSnapshot: (cb, err) => onSnapshot(collection(fs, ...segs(path)), (qs) => cb({
          metadata: qs.metadata,
          docChanges: () => qs.docChanges().map((c) => ({ type: c.type, doc: { id: c.doc.id, data: () => c.doc.data() } }))
        }), err)
      })
    },
    signOut: () => signOut(auth),
    // Import an export of the claude.ai artifact: { settings: { main: {...} }, sessions: { "w01-mon": {...} }, bench: {...}, body: {...} }
    async importData(data) {
      if (!data || typeof data !== "object") throw new Error("That file isn't a Winter Arc export.");
      const writes = [];
      for (const [col, docs] of Object.entries(data)) {
        if (!COLLECTIONS.includes(col) || !docs || typeof docs !== "object") continue;
        for (const [id, d] of Object.entries(docs)) {
          if (/^[\w.-]{1,100}$/.test(id) && d && typeof d === "object") writes.push([col, id, d]);
        }
      }
      if (!writes.length) throw new Error("No Winter Arc data found in that file.");
      for (let i = 0; i < writes.length; i += 400) {
        const batch = writeBatch(fs);
        for (const [col, id, d] of writes.slice(i, i + 400)) batch.set(doc(fs, "users", user.uid, col, id), d);
        await batch.commit();
      }
      return writes.length;
    }
  };
  function fail(e) { console.error(e); if (api.onWriteError) api.onWriteError(e); }
  return api;
}

/* ---------- sign-in screen ---------- */
function showGate({ title, text, form, auth }) {
  hideGate();
  gate = document.createElement("div");
  gate.className = "wa-gate";
  gate.setAttribute("role", "dialog");
  gate.setAttribute("aria-modal", "true");
  gate.setAttribute("aria-labelledby", "wa-gate-h");
  gate.innerHTML = `
    <form class="wa-gate-card" novalidate>
      <img src="icons/icon.svg" alt="" width="76" height="76">
      <h1 id="wa-gate-h"></h1>
      <p class="wa-gate-text"></p>
      ${form ? `
      <label>Email<input class="field" type="email" name="email" autocomplete="username" inputmode="email" required></label>
      <label>Password<input class="field" type="password" name="password" autocomplete="current-password" required></label>
      <button class="btn" type="submit">Sign in</button>
      <button class="wa-gate-link" type="button" data-reset>Forgot password?</button>` : ""}
      <p class="wa-gate-msg" role="status"></p>
    </form>`;
  gate.querySelector("h1").textContent = title;
  gate.querySelector(".wa-gate-text").textContent = text;
  document.body.append(gate);
  if (!form) return;
  const f = gate.querySelector("form");
  const msg = gate.querySelector(".wa-gate-msg");
  const btn = f.querySelector("button[type=submit]");
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = f.email.value.trim(), pw = f.password.value;
    if (!email || !pw) { msg.textContent = "Enter your email and password."; return; }
    btn.disabled = true; msg.textContent = "Signing in…";
    try { await signInWithEmailAndPassword(auth, email, pw); }
    catch (err) { msg.textContent = authMessage(err); btn.disabled = false; }
  });
  gate.querySelector("[data-reset]").addEventListener("click", async () => {
    const email = f.email.value.trim();
    if (!email) { msg.textContent = "Type your email first, then tap Forgot password."; f.email.focus(); return; }
    try { await sendPasswordResetEmail(auth, email); msg.textContent = "If that address has an account, a reset link is on its way."; }
    catch (err) { msg.textContent = authMessage(err); }
  });
  setTimeout(() => f.email.focus(), 50);
}
function hideGate() { if (gate) { gate.remove(); gate = null; } }
function authMessage(err) {
  const code = (err && err.code) || "";
  if (code === "auth/invalid-credential" || code === "auth/wrong-password" || code === "auth/user-not-found" || code === "auth/invalid-email") return "That email and password don't match.";
  if (code === "auth/too-many-requests") return "Too many tries. Wait a minute and try again.";
  if (code === "auth/network-request-failed") return "No connection. Sign-in needs signal the first time.";
  return "Couldn't sign in (" + (code || "unknown error") + ").";
}
function injectStyles() {
  const s = document.createElement("style");
  s.textContent = `
    .wa-gate { position: fixed; inset: 0; z-index: 50; background: var(--bg); display: grid; place-items: center;
      padding: max(24px, env(safe-area-inset-top)) 16px max(24px, env(safe-area-inset-bottom)); overflow: auto; }
    .wa-gate-card { width: min(380px, 100%); display: grid; gap: 14px; text-align: center; }
    .wa-gate-card img { margin: 0 auto 4px; border-radius: 18px; }
    .wa-gate-card h1 { font-weight: 800; font-size: 30px; letter-spacing: -0.02em; }
    .wa-gate-text { color: var(--muted); }
    .wa-gate-card label { display: grid; gap: 4px; text-align: left; font-size: 12.5px; font-weight: 500; color: var(--muted); }
    .wa-gate-card .btn { margin-top: 4px; }
    .wa-gate-link { background: none; border: 0; color: var(--muted); font: inherit; font-size: 13.5px; text-decoration: underline; cursor: pointer; justify-self: center; }
    .wa-gate-msg { min-height: 1.5em; font-size: 14px; color: var(--accent); }`;
  document.head.append(s);
}
