// Parse a Claude Code selection menu (AskUserQuestion, permission prompt, any "1. … 2. …" list
// with an "Enter to select / Esc to cancel" footer) from the visible screen.
export type Menu = { title: string; tabs: string; options: { n: number; label: string; desc: string; selected: boolean }[]; footer: string };
export function parseMenu(lines: string[]): Menu | null {
  const fi = lines.findLastIndex((l) => /Enter to (select|confirm)|to navigate|Esc to (cancel|exit)/i.test(l));
  if (fi < 0) return null;
  const optRe = /^\s*(?:[❯›>]\s*)?(\d{1,2})[.)]\s+(.+?)\s*$/;
  // Walk up from the footer: menu numbers count down to 1, so the option numbered 1 is the top.
  let first = -1, gap = 0, expect = Infinity;
  for (let i = fi - 1; i >= 0 && i >= fi - 60; i--) {
    const m = lines[i].match(optRe);
    if (m) {
      const n = +m[1];
      if (n >= expect) break; // numbering restarted: an older list above the menu
      first = i; expect = n; gap = 0;
      if (n === 1) break;
      continue;
    }
    if (first >= 0 && ++gap > 14) break;
  }
  if (first >= 0 && expect !== 1) return null; // no complete 1..N menu
  if (first < 0) return null;
  const options: Menu["options"] = [];
  for (let i = first; i < fi; i++) {
    const m = lines[i].match(optRe);
    if (m) { options.push({ n: +m[1], label: m[2], desc: "", selected: /^\s*[❯›>]/.test(lines[i]) }); continue; }
    const t = lines[i].trim();
    if (!t || /^[─━]{10,}/.test(t)) continue;
    if (options.length) options[options.length - 1].desc = (options[options.length - 1].desc + " " + t).trim();
  }
  if (options.length < 2) return null;
  // Title: non-empty lines between the previous separator and the first option.
  let ti = first - 1; const head: string[] = [];
  while (ti >= 0 && !/^[─━]{10,}/.test(lines[ti].trim()) && head.length < 12) { if (lines[ti].trim()) head.unshift(lines[ti].trim()); ti--; }
  const tabs = head.find((l) => /[☐☑✔✓]/.test(l)) || "";
  return { title: head.filter((l) => l !== tabs).join("\n"), tabs, options, footer: lines[fi].trim() };
}
