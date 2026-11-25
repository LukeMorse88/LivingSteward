const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
let S = null;

function msgNode(m) {
  const d = document.createElement('div');
  d.dataset.id = m.id;
  if (m.kind === 'tool') {
    d.className = 'msg card' + (m.sub ? ' sub' : '');
    d.innerHTML = `<div class="card-head"><b>${m.sub ? '↳ 子Agent · ' : ''}${esc(m.name)}</b><span class="st">${esc(m.state)}</span></div>
      <pre class="args">${esc(JSON.stringify(m.args ?? {}))}</pre>
      <pre class="out">${esc(m.output ?? '')}</pre>
      <div class="appr" hidden><button data-appr="allow">允许</button><button data-appr="always">常允许</button><button data-appr="deny">拒绝</button></div>`;
    syncCard(d, m);
  } else if (m.kind === 'ask') {
    d.className = 'msg ask';
    d.innerHTML = `<div class="q">${esc(m.question)}</div>` +
      (m.answer != null ? `<div class="a">答：${esc(m.answer)}</div>` :
        `<div class="opts">${(m.options ?? []).map((o) => `<button data-opt="${esc(o)}">${esc(o)}</button>`).join('')}</div>
         <div class="composer"><input placeholder="回答"><button class="send">答</button></div>`);
  } else if (m.kind === 'cmd') {
    d.className = 'msg cmd';
    d.innerHTML = `<b>/${esc(m.name)}</b><pre>${esc(m.text)}</pre>`;
  } else {
    d.className = 'msg ' + m.kind;
    d.textContent = (m.kind === 'dispatch' ? '↓ 派发：' : '') + m.text;
  }
  return d;
}
function syncCard(d, m) {
  $('.st', d).textContent = m.state + (m.decision ? '·' + m.decision : '');
  $('.out', d).textContent = m.output ?? '';
  $('.appr', d).hidden = m.state !== 'holding';
}
function pane(role) { return $(`.pane[data-role="${role}"]`); }
function append(role, m) {
  const box = $('.msgs', pane(role));
  box.appendChild(msgNode(m));
  box.scrollTop = box.scrollHeight;
}
function renderAll() {
  for (const role of ['cloud', 'local']) {
    const box = $('.msgs', pane(role));
    box.innerHTML = '';
    for (const m of S.hist[role]) box.appendChild(msgNode(m));
    box.scrollTop = box.scrollHeight;
  }
  syncFooter();
}
function syncFooter() {
  const ws = $('#ws-select');
  ws.innerHTML = S.workspaces.map((w) => `<option value="${w.id}" ${w.id === S.activeWs ? 'selected' : ''}>${esc(w.name)}</option>`).join('');
  $('#mode-select').value = S.mode;
  $('#ws-path').textContent = S.workspace;
}
function syncBusy(role, busy) {
  $('.stop', pane(role)).hidden = !busy;
  pane(role).classList.toggle('busy', busy);
  if (!busy) $('.stream', pane(role))?.remove();
}

document.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const card = b.closest('.card');
  if (card && b.dataset.appr) { ls.approval(card.dataset.id, b.dataset.appr !== 'deny', b.dataset.appr === 'always'); return; }
  const ask = b.closest('.ask');
  if (ask && b.dataset.opt) { ls.ask(ask.dataset.id, b.dataset.opt); return; }
  if (b.classList.contains('stop')) { ls.abort(b.closest('.pane').dataset.role); return; }
  if (b.classList.contains('send')) {
    const p = b.closest('.pane') ?? b.closest('.ask');
    const input = $('input', b.closest('.composer'));
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    if (b.closest('.ask')) { ls.ask(b.closest('.ask').dataset.id, text); return; }
    const role = p.dataset.role;
    if (text.startsWith('/')) ls.command(role, text); else ls.send(role, text);
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const input = e.target.closest('.composer input');
  if (input) $('.send', input.closest('.composer')).click();
});
$('#ws-select').addEventListener('change', (e) => ls.wsSwitch(e.target.value));
$('#mode-select').addEventListener('change', (e) => ls.command('local', '/mode ' + e.target.value));

ls.onEvent((ev) => {
  if (ev.type === 'msg') append(ev.role, ev.msg);
  if (ev.type === 'update') {
    const d = $(`.pane[data-role="${ev.role}"] .msg[data-id="${ev.id}"]`);
    if (d && d.classList.contains('card')) syncCard(d, { ...S.hist[ev.role].find((m) => m.id === ev.id), ...ev.patch });
    if (d && d.classList.contains('ask') && ev.patch.answer != null) d.replaceWith(msgNode({ ...S.hist[ev.role].find((m) => m.id === ev.id), ...ev.patch }));
  }
  if (ev.type === 'delta') {
    const p = pane(ev.role);
    let st = $('.stream', p);
    if (!st) { st = document.createElement('div'); st.className = 'msg stream'; $('.msgs', p).appendChild(st); }
    st.textContent += ev.text;
    $('.msgs', p).scrollTop = $('.msgs', p).scrollHeight;
  }
  if (ev.type === 'status') syncBusy(ev.role, ev.busy);
  if (ev.type === 'state') ls.getState().then((s) => { S = s; syncFooter(); });
});

(async () => {
  S = await ls.getState();
  renderAll();
  for (const role of ['cloud', 'local']) syncBusy(role, S.busy[role]);
  const brains = async () => {
    const b = await ls.brains();
    $('#b-q').className = b.quality ? 'on' : '';
    $('#b-s').className = b.speed ? 'on' : '';
  };
  brains();
  setInterval(brains, 15000);
})();