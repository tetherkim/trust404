const $ = id => document.getElementById(id);
let deployment, connectedWallet, metamask;
const isMetaMask = provider => provider?.isMetaMask && !provider?.isPhantom;
const rememberMetaMask = provider => {
  if (!metamask && isMetaMask(provider)) {
    metamask = provider;
    provider.on?.('accountsChanged', accounts => { connectedWallet = accounts?.[0]; updateDeployment(); });
    provider.on?.('chainChanged', updateDeployment);
    provider.request({ method: 'eth_accounts' }).then(accounts => { connectedWallet = accounts?.[0]; updateDeployment(); }).catch(() => {});
    updateDeployment();
  }
};
window.addEventListener('eip6963:announceProvider', event => {
  if (event.detail?.info?.rdns === 'io.metamask' || isMetaMask(event.detail?.provider)) rememberMetaMask(event.detail.provider);
});
window.dispatchEvent(new Event('eip6963:requestProvider'));
for (const provider of window.ethereum?.providers ?? []) rememberMetaMask(provider);
rememberMetaMask(window.ethereum);
const walletProvider = () => metamask;
const waitForReceipt = async (provider, transactionHash) => {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const receipt = await provider.request({ method: 'eth_getTransactionReceipt', params: [transactionHash] });
    if (receipt) return receipt;
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  return null;
};
function updateDeployment() {
  if (!deployment?.transaction) return;
  $('deploy-network').textContent = `${deployment.chainName} / 체인 ${deployment.chainId}`;
  $('deploy-publisher').textContent = deployment.publisher;
  $('deploy-simulation').textContent = '서명 요청 시 네트워크·계정·가스 확인';
  const provider = walletProvider();
  $('connect-wallet').disabled = !provider;
  $('deploy-contract').disabled = !connectedWallet || connectedWallet.toLowerCase() !== deployment.publisher;
  if (!provider) $('deploy-state').textContent = '이 브라우저에서 MetaMask 확장 프로그램을 찾지 못했습니다.';
  else if (!connectedWallet) $('deploy-state').textContent = 'MetaMask에서 배포 권한자 계정을 연결해 주세요.';
  else if (connectedWallet.toLowerCase() !== deployment.publisher) $('deploy-state').textContent = `연결 주소 불일치: ${connectedWallet}`;
  else $('deploy-state').textContent = `서명 준비 완료 · ${connectedWallet}`;
}
async function requireBaseSepolia(provider) {
  const chainId = await provider.request({ method: 'eth_chainId' });
  if (BigInt(chainId) === 84532n) return;
  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x14a34' }] });
  } catch (error) {
    if (error.code !== 4902) throw error;
    await provider.request({ method: 'wallet_addEthereumChain', params: [{
      chainId: '0x14a34', chainName: 'Base Sepolia',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: ['https://sepolia.base.org'], blockExplorerUrls: ['https://sepolia.basescan.org'],
    }] });
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x14a34' }] });
  }
}
$('connect-wallet').addEventListener('click', async () => {
  try {
    const provider = walletProvider();
    if (!provider) throw new Error('MetaMask 확장 프로그램이 없습니다.');
    const accounts = await provider.request({ method: 'eth_requestAccounts' });
    connectedWallet = accounts?.[0]; await requireBaseSepolia(provider); updateDeployment();
  } catch (error) { $('deploy-state').textContent = `지갑 연결 실패: ${error.message}`; }
});
$('deploy-contract').addEventListener('click', async () => {
  try {
    const provider = walletProvider(); await requireBaseSepolia(provider);
    const accounts = await provider.request({ method: 'eth_accounts' });
    if (accounts?.[0]?.toLowerCase() !== deployment.publisher) throw new Error('배포 권한자 계정을 선택해 주세요.');
    await provider.request({ method: 'eth_estimateGas', params: [deployment.transaction] });
    $('deploy-contract').disabled = true; $('deploy-state').textContent = '지갑에서 배포 거래를 확인하고 서명해 주세요.';
    const transactionHash = await provider.request({ method: 'eth_sendTransaction', params: [deployment.transaction] });
    $('deploy-state').textContent = `전송됨 · 체인 포함 대기 중 · ${transactionHash}`;
    const receipt = await waitForReceipt(provider, transactionHash);
    if (!receipt) $('deploy-state').textContent = `전송됨 · 확인 시간 초과 · 거래 ${transactionHash}`;
    else if (receipt.status !== '0x1') $('deploy-state').textContent = `배포 실패 · 거래 ${transactionHash}`;
    else $('deploy-state').textContent = `배포 완료 · 계약 ${receipt.contractAddress}`;
  } catch (error) { $('deploy-state').textContent = error.code === 4001 ? '사용자가 서명을 취소했습니다.' : `배포 요청 실패: ${error.message}`; $('deploy-contract').disabled = false; }
});
fetch('/api/deployment').then(async response => {
  if (!response.ok) throw new Error('배포 정보를 가져오지 못했습니다.');
  deployment = await response.json();
  if (!deployment.transaction) throw new Error('배포 권한자 주소가 설정되지 않았습니다.');
  updateDeployment();
}).catch(error => { $('deploy-network').textContent = '사용 불가'; $('deploy-state').textContent = error.message; });
