const $=id=>document.getElementById(id);
const states={queued:'대기',running:'Aomi 처리 중',done:'기록 저장 완료',failed:'처리 중단 · 재개 필요'};
const labels={REJECTED:'거절',APPROVED:'승인',REGISTERED_ON_TIME:'기한 내 등록',REGISTERED_LATE:'지연 등록',RESERVE_FLOOR:'준비금 부족',LIMIT_EXCEEDED:'한도 초과'};
const errors={LOGIN_REQUIRED:'접속 코드를 입력해 주세요.',ACCESS_DENIED:'접속 코드가 맞지 않습니다.',QUEUE_FULL:'대기열이 가득 찼습니다.',DAILY_REQUEST_LIMIT:'하루 요청 한도에 도달했습니다.',OPERATOR_NOT_READY:'운영자 초기 설정이 필요합니다.',RETRY_LIMIT_REACHED:'재시도 한도입니다. 운영자가 기록을 확인해야 합니다.',LOGIN_RATE_LIMIT:'잠시 후 다시 접속해 주세요.'};
let pendingId=null,pendingAmount=null,refreshTimer,submitting=false;
try{const saved=JSON.parse(sessionStorage.getItem('trust404-pending')??'null');pendingId=saved?.id;pendingAmount=saved?.amount;}catch{}
async function api(path,body){const r=await fetch(path,body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});const data=await r.json();if(r.status===401){$('login-panel').hidden=false;$('workspace').hidden=true;clearTimeout(refreshTimer);}if(!r.ok)throw Error(errors[data.error]??data.error??'서버 응답 오류');return data;}
function amountAtomic(text){if(!/^\d{1,5}(\.\d{1,6})?$/.test(text))throw Error('금액을 소수점 6자리 이내로 입력해 주세요.');const [whole,part='']=text.split('.');const value=BigInt(whole)*1000000n+BigInt(part.padEnd(6,'0'));if(value<=0n||value>10000000000n)throw Error('0 초과 10,000 USDC 이하로 입력해 주세요.');return value.toString();}
function auditSummary(result){
 if(!result)return '미검증';
 const decisions=result.requestAudit?.decisions??[];
 const individual=decisions.length===1&&decisions[0].record==='VALID'&&decisions[0].policy==='MATCH'?'개별 서명·정책 일치':'개별 검증 확인 필요';
 const overall=result.auditOk===true?'전체 감사 통과':result.auditOk===false?'전체 감사 이상 있음':'전체 감사 미확인';
 const finality=result.finality==='FINALIZED'?'체인 확정':result.finality==='PROVISIONAL'?'체인 확정 대기':'체인 확정 미확인';
 return `${individual} / ${overall} / ${finality}`;
}
async function refresh(){
 try{const data=await api('/api/status');$('login-panel').hidden=true;$('workspace').hidden=false;$('submit').disabled=!data.ready||data.paused||submitting;
 $('server-state').textContent=!data.ready?'운영자 초기 설정 대기':data.paused?'실패 기록 확인 필요 · 대기열 일시 중지':'요청 접수 가능 · 순차 처리';
 $('jobs').replaceChildren();for(const job of data.jobs){const tr=document.createElement('tr');const decision=job.result?.requestAudit?.decisions?.[0];for(const text of [job.id,`${Number(job.amount)/1000000} USDC`,states[job.state],decision?.error?`검증 오류: ${decision.error}`:decision?`${labels[decision.outcome]??decision.outcome} / ${labels[decision.reason]??decision.reason} / ${labels[job.result.requestAudit.timing]??job.result.requestAudit.timing}`:'—',auditSummary(job.result)]){const td=document.createElement('td');td.textContent=text;tr.append(td);}
 const cell=document.createElement('td');if(job.state==='done'){for(const [name,label] of [['audit.json','감사 파일'],['execution.json','Aomi 이력'],['trust.json','신뢰 기준'],['profiles.json','서버 설정']]){const a=document.createElement('a');a.href=`/api/jobs/${job.id}/files/${name}`;a.download=name;a.textContent=label;cell.append(a);}}
 if(job.state==='failed'){const b=document.createElement('button');b.disabled=job.attempts>=3;b.textContent=b.disabled?'재시도 한도 · 운영자 확인':'같은 요청 재개';b.addEventListener('click',async()=>{b.disabled=true;try{await api(`/api/jobs/${job.id}/retry`,{});await refresh();}catch(e){$('error').textContent=e.message;b.disabled=false;}});cell.append(b);}tr.append(cell);$('jobs').append(tr);}
 }catch(e){$('error').textContent=e.message;}finally{clearTimeout(refreshTimer);if(!$('workspace').hidden)refreshTimer=setTimeout(refresh,4000);}
}
$('login-form').addEventListener('submit',async e=>{e.preventDefault();$('login-button').disabled=true;$('error').textContent='';try{await api('/api/login',{code:$('access-code').value});$('access-code').value='';await refresh();}catch(error){$('error').textContent=error.message;}finally{$('login-button').disabled=false;}});
$('request-form').addEventListener('submit',async e=>{e.preventDefault();if(submitting)return;submitting=true;$('submit').disabled=true;$('error').textContent='';try{const amount=amountAtomic($('amount').value.trim());if(pendingAmount!==amount){pendingId=crypto.randomUUID();pendingAmount=amount;sessionStorage.setItem('trust404-pending',JSON.stringify({id:pendingId,amount}));}await api('/api/requests',{id:pendingId,amount});pendingId=null;pendingAmount=null;sessionStorage.removeItem('trust404-pending');}catch(error){$('error').textContent=error.message;}finally{submitting=false;await refresh();}});
refresh();
