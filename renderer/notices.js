// Notices about long jobs: Hockey AI runs, saving clips, reels and review clips, Auto-Cut and YouTube
// uploads. The bell in the header lists what's running, what finished and what failed; a pop-up shows
// in the corner when a job finishes or fails; and, if the user leaves it on, the computer shows its
// own notice too while Pucked Video isn't the window in front.
const Notices = {
  items: [],
  // Notices the user hasn't seen in the bell yet stay highlighted while the bell is open.
  fresh: new Set(),

  kinds: { ai: '🏒', clips: '🎬', review: '🎙', autocut: '✂', youtube: '▶' },
  states: { running: 'Working', done: 'Done', failed: 'Failed', cancelled: 'Stopped' },

  // Desktop notices: on unless the user turned them off. A browser has to be allowed to show them first.
  get desktop() {
    return AI.settings.desktopNotices ?? Boolean(window.native);
  },
  async setDesktop(on) {
    if (on && !window.native && 'Notification' in window && Notification.permission !== 'granted') {
      on = (await Notification.requestPermission()) === 'granted';
      if (!on) alert('Your browser said no to notices from Pucked Video. You can allow them in the browser\'s site settings.');
    }
    AI.settings.desktopNotices = on;
    await window.api.saveSettings(AI.settings);
    this.render();
  },

  async load() {
    this.items = (await window.api.listNotices()) ?? [];
    this.render();
  },

  // One notice changed or is new.
  update(n) {
    const i = this.items.findIndex((x) => x.id === n.id);
    const before = i >= 0 ? this.items[i] : null;
    if (i >= 0) this.items[i] = n; else this.items.unshift(n);
    const ended = n.state !== 'running' && before?.state !== n.state && (before || n.unread);
    if (ended && n.state !== 'cancelled') this.announce(n);
    this.render();
  },

  // A job just finished or failed: a pop-up in the corner, and the desktop notice if the app isn't in front.
  announce(n) {
    this.toast(n);
    if (!this.desktop || !('Notification' in window) || Notification.permission !== 'granted') return;
    if (document.visibilityState === 'visible' && document.hasFocus()) return;
    const note = new Notification(`${n.title}: ${n.state === 'done' ? 'done' : 'failed'}`, {
      body: [n.detail, n.message].filter(Boolean).join('\n'), tag: n.id, silent: false,
    });
    note.onclick = () => {
      window.native?.focusWindow ? window.native.focusWindow() : window.focus();
      this.open();
      note.close();
    };
  },

  toast(n) {
    const t = document.createElement('div');
    t.className = `toast ${n.state}`;
    t.innerHTML = `<b>${this.kinds[n.kind] ?? ''} ${esc(n.title)}: ${n.state === 'done' ? 'done' : 'failed'}</b>`
      + (n.detail ? `<div class="muted">${esc(n.detail)}</div>` : '')
      + (n.state === 'failed' && n.message ? `<div class="toast-msg">${esc(n.message)}</div>` : '')
      + `<div class="toast-actions">${this.actions(n)}<button data-act="close">Close</button></div>`;
    t.onclick = (e) => {
      const act = e.target.dataset.act;
      if (!act) return;
      if (act !== 'close') this.act(n, act);
      t.remove();
    };
    $('toasts').append(t);
    // A failure stays until it's closed, so it isn't missed.
    if (n.state === 'done') setTimeout(() => t.remove(), 10000);
  },

  actions(n) {
    if (n.state !== 'done') return '';
    const b = [];
    if (n.file) b.push('<button data-act="open">Open</button>', window.native ? '<button data-act="show">Show in folder</button>' : '');
    if (n.url) b.push('<button data-act="link">Watch on YouTube</button>');
    if (n.kind === 'ai' && n.video && n.video !== current?.path) b.push('<button data-act="game">Open the game</button>');
    return b.join('');
  },

  async act(n, act) {
    if (act === 'open') window.api.openFile(n.file);
    if (act === 'show') window.api.showFile(n.file);
    if (act === 'link') window.api.openExternal(n.url);
    if (act === 'game') {
      const file = await window.api.openVideoPath(n.video);
      if (!file) return alert(`${n.video} isn't there any more.`);
      $('noticePanel').hidden = true;
      await showGame(file);
    }
    if (act === 'dismiss') await window.api.dismissNotice(n.id);
  },

  when(ms) {
    const d = new Date(ms);
    const today = new Date().toDateString() === d.toDateString();
    return d.toLocaleString([], today ? { hour: 'numeric', minute: '2-digit' } : { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  },

  row(n) {
    const pct = n.state === 'running' && n.pct != null ? ` ${Math.floor(n.pct)}%` : '';
    const at = n.state === 'running' ? `started ${this.when(n.startedAt)}` : this.when(n.finishedAt ?? n.updatedAt);
    return `<li class="notice ${n.state}${this.fresh.has(n.id) ? ' fresh' : ''}" data-id="${esc(n.id)}">
      <span class="notice-icon">${this.kinds[n.kind] ?? '•'}</span>
      <div class="notice-body">
        <div><b>${esc(n.title)}</b> <span class="pill ${n.state}">${this.states[n.state] ?? n.state}${pct}</span></div>
        ${n.detail ? `<div class="muted">${esc(n.detail)}</div>` : ''}
        ${n.state === 'running' ? `<div class="notice-bar"><i style="width:${n.pct ?? 0}%"></i></div>` : ''}
        ${n.message ? `<div class="notice-msg">${esc(n.message)}</div>` : ''}
        <div class="notice-foot"><span class="muted">${at}</span>${this.actions(n)}${n.state !== 'running' ? '<button data-act="dismiss" title="Remove this notice">×</button>' : ''}</div>
      </div></li>`;
  },

  render() {
    const running = this.items.filter((n) => n.state === 'running').length;
    const unread = this.items.filter((n) => n.unread).length;
    $('noticeCount').textContent = unread || '';
    $('noticeCount').hidden = !unread;
    $('noticeCount').className = `notice-count${this.items.some((n) => n.unread && n.state === 'failed') ? ' failed' : ''}`;
    $('noticeBtn').classList.toggle('busy', running > 0);
    $('noticeBtn').title = [running && `${running} job${running === 1 ? '' : 's'} working`, unread && `${unread} new`].filter(Boolean).join(', ') || 'Notices';
    if ($('noticePanel').hidden) return;
    $('noticeDesktop').checked = this.desktop;
    $('noticeList').innerHTML = this.items.length ? this.items.map((n) => this.row(n)).join('')
      : '<li class="muted notice-empty">Nothing yet. Long jobs like Hockey AI, saving clips and YouTube uploads show up here.</li>';
    $('noticeClear').disabled = !this.items.some((n) => n.state !== 'running');
  },

  async open() {
    this.fresh = new Set(this.items.filter((n) => n.unread).map((n) => n.id));
    $('noticePanel').hidden = false;
    this.render();
    if (this.fresh.size) {
      await window.api.markNoticesRead();
      for (const n of this.items) n.unread = false;
      this.render();
    }
  },

  wire() {
    window.api.onNotice((n) => this.update(n));
    window.api.onNotices((all) => { this.items = all; this.render(); });
    $('noticeBtn').onclick = (e) => {
      e.stopPropagation();
      if ($('noticePanel').hidden) this.open(); else $('noticePanel').hidden = true;
    };
    // Clicking anywhere else closes the list.
    document.addEventListener('click', (e) => {
      if (!$('noticePanel').hidden && !e.target.closest('#noticePanel')) $('noticePanel').hidden = true;
    });
    $('noticeList').onclick = (e) => {
      const act = e.target.dataset.act;
      const n = act && this.items.find((x) => x.id === e.target.closest('[data-id]')?.dataset.id);
      if (n) this.act(n, act);
    };
    $('noticeClear').onclick = () => window.api.clearNotices();
    $('noticeDesktop').onchange = () => this.setDesktop($('noticeDesktop').checked);
    // The list can be missed while the server restarts; read it again when the window comes back.
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') this.load(); });
    return this.load();
  },
};
