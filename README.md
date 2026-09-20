# TRUST404 — 테스트넷 자동 기록·독립 감사

요청과 거절 판단을 서명한 뒤 Merkle root를 체인에 등록하고, 감사자가 파일과 독립 RPC로 기록 및 정책 판단을 검증합니다. 검증 성공은 송금 승인이 아니라 기록과 판단의 일치를 의미합니다.

## 현재 구현과 범위

- 감사 UI: 파일 하나를 입력하면 서버에 사전 등록된 신뢰 기준을 선택해 검증합니다. 지갑은 필요 없습니다.
- 자동 운영: 전용 운영 지갑으로 요청 batch → 블록 상태 조회 → 판단 → 판단 batch → 감사 파일을 생성합니다. 반복 MetaMask 서명은 없습니다.
- SQLite와 파일 outbox, 배치별 서명 거래 journal로 재시작 및 동일 거래 재전송을 처리합니다.
- 정상·변조·자료 유실 검증은 기존 수동 지갑으로 Base Sepolia에서 확인했습니다. 새 자동 worker의 3건 처리·재시작·중복 방지는 로컬 Anvil에서 검증했습니다. 자동 지갑의 Base Sepolia 실행은 자금 충전 후 검증해야 합니다.
- 자동 worker는 직접 RPC를 사용합니다. Aomi는 기존 계약 읽기를 검증했으며 자동 서명/전송 경로는 아직 연결하지 않았습니다.
- 요청자·기관 키는 로컬 시연용입니다. 실제 고객 인증·요청자 키 소유 증명·외부 공개 저장소·운영용 KMS는 미구현입니다.

## 설치

저장소 루트에서 Node.js 22.22.2 이상, npm, Foundry의 forge/anvil이 필요합니다. 패키지 설치와 테스트넷 실행에는 네트워크 연결이 필요합니다.

```sh
npm ci
forge build
npm run test:integration
```

## 자동 운영 E2E

### 1. 전용 지갑 생성 및 충전

```sh
npm run operator -- init
```

출력된 `address`에 **Base Sepolia test ETH만** 보냅니다. 개인 지갑 키를 가져올 필요가 없습니다. 로컬 테스트용 키는 Git에서 제외되는 `.local-demo/operator/secrets.json`에 권한 0600으로 저장합니다. 이는 OS 접근 권한으로 보호한 평문 파일이며 운영용 비밀 저장소가 아닙니다. 폴더를 삭제하면 서명 키와 기록을 잃습니다.

```sh
npm run operator -- status
npm run operator -- deploy
```

`deploy`는 전용 지갑을 publisher로 새 RecordAnchor를 한 번 배포합니다. 이미 배포된 경우 주소를 반환합니다. 거래당 최대 예상 비용은 0.001 test ETH, 하루 예약 비용 한도는 0.01 test ETH입니다. 가스 부족이나 한도 초과 시 중단합니다. 계정은 이 worker만 사용하세요.

### 2. 요청 세 건 생성

금액은 USDC의 최소 단위(1 USDC = 1000000)입니다. 마지막 인자는 필수 중복 방지 키입니다. 같은 키·금액으로 재실행해도 요청은 하나이며, 같은 키에 다른 금액은 거부합니다.

```sh
npm run operator -- request 50000000 demo-1
npm run operator -- request 50000000 demo-2
npm run operator -- request 50000000 demo-3
npm run operator -- tick
```

`tick`은 한 차례 처리하고 감사 결과를 출력합니다. 테스트 USDC 잔액이 없는 운영 지갑에서는 최소 잔액 정책에 따라 거절됩니다. 실제 USDC 송금은 수행하지 않습니다.

상시 처리하려면 별도 터미널에서 실행합니다. 실행 중 다른 터미널에서 `request`로 새 요청을 넣을 수 있습니다.

```sh
npm run operator -- run
```

Ctrl+C로 정상 종료합니다. worker는 단일 실행 잠금을 사용합니다. 강제 종료 후 잠금이 남으면 `operator.lock`에 기록된 PID가 실행 중인지 확인한 뒤, 해당 프로세스가 없을 때만 잠금을 지우세요. journal은 삭제하지 마세요. RPC timeout에서는 같은 저장된 서명 거래와 hash를 재확인하며 임의의 새 nonce로 대체하지 않습니다. 장기 pending/revert/수수료 급등은 운영자 조치가 필요합니다.

### 3. 감사 UI에 연결

`.env`에 다음 설정을 넣고 감사 서버를 실행합니다.

```text
AUDIT_PROFILES_FILE=.local-demo/operator/profiles.json
```

```sh
npm run demo:local
```

http://127.0.0.1:4040 에서 `.local-demo/operator/audit.json`을 선택하고 **파일 검증**을 누릅니다. 신뢰 기준의 키/계약 주소는 업로드 파일이 아니라 서버 설정에서 가져옵니다. 다른 감사자는 공개 trust.json과 감사 파일을 전달받되 trust.json의 진위를 별도 경로로 확인해야 합니다. secrets.json과 거래 journal은 공유하지 않습니다.

