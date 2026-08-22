const NAMED_ENTITIES = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"'
};

function decodeEntities(text) {
  return text
    .replace(/&#(?:x([0-9a-f]+)|(\d+));?/gi, (_, hex, decimal) => {
      const codePoint = Number.parseInt(hex || decimal, hex ? 16 : 10);
      try { return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : _; }
      catch { return _; }
    })
    .replace(/&([a-z]+);/gi, (entity, name) => NAMED_ENTITIES[name.toLowerCase()] ?? entity);
}

function splitTopLevel(text) {
  const chunks = [];
  let start = 0;
  let round = 0;
  let square = 0;
  let curly = 0;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "(") round += 1;
    else if (char === ")") round = Math.max(0, round - 1);
    else if (char === "[") square += 1;
    else if (char === "]") square = Math.max(0, square - 1);
    else if (char === "{") curly += 1;
    else if (char === "}") curly = Math.max(0, curly - 1);

    const separator = char === "," || char === "\n";
    if (separator && round === 0 && square === 0 && curly === 0) {
      chunks.push({ text: text.slice(start, index), separator: char });
      start = index + 1;
    }
  }
  chunks.push({ text: text.slice(start), separator: "" });
  return chunks;
}

function fullyWrapped(text) {
  if (text.length < 2 || text[0] !== "(" || text.at(-1) !== ")") return false;
  let depth = 0;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "(") depth += 1;
    if (char === ")") {
      depth -= 1;
      if (depth === 0 && index !== text.length - 1) return false;
      if (depth < 0) return false;
    }
  }
  return depth === 0;
}

function explicitWeight(text) {
  const match = text.match(/^([\s\S]*?[^:])\s*:\s*(-?(?:\d+(?:\.\d*)?|\.\d+))\s*$/);
  if (!match) return null;
  const weight = Number(match[2]);
  return Number.isFinite(weight) ? { text: match[1].trim(), weight } : null;
}

function normalizedText(text) {
  return text
    .replace(/\\_/g, "_")
    .replace(/_/g, " ")
    .replace(/\\([,()[\]{}:])/g, "$1")
    .replace(/[ \t\r]+/g, " ")
    .replace(/[ \t]*,[ \t]*/g, ", ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .trim();
}

function formattedWeight(weight) {
  return String(Number(weight.toFixed(4)));
}

function convertPart(rawPart) {
  let part = rawPart.trim().replace(/^\\+|\\+$/g, "").trim();
  if (!part) return "";

  let wrappers = 0;
  while (fullyWrapped(part)) {
    wrappers += 1;
    part = part.slice(1, -1).trim();
  }
  if (!part) return "";

  const explicit = wrappers ? explicitWeight(part) : null;
  if (explicit) part = explicit.text;
  const content = normalizedText(part);
  if (!content) return "";
  if (!wrappers) return content;

  const weight = explicit
    ? explicit.weight * (1.1 ** Math.max(0, wrappers - 1))
    : 1.1 ** wrappers;
  return Math.abs(weight - 1) < 1e-9
    ? content
    : `${formattedWeight(weight)}::${content}::`;
}

export function convertToNaiPrompt(rawPrompt) {
  const normalized = decodeEntities(String(rawPrompt || ""))
    .replace(/\\[ \t]*(?:\r?\n|$)/g, "\n")
    .replace(/\r\n?/g, "\n");
  let output = "";
  let boundary = "";
  for (const chunk of splitTopLevel(normalized)) {
    const converted = convertPart(chunk.text);
    if (converted) {
      if (output) {
        const lineBreaks = (boundary.match(/\n/g) || []).length;
        output += lineBreaks
          ? `${boundary.includes(",") ? "," : ""}${"\n".repeat(lineBreaks)}`
          : boundary.includes(",") ? ", " : "";
      }
      output += converted;
      boundary = "";
    }
    boundary += chunk.separator;
  }
  return output;
}
