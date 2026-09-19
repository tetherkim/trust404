const $ = id => document.getElementById(id);
let selected, controller, generation = 0;
const caseCopy = {
  rejection: ['정상 거절', '당시 기준으로 판단 확인', '현재 잔액이 늘었어도, 접수 당시의 거절 사유를 다시 확인합니다.'],
  tamper: ['기록 변조', '보관된 판단 내용 변경', '보관된 판단을 바꾼 사본과 체인에 등록된 기록을 비교합니다.'],
  unavailable: ['자료 유실', '등록된 기록의 내용 유실', '체인에는 등록됐지만 내용을 가져올 수 없는 경우를 확인합니다.'],
  missing: ['결과 미등록', '기한까지 판단 등록 없음', '요청 후 90초가 지난 기준 블록까지 판단이 등록됐는지 확인합니다.'],
  wrong: ['잘못된 판단', '서명된 승인 판단 재계산', '기관이 승인으로 서명한 기록을 당시 잔액과 규칙으로 다시 계산합니다.'],
};
const format = value => value == null ? '—' : String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
function setResult(status, title, detail, kind = '', checks = []) {
  $('result').className = `result ${kind}`;
  $('result-status').textContent = status; $('result-title').textContent = title; $('result-detail').textContent = detail;
  $('checks').replaceChildren();
  for (const [label, value] of checks) {
    const row = document.createElement('li'), name = document.createElement('span'), result = document.createElement('strong');
    row.className = 'check'; name.textContent = label; result.textContent = value; row.append(name, result); $('checks').append(row);
  }
}
function choose(scenario, index, count) {
  controller?.abort(); generation++; selected = scenario;
  $('run').disabled = false; $('run').textContent = '이 사례 검증하기'; $('result').removeAttribute('aria-busy');
  const copy = caseCopy[scenario.id];
  $('title').textContent = copy?.[0] ?? scenario.title; $('description').textContent = copy?.[2] ?? scenario.description;
  $('case-index').textContent = `${String(index + 1).padStart(2, '0')} / ${String(count).padStart(2, '0')}`;
  for (const button of $('scenarios').children) button.setAttribute('aria-pressed', String(button.dataset.id === scenario.id));
  for (const [id, value] of [['amount', scenario.amount], ['minimum', scenario.minimumBalance], ['historical', scenario.receiptBalance], ['current', scenario.currentBalance]]) $(id).textContent = format(value);
  // Display values explain the example; the audit response supplies the verdict.
  const integers = [scenario.receiptBalance, scenario.amount, scenario.minimumBalance].every(value => /^\d+$/.test(value));
  if (integers) {
    const after = BigInt(scenario.receiptBalance) - BigInt(scenario.amount);
    $('equation').textContent = `${format(scenario.receiptBalance)} − ${format(scenario.amount)} = ${format(after)} 토큰 · 출금 후 잔액이 최소 ${format(scenario.minimumBalance)} 토큰${after < BigInt(scenario.minimumBalance) ? '보다 적습니다.' : ' 이상입니다.'}`;
  } else $('equation').textContent = '출금 후 잔액을 최소 잔액과 비교합니다.';
  $('records').replaceChildren();
  for (const [label, value] of [['요청 ID', scenario.requestId], ['기록 계약', scenario.anchorAddress], ['요청 등록 거래', scenario.requestTransaction], ['결과 등록 거래', scenario.decisionTransaction ?? '등록 없음'], ['검증 범위의 마지막 블록', scenario.asOf.blockNumber], ['해당 블록 해시', scenario.asOf.blockHash]]) {
    const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = label; dd.textContent = value; $('records').append(dt, dd);
  }
  $('raw').textContent = '아직 실행하지 않았습니다.';
  setResult('실행 전', '검증을 기다리고 있습니다', '버튼을 누르면 등록 기록과 보관 자료를 읽고 당시 판단을 확인합니다.');
}
function showAudit(result, scenario) {
  const issues = result.issues ?? [], requests = result.requests ?? [];
  const request = requests.find(item => item.requestId === scenario.requestId);
  const has = code => issues.some(issue => issue.code === code);
  const scope = ['검증 범위', `블록 ${result.asOf?.blockNumber ?? '—'}까지`];
  if (has('TAMPERED_EXPORT')) {
    setResult('이상 탐지', '보관된 기록이 바뀌었습니다', '보관 자료를 다시 계산한 해시가 체인에 등록된 값과 다릅니다. 이 자료로 판단의 옳고 그름을 확인할 수 없습니다.', 'detected', [['기록 대조', '등록된 해시와 불일치'], ['판단 재계산', '변조된 자료로 확인 불가'], scope]);
  } else if (has('DATA_UNAVAILABLE')) {
    setResult('확인 불가', '검증에 필요한 자료가 없습니다', '체인의 등록 기록에 대응하는 자료를 가져오지 못했습니다. 결과가 미등록됐다고 단정하지 않습니다.', 'unknown', [['보관 자료', '일부 자료를 가져올 수 없음'], ['결과 미등록 여부', '확인 불가'], scope]);
  } else if (has('POLICY_MISMATCH')) {
    setResult('이상 탐지', '등록된 판단이 규칙과 다릅니다', '당시 상태로 다시 계산한 판단과 기관이 남긴 판단이 일치하지 않습니다. 기록이 남아 있다는 사실만으로 판단이 옳아지지는 않습니다.', 'detected', [['판단 재계산', '등록된 판단과 불일치'], ['검증 코드', 'POLICY_MISMATCH'], scope]);
  } else if (request?.timing === 'MISSING_AS_OF_H') {
    setResult('이상 탐지', '기한까지 결과가 등록되지 않았습니다', '요청은 등록됐지만, 90초 기한이 지난 검증 기준 블록까지 대응하는 판단이 없습니다.', 'detected', [['자료 확인', result.complete ? '등록된 자료 전체 확인' : '일부 확인 불가'], ['판단 등록', '기한 경과 · 결과 없음'], scope]);
  } else if (result.ok && request?.decisions?.some(decision => decision.record === 'VALID' && decision.policy === 'MATCH' && decision.outcome === 'REJECTED')) {
    setResult('검증 완료', '당시의 거절은 올바른 판단입니다', `이후 잔액은 ${format(scenario.currentBalance)} 토큰으로 바뀌었지만, 접수 당시의 ${format(scenario.receiptBalance)} 토큰을 기준으로 다시 검증해 같은 거절 사유를 확인했습니다.`, 'good', [['기록과 서명', '검증 통과'], ['당시 상태와 규칙', '거절 판단 일치'], ['판단 등록 시점', request.timing === 'REGISTERED_ON_TIME' ? '기한 내 등록' : request.timing], scope]);
  } else {
    setResult('추가 확인 필요', '검증 결과를 확인해 주세요', '선택한 사례의 검증을 확정할 수 없습니다. 아래 원본 결과에서 상세 내용을 확인할 수 있습니다.', 'unknown', [['자료 확인', result.complete ? '전체 확인' : '일부 확인 불가'], ['검증 코드', issues.map(issue => issue.code).join(', ') || request?.timing || '예상하지 못한 응답'], scope]);
  }
}
$('run').addEventListener('click', async () => {
  if (!selected) return;
  controller?.abort(); controller = new AbortController();
  const signal = controller.signal, token = ++generation, scenario = selected;
  $('run').disabled = true; $('run').textContent = '검증 중…'; $('result').setAttribute('aria-busy', 'true'); $('raw').textContent = '검증 중입니다.';
  setResult('실행 중', '기록과 당시 상태를 확인하고 있습니다', '체인에 등록된 기록과 보관 자료를 다시 읽습니다.');
  try {
    const response = await fetch(`/api/audit/${encodeURIComponent(scenario.id)}`, { signal });
    const result = await response.json();
    if (token !== generation) return;
    $('raw').textContent = JSON.stringify(result, null, 2);
    if (!response.ok) throw new Error(result.error ?? 'AUDIT_FAILED');
    showAudit(result, scenario);
  } catch (error) {
    if (token !== generation || error.name === 'AbortError') return;
    setResult('연결 오류', '검증을 완료하지 못했습니다', '로컬 서버와 체인 실행 상태를 확인하고 다시 실행하세요. 이 오류는 기록의 변조를 뜻하지 않습니다.', 'error');
  } finally {
    if (token === generation) { $('run').disabled = false; $('run').textContent = '다시 검증하기'; $('result').removeAttribute('aria-busy'); }
  }
});
fetch('/api/status').then(async response => {
  if (!response.ok) throw new Error('STATUS_FAILED');
  const status = await response.json();
  if (!status.scenarios?.length) throw new Error('NO_SCENARIOS');
  $('environment').textContent = status.environment === 'local-anvil' ? '로컬 테스트 체인' : `${status.environment} · ${status.chainId}`;
  $('aomi').textContent = status.aomiConnected ? 'Aomi 연결됨' : 'Aomi 연결 전';
  status.scenarios.forEach((scenario, index) => {
    const copy = caseCopy[scenario.id], button = document.createElement('button'), number = document.createElement('span'), text = document.createElement('span'), name = document.createElement('strong'), detail = document.createElement('small');
    button.className = 'scenario'; button.dataset.id = scenario.id; button.setAttribute('aria-pressed', 'false');
    number.className = 'number'; number.textContent = String(index + 1).padStart(2, '0'); name.textContent = copy?.[0] ?? scenario.title; detail.textContent = copy?.[1] ?? '';
    text.append(name, detail); button.append(number, text); button.addEventListener('click', () => choose(scenario, index, status.scenarios.length)); $('scenarios').append(button);
  });
  choose(status.scenarios[0], 0, status.scenarios.length);
}).catch(() => {
  $('environment').textContent = '연결 확인 필요'; $('aomi').textContent = 'Aomi 상태 미확인';
  $('load-error').textContent = '시연 서버에 연결하지 못했습니다. 서버가 실행 중인지 확인한 뒤 페이지를 새로고침하세요.';
  $('title').textContent = '사례를 불러오지 못했습니다'; $('description').textContent = '서버 연결이 필요합니다.';
  setResult('연결 오류', '검증을 시작할 수 없습니다', '로컬 시연 서버의 실행 상태를 확인하세요.', 'error');
});
