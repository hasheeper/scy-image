/**
 * NAI prompt weight highlighting.
 *
 * Recognised syntax
 *   W::text::   absolute weight W (may be negative, e.g. -5::artist::)
 *   {text}      multiply current weight by 1.05  (nestable)
 *   [text]      divide current weight by 1.05    (nestable)
 *
 * Parentheses are NOT weight syntax here: real tags contain them
 * (`sho_(sho_lwlw)`), so treating them as modifiers would corrupt the prompt.
 *
 * Colour, against the dark canvas:
 *   weight > 1  → red,  brighter as the weight climbs
 *   weight < 1  → blue, brighter as the weight drops (negatives are brightest)
 *   weight = 1  → no tint, only a faint block so the group is still legible
 */

const BRACE_STEP = 1.05;

/* A number only opens a scope when it starts a token; otherwise the trailing
   digit of a tag such as `aku0::` would be mistaken for an opener. */
const DELIM = /[\s,:{}[\]()|]/;
const OPENER = /(-?\d*\.?\d+)[ \t]*::/y;

/**
 * @returns {{text:string, weight:number, depth:number, syntax:boolean}[]}
 */
export function analyze(text) {
  const n = text.length;
  if (!n) return [];

  const weights = new Float64Array(n).fill(1);
  const depths = new Uint8Array(n);
  const syntax = new Uint8Array(n);
  const stack = [];
  const top = () => (stack.length ? stack[stack.length - 1] : 1);

  const isDelim = (index) => index < 0 || DELIM.test(text[index]);
  const paint = (from, len, weight) => {
    for (let k = from; k < from + len && k < n; k += 1) {
      weights[k] = weight;
      depths[k] = stack.length;
      syntax[k] = 1;
    }
  };

  let i = 0;
  while (i < n) {
    const ch = text[i];

    // ── W:: opener ────────────────────────────────────────────
    if ((ch === "-" || ch === "." || (ch >= "0" && ch <= "9")) && isDelim(i - 1)) {
      OPENER.lastIndex = i;
      const match = OPENER.exec(text);
      if (match && match.index === i) {
        const weight = Number(match[1]);
        if (Number.isFinite(weight)) {
          stack.push(weight);
          paint(i, match[0].length, weight);
          i += match[0].length;
          continue;
        }
      }
    }

    // ── :: closer ─────────────────────────────────────────────
    if (ch === ":" && text[i + 1] === ":") {
      const closing = stack.length ? stack.pop() : 1;
      weights[i] = weights[i + 1] = closing;
      depths[i] = depths[i + 1] = stack.length;
      syntax[i] = syntax[i + 1] = 1;
      i += 2;
      continue;
    }

    // ── braces ────────────────────────────────────────────────
    if (ch === "{" || ch === "[") {
      const next = ch === "{" ? top() * BRACE_STEP : top() / BRACE_STEP;
      stack.push(next);
      paint(i, 1, next);
      i += 1;
      continue;
    }
    if (ch === "}" || ch === "]") {
      const closing = stack.length ? stack.pop() : 1;
      weights[i] = closing;
      depths[i] = stack.length;
      syntax[i] = 1;
      i += 1;
      continue;
    }

    weights[i] = top();
    depths[i] = stack.length;
    i += 1;
  }

  // ── coalesce equal runs ─────────────────────────────────────
  const out = [];
  let start = 0;
  const same = (a, b) =>
    weights[a] === weights[b] && depths[a] === depths[b] && syntax[a] === syntax[b];

  for (let k = 1; k <= n; k += 1) {
    if (k === n || !same(k - 1, k)) {
      out.push({
        text: text.slice(start, k),
        weight: weights[start],
        depth: depths[start],
        syntax: syntax[start] === 1
      });
      start = k;
    }
  }
  return out;
}

/** Normalised distance from neutral, 0 → 1. */
function intensity(weight) {
  if (weight <= 0) return Math.min(1, 0.72 + Math.abs(weight) / 12);
  const ratio = weight > 1 ? weight : 1 / weight;
  return Math.min(1, Math.log(ratio) / Math.log(5));
}

export function tint(weight, depth) {
  if (!Number.isFinite(weight) || Math.abs(weight - 1) < 1e-6) {
    // Explicit but neutral scope: hint the grouping without colouring it.
    return depth > 0 ? "background-color:rgba(255,255,255,.05)" : "";
  }
  const t = intensity(weight);
  const hue = weight > 1 ? 353 : 212;
  const sat = Math.round(55 + t * 40);
  const light = Math.round(26 + t * 34);
  const alpha = (0.2 + t * 0.34).toFixed(3);
  return `background-color:hsl(${hue} ${sat}% ${light}% / ${alpha})`;
}

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };
const escape = (s) => s.replace(/[&<>]/g, (c) => ESC[c]);

/** Build the mirror markup for a textarea's value. */
export function render(text) {
  // A trailing newline needs a filler or the mirror loses its last line box.
  const source = text.endsWith("\n") ? `${text} ` : text;
  let html = "";

  for (const token of analyze(source)) {
    const style = tint(token.weight, token.depth);
    const classes = ["w"];
    if (token.syntax) classes.push("w-mark");
    const label =
      Math.abs(token.weight - 1) > 1e-6 ? ` data-w="${token.weight.toFixed(2)}"` : "";
    html += `<span class="${classes.join(" ")}"${style ? ` style="${style}"` : ""}${label}>${escape(token.text)}</span>`;
  }
  return html;
}

/**
 * Attach a highlighted mirror behind a textarea.
 * Returns a refresh function to call whenever the value changes elsewhere.
 */
export function attach(textarea) {
  if (textarea.parentElement?.classList.contains("hl-wrap")) {
    return () => {}; // already attached
  }

  const wrap = document.createElement("div");
  wrap.className = "hl-wrap";
  const mirror = document.createElement("div");
  mirror.className = "hl-mirror";
  mirror.setAttribute("aria-hidden", "true");

  textarea.parentNode.insertBefore(wrap, textarea);
  wrap.append(mirror, textarea);
  // Both children share one grid cell, so the grid keeps their boxes equal —
  // no explicit height syncing needed, which avoids another source of drift.

  /* Overlays that were siblings of the textarea (e.g. the character counter)
     must move inside the wrapper. Left outside they become extra grid items
     in the parent and push it into an implicit third row, which breaks the
     field's height. */
  for (const overlay of [...wrap.parentElement.querySelectorAll(":scope > .fld-foot")]) {
    wrap.append(overlay);
  }

  /* Synchronous on purpose. Deferring to requestAnimationFrame put the blocks
     a frame behind the caret, which reads as lag while typing. Repainting is
     cheap because the mirror is a leaf with `contain` applied. */
  /* Grow the textarea to fit its content so the wrapper — the single
     scrollport shared with the mirror — does the scrolling. This is what
     removes the need for any scroll synchronisation: both elements are
     translated together by the browser, so blocks track the caret exactly
     and cannot detach at the top or bottom. */
  const autoGrow = () => {
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight}px`;
  };

  let lastValue = null;
  const refresh = () => {
    const value = textarea.value;
    if (value === lastValue) return;
    lastValue = value;
    mirror.innerHTML = render(value);
    autoGrow();
  };

  textarea.addEventListener("input", refresh);
  // Width changes (rail drag / window resize) alter wrapping and thus height.
  new ResizeObserver(autoGrow).observe(wrap);
  refresh();
  return refresh;
}
