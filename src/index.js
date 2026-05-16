const $ = id => document.getElementById(id);
const PROXY = 'https://cors-proxy.ohaibuzzle-cloudflare.workers.dev/corsproxy/?apiurl=';
let _cached = [];
let _streamUrl = '';

// helpers

function setStatus(html, type = '') {
  const el = $('status');
  el.innerHTML = html;
  el.className = type;
}

function esc(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function hashFromMagnet(magnet) {
  const m = magnet.match(/xt=urn:btih:([a-fA-F0-9]{32,40})/i);
  return m ? m[1].toLowerCase() : null;
}

function parseSize(str) {
  if (!str) return 0;
  if (typeof str === 'number') return str;
  const val = parseFloat(str);
  if (isNaN(val)) return 0;
  const s = str.toString().toLowerCase();
  if (s.includes('gib') || s.includes('gb')) return Math.round(val * 1e9);
  if (s.includes('mib') || s.includes('mb')) return Math.round(val * 1e6);
  if (s.includes('kib') || s.includes('kb')) return Math.round(val * 1e3);
  return val;
}

function fmtBytes(bytes) {
  if (!bytes) return '?';
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(2) + ' GB';
  if (bytes >= 1e6) return (bytes / 1e6).toFixed(1) + ' MB';
  return (bytes / 1e3).toFixed(0) + ' KB';
}

// nyaa query + torbox search

async function runSearch() {
  const q = $('query').value.trim();
  const key = $('apiKey').value.trim();

  if (!q)   { setStatus('Enter a search query first.', 'error'); return; }
  if (!key) { setStatus('Enter your TorBox API key first.', 'error'); return; }

  $('results').innerHTML = '';
  $('results').style.display = '';
  $('watchWrap').style.display = 'none';
  $('searchBtn').disabled = true;

  setStatus('<span class="spin"></span> Searching Nyaa…');

  const cat = $('category').value;
  const nyaaUrl = `https://nyaaapi.onrender.com/nyaa?q=${encodeURIComponent(q)}${cat ? '&category=' + cat : ''}&sort=seeders&order=desc&page=1`;

  let torrents;
  try {
    const res = await fetch(nyaaUrl, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`Nyaa responded with ${res.status}`);
    const json = await res.json();
    torrents = Array.isArray(json) ? json : (json.data ?? json.torrents ?? json.results ?? []);
  } catch (e) {
    setStatus(`Nyaa fetch failed: ${e.message}`, 'error');
    $('searchBtn').disabled = false;
    return;
  }

  if (!torrents.length) {
    setStatus('No results on Nyaa for that query.', 'error');
    $('searchBtn').disabled = false;
    return;
  }

  const hashMap = {};
  for (const t of torrents) {
    const magnet = t.magnet ?? t.magnet_uri ?? '';
    const hash = hashFromMagnet(magnet);
    if (hash && !hashMap[hash]) hashMap[hash] = t;
  }

  const hashes = Object.keys(hashMap);
  if (!hashes.length) {
    setStatus('Could not extract info hashes from Nyaa results.', 'error');
    $('searchBtn').disabled = false;
    return;
  }

  setStatus(`<span class="spin"></span> Checking TorBox cache for ${hashes.length} torrent${hashes.length > 1 ? 's' : ''}…`);

  let cacheData;
  try {
    const res = await fetch(PROXY + encodeURIComponent('https://api.torbox.app/v1/api/torrents/checkcached'), {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ hashes }),
    });
    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`TorBox ${res.status}: ${txt}`);
    }
    const json = await res.json();
    if (!json.success) throw new Error(json.detail ?? 'Cache check failed');
    cacheData = json.data ?? {};
  } catch (e) {
    setStatus(`TorBox cache check failed: ${e.message}`, 'error');
    $('searchBtn').disabled = false;
    return;
  }

  const cached = [];
  for (const [hash, info] of Object.entries(cacheData)) {
    if (!info) continue;
    const src = hashMap[hash.toLowerCase()] ?? {};
    const name = info.name || src.title || src.name || hash;
    const size = info.size || parseSize(src.size) || 0;

    const files = info.files?.length
      ? info.files
      : [{ id: 0, name, short_name: name, size, mimetype: '' }];

    cached.push({
      hash: hash.toLowerCase(),
      name,
      size,
      seeders: src.seeders ?? 0,
      files,
      magnet: src.magnet ?? src.magnet_uri ?? `magnet:?xt=urn:btih:${hash}`,
    });
  }

  $('searchBtn').disabled = false;

  if (!cached.length) {
    setStatus(
      `None of the ${hashes.length} results are cached on TorBox. Try a different search or check back later.`,
      'error'
    );
    return;
  }

  setStatus(
    `<span style="color:var(--success)">✓</span> ${cached.length} cached result${cached.length > 1 ? 's' : ''} — pick one to stream.`,
    'ok'
  );
  renderResults(cached);
}

// display results + file selection

