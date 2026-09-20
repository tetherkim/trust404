const $ = id => document.getElementById(id);
const names = { rejection: 'Valid rejection', tamper: 'Record tampering', unavailable: 'Archive unavailable', missing: 'Missing decision', wrong: 'Policy mismatch' };
let scenarios = [], selected, busy = false;
const results = new Map();
const short = value => value ? `${value.slice(0, 10)}…${value.slice(-6)}` : '—';
function summary(scenario) {
  const entry = results.get(scenario.id);
  if (!entry || entry.running || entry.error) return { verdict: entry?.running ? 'RUNNING' : entry?.error ? 'ERROR' : 'NOT_RUN', tone: entry?.error ? 'fail' : 'muted', archive: '—', policy: '—', timing: '—', finding: entry?.error ?? '—' };
  const r = entry.data, request = r.requests?.find(item => item.requestId === scenario.requestId);
  const codes = (r.issues ?? []).map(issue => issue.code);
  const match = request?.decisions?.find(decision => decision.policy === 'MATCH');
  const missing = request?.timing === 'MISSING_AS_OF_H';
  const uncertain = codes.includes('DATA_UNAVAILABLE');
  const finding = codes.length > 0 || missing;
  return { verdict: uncertain ? 'INCONCLUSIVE' : finding ? 'FINDING' : r.ok && match ? 'VERIFIED' : 'INCONCLUSIVE',
    tone: uncertain ? 'unknown' : finding ? 'warn' : r.ok && match ? 'pass' : 'unknown',
    archive: r.complete ? 'COMPLETE' : 'INCOMPLETE',
    policy: codes.includes('POLICY_MISMATCH') ? 'MISMATCH' : match ? 'MATCH' : 'NOT_EVALUATED',
    timing: request?.timing ?? 'UNKNOWN', finding: codes.join(' · ') || (missing ? 'MISSING_AS_OF_H' : match?.outcome ?? '—'), request };
}
function cell(row, value, className = '') { const el = document.createElement('td'); el.textContent = value; el.className = className; row.append(el); return el; }
function render() {
  $('run').disabled = $('run-all').disabled = busy || !selected;
  $('suite-state').textContent = busy ? 'RUNNING' : 'READY';
  const values = scenarios.map(summary);
  $('count-done').textContent = `${[...results.values()].filter(r => !r.running).length} / ${scenarios.length}`;
  $('count-pass').textContent = values.filter(r => r.verdict === 'VERIFIED').length;
  $('count-findings').textContent = values.filter(r => r.verdict === 'FINDING').length;
  $('count-unknown').textContent = values.filter(r => ['INCONCLUSIVE', 'ERROR'].includes(r.verdict)).length;
  $('cases').replaceChildren();
  scenarios.forEach((scenario, index) => {
    const state = summary(scenario), row = document.createElement('tr');
    row.className = selected?.id === scenario.id ? 'selected' : '';
    const first = cell(row, ''), button = document.createElement('button'), number = document.createElement('small');
    button.className = 'case-button'; button.setAttribute('aria-pressed', String(selected?.id === scenario.id));
    number.textContent = String(index + 1).padStart(2, '0'); button.append(number, names[scenario.id] ?? scenario.title);
    button.addEventListener('click', () => { selected = scenario; render(); }); first.append(button);
    cell(row, short(scenario.requestId), 'code muted').title = scenario.requestId;
    cell(row, `${scenario.requestAnchor.blockNumber} → ${scenario.asOf.blockNumber}`, 'code');
    cell(row, state.archive, 'badge'); cell(row, state.policy, `badge ${state.policy === 'MISMATCH' ? 'warn' : state.policy === 'MATCH' ? 'pass' : ''}`);
    cell(row, state.timing, 'badge'); cell(row, state.finding === '—' ? state.verdict : state.finding, `badge ${state.tone}`);
    $('cases').append(row);
  });
  if (!selected) return;
  const s = selected, state = summary(s), entry = results.get(s.id);
  $('selected-title').textContent = `02 / ${names[s.id].toUpperCase()}`;
  $('case-index').textContent = `${scenarios.indexOf(s) + 1} / ${scenarios.length}`;
  for (const [id, value] of Object.entries({ historical: s.receiptBalance, current: s.currentBalance, amount: s.amount, minimum: s.minimumBalance,
    'after-n': BigInt(s.receiptBalance) - BigInt(s.amount), 'after-current': BigInt(s.currentBalance) - BigInt(s.amount),
    policy: s.policyId, window: `${s.decisionWindowSeconds}s`, 'receipt-block': s.requestAnchor.blockNumber, cutoff: s.asOf.blockNumber,
    batches: `${s.requestAnchor.batchId} → ${s.decisionAnchor?.batchId ?? 'NONE'}`,
    deadline: new Date((Number(s.requestAnchor.anchoredAt) + s.decisionWindowSeconds) * 1000).toISOString(),
    duration: entry?.ms == null ? '—' : `${entry.ms} ms`, finality: `FINALITY ${entry?.data?.finality ?? '—'}` })) $(id).textContent = String(value);
  $('result-title').textContent = state.verdict; $('result-title').className = state.tone;
  $('result').setAttribute('aria-busy', String(entry?.running ?? false));
  $('checks').replaceChildren();
  for (const [label, value] of [['Archive coverage', state.archive], ['Policy replay', state.policy], ['Registration', state.timing], ['Finding / outcome', state.finding]]) {
    const li = document.createElement('li'), span = document.createElement('span'), strong = document.createElement('strong');
    span.textContent = label; strong.textContent = value; li.append(span, strong); $('checks').append(li);
  }
  $('records').replaceChildren();
  for (const [label, value] of [['REQUEST ID', s.requestId], ['POLICY HASH', s.policyHash], ['ANCHOR', s.anchorAddress], ['TOKEN', s.token], ['TREASURY', s.treasury], ['BLOCK N HASH', s.requestAnchor.blockHash], ['BLOCK H HASH', s.asOf.blockHash], ['REQUEST ROOT', s.requestAnchor.root], ['DECISION ROOT', s.decisionAnchor?.root], ['REQUEST TX', s.requestTransaction], ['DECISION TX', s.decisionTransaction]]) {
    const row = document.createElement('tr'), th = document.createElement('th'); th.scope = 'row'; th.textContent = label; row.append(th); cell(row, value ?? 'NONE', value ? '' : 'empty'); $('records').append(row);
  }
  $('raw').textContent = JSON.stringify(entry?.data ?? { status: state.verdict, ...(entry?.error ? { error: entry.error } : {}) }, null, 2);
}
async function run(list) {
  if (busy) return; busy = true;
  try {
    for (const scenario of list) {
      results.set(scenario.id, { running: true }); render(); const started = performance.now();
      try {
        const response = await fetch(`/api/audit/${encodeURIComponent(scenario.id)}`, { signal: AbortSignal.timeout(30000) });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error ?? `HTTP_${response.status}`);
        results.set(scenario.id, { data, ms: Math.round(performance.now() - started) });
      } catch (error) { results.set(scenario.id, { error: error.message, ms: Math.round(performance.now() - started) }); }
      render();
    }
  } finally { busy = false; render(); }
}
$('run').addEventListener('click', () => selected && run([selected]));
$('run-all').addEventListener('click', () => run([...scenarios]));
fetch('/api/status').then(async response => {
  if (!response.ok) throw new Error('STATUS_FAILED');
  const status = await response.json();
  if (!status.scenarios?.length) throw new Error('NO_SCENARIOS');
  scenarios = status.scenarios; selected = scenarios[0];
  $('environment').textContent = `${status.environment.toUpperCase()} / ${status.chainId}`;
  $('aomi').textContent = 'AUDIT RUNTIME / LOCAL RPC';
  render();
}).catch(error => { $('load-error').textContent = error.message; $('suite-state').textContent = 'OFFLINE'; });
