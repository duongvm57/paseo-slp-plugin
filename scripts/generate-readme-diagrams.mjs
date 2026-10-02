// Both README illustrations share one layout; edit labels here and regenerate.
// node scripts/generate-readme-diagrams.mjs [--check]
import { readFileSync, writeFileSync } from 'node:fs';

const labels = {
  en: {
    file: 'slp-overview.svg',
    title: 'Paseo SLP at a glance',
    subtitle: 'You own intent and final acceptance. The team returns evidence.',
    description: 'The Human assigns a Lead directly or works through an optional Supervisor. The Lead frames and integrates work, delegates bounded outcomes to independent Peers, and receives evidence and challenges. The Supervisor observes workflow and relays Human decisions outside execution. The plugin delivers role instructions and checks launch preparation; Paseo remains the agent control plane.',
    human: 'Human', humanDetail: 'intent · boundaries · final acceptance',
    paseo: 'Paseo', paseoDetail: 'ordinary agents · your conversations',
    objective: 'objective', optional: 'optional observer',
    execution: 'EXECUTION · LEAD AND PEERS',
    leadDetail: 'frame · choose runtimes · integrate · verdict',
    outcomes: 'bounded outcomes', evidence: 'evidence · challenges',
    peerNames: ['Engineer', 'Architect', 'Reviewer', 'Scout'],
    peerDetails: ['implementation', 'design judgment', 'independent', 'findings'],
    peerNote: 'Peers are chosen per task; each owns one outcome and can challenge,',
    peerNoteEnd: 'ask for a dependency or report blocked. One writer per moving scope.',
    observation: 'WORKFLOW OBSERVATION',
    supervisorDetail: 'optional seat', observes: 'observes',
    supervisorLines: ['Observes reasoning and workflow.', 'Relays your decisions.', 'Checks the handback.', 'Stays outside implementation', 'and project acceptance.'],
    plugin: 'PLUGIN · SESSION ENTRY AND PREPARATION',
    delivery: 'Role instructions', deliveryLines: ['Loaded at session entry,', 'separate from the task prompt.'],
    preparation: 'Checked preparation', preparationLines: ['prepare checks the pool choice.', 'Paseo creates the agent.'],
    settings: 'Your configuration', settingsLines: ['Role profiles · Peer pool', 'Optional language · Jev · beads'],
  },
  vi: {
    file: 'slp-overview.vi.svg',
    title: 'Paseo SLP: mô hình làm việc',
    subtitle: 'Bạn giữ mục tiêu và nghiệm thu cuối. Team trả lại bằng chứng.',
    description: 'Human giao việc thẳng cho Lead hoặc làm việc qua Supervisor tùy chọn. Lead định khung và tích hợp công việc, giao outcome có giới hạn cho Peer độc lập, nhận lại bằng chứng và phản biện. Supervisor quan sát workflow và chuyển quyết định của Human, đứng ngoài phần thực thi. Plugin nạp hướng dẫn role và kiểm tra bước chuẩn bị khởi chạy; Paseo vẫn là control plane của agent.',
    human: 'Human', humanDetail: 'mục tiêu · giới hạn · nghiệm thu cuối',
    paseo: 'Paseo', paseoDetail: 'agent bình thường · hội thoại của bạn',
    objective: 'mục tiêu', optional: 'seat quan sát tùy chọn',
    execution: 'THỰC THI · LEAD VÀ PEER',
    leadDetail: 'định khung · chọn runtime · tích hợp · verdict',
    outcomes: 'outcome có giới hạn', evidence: 'bằng chứng · phản biện',
    peerNames: ['Engineer', 'Architect', 'Reviewer', 'Scout'],
    peerDetails: ['triển khai', 'phán đoán thiết kế', 'review độc lập', 'phát hiện'],
    peerNote: 'Chọn Peer theo task; mỗi Peer sở hữu một outcome, có thể phản biện,',
    peerNoteEnd: 'xin dependency hoặc báo blocked. Mỗi phạm vi chỉ một người ghi.',
    observation: 'QUAN SÁT WORKFLOW',
    supervisorDetail: 'seat tùy chọn', observes: 'quan sát',
    supervisorLines: ['Quan sát lập luận và workflow.', 'Chuyển quyết định của bạn.', 'Kiểm tra handback.', 'Đứng ngoài phần triển khai', 'và nghiệm thu dự án.'],
    plugin: 'PLUGIN · NẠP ROLE VÀ CHUẨN BỊ KHỞI CHẠY',
    delivery: 'Hướng dẫn role', deliveryLines: ['Nạp lúc session bắt đầu,', 'tách riêng với prompt công việc.'],
    preparation: 'Kiểm tra chuẩn bị', preparationLines: ['prepare kiểm tra lựa chọn pool.', 'Paseo tạo agent.'],
    settings: 'Cấu hình của bạn', settingsLines: ['Role profiles · Peer pool', 'Tùy chọn: ngôn ngữ · Jev · beads'],
  },
};

