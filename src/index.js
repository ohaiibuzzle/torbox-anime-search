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

// display results

function renderResults(cached) {
  _cached = cached;
  const container = $('results');
  container.innerHTML = '';

  cached.forEach((torrent, idx) => {
    const card = document.createElement('div');
    card.className = 't-card';
    card.id = `tc-${idx}`;
    card.onclick = () => openTorrent(idx);

    card.innerHTML = `
      <div class="t-header">
        <div class="t-title" title="${esc(torrent.name)}">${esc(torrent.name)}</div>
        <div class="t-meta">
          ${torrent.seeders ? `<span class="seed-dot" title="${torrent.seeders} seeders"></span><span>${torrent.seeders}</span>` : ''}
          <span>${fmtBytes(torrent.size)}</span>
          <span class="pill pill-cached">CACHED</span>
        </div>
      </div>
    `;

    container.appendChild(card);
  });
}

// torrent detail page: torrentinfo + mylist/createtorrent run in parallel

async function openTorrent(idx) {
  const torrent = _cached[idx];
  const key = $('apiKey').value.trim();

  $('results').style.display = 'none';
  $('detailContent').innerHTML = '';
  $('watchWrap').style.display = 'block';
  setStatus('<span class="spin"></span> Fetching torrent info… (may take up to 30s)');

  const [filesResult, idResult] = await Promise.allSettled([
    fetchTorrentFiles(torrent.hash, key),
    ensureTorrentId(torrent, key),
  ]);

  if (filesResult.status === 'rejected') {
    setStatus(`Failed to load files: ${esc(filesResult.reason?.message)}`, 'error');
    return;
  }
  if (idResult.status === 'rejected') {
    setStatus(`Failed to add torrent: ${esc(idResult.reason?.message)}`, 'error');
    return;
  }

  const files = filesResult.value;
  const torrentId = idResult.value;

  if (!files.length) {
    setStatus('No files found in this torrent.', 'error');
    return;
  }

  if (files.length === 1) {
    const f = files[0];
    _streamUrl =
      `https://api.torbox.app/v1/api/torrents/requestdl` +
      `?token=${encodeURIComponent(key)}` +
      `&torrent_id=${torrentId}` +
      `&file_id=0&redirect=true`;

    setStatus(`<span style="color:var(--success)">✓</span> Ready — <em>${esc(f.name)}</em>`, 'ok');
    $('detailContent').innerHTML = `
      <button id="copyBtn" onclick="copyLink()">Copy Link (for use with a media player)</button>
      <div class="action-row">
        <a id="watchLink" href="${esc(_streamUrl)}" target="_blank" rel="noopener" class="btn-outline">Download</a>
        <button id="vlcBtn" class="btn-outline" onclick="openVlc()">Open in VLC</button>
      </div>
    `;
  } else {
    _streamUrl = '';
    const zipUrl =
      `https://api.torbox.app/v1/api/torrents/requestdl` +
      `?token=${encodeURIComponent(key)}` +
      `&torrent_id=${torrentId}` +
      `&zip_link=true` +
      `&redirect=true`;

    setStatus(`<span style="color:var(--success)">✓</span> ${files.length} files found.`, 'ok');
    const fileListHtml = files.map(f => `
      <div class="f-item" style="cursor:default">
        <div class="f-name" title="${esc(f.name)}">${esc(f.name)}</div>
        <div class="f-size">${fmtBytes(f.size)}</div>
      </div>
    `).join('');
    $('detailContent').innerHTML = `
      <div class="action-row" style="margin-bottom:1rem">
        <a href="${esc(zipUrl)}" target="_blank" rel="noopener" class="btn-outline">Download as ZIP</a>
      </div>
      <div class="f-list" style="max-height:300px;overflow-y:auto">${fileListHtml}</div>
    `;
  }

  $('watchWrap').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function fetchTorrentFiles(hash, key) {
  const url = `https://api.torbox.app/v1/api/torrents/torrentinfo?hash=${hash}&timeout=30&use_cache_lookup=true`;
  const res = await fetch(PROXY + encodeURIComponent(url), {
    headers: { 'Authorization': `Bearer ${key}` },
  });
  if (!res.ok) throw new Error(`TorBox ${res.status}`);
  const json = await res.json();
  if (!json.success) throw new Error(json.detail ?? 'Failed to load torrent info');
  return json.data?.files ?? [];
}

async function ensureTorrentId(torrent, key) {
  // Check existing library first to avoid the createtorrent rate limit (60/min)
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
        if (existing) return existing.id;
      }
    }
  } catch { /* fall through to createtorrent */ }

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
  return json.data.torrent_id;
}

function showResults() {
  $('results').style.display = '';
  $('watchWrap').style.display = 'none';
  $('detailContent').innerHTML = '';
  setStatus('');
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