function renderResults(cached) {
  _cached = cached;
  const container = $('results');
  container.innerHTML = '';

  cached.forEach((torrent, idx) => {
    const card = document.createElement('div');
    card.className = 't-card';
    card.id = `tc-${idx}`;

    const filesHtml = torrent.files.map((f, fIdx) => `
      <div class="f-item" id="fi-${idx}-${fIdx}" onclick="selectFile(${idx}, ${fIdx})">
        <div class="f-name" title="${esc(f.name || f.short_name)}">${esc(f.short_name || f.name || ('File ' + f.id))}</div>
        <div class="f-size">${fmtBytes(f.size)}</div>
      </div>
    `).join('');

    card.innerHTML = `
      <div class="t-header" onclick="toggleCard(${idx})">
        <div class="t-title" title="${esc(torrent.name)}">${esc(torrent.name)}</div>
        <div class="t-meta">
          ${torrent.seeders ? `<span class="seed-dot" title="${torrent.seeders} seeders"></span><span>${torrent.seeders}</span>` : ''}
          <span>${fmtBytes(torrent.size)}</span>
          <span class="pill pill-cached">CACHED</span>
          <span class="chevron">▼</span>
        </div>
      </div>
      <div class="f-list">${filesHtml}</div>
    `;

    container.appendChild(card);
  });
}

function toggleCard(idx) {
  const card = $(`tc-${idx}`);
  const isOpen = card.classList.contains('open');
  document.querySelectorAll('.t-card').forEach(c => c.classList.remove('open'));
  if (!isOpen) card.classList.add('open');
}

// mylist check → createtorrent (if needed) → stream links

async function selectFile(cardIdx, fileIdx) {
  const key = $('apiKey').value.trim();
  const torrent = _cached[cardIdx];
  const f = torrent.files[fileIdx];
  const fileId = f.id;
  const fileName = f.name || f.short_name || String(f.id);

  document.querySelectorAll('.f-item').forEach(el => el.classList.remove('selected'));
  const fi = $(`fi-${cardIdx}-${fileIdx}`);
  if (fi) fi.classList.add('selected');

  $('watchWrap').style.display = 'none';
  setStatus(`<span class="spin"></span> Checking your TorBox library…`);

  // Check existing library first to avoid hitting the createtorrent rate limit (60/min)
  let torrentId = null;
  try {
    const res = await fetch(PROXY + encodeURIComponent('https://api.torbox.app/v1/api/torrents/mylist'), {
      headers: { 'Authorization': `Bearer ${key}` },
    });
    if (res.ok) {
      const json = await res.json();
      if (json.success && Array.isArray(json.data)) {
        const existing = json.data.find(t =>
          t.hash?.toLowerCase() === torrent.hash ||
          t.alternative_hashes?.some(h => h.toLowerCase() === torrent.hash)
        );
        if (existing) torrentId = existing.id;
      }
    }
  } catch { /* non-fatal — fall through to createtorrent */ }

  if (torrentId === null) {
    setStatus(`<span class="spin"></span> Adding torrent to TorBox…`);
    try {
      const form = new FormData();
      form.append('magnet', torrent.magnet);
      form.append('add_only_if_cached', 'true');

      const res = await fetch(PROXY + encodeURIComponent('https://api.torbox.app/v1/api/torrents/createtorrent'), {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${key}` },
        body: form,
      });

      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`TorBox ${res.status}: ${txt}`);
      }

      const json = await res.json();
      if (!json.success) throw new Error(json.detail ?? 'Failed to add torrent');
      torrentId = json.data.torrent_id;
    } catch (e) {
      setStatus(`Failed to add torrent: ${e.message}`, 'error');
      return;
    }
  }

  _streamUrl =
    `https://api.torbox.app/v1/api/torrents/requestdl` +
    `?token=${encodeURIComponent(key)}` +
    `&torrent_id=${torrentId}` +
    `&file_id=${fileId}` +
    `&redirect=true`;

  setStatus(`<span style="color:var(--success)">✓</span> Ready — <em>${esc(fileName)}</em>`, 'ok');

  $('watchLink').href = _streamUrl;
  $('results').style.display = 'none';
  $('watchWrap').style.display = 'block';
  $('watchWrap').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function showResults() {
  $('results').style.display = '';
}

async function copyLink() {
  if (!_streamUrl) return;
  try {
    await navigator.clipboard.writeText(_streamUrl);
    const btn = $('copyBtn');
    const orig = btn.textContent;
    btn.textContent = '✓ Copied';
    setTimeout(() => { btn.textContent = orig; }, 2000);
  } catch {
    prompt('Copy this link:', _streamUrl);
  }
}

function openVlc() {
  if (!_streamUrl) return;
  window.location.href = 'vlc://' + _streamUrl;
}

function clearApiKey() {
  localStorage.removeItem('torbox_api_key');
  $('apiKey').value = '';
  $('keySaved').classList.remove('visible');
  $('apiKeyWrap').style.display = 'block';
  $('clearKeyBtn').style.display = 'none';
}

// key saving on client side + event listeners

$('query').addEventListener('keydown', e => { if (e.key === 'Enter') runSearch(); });

const _keyInput = $('apiKey');
const _storedKey = localStorage.getItem('torbox_api_key');
if (_storedKey) {
  _keyInput.value = _storedKey;
  $('keySaved').classList.add('visible');
  $('apiKeyWrap').style.display = 'none';
  $('clearKeyBtn').style.display = 'inline-block';
}

_keyInput.addEventListener('input', () => {
  const val = _keyInput.value.trim();
  if (val) {
    localStorage.setItem('torbox_api_key', val);
  } else {
    localStorage.removeItem('torbox_api_key');
  }
  $('keySaved').classList.toggle('visible', !!val);
});
