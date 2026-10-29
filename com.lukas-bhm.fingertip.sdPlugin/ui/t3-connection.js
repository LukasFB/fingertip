(() => {
  const api = window.FingertipModelPI || window.FingertipPI;
  const first = document.querySelector('[data-tab="general"]');
  if (!api || !first) return;
  const container = document.createElement('div');
  container.className = 'item';
  container.dataset.tab = 'general';
  container.innerHTML = `<label>App</label><div>
    <select id="backend"><option value="codex">Codex / ChatGPT</option><option value="t3">T3 Code</option></select>
    <div id="t3-connect" hidden style="margin-top:12px">
      <div id="t3-connection-message">Checking shared T3 connection…</div>
      <div id="t3-shared-address" class="helper" style="margin-top:4px"></div>
      <div class="helper" style="margin-top:8px">One shared connection for all T3 Task, Model and Fast Mode keys. No pairing per key.</div>
      <button id="t3-change-connection" type="button" hidden style="margin-top:8px">Change shared connection</button>
      <div id="t3-pair-form" hidden style="margin-top:12px">
        <label for="t3-server-address">T3 server address</label>
        <input id="t3-server-address" type="url" placeholder="http://127.0.0.1:3773" style="width:100%;box-sizing:border-box;margin:8px 0">
        <div class="helper">Use the address under T3 Settings → Sharing &amp; access → Version (Connections in older versions).</div>
        <label for="t3-pair-link">T3 pairing link</label>
        <input id="t3-pair-link" type="password" autocomplete="off" placeholder="t3code://app/pair#token=… or HTTP link" style="width:100%;box-sizing:border-box;margin:8px 0">
        <button id="t3-pair" type="button">Connect all T3 keys</button>
        <div class="helper" style="margin-top:8px">Create a pairing link in that same T3 instance. Changing this connection applies to every T3 key.</div>
      </div>
      <div class="helper" style="margin-top:8px">Queue and Git-diff badges currently remain Codex-only. Model / Fast Mode use the most recently visited thread (single window).</div>
    </div></div>`;
  first.before(container);
  for (const button of document.querySelectorAll("[data-tab-button]")) button.addEventListener("click", () => { container.hidden = button.dataset.tabButton !== "general"; });
  const select = container.querySelector('#backend');
  const panel = container.querySelector('#t3-connect');
  let configured = false;
  let editing = false;
  let pending = false;
  const form = container.querySelector('#t3-pair-form');
  const change = container.querySelector('#t3-change-connection');
  const address = container.querySelector('#t3-server-address');
  change.addEventListener('click', () => {
    editing = !editing;
    form.hidden = configured && !editing;
    change.textContent = editing ? 'Cancel connection change' : 'Change shared connection';
  });
  api.onSettings(settings => {
    select.value = settings.backend || 'codex'; panel.hidden = select.value !== 't3';
    for (const id of ['queue-badge', 'git-diff-stats', 'window-target']) {
      const input = document.getElementById(id);
      if (input) input.disabled = select.value === 't3';
    }
    const source = document.getElementById('task-source');
    if (source) {
      source.options[0].textContent = select.value === 't3' ? 'Pinned + Active Threads' : 'Pinned + Projects';
      source.options[1].textContent = select.value === 't3' ? 'Unpinned Active Threads' : 'Tasks';
    }
  });
  select.addEventListener('change', () => {
    if (api.setSetting) api.setSetting('backend', select.value);
    else api.setSettings({ backend: select.value, model: '', effort: '' });
  });
  container.querySelector('#t3-pair').addEventListener('click', () => {
    const input = container.querySelector('#t3-pair-link');
    const link = input.value.trim();
    if (!link) return;
    const serverAddress = container.querySelector('#t3-server-address').value.trim();
    if (/^t3code(?:-dev)?:/i.test(link) && !serverAddress) {
      container.querySelector('#t3-connection-message').textContent = 'Enter the HTTP server address shown under T3 Connections → Version.';
      return;
    }
    input.value = '';
    pending = true;
    container.querySelector('#t3-connection-message').textContent = 'Connecting…';
    api.pairT3(link, serverAddress);
  });
  api.onState(state => {
    if (state.type !== 'fingertip-t3-state') return;
    configured = state.configured === true;
    if (pending && !state.pairing && state.connected && state.message === 'T3 Code connected') {
      editing = false;
      pending = false;
    }
    container.querySelector('#t3-connection-message').textContent = state.connected && !editing
      ? 'T3 Code connected — shared by all T3 keys' : state.message;
    container.querySelector('#t3-shared-address').textContent = state.serverAddress || '';
    if (!editing && state.serverAddress) address.value = state.serverAddress;
    form.hidden = configured && !editing;
    change.hidden = !configured;
    change.textContent = editing ? 'Cancel connection change' : 'Change shared connection';
  });
})();
