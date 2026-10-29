import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const esc = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
export const run = (command, args) => {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command}: ${result.stderr || result.stdout}`);
  return result.stdout;
};
export const png = async path => `data:image/png;base64,${(await readFile(path)).toString('base64')}`;
export const compileRenderer = (root, work) => {
  const renderer = join(work, 'render-artwork');
  run('xcrun', ['swiftc', '-framework', 'AppKit', '-framework', 'WebKit', join(root, 'scripts/marketplace-assets/render-svg-webkit.swift'), '-o', renderer]);
  return renderer;
};
export async function renderHtml(renderer, work, name, html, width = 1920, height = 960) {
  const input = join(work, `${name}.html`);
  const output = join(work, `${name}.png`);
  await writeFile(input, html);
  run(renderer, [input, output, String(width), String(height)]);
  const deviation = Number(run('magick', [output, '-colorspace', 'gray', '-format', '%[fx:standard_deviation]', 'info:']).trim());
  if (!(deviation > .01)) throw new Error(`Blank artwork: ${name}`);
  return output;
}
export const styles = `
*{box-sizing:border-box}html,body{margin:0;width:1920px;height:960px;overflow:hidden;background:transparent;color:#fff;font-family:-apple-system,BlinkMacSystemFont,'Helvetica Neue',sans-serif}
.panel{position:absolute;top:0;height:960px;padding:68px 76px;background:radial-gradient(ellipse at 15% 0%,#352865 0,transparent 66%),linear-gradient(150deg,#10152e,#050918 78%)}
.brand{display:flex;align-items:center;gap:20px}.brand img{width:68px;height:68px;border-radius:16px}.brand strong{font-size:26px;letter-spacing:5px}.brand small{display:block;margin-top:8px;color:#b8c6ed;font-size:15px;letter-spacing:2px}
.eyebrow{color:#a9d9ff;font-size:19px;font-weight:650;letter-spacing:3px;text-transform:uppercase;margin:0 0 24px}
h1{font-size:68px;line-height:1.07;letter-spacing:-2.5px;margin:0;font-weight:750}p{font-size:27px;line-height:1.45;color:#cfdaef;margin:28px 0 0}.apps{display:flex;gap:12px;align-items:center;margin-top:34px}.chip{display:inline-flex;align-items:center;gap:10px;padding:12px 22px;border:1px solid #647099;border-radius:100px;background:#ffffff09;font-size:22px;font-weight:600}.chip i{width:9px;height:9px;border-radius:50%;background:#a9d9ff}.chip.t3{border-color:#9377c7}.chip.t3 i{background:#cba9ff}.foot{position:absolute;bottom:52px;left:76px;right:76px;color:#9eacca;font-size:16px;line-height:1.5}.divider{height:1px;background:#ffffff20;margin:26px 0}.tag{font-size:16px;letter-spacing:2px;color:#b7c9eb;text-transform:uppercase}.pill{padding:8px 13px;border-radius:8px;background:#a9d9ff1a;color:#a9d9ff;font-size:15px;font-weight:600}.note{font-size:18px;color:#b0bdd8;line-height:1.5}.legend{display:flex;gap:20px;flex-wrap:wrap}.legend span{font-size:18px;color:#dae3f7;display:flex;align-items:center;gap:9px}.legend i{display:inline-block;width:12px;height:12px;border-radius:4px}
`;
export const doc = (content, css = '') => `<!doctype html><html><head><meta charset="utf-8"><style>${styles}${css}</style></head><body>${content}</body></html>`;
export const brand = logo => `<div class="brand"><img src="${logo}"><div><strong>FINGERTIP AGENT</strong><small>CODING AGENTS ON STREAM DECK</small></div></div>`;
export const apps = () => '<div class="apps"><span class="chip"><i></i>Codex</span><span class="chip t3"><i></i>T3 Code</span></div>';

export function hardwareCopy(name, logo) {
  const right = name === 'thumbnail.png' || name === 'gallery-3-exact-task.png';
  const geometry = right ? 'left:1050px;width:870px;padding-left:76px;padding-right:66px' : 'left:0;width:781px';
  const header = brand(logo);
  let content;
  if (name === 'thumbnail.png') content = `${header}<main style="margin-top:84px"><div class="eyebrow">Two apps. One Stream Deck.</div><h1>Codex + T3 Code.<br>At your<br>fingertips.</h1>${apps()}<p>Follow live tasks.<br>Open threads. Set your model.</p></main><div class="foot">For macOS · Task, Model &amp; Fast Mode keys</div>`;
  if (name === 'gallery-1-live-status.png') content = `${header}<main style="margin-top:70px"><div class="eyebrow">Live task status</div><h1>Know what’s<br>working.<br>At a glance.</h1>${apps()}<p>Live colors for progress,<br>finished work and approvals.</p><div class="divider"></div><div class="legend"><span><i style="background:#9cd5fe"></i>Working</span><span><i style="background:#9bf396"></i>Done</span><span><i style="background:#ffad28"></i>Approval</span></div></main><div class="foot">Keys rendered by Fingertip · Illustrative task data</div>`;
  if (name === 'gallery-2-task-context.png') content = `${header}<main style="margin-top:60px"><div class="eyebrow">Context on every key</div><h1>Project. Task.<br>Progress.</h1><p>Keep your place across both apps.<br>See what needs your attention.</p></main><div style="position:absolute;left:118px;top:575px" class="pill">CODEX · DIFF + QUEUE BADGES</div><div style="position:absolute;left:380px;top:575px" class="pill">T3 CODE · LIVE STATUS</div><div class="foot">Line changes and queue badges are Codex-only.</div>`;
  if (name === 'gallery-3-exact-task.png') content = `${header}<main style="margin-top:65px"><div class="eyebrow">Direct thread navigation</div><h1>One press.<br>The right thread.</h1><p>Open the matching conversation<br>in Codex or T3 Code.</p>${apps()}</main><div style="position:absolute;left:76px;top:640px;width:380px"><div class="tag">More at your fingertips</div><p style="font-size:23px">Double press to highlight.<br>Hold to mark unread.</p></div><div class="foot">T3 Code currently targets a single window.</div>`;
  return doc(`<section class="panel" style="${geometry}">${content}</section>`);
}
