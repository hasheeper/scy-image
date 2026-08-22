/**
 * Key vault — client-side encrypted storage for the API token.
 *
 * Threat model (read this before trusting it):
 *   Protects against: someone browsing your localStorage, a shared/synced
 *   browser profile, or the token being committed to git.
 *   Does NOT protect against: XSS or a malicious extension reading the
 *   decrypted token out of memory while the page is unlocked. On a static
 *   site the token must eventually be sent as a plaintext request header —
 *   that is a physical limit, not something encryption can fix.
 *
 * Modes:
 *   "encrypted" — PBKDF2-SHA256(210k) -> AES-GCM, ciphertext in localStorage.
 *   "session"   — plaintext in sessionStorage, dies with the tab. No passphrase.
 */

const LS_VAULT = "scy.vault.v1";
const SS_TOKEN = "scy.session.token";
const SS_DK = "scy.session.dk";

const PBKDF2_ITERATIONS = 210_000;
const enc = new TextEncoder();
const dec = new TextDecoder();

const b64 = {
  to(buf) {
    const bytes = new Uint8Array(buf);
    let s = "";
    for (const byte of bytes) s += String.fromCharCode(byte);
    return btoa(s);
  },
  from(str) {
    const bin = atob(str);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
    return out;
  }
};

function assertCrypto() {
  if (!globalThis.crypto?.subtle) {
    throw new Error("当前环境不支持 Web Crypto，请使用 HTTPS 或 localhost 打开本页");
  }
}

async function deriveKey(passphrase, salt) {
  assertCrypto();
  const base = await crypto.subtle.importKey("raw", enc.encode(passphrase), "PBKDF2", false, [
    "deriveKey"
  ]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITERATIONS },
    base,
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
}

/** In-memory only. Never persisted in "encrypted" mode. */
let unlockedToken = null;

export const vault = {
  /** @returns {"encrypted"|"session"|"empty"} */
  mode() {
    if (localStorage.getItem(LS_VAULT)) return "encrypted";
    if (sessionStorage.getItem(SS_TOKEN)) return "session";
    return "empty";
  },

  isUnlocked() {
    return Boolean(unlockedToken);
  },

  token() {
    return unlockedToken;
  },

  /** Try to restore without user interaction (session mode, or remembered key). */
  async tryResume() {
    const sessionToken = sessionStorage.getItem(SS_TOKEN);
    if (sessionToken) {
      unlockedToken = sessionToken;
      return true;
    }

    const rawVault = localStorage.getItem(LS_VAULT);
    const rawDk = sessionStorage.getItem(SS_DK);
    if (!rawVault || !rawDk) return false;

    try {
      const parsed = JSON.parse(rawVault);
      const key = await crypto.subtle.importKey(
        "raw",
        b64.from(rawDk),
        { name: "AES-GCM", length: 256 },
        false,
        ["decrypt"]
      );
      const plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: b64.from(parsed.iv) },
        key,
        b64.from(parsed.ct)
      );
      unlockedToken = dec.decode(plain);
      return true;
    } catch {
      sessionStorage.removeItem(SS_DK);
      return false;
    }
  },

  /** Persist token encrypted under a passphrase. */
  async saveEncrypted(token, passphrase, { remember = false } = {}) {
    assertCrypto();
    if (!token?.trim()) throw new Error("请填写 API Key");
    if (!passphrase || passphrase.length < 4) throw new Error("口令至少 4 个字符");

    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(passphrase, salt);
    const ct = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      key,
      enc.encode(token.trim())
    );

    localStorage.setItem(
      LS_VAULT,
      JSON.stringify({
        v: 1,
        kdf: "PBKDF2-SHA256",
        iterations: PBKDF2_ITERATIONS,
        salt: b64.to(salt),
        iv: b64.to(iv),
        ct: b64.to(ct)
      })
    );
    sessionStorage.removeItem(SS_TOKEN);

    if (remember) {
      const raw = await crypto.subtle.exportKey("raw", key);
      sessionStorage.setItem(SS_DK, b64.to(raw));
    } else {
      sessionStorage.removeItem(SS_DK);
    }

    unlockedToken = token.trim();
  },

  /** Store plaintext for this tab only. */
  saveSession(token) {
    if (!token?.trim()) throw new Error("请填写 API Key");
    sessionStorage.setItem(SS_TOKEN, token.trim());
    localStorage.removeItem(LS_VAULT);
    sessionStorage.removeItem(SS_DK);
    unlockedToken = token.trim();
  },

  async unlock(passphrase, { remember = false } = {}) {
    assertCrypto();
    const rawVault = localStorage.getItem(LS_VAULT);
    if (!rawVault) throw new Error("本地没有已保存的 Key");

    const parsed = JSON.parse(rawVault);
    const key = await deriveKey(passphrase, b64.from(parsed.salt));

    let plain;
    try {
      plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: b64.from(parsed.iv) },
        key,
        b64.from(parsed.ct)
      );
    } catch {
      throw new Error("口令不正确");
    }

    unlockedToken = dec.decode(plain);
    if (remember) {
      const raw = await crypto.subtle.exportKey("raw", key);
      sessionStorage.setItem(SS_DK, b64.to(raw));
    }
    return unlockedToken;
  },

  lock() {
    unlockedToken = null;
    sessionStorage.removeItem(SS_DK);
  },

  forget() {
    unlockedToken = null;
    localStorage.removeItem(LS_VAULT);
    sessionStorage.removeItem(SS_TOKEN);
    sessionStorage.removeItem(SS_DK);
  }
};