const stylesheet = `
  svg { --bg:#fff; --panel:#f6f8fa; --line:#d0d7de; --ink:#1f2328; --muted:#59636e;
    --blue-fill:#eef6ff; --blue:#0969da; --blue-ink:#0550ae;
    --violet-fill:#f7f1ff; --violet:#8250df; --violet-ink:#6639ba;
    --green-fill:#eefbf1; --green:#1a7f37; --green-ink:#116329;
    --amber-fill:#fff8e1; --amber:#9a6700; --amber-ink:#7d4e00;
    --teal-fill:#ebf9f7; --teal:#0f766e; --teal-ink:#0b5e57; }
  @media (prefers-color-scheme:dark) { svg { --bg:#0d1117; --panel:#151b23;
    --line:#30363d; --ink:#e6edf3; --muted:#9198a1;
    --blue-fill:#0f2238; --blue:#4493f8; --blue-ink:#79c0ff;
    --violet-fill:#231b35; --violet:#a371f7; --violet-ink:#d2a8ff;
    --green-fill:#10261a; --green:#3fb950; --green-ink:#7ee787;
    --amber-fill:#2b2108; --amber:#d29922; --amber-ink:#e3b341;
    --teal-fill:#0c2826; --teal:#2bb5a5; --teal-ink:#5eead4; } }
  text { font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans',Helvetica,Arial,sans-serif; fill:var(--ink); }
  .title { font-size:24px; font-weight:650; }
  .body { font-size:15px; fill:var(--muted); }
  .section { font-size:12px; font-weight:700; letter-spacing:.07em; }
  .name { font-size:18px; font-weight:650; }
  .peer-name { font-size:16px; font-weight:650; }
  .detail { font-size:13px; fill:var(--muted); }
  .label { font-size:13px; font-weight:550; }
  .edge { fill:none; stroke-width:1.7; stroke-linecap:round; stroke-linejoin:round; }
  .dash { stroke-dasharray:5 4; }
`;

const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

