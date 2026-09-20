# 테스트넷 자동 운영 선택지

확인일: 2026-09-20. 조사 결과이며 자동 서명 권한은 아직 부여하지 않았다.

## 현재 확인한 상태

- 구현 커밋 `5c748b4`가 원격 브랜치에 있다. `.agent/`는 다른 IDE 파일이므로 제외한다.
- Base Sepolia RecordAnchor: `0xe4a4ecdb110c4135e0093caf255d50f3412c7f72`.
- 계약의 `publisher`는 immutable이며 `anchorBatch`는 해당 주소만 호출할 수 있다.
- 현재 요청/판단 등록은 MetaMask 서명으로 수행한다. Aomi의 이 계약 읽기는 확인했지만 Aomi 자동 서명/전송은 확인하지 않았다.
- `src/demo/testnet.js`는 고정된 요청 하나와 배치 두 개의 시연이다. 여러 요청을 처리하는 상시 운영 서비스가 아니다.
- 요청자/기관 기록 서명은 시연용 Ed25519 키이며, MetaMask의 온체인 등록 서명과 별개다. 실제 요청자가 직접 서명했다는 운영 수준의 신원 보장은 아직 없다.

## 가능한 두 경로

### 1. 전용 테스트넷 운영 지갑 + 결정론적 worker (우선 추천)

개인 MetaMask와 별도인 운영 지갑을 만들고 해당 주소를 publisher로 지정해 새 RecordAnchor를 배포한다. 개인 지갑의 키를 내보내서 서버에 넣지 않는다. 서버 worker가 요청 기록 및 판단 기록의 해시를 등록한다. 키는 저장소와 분리한 signer/secret storage에서 사용한다. 메모리에서 서명한 거래를 RPC로 전송할 수 있다. viem의 local account 및 Wallet Client를 사용할 수 있다.

Aomi를 사용한다면 worker가 이미 결정한 calldata를 Pipeline의 stage → simulate → commit 경로에 전달한다. 현재 설치 CLI 0.7.6의 `pipeline evm commit --help`는 private-key, rpc-url, idempotency-key 옵션을 제공한다. 다만 플래그 존재는 실제 서명 성공의 증거가 아니다. 키를 명령행 인자로 노출하는 방식은 운영 구성에서 피하고 SDK나 전용 signer adapter를 검토한다.

직접 RPC 전송과 Aomi 경유는 다른 실행 경로로 표시해야 한다. Aomi 장애 때 자동으로 직접 전송하는 우회는 두지 않는다. Aomi 경유 시 signer는 반환된 발신자, chain ID, to, calldata, value를 원래 준비한 거래와 대조한 후 서명한다. 예기치 않은 수수료 전송이나 signer 교체는 거부한다.

### 2. Aomi Privy/Para 위임 지갑 + 제한된 App

공식 문서상 Privy는 provider delegation 후 해당 지갑의 Bypass permissions를 선택하고, Para는 별도로 provision한 agent wallet을 사용한다. 자동 실행에는 권한 정책과 실제 signing capability가 모두 필요하다. 계정 인증 또는 pipeline:execute OAuth scope만으로 지갑 서명 권한이 생기지 않는다.

MetaMask 연결만으로 백그라운드 서버가 서명할 수는 없다. client_auto는 서명 가능한 클라이언트가 필요하다. unattended auto는 적격 provider grant가 필요하다. 해당 지갑 주소가 현재 publisher와 다르면 새 계약이 필요하다. EIP-7702 등으로 같은 주소를 유지하는 별도 설계는 이번 범위에서 검증하지 않았으며 추천 경로에 포함하지 않는다.

배포 전 검증할 항목: 현재 계정의 적격 지갑, Base Sepolia 자동 실행 지원, 호출 경로의 guard 적용, 가스/서비스 비용, 브라우저를 닫은 상태에서 서명 가능 여부, 위임 철회 후 실행 차단. 문서상 가능성과 이 계정에서 실제 가능한지는 구분한다.

## 프로토콜처럼 동작하는 구현

1. 인증된 요청 API가 요청자 서명을 검증하고 requestId 중복을 제거한다.
2. DB transaction으로 요청과 outbox를 함께 기록한다. 이 시점부터 영속적인 접수 상태를 반환한다.
3. 단일 publisher worker가 요청 batch를 고정하고 시뮬레이션 후 전송한다. batch ID와 wallet nonce를 별도로 관리한다.
4. receipt와 canonical block hash를 확인한 뒤 그 블록 종료 상태를 읽어 결정론적 정책을 평가한다. LLM은 승인/거절 판단 기준으로 사용하지 않는다.
5. 기관 signer가 판단 기록에 서명한다. worker는 판단 batch를 우선 등록해 90초 기한을 지킨다.
6. tx hash와 원문을 영속 저장한다. 재시작 시 receipt 및 온체인 root를 확인한 뒤 이어간다. 타임아웃만으로 새 batch를 만들지 않는다.
7. 감사 파일과 공개 자료 저장소를 갱신한다. 감사자는 독립 RPC 및 별도로 신뢰한 키/정책으로 검증한다. 파일이 자기 검증 기준을 정하지 않는다.
8. 최초 포함 시 provisional로 표시하고 finality 확인 뒤 finalized로 승격한다. reorg 시 판단의 근거 블록 및 등록 상태를 재검사한다. 최종 확정을 기다리다가 90초를 넘기는 설계는 피한다.

서명 범위: Base Sepolia(84532), 지정 RecordAnchor, anchorBatch(uint256,bytes32,uint256), value=0, batch count 1..32. 가스 상한과 일일 운영 예산은 별도 적용한다. value=0은 가스 비용이 없다는 뜻이 아니다. 계약은 root의 정당성을 검사하지 않으므로 outbox 내용 검증과 독립 감사는 계속 필요하다.

## 완료 판정

- 사람이 MetaMask를 열지 않아도 서로 다른 요청 세 건이 기록 등록부터 감사까지 완료된다.
- worker 재시작, RPC timeout, 거래 재전송 상황에서 중복 배치가 생기지 않는다.
- 잘못된 chain/contract/selector/value는 서명 전에 거부한다.
- 정상, 변조, 자료 유실, 기한 내 결과 미등록을 구별한다. 자료 유실 탐지만으로 모든 요청의 완전성을 주장하지 않는다.
- 위임 철회 또는 signer 중단 이후 새 거래는 전송되지 않는다.
- README는 현재 수동 E2E와 자동 운영 E2E를 분리하고 실제 확인한 명령·환경만 기재한다.

## 근거

- https://aomi.dev/docs/security/permission-model — policy, capability, constraints의 분리.
- https://aomi.dev/docs/security/configure-approvals — Privy/Para 위임과 자동 실행 설정.
- https://aomi.dev/docs/security/signing — 연결 클라이언트 및 unattended 실행의 구분.
- https://aomi.dev/docs/integrate/pipeline — stateless Build, simulate, commit, pending wallet action.
- https://aomi.dev/docs/reference/client-cli/transactions-and-signing — 로컬 EOA 서명, 별도 AA 경로 및 CLI 주의점.
- https://aomi.dev/docs/llms-full.txt — 위 공식 문서 본문을 직접 내려받아 확인.
- 로컬 소스: contracts/RecordAnchor.sol, src/v3/store.js, src/demo/testnet.js.

다음 구현은 경로 1의 worker와 signer adapter를 먼저 만들고, Aomi hosted signing은 경로 2의 실환경 검증을 통과한 뒤 adapter로 추가하는 것을 추천한다. 지금은 계정 권한 변경, 지갑 생성 또는 신규 배포를 수행하지 않았다.