`profiles.json`의 기본 `asOf: latest`는 최종 확정 전 결과를 `PROVISIONAL`로 표시합니다. 확정 이후 `asOf: finalized`로 변경하고 서버를 재시작하면 확정 블록 기준 감사를 수행합니다. 자동 finality 승격과 깊은 reorg 복구는 아직 구현하지 않았습니다.

### 4. 결과 해석

- 정상: `ok: true`, `record: VALID`, `policy: MATCH`.
- 판단 내용 변경: `TAMPERED_EXPORT`.
- 등록된 batch의 원문 제거: `DATA_UNAVAILABLE`. 판단의 옳고 그름은 확인 불가입니다.
- 판단 미등록 또는 지연: 요청 등록과 90초 기한을 비교합니다. 기관이 접수 이전부터 숨긴 요청까지 탐지한다는 보장은 아닙니다.

## 기존 MetaMask 수동 시연

기존 로컬 설정이 있는 컴퓨터에서 `node src/demo/testnet.js`로 http://127.0.0.1:4041 을 엽니다. 이 스크립트는 기존 `.local-demo/base-sepolia-deployed.json`에 의존하는 **요청 한 건 전용 시연**입니다. 새 clone의 시작점은 위 자동 운영 절차입니다.

서명 2회가 완료되면 정상·변조·누락 파일을 다운로드할 수 있습니다. 기존 계약의 publisher는 변경 불가능하므로 전용 자동 지갑이 기존 개인 지갑 계약에 기록을 추가할 수는 없습니다.

## 소스 안내

| 경로 | 역할 |
|---|---|
| `src/operator/run.js` | 전용 지갑, 영속 요청 큐, 자동 등록 worker |
| `src/v3/store.js` | SQLite 기록, 배치 고정, 판단 저장 |
| `src/v3/policy.js` | 서명 검증과 결정론적 판단 |
| `src/v3/verify.js` | 독립 감사 |
| `contracts/RecordAnchor.sol` | root 등록·등록 권한 제한 |
| `src/demo/` | 감사 UI와 수동 운영 도구 |

[Aomi 및 서명 방식 비교](docs/automation-options.md)

---

## 이전 오프라인 프로토타입 (별도 실행 경로)

아래는 `src/cli.js` 기반 초기 모델입니다. 위 v3 테스트넷 실행 경로와 파일 형식이 다릅니다.

# Trust404 — 거절에도 영수증이 필요하다

150만 원을 송금하려던 고객이 “1회 한도 100만 원 초과”로 거절당했습니다. 돈이 이동하지 않아 송금 내역은 없습니다. 기관이 나중에 거절 이유를 바꾸거나 요청 자체를 지우면, 고객은 무엇으로 사실을 입증할까요?

이 프로토타입은 **요청 접수부터 판단까지 외부 증거를 남기고, 기관 저장소 없이 그 증거를 검증**합니다. 거절 한 건의 진위를 확인하고, 지정된 감사 범위에서 기록 삭제와 미처리 요청을 찾아냅니다.

## 바로 실행

Node.js 22 이상이 필요합니다. 외부 패키지 설치와 네트워크 연결은 필요 없습니다. 저장소 루트에서 실행합니다.

```sh
npm test
node src/cli.js demo demo-output
node src/cli.js verify demo-output/customer/rejection.json demo-output/auditor/trust.json
node src/cli.js verify demo-output/customer/approval.json demo-output/auditor/trust.json
node src/cli.js audit demo-output/witness/log.json demo-output/auditor/trust.json
```

`demo-output`이 이미 있으면 덮어쓰지 않습니다. 다음 실행에는 새 경로를 주거나 `npm run demo`로 시각이 붙은 새 디렉토리를 만드세요.

정상 거절 증거의 검증 결과는 `ok: true`, `outcome: REJECTED`, `reason: LIMIT_EXCEEDED`입니다. **검증 성공은 송금 승인을 뜻하지 않습니다.** 판단이 기록·서명·규칙과 일치한다는 뜻입니다.

## 3분 시연

1. `demo`로 150만 원 거절과 50만 원 승인을 생성합니다. 정상 검증과 다섯 가지 공격 검사를 자동으로 실행합니다.
2. `verify`를 별도 프로세스에서 실행합니다. 고객 증거와 감사자 신뢰 파일만 읽으며 기관 저장 파일을 읽지 않습니다. 이 두 파일을 다른 컴퓨터로 옮겨도 검증할 수 있습니다.
3. `demo-output/institution` 폴더를 다른 위치로 옮긴 뒤 같은 검증을 반복합니다. 기관 기록이 없어도 거절 사실은 남습니다. 자동 테스트에서는 실제로 해당 임시 폴더를 삭제하고 검증합니다.
4. 아래 공격 파일들을 검증해 탐지 결과를 보여줍니다.