function render(language, l) {
  const parts = [
    `<!-- Generated by scripts/generate-readme-diagrams.mjs; edit the source. -->`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="688" viewBox="0 0 960 688" role="img" xml:lang="${language}" aria-labelledby="title description">`,
    `<title id="title">${escape(l.title)}</title>`,
    `<desc id="description">${escape(l.description)}</desc>`,
    `<style>${stylesheet}</style>`,
    '<defs>',
  ];
  for (const color of ['blue', 'violet', 'green']) {
    parts.push(`<marker id="arrow-${color}" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M1,1 L9,5 L1,9 z" fill="var(--${color})"/></marker>`);
  }
  parts.push('</defs>');
  const rect = (x, y, width, height, color = null, radius = 12) => parts.push(`<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="${radius}" fill="var(--${color ? `${color}-fill` : 'panel'})" stroke="var(--${color ?? 'line'})"/>`);
  const text = (x, y, value, style = 'body', color = null, anchor = 'start') => parts.push(`<text x="${x}" y="${y}" class="${style}" text-anchor="${anchor}"${color ? ` fill="var(--${color}-ink)" style="fill:var(--${color}-ink)"` : ''}>${escape(value)}</text>`);
  const edge = (path, color, dashed = false, arrow = true) => parts.push(`<path d="${path}" class="edge${dashed ? ' dash' : ''}" stroke="var(--${color})"${arrow ? ` marker-end="url(#arrow-${color})"` : ''}/>`);
  const pill = (x, y, width, value, color) => {
    parts.push(`<rect x="${x - width / 2}" y="${y - 15}" width="${width}" height="24" rx="12" fill="var(--bg)" stroke="var(--${color})" stroke-opacity=".4"/>`);
    text(x, y + 1, value, 'label', color, 'middle');
  };

  parts.push('<rect x=".5" y=".5" width="959" height="687" rx="18" fill="var(--bg)" stroke="var(--line)"/>');
  text(32, 43, l.title, 'title');
  text(32, 68, l.subtitle);

  rect(24, 88, 912, 66);
  text(44, 113, l.human, 'name');
  text(44, 138, l.humanDetail);
  text(640, 113, l.paseo, 'name');
  text(640, 138, l.paseoDetail, 'detail');

  rect(24, 196, 584, 340, 'blue');
  text(44, 219, l.execution, 'section', 'blue');
  rect(60, 240, 488, 72, 'blue');
  text(84, 266, 'Lead', 'name', 'blue');
  text(84, 292, l.leadDetail);

  edge('M304,154 L304,236', 'blue');
  pill(304, 176, 96, l.objective, 'blue');

  edge('M304,312 L304,368', 'blue', false, false);
  edge('M108,368 L524,368', 'blue', false, false);
  pill(372, 341, 172, l.outcomes, 'blue');
  const peerX = [44, 184, 324, 464];
  for (let i = 0; i < peerX.length; i++) {
    const x = peerX[i], color = i === 2 ? 'amber' : 'green';
    edge(`M${x + 62},368 L${x + 62},390`, 'blue');
    rect(x, 394, 124, 80, color, 10);
    text(x + 62, 426, l.peerNames[i], 'peer-name', color, 'middle');
    text(x + 62, 452, l.peerDetails[i], 'detail', null, 'middle');
  }
  edge('M44,434 L36,434 L36,280 L56,280', 'green');
  pill(152, 341, 194, l.evidence, 'green');
  text(44, 501, l.peerNote, 'detail');
  text(44, 521, l.peerNoteEnd, 'detail');

  rect(640, 196, 296, 340, 'violet');
  text(660, 219, l.observation, 'section', 'violet');
  rect(660, 240, 256, 72, 'violet');
  text(788, 267, 'Supervisor', 'name', 'violet', 'middle');
  text(788, 292, l.supervisorDetail, 'body', null, 'middle');
  edge('M788,154 L788,188 L916,188 Q924,188 924,196 L924,262 Q924,270 916,270', 'violet');
  pill(788, 176, 180, l.optional, 'violet');
  edge('M656,276 L552,276', 'violet', true);
  pill(604, 259, 80, l.observes, 'violet');
  for (const [i, line] of l.supervisorLines.entries()) text(660, 352 + i * 30, line, 'detail');

  rect(24, 564, 912, 104, 'teal');
  text(44, 586, l.plugin, 'section', 'teal');
  for (const [x, title, lines] of [[44, l.delivery, l.deliveryLines], [356, l.preparation, l.preparationLines], [668, l.settings, l.settingsLines]]) {
    text(x, 613, title, 'peer-name', 'teal');
    text(x, 638, lines[0], 'detail');
    text(x, 657, lines[1], 'detail');
  }
  parts.push('</svg>');
  return parts.join('\n') + '\n';
}

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== '--check')) {
  console.error('Usage: node scripts/generate-readme-diagrams.mjs [--check]');
  process.exit(2);
}
let stale = false;
for (const [language, values] of Object.entries(labels)) {
  const path = new URL(`../docs/images/${values.file}`, import.meta.url);
  const svg = render(language, values);
  if (args[0] === '--check') {
    let saved = null;
    try { saved = readFileSync(path, 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (saved !== svg) { console.error(`${values.file} is stale`); stale = true; }
  } else writeFileSync(path, svg);
}
if (stale) process.exit(1);
console.log(args[0] === '--check' ? 'README diagrams are current (English and Vietnamese).' : 'Generated README diagrams (English and Vietnamese).');
