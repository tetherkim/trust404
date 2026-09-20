const $ = id => document.getElementById(id);
let input, profiles = [], busy = false, generation = 0;
function reset() {
  for (const id of ['requests', 'issues', 'references']) $(id).replaceChildren();
  for (const id of ['count-requests', 'count-batches', 'count-issues', 'coverage', 'duration', 'finality']) $(id).textContent = '—';
  $('verdict').textContent = 'NOT_RUN'; $('verdict').className = ''; $('raw').textContent = 'NOT_RUN';
}
function ready() {
  const profile = profiles.find(p => p.id === input?.profileId);
  $('run').disabled = busy || !profile;
  $('profile-name').textContent = profile ? `${profile.institutionId} / ${profile.policyId}` : input ? 'UNREGISTERED' : 'AWAITING FILE';
  $('profile-info').textContent = profile ? `CHAIN ${profile.chainId} / ${profile.anchorAddress}` : '—';
}
$('file').addEventListener('change', async () => {
  const token = ++generation; input = null; reset(); ready(); $('load-error').textContent = '';
  const file = $('file').files[0]; if (!file) { $('file-info').textContent = 'NO FILE SELECTED'; return; }
  $('file-info').textContent = `${file.name} / ${file.size.toLocaleString()} bytes`;
  try {
    if (file.size > 2 * 1024 * 1024) throw new Error('FILE_TOO_LARGE');
    const data = JSON.parse(await file.text()); if (token !== generation) return;
    if (data?.format !== 'trust404-audit-v1') throw new Error('INVALID_FILE_FORMAT');
    input = data;
    if (!profiles.some(p => p.id === data.profileId)) $('load-error').textContent = 'UNKNOWN_TRUST_PROFILE · 검증 기준 미등록';
  } catch (error) { if (token === generation) { input = null; $('load-error').textContent = error.message; } }
  ready();
});
function row(parent, values, header = false) {
  const tr = document.createElement('tr');
  values.forEach((value, i) => { const td = document.createElement(header && i === 0 ? 'th' : 'td'); td.textContent = String(value ?? '—'); tr.append(td); });
  parent.append(tr);
}
$('run').addEventListener('click', async () => {
  if (busy || !input || !profiles.some(p => p.id === input.profileId)) return;
  busy = true; const token = ++generation; reset(); ready();
  $('file').disabled = true; $('verdict').textContent = 'RUNNING'; $('load-error').textContent = '';
  const started = performance.now();
  try {
    const response = await fetch('/api/audit-file', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input), signal: AbortSignal.timeout(120000) });
    const result = await response.json(); if (token !== generation) return;
    if (!response.ok) throw new Error(result.error ?? `HTTP_${response.status}`);
    const missing = result.requests.filter(r => ['MISSING_AS_OF_H', 'REGISTERED_LATE'].includes(r.timing));
    const unavailable = result.issues.some(i => ['DATA_UNAVAILABLE', 'RPC_UNAVAILABLE', 'STATE_UNAVAILABLE'].includes(i.code));
    $('verdict').textContent = result.ok ? 'VERIFIED' : unavailable ? 'INCONCLUSIVE' : 'FINDING';
    $('verdict').className = result.ok ? 'pass' : unavailable ? 'unknown' : 'warn';
    $('count-requests').textContent = result.requests.length; $('count-batches').textContent = result.batchCount;
    $('count-issues').textContent = result.issues.length + missing.length;
    $('coverage').textContent = result.complete ? 'COMPLETE' : 'INCOMPLETE';
    $('finality').textContent = result.finality; $('raw').textContent = JSON.stringify(result, null, 2);
    for (const request of result.requests) {
      row($('requests'), [request.requestId, request.timing, request.decisions.map(d => d.error ? 'NOT_VERIFIED' : `${d.record} / ${d.policy}`).join(' · ') || '—', request.decisions.map(d => d.error ?? `${d.outcome} / ${d.reason}`).join(' · ') || (result.complete ? 'NO DECISION' : 'UNKNOWN')]);
    }
    for (const issue of [...result.issues, ...missing.map(r => ({ code: r.timing, requestId: r.requestId }))]) {
      const li = document.createElement('li'); li.textContent = `${issue.code} / ${issue.requestId ?? `batch ${issue.batchId ?? '—'}`}`; $('issues').append(li);
    }
    for (const pair of [['PROFILE / POLICY HASH', result.profileId], ['CHAIN', result.chainId], ['ANCHOR', result.anchorAddress], ['CUTOFF BLOCK', result.asOf.blockNumber], ['CUTOFF HASH', result.asOf.blockHash]]) row($('references'), pair, true);
  } catch (error) { $('verdict').textContent = 'ERROR'; $('verdict').className = 'fail'; $('load-error').textContent = error.message; }
  finally { busy = false; $('duration').textContent = `${Math.round(performance.now() - started)} ms`; $('file').disabled = false; ready(); }
});
fetch('/api/profiles').then(async response => {
  if (!response.ok) throw new Error('PROFILES_UNAVAILABLE'); profiles = await response.json();
  $('file').disabled = false;
  for (const [id, name] of Object.entries({ rejection: 'Valid', tamper: 'Tampered', unavailable: 'Unavailable', missing: 'Missing', wrong: 'Wrong decision' })) {
    const link = document.createElement('a'); link.href = `/api/sample/${id}`; link.textContent = name; link.download = `audit-${id}.json`; link.style.color = '#b49aff'; link.style.marginRight = '18px'; $('samples').append(link);
  }
  ready();
}).catch(error => { $('load-error').textContent = error.message; });
