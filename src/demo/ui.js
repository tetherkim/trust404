const $ = id => document.getElementById(id);
let input, profiles = [], busy = false, generation = 0;
const labels = {
  VERIFIED: '검증 완료', FINDING: '이상 탐지', INCONCLUSIVE: '판정 불가', RUNNING: '검증 중', ERROR: '오류',
  COMPLETE: '완전', INCOMPLETE: '불완전', FINALIZED: '확정', PROVISIONAL: '확정 대기',
  REGISTERED_ON_TIME: '기한 내 등록', REGISTERED_LATE: '기한 후 등록', MISSING_AS_OF_H: '기한 내 결과 없음', UNKNOWN: '확인 불가',
  VALID: '유효', MATCH: '일치', NOT_VERIFIED: '검증 실패', REJECTED: '거절', APPROVED: '승인', NO_DECISION: '판정 없음',
  RESERVE_FLOOR: '최소 잔액 미달', POLICY_MISMATCH: '정책 재검증 불일치', TAMPERED_EXPORT: '보관 기록 변조', DATA_UNAVAILABLE: '자료 없음',
};
const ko = value => labels[value] ? `${labels[value]} (${value})` : value;
function reset() {
  for (const id of ['requests', 'issues', 'references']) $(id).replaceChildren();
  for (const id of ['count-requests', 'count-batches', 'count-issues', 'coverage', 'duration', 'finality']) $(id).textContent = '—';
  $('verdict').textContent = '실행 전'; $('verdict').className = ''; $('raw').textContent = '실행 전';
}
function ready() {
  const profile = profiles.find(p => p.id === input?.profileId);
  $('run').disabled = busy || !profile;
  $('profile-name').textContent = profile ? `${profile.institutionId} / ${profile.policyId}` : input ? '검증 기준 미등록' : '파일 입력 대기';
  $('profile-info').textContent = profile ? `체인 ${profile.chainId} / 계약 ${profile.anchorAddress}` : '—';
}
$('file').addEventListener('change', async () => {
  const token = ++generation; input = null; reset(); ready(); $('load-error').textContent = '';
  const file = $('file').files[0]; if (!file) { $('file-info').textContent = '선택된 파일 없음'; return; }
  $('file-info').textContent = `${file.name} / ${file.size.toLocaleString()} bytes`;
  try {
    if (file.size > 2 * 1024 * 1024) throw new Error('파일 용량 초과 (FILE_TOO_LARGE)');
    const data = JSON.parse(await file.text()); if (token !== generation) return;
    if (data?.format !== 'trust404-audit-v1') throw new Error('지원하지 않는 파일 형식 (INVALID_FILE_FORMAT)');
    input = data;
    if (!profiles.some(p => p.id === data.profileId)) $('load-error').textContent = '검증 기준 미등록 (UNKNOWN_TRUST_PROFILE)';
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
  $('file').disabled = true; $('verdict').textContent = '검증 중'; $('load-error').textContent = '';
  const started = performance.now();
  try {
    const response = await fetch('/api/audit-file', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input), signal: AbortSignal.timeout(120000) });
    const result = await response.json(); if (token !== generation) return;
    if (!response.ok) throw new Error(result.error ?? `HTTP_${response.status}`);
    const missing = result.requests.filter(r => ['MISSING_AS_OF_H', 'REGISTERED_LATE'].includes(r.timing));
    const unavailable = result.issues.some(i => ['DATA_UNAVAILABLE', 'RPC_UNAVAILABLE', 'STATE_UNAVAILABLE'].includes(i.code));
    $('verdict').textContent = result.ok ? ko('VERIFIED') : unavailable ? ko('INCONCLUSIVE') : ko('FINDING');
    $('verdict').className = result.ok ? 'pass' : unavailable ? 'unknown' : 'warn';
    $('count-requests').textContent = result.requests.length; $('count-batches').textContent = result.batchCount;
    $('count-issues').textContent = result.issues.length + missing.length;
    $('coverage').textContent = ko(result.complete ? 'COMPLETE' : 'INCOMPLETE');
    $('finality').textContent = ko(result.finality); $('raw').textContent = JSON.stringify(result, null, 2);
    for (const request of result.requests) {
      row($('requests'), [request.requestId, ko(request.timing), request.decisions.map(d => d.error ? ko('NOT_VERIFIED') : `${ko(d.record)} / ${ko(d.policy)}`).join(' · ') || '—', request.decisions.map(d => d.error ? ko(d.error) : `${ko(d.outcome)} / ${ko(d.reason)}`).join(' · ') || (result.complete ? '판정 없음' : ko('UNKNOWN'))]);
    }
    for (const issue of [...result.issues, ...missing.map(r => ({ code: r.timing, requestId: r.requestId }))]) {
      const li = document.createElement('li'); li.textContent = `${ko(issue.code)} / ${issue.requestId ?? `배치 ${issue.batchId ?? '—'}`}`; $('issues').append(li);
    }
    for (const pair of [['검증 기준 / 정책 해시', result.profileId], ['체인 ID', result.chainId], ['기록 계약', result.anchorAddress], ['감사 기준 블록', result.asOf.blockNumber], ['감사 기준 블록 해시', result.asOf.blockHash]]) row($('references'), pair, true);
  } catch (error) { $('verdict').textContent = ko('ERROR'); $('verdict').className = 'fail'; $('load-error').textContent = error.message; }
  finally { busy = false; $('duration').textContent = `${Math.round(performance.now() - started)} ms`; $('file').disabled = false; ready(); }
});
fetch('/api/profiles').then(async response => {
  if (!response.ok) throw new Error('PROFILES_UNAVAILABLE'); profiles = await response.json();
  $('file').disabled = false;
  for (const [id, name] of Object.entries({ rejection: '정상 거절', tamper: '기록 변조', unavailable: '자료 유실', missing: '결과 미등록', wrong: '잘못된 판단' })) {
    const link = document.createElement('a'); link.href = `/api/sample/${id}`; link.textContent = name; link.download = `audit-${id}.json`; link.style.color = '#b49aff'; link.style.marginRight = '18px'; $('samples').append(link);
  }
  ready();
}).catch(error => { $('load-error').textContent = error.message; });
