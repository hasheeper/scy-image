/**
 * Transient status messages.
 *
 * Both the generator and the tag dictionary render into the same stack so the
 * motion, elevation and semantic colour bar stay identical across pages.
 * Errors linger longer than confirmations because they usually ask the reader
 * to do something about them.
 */

const DWELL = { err: 7000, ok: 3000, "": 3000 };
const container = () => {
  let host = document.querySelector(".toasts");
  if (!host) {
    host = document.createElement("div");
    host.className = "toasts";
    host.setAttribute("role", "status");
    host.setAttribute("aria-live", "polite");
    document.body.append(host);
  }
  return host;
};

export function toast(message, kind = "err") {
  const el = document.createElement("div");
  el.className = `toast ${kind}`.trim();
  el.append(document.createTextNode(message));
  container().append(el);
  setTimeout(() => {
    el.classList.add("out");
    setTimeout(() => el.remove(), 160);
  }, DWELL[kind] ?? DWELL.ok);
  return el;
}
