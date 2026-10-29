import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeTaskKeyAppearanceSettings, normalizeTaskKeySettings } from '../src/settings/task-key-settings.ts';
import { normalizeModelKeySettings } from '../src/settings/model-key-settings.ts';
import { renderModelKeyDataUrl } from '../src/rendering/model-key-renderer.ts';
import { apps, brand, compileRenderer, doc, esc, png, renderHtml, run } from './marketplace-assets/artwork.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'marketplace-assets');
const ui = path.join(root, 'com.lukas-bhm.fingertip.sdPlugin/ui');
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const work = await mkdtemp(path.join(tmpdir(), 'fingertip-gallery-'));
const settings = { ...normalizeTaskKeySettings({ backend: 't3', taskPosition: 1 }),
  ...normalizeTaskKeyAppearanceSettings({ projectColorEnabled: true, projectColorOpacity: 60,
    doneNotification: 'both', confirmationNotification: 'sound', doneSound: 'Glass', confirmationSound: 'Basso' }) };
const model = normalizeModelKeySettings({ backend: 'codex', model: 'gpt-6-astra', effort: 'high', modelFontSize: 8 });

// Render the shipping inspector HTML with synthetic state. No live app, server,
// credentials, network traffic, or user settings are accessed by this generator.
async function inspector(renderer, tab) {
  let html = await readFile(path.join(ui, 'task-key.html'), 'utf8');
  const bridge = `<script>
    const listeners=[];
    window.FingertipPI={onSettings(f){f(${JSON.stringify(settings)})},onState(f){listeners.push(f)},setSetting(){},retry(){},resetAppearance(){},pairT3(){},importCustomSound(){},previewSound(){}};
  </script>`;
  html = html.replace('<script src="sdpi-components.js"></script>', bridge);
  for (const name of ['task-position.js', 't3-connection.js']) {
    html = html.replace(`<script src="${name}"></script>`, `<script>${await readFile(path.join(ui, name), 'utf8')}</script>`);
  }
  html = html.replace('</head>', '<style>html{zoom:2}</style></head>');
  html = html.replace('</body>', `<script>
    for(const listener of listeners)listener({type:'fingertip-t3-state',configured:true,connected:true,serverAddress:'http://127.0.0.1:3773',message:'T3 Code connected'});
    document.querySelector('[data-tab-button="${tab}"]').click();
    window.__artworkReady=true;
  </script></body>`);
  return renderHtml(renderer, work, `inspector-${tab}`, html, 1040, tab === 'notifications' ? 1220 : 1120);
}

const galleryStyle = `
body{background:radial-gradient(ellipse at 80% 10%,#303b83 0,transparent 52%),radial-gradient(ellipse at 98% 85%,#182452 0,transparent 50%),#080c1d}
.copy{position:absolute;left:80px;top:70px;width:830px;height:820px}.copy main{margin-top:76px}.copy h1{font-size:74px}.copy p{font-size:29px;line-height:1.5}.copy .foot{left:0;bottom:0;right:0}.frame{position:absolute;left:1010px;top:70px;width:830px;height:820px;background:#292929;border:1px solid #63749e;border-radius:22px;box-shadow:0 26px 80px #0007;overflow:hidden}.framehead{height:66px;display:flex;align-items:center;justify-content:space-between;padding:0 30px;background:#22242c;border-bottom:1px solid #ffffff15;font-size:21px;color:#e1e9fc}.framehead small{font-size:16px;color:#9cadce}.capture{position:absolute;top:82px;left:77px;width:676px}.detail{display:flex;gap:15px;align-items:flex-start;margin-top:24px;color:#dce6f8;font-size:24px;line-height:1.4}.detail b{flex:0 0 36px;height:36px;border:1px solid #6d7db3;border-radius:50%;text-align:center;padding-top:2px;color:#b9ddff;font-size:20px}.palette{display:flex;gap:12px;margin-top:34px}.palette div{width:103px}.palette i{display:block;height:12px;border-radius:4px;margin-bottom:10px}.palette span{font-size:17px;color:#acbad9}.illustration{font-size:15px;color:#93a3c4;position:absolute;bottom:35px;right:80px}
`;
const foot = () => `<div class="foot">macOS · Version ${esc(version)}<br>Codex + T3 Code</div>`;
const content = {
  general: { target: 'gallery-4-settings-general.png', label: 'Shared T3 connection', title: 'Choose your app.<br>Pair T3 once.', text: 'One T3 connection for every Task,<br>Model and Fast Mode key.', extra: '<div class="detail"><b>1</b><span>Select Codex or T3 Code per key.</span></div><div class="detail"><b>2</b><span>Pair T3 once with your local instance.</span></div><div class="detail"><b>3</b><span>Pick the source and task position.</span></div>', frame: 'Agent Task · T3 Code', tab: 'General' },
  appearance: { target: 'gallery-5-settings-appearance.png', label: 'Shared appearance', title: 'Your colors.<br>Your workflow.', text: 'Tune status colors, project bars,<br>type sizes and alignment.<br>One shared look across both apps.', extra: '<div class="palette">'+[['Idle','#06090b'],['Working','#9cd5fe'],['Done','#9bf396'],['Waiting','#ffd0b8'],['Approval','#ffad28']].map(([label,color])=>`<div><i style="background:${color};border:1px solid #ffffff30"></i><span>${label}</span></div>`).join('')+'</div>', frame: 'Agent Task · Appearance', tab: 'Appearance' },
  notifications: { target: 'gallery-6-settings-notifications.png', label: 'Notifications', title: 'Hear when it’s<br>time to act.', text: 'Choose alerts for finished work<br>and approval requests.<br>Use system sounds or custom audio.', extra: '<div class="apps"><span class="chip">Toast</span><span class="chip">Audio</span><span class="chip">Both</span></div><p class="note" style="font-size:21px">Adjust volume, repeats and delay.<br>Preview each sound before you use it.</p>', frame: 'Agent Task · Notifications', tab: 'Notif.' },
};

