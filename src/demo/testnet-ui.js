const $=id=>document.getElementById(id);
let provider, step, busy=false;
window.addEventListener('eip6963:announceProvider', event=>{if(event.detail?.info?.rdns==='io.metamask') provider=event.detail.provider;});
window.dispatchEvent(new Event('eip6963:requestProvider'));
async function prepare(){
  $('sign').disabled=true;
  const response=await fetch('/prepare',{method:'POST'}); step=await response.json();
  if(!response.ok) throw Error(step.error);
  $('status').textContent=JSON.stringify(step,null,2);
  $('downloads').hidden=step.stage!=='COMPLETE';
  $('sign').disabled=!step.transaction;
}
$('prepare').onclick=async()=>{if(busy)return;try{await prepare();}catch(e){$('status').textContent=e.message;}};
$('sign').onclick=async()=>{
  if(busy||!step?.transaction)return;
  busy=true;$('sign').disabled=true;$('prepare').disabled=true;
  try{
    if(!provider)throw Error('MetaMask를 찾지 못했습니다.');
    const accounts=await provider.request({method:'eth_requestAccounts'});
    if(accounts[0]?.toLowerCase()!==step.publisher)throw Error('기록 등록 권한자 계정을 선택해 주세요.');
    await provider.request({method:'wallet_switchEthereumChain',params:[{chainId:'0x14a34'}]});
    const tx={to:step.transaction.to,data:step.transaction.data,from:accounts[0],value:'0x0',chainId:'0x14a34'};
    await provider.request({method:'eth_estimateGas',params:[tx]});
    $('status').textContent='MetaMask에서 기록 등록 거래를 확인하고 서명해 주세요.';
    const hash=await provider.request({method:'eth_sendTransaction',params:[tx]});
    $('status').textContent=`전송됨 · ${hash}`;
    let receipt;
    for(let i=0;i<90;i++){
      receipt=await provider.request({method:'eth_getTransactionReceipt',params:[hash]});
      if(receipt)break;
      await new Promise(resolve=>setTimeout(resolve,1000));
    }
    if(!receipt)throw Error(`확인 대기 중 · ${hash} · 다음 단계 준비로 재확인하세요.`);
    if(receipt.status!=='0x1')throw Error('거래 실패');
    await prepare();
  }catch(e){$('status').textContent=e.message;}
  finally{busy=false;$('prepare').disabled=false;}
};
