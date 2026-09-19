const $ = id => document.getElementById(id);
let selected;
const explanations = {
  TAMPERED_EXPORT: ['기록 변조 탐지', '제공된 기록을 다시 해시한 값이 계약에 등록된 값과 다릅니다.'],
  DATA_UNAVAILABLE: ['검증 자료 유실', '계약에는 기록이 있지만 내용을 가져올 수 없습니다. 결과 미등록 여부를 단정하지 않습니다.'],
  POLICY_MISMATCH: ['잘못된 판단 탐지', '서명과 기록 등록은 확인됐지만, 당시 잔액으로 계산하면 승인할 수 없습니다.'],
};
function message(title, detail, kind = '') {
  $('result').className = kind; $('result').replaceChildren();
  const heading = document.createElement('strong'), text = document.createElement('p');
  heading.textContent = title; text.textContent = detail; $('result').append(heading, text);
}
function choose(scenario) {
  selected = scenario; $('title').textContent = scenario.title; $('description').textContent = scenario.description;
  for (const button of $('scenarios').children) button.setAttribute('aria-pressed', String(button.dataset.id === scenario.id));
  $('records').replaceChildren();
  for (const [label, value] of [['요청 ID', scenario.requestId], ['기록 계약', scenario.anchorAddress], ['요청 등록 거래', scenario.requestTransaction],
    ['결과 등록 거래', scenario.decisionTransaction ?? '등록 없음'], ['검증 기준 블록', scenario.asOf.blockNumber], ['블록 해시', scenario.asOf.blockHash]]) {
    const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = label; dd.textContent = value; $('records').append(dt, dd);
  }
  $('raw').textContent = '아직 실행하지 않았습니다.'; message('검증 준비', '버튼을 누르면 체인과 보관 파일을 다시 읽습니다.'); $('run').disabled = false;
}
$('run').addEventListener('click', async () => {
  const id = selected.id; $('run').disabled = true; message('검증 중', '등록 기록과 과거 잔액을 확인하고 있습니다.');
  try {
    const response = await fetch(`/api/audit/${id}`), result = await response.json();
    if (selected.id !== id) return;
    $('raw').textContent = JSON.stringify(result, null, 2);
    if (!response.ok) throw Error(result.error);
    const issue = result.issues.find(i => explanations[i.code]);
    if (issue) message(...explanations[issue.code], 'detected');
    else if (result.requests.some(r => r.timing === 'MISSING_AS_OF_H')) message('결과 미등록 탐지', '요청은 등록됐지만, 90초 기한이 지난 검증 기준 블록까지 결과가 등록되지 않았습니다.', 'detected');
    else if (result.ok) message('거절 사유 확인 완료', '현재 잔액은 200이지만, 접수 당시 잔액 120으로 다시 계산한 결과 거절이 맞습니다.', 'good');
    else message('추가 확인 필요', '아래의 검증 결과를 확인하세요.', 'error');
  } catch { if (selected.id === id) message('검증을 완료하지 못했습니다', '로컬 체인과 서버의 실행 상태를 확인하세요.', 'error'); }
  finally { if (selected.id === id) $('run').disabled = false; }
});
fetch('/api/status').then(async response => {
  if (!response.ok) throw Error(); const status = await response.json();
  for (const scenario of status.scenarios) {
    const button = document.createElement('button'); button.textContent = scenario.title; button.dataset.id = scenario.id;
    button.addEventListener('click', () => choose(scenario)); $('scenarios').append(button);
  }
  choose(status.scenarios[0]);
}).catch(() => message('서버에 연결하지 못했습니다', '로컬 시연 서버를 먼저 실행하세요.', 'error'));