try {
  await mkdir(output, { recursive: true });
  const renderer = compileRenderer(root, work);
  const logo = await png(path.join(root, 'assets/fingertip-logo-master.png'));
  for (const [tab, copy] of Object.entries(content)) {
    const capture = await png(await inspector(renderer, tab));
    const html = doc(`<section class="copy">${brand(logo)}<main><div class="eyebrow">${copy.label}</div><h1>${copy.title}</h1><p>${copy.text}</p>${copy.extra}</main>${foot()}</section><section class="frame"><div class="framehead"><span>${copy.frame}</span><small>${copy.tab}</small></div><img class="capture" src="${capture}" ${tab === 'notifications' ? 'style="width:624px;left:103px"' : ''}></section><span class="illustration">Current plugin interface · Example settings</span>`, galleryStyle);
    await copyFile(await renderHtml(renderer, work, tab, html), path.join(output, copy.target));
  }
  const modelKey = (effort, active) => renderModelKeyDataUrl({ settings: { ...model, effort, backgroundColor: active ? '#283d64' : '#111a2e' }, modelLabel: 'gpt-6-astra', active });
  const keys = ['medium','high','xhigh'].map((effort,i)=>`<div class="modelcell"><img src="${modelKey(effort,i===1)}"><span>${i===1?'Active selection':i===0?'Balanced thinking':'Extra thinking'}</span></div>`).join('');
  const modelHtml = doc(`<section class="copy">${brand(logo)}<main><div class="eyebrow">Configurable model keys</div><h1>Your model.<br>Your thinking level.</h1><p>Apply a saved combination<br>to the active thread with one press.</p>${apps()}<div class="divider"></div><p class="note" style="font-size:23px">Available models come from your app.<br>The confirmed selection stays highlighted.</p></main>${foot()}</section><section class="modelstage"><div class="tag">Agent Model · Example configuration</div><div class="modelrow">${keys}</div><div class="explain"><strong>One key. One combination.</strong><p>Choose a model and supported thinking level.<br>Customize each key’s color and typography.</p></div><div class="fast"><strong>Fast Mode</strong><p>Add a separate key for supported providers.</p></div></section><div class="modelnote">T3 targets the most recently visited thread · Single window<br>Models and options depend on your connected app and provider.</div>`, `${galleryStyle}.copy h1{font-size:68px}.modelstage{position:absolute;left:1010px;top:170px;width:830px;border:1px solid #586b9b;border-radius:28px;background:linear-gradient(150deg,#1c2542,#0c1226);padding:36px;box-shadow:0 28px 90px #0006}.modelrow{display:flex;gap:26px;margin-top:40px}.modelcell{width:234px;text-align:center}.modelcell img{width:234px;height:234px;filter:drop-shadow(0 12px 14px #0006)}.modelcell span{display:block;margin-top:18px;font-size:18px;color:#bccce9}.explain{margin-top:44px;padding-top:28px;border-top:1px solid #ffffff20}.explain strong,.fast strong{font-size:25px}.explain p,.fast p{font-size:21px;margin:12px 0 0}.fast{margin-top:28px;border-left:3px solid #adceff;padding-left:18px}.modelnote{position:absolute;left:1010px;top:883px;font-size:16px;color:#a2b3d3;line-height:1.5}`);
  await copyFile(await renderHtml(renderer, work, 'model-keys', modelHtml), path.join(output, 'gallery-7-model-keys.png'));
  // Remove only the superseded generated image; historical source captures remain intact.
  await rm(path.join(output, 'gallery-7-model-selector.png'), { force: true });
  const previewDirectory = path.join(output, 'previews');
  await mkdir(previewDirectory, { recursive: true });
  const previewFiles = [
    'thumbnail.png', 'gallery-1-live-status.png', 'gallery-2-task-context.png',
    'gallery-3-exact-task.png', 'gallery-4-settings-general.png',
    'gallery-5-settings-appearance.png', 'gallery-6-settings-notifications.png',
    'gallery-7-model-keys.png',
  ];
  const montage = [];
  for (let i = 0; i < previewFiles.length; i += 2) {
    montage.push('(');
    for (const name of previewFiles.slice(i, i + 2)) {
      montage.push('(', path.join(output, name), '-resize', '960x480',
        '-bordercolor', '#080c1d', '-border', '12', ')');
    }
    montage.push('+append', ')');
  }
  run('magick', [...montage, '-append', '-strip', path.join(previewDirectory, 'overview.png')]);
  console.log(`generated 4 current release gallery images for ${version}`);
} finally {
  if (process.env.KEEP_MARKETPLACE_WORK === '1') console.log(`kept generator work directory: ${work}`);
  else await rm(work, { recursive: true, force: true });
}