```sh
# 사후 거절 사유 변경: INVALID_INCLUSION_PROOF, 종료 코드 1
node src/cli.js verify demo-output/attacks/tampered.json demo-output/auditor/trust.json

# 전체 제출 목록에서 거절 한 건 삭제: LOG_SIZE_MISMATCH, 종료 코드 1
node src/cli.js audit demo-output/attacks/deleted-log.json demo-output/auditor/trust.json

# 접수 후 판단을 처음부터 남기지 않음: overdue에 unanswered 표시, 종료 코드 1
node src/cli.js audit demo-output/attacks/missing-log.json demo-output/attacks/missing-trust.json

# 기관이 허위 승인에 실제로 서명했어도: POLICY_MISMATCH, 종료 코드 1
node src/cli.js verify demo-output/attacks/wrong-policy-result.json demo-output/attacks/wrong-policy-trust.json
```

`missing-*`와 `wrong-policy-*`는 별도 키와 로그를 사용하는 독립 공격 사례입니다. 공격 파일이 자신의 신뢰 기준을 정하는 실제 운영 흐름이 아닙니다. 감사자는 각 시연 환경의 신뢰 파일을 사전에 전달받았다고 가정합니다.

## 증거가 만들어지는 과정

```mermaid
sequenceDiagram
    participant C as 고객
    participant W as 외부 기록 주체
    participant I as 기관
    participant A as 감사자
    C->>W: 서명한 송금 요청
    W-->>C: 접수 증거와 판단 기한
    W->>I: 접수된 요청
    I->>I: 공개된 한도 규칙 실행
    I->>W: 요청과 규칙에 연결된 서명 판단
    W-->>C: 요청·판단의 포함 증거
    W-->>A: 별도 경로의 공개키·체크포인트
    C->>A: 고객 보관 증거
    A->>A: 서명·포함 증명·규칙 재실행
```

요청은 고객 키로, 판단은 기관 키로 서명합니다. 기관은 요청 내용과 적용 정책의 해시를 판단에 연결합니다. 외부 기록 주체는 요청과 판단에 순번을 부여하고 Merkle 루트와 크기에 서명합니다. 단건 검증은 요청과 판단의 포함 증명을 확인하고, 전체 감사는 고정된 범위의 모든 기록을 대조합니다.

고객 접수 증거는 판단 전에 파일로 저장됩니다. 데모 로그 저장이 실패하면 요청·판단의 성공 응답도 반환하지 않습니다. 외부 기록 파일은 정상 작업에서 추가만 하며, 파일을 직접 편집하는 공격은 사전에 보관한 체크포인트와 비교하여 탐지합니다.

## 무엇을 보장하는가

| 평가 항목 | 검증 근거 | 한계 |
| --- | --- | --- |
| 불변성 | 서명과 고정 Merkle 루트 | 파일 편집을 물리적으로 금지하는 대신 탐지 |
| 완전성 | 감사 범위의 크기·루트, 접수와 판단의 대조 | 외부에 접수되지 않은 요청은 탐지 불가 |
| 독립 검증 | 별도로 확보한 공개키와 체크포인트 | 그 기준의 안전한 전달을 가정 |
| 부인 방지 | 고객의 요청 서명과 기관의 판단 서명 | 키 소유·보호를 가정; 고객의 판단 동의는 의미하지 않음 |
| 사유 검증 | 서명된 입력과 정책으로 판단 재실행 | 현실 입력의 진실성이나 숨은 동기는 증명하지 않음 |

현재는 한 머신에서 역할별 키·폴더를 분리한 **로컬 모의 프로토타입**입니다. 생성기는 모든 역할의 키를 메모리에 보유하며 개인키는 파일에 저장하지 않습니다. 실제 외부 운영, 온체인 앵커, 분산 합의, 로그 분기 방지, 운영용 키 관리, 프로세스 재시작 복구는 구현하지 않았습니다. 판단 시각도 시연을 위해 증가시키는 모의 시계입니다. 기한 전 판단 없음은 `pending`, 기한 경과 후는 `overdue`로 구분합니다.

공개키와 체크포인트까지 공격자가 함께 바꿀 수 있다면 독립 검증은 성립하지 않습니다. 과거 체크포인트로 검증한 결과는 그 범위에만 유효하며 최신 전체 기록을 보장하지 않습니다.

## 참고와 문서

- [시나리오](SCENARIO.md), [요구사항·증거 스키마](REQUIREMENTS.md), [테스트 스위트](TEST-SUITE.md), [검증 기록](VALIDATION.md), [용어](CONTEXT.md)
- [Tessera](../reference-projects/tessera/README.md): 추가 전용 Merkle 로그, 순번, 체크포인트 아이디어를 참고했습니다.
- [daryl의 서명 기본 요소](../reference-projects/daryl/packages/dsm-primitives/README.md): 정규 직렬화·해시·서명 분리를 참고했습니다. 바이트 포맷 호환 구현은 아닙니다.
- [Linera](../reference-projects/linera-protocol/README.md): 외부 체인 앵커 후보를 검토했으나 이번 로컬 시연에는 연동하지 않았습니다.

`src/evidence.js`는 증거 생성과 독립 검증 함수, `src/cli.js`는 파일 기반 실행 도구입니다. 전체 감사는 로그 전체를 읽는 단순한 구현입니다. 성능보다 요구사항 충족을 우선했습니다.
