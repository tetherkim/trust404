# TRUST404 Track 3 디렉터리 및 파일 구조 설명서

본 문서는 **TRUST404 Track 3 (오프체인 의사결정 독립 검증 인프라)** 프로젝트의 전체 디렉터리 구조와 모든 파일의 역할, 설계 의도 및 상호 작용을 상세하게 설명합니다.

---

## 1. 전체 디렉터리 맵

```
track3/
├── contracts/               # 온체인 스마트 컨트랙트 (Solidity & Foundry)
│   ├── CreditState.sol      # 차입자 담보(collateral) 및 부채(debt) 상태 관리 컨트랙트
│   ├── RecordAnchor.sol     # 오프체인 머클 배치 루트(root)를 앵커링하는 컨트랙트
│   └── test/                # 컨트랙트 단위 테스트 (Foundry)
│       ├── CreditState.t.sol
│       └── RecordAnchor.t.sol
├── scripts/                 # 환경 진단 및 로컬 배포 스크립트
│   ├── check-aomi.js        # Aomi CLI 설치 유무 및 세션 인증 상태 진단
│   ├── check-base-sepolia.js # Base Sepolia 테스트넷 RPC 응답성 및 상태 진단
│   ├── check-testnet.js     # 공개 테스트넷 RPC 블록 완결성 확인
│   ├── deploy-local.js      # Anvil 로컬 체인 실행 및 기준선(Baseline) 배포
│   └── local-process.js     # 로컬 자식 프로세스 종료 및 HTTP 연결 정리
├── src/                     # 시스템 핵심 소스 코드 (역할별 모듈화)
│   ├── common/              # [공통] 암호화 원천, 머클트리, RPC, 컨트랙트 ABI
│   │   ├── crypto.js        # JCS(RFC 8785) 정규화, SHA-256, Ed25519 서명/검증
│   │   ├── merkle.js        # RFC 6962 표준 머클트리 빌더 및 감사 경로 검증
│   │   ├── rpc.js           # 경량 JSON-RPC 2.0 클라이언트 및 수량 포맷터
│   │   ├── abi.js           # 컨트랙트 인터페이스 ABI 정의
│   │   └── index.js         # common 모듈 배럴 export
│   ├── policy/              # [비즈니스 정책] 대출 심사 규칙 및 상태 스냅샷
│   │   └── policy.js        # USDC 준비금 정책, LTV 정책, 상태 스냅샷, 결정 생성
│   ├── verifier/            # [독립 검증기] 제3자 검증 및 전수 감사
│   │   ├── verify.js        # 단건 검증(verifyOne), 전수 감사(auditAll), SLA 타이밍
│   │   └── finality.js      # 감사 기준 체인 확정(Finalized) 뷰 결정기
│   ├── chain/               # [블록체인 연동] 상태 조회 및 로컬 런타임
│   │   ├── reader.js        # ChainReader, ChainView, anchorCall 트랜잭션 빌더
│   │   └── rpc-runtime.js   # 과거 블록 상태 재생(Replay) 및 로컬 시뮬레이션 어댑터
│   ├── storage/             # [영속성 계층] 로컬 DB 및 증거 아카이브
│   │   └── store.js         # EvidenceStore (SQLite WAL), Archive (동일 ID 덮어쓰기 거부)
│   ├── server/              # [서비스 계층] 내부 증거 관리 HTTP API
│   │   └── server.js        # 요청 접수, 배치 준비, 의사결정 평가용 하위 HTTP 서비스
│   ├── operator/            # [기관 운영 데몬] 트랜잭션 앵커링 및 Aomi 실행
│   │   ├── run.js           # 오퍼레이터 메인 데몬 (지갑, 배치 앵커링, 저널 복구)
│   │   └── aomi.js          # Aomi SDK/SIWE 연동, 세션 관리, 시뮬레이션 가드 검증
│   ├── hosted/              # [사용자 포털] 판단 요청 웹 포털
│   │   ├── server.js        # 웹 포털 서버 (접근 코드 인증, SQLite 작업 큐)
│   │   ├── portal.html      # 사용자 판단 요청 포털 웹 UI
│   │   └── portal.js        # 판단 요청 및 증거 파일 다운로드 프론트엔드 로직
│   ├── demo/                # [시연 및 감사 UI] 로컬 시연 및 독립 감사관 환경
│   │   ├── local.js         # Anvil 기반 정상 거절 및 4대 공격 시나리오 시연 엔진
│   │   ├── aim.js           # AIM 평가용 프로세스 격리 검증 시연 스크립트
│   │   ├── audit-server.js  # 감사관이 자신의 컴퓨터에서 띄우는 독립 감사 웹 서버
│   │   ├── audit-file.js    # 업로드 감사 파일 무결성 검사 및 감사 실행기
│   │   ├── ui.js            # 브라우저 기반 감사 결과 렌더링 스크립트
│   │   ├── index.html       # 브라우저 기반 감사 웹 UI
│   │   ├── deploy.js        # MetaMask 연동 수동 컨트랙트 배포 스크립트 (선택 기능)
│   │   ├── deploy.html      # 수동 컨트랙트 배포 웹 UI (선택 기능)
│   │   ├── testnet.js       # (레거시) 초기 테스트넷 수동 시연 스크립트
│   │   └── testnet-ui.js    # (레거시) 초기 테스트넷 수동 시연 UI
│   ├── v3/                  # [하위 호환 레이어] 기존 테스트 및 CLI 지원 파사드
│   │   ├── cli.js           # 단건 검증 및 전수 감사 커맨드라인 도구
│   │   └── (re-exports)     # crypto, merkle, policy, verify, store 등 재수출
│   ├── evidence.js          # (초기 프로토타입) 파일 기반 오프라인 증거 프로토타입
│   └── cli.js               # (초기 프로토타입) 초기 오프라인 시연 CLI
├── test/                    # 테스트 스위트
│   ├── v3/                  # 알고리즘, 스키마, 단위 기능 테스트
│   │   ├── core.test.js
│   │   ├── credit-policy.test.js
│   │   ├── aomi.test.js
│   │   ├── rpc-runtime.test.js
│   │   ├── store.test.js
│   │   ├── server-verification.test.js
│   │   ├── state-mutation-demo.test.js
│   │   ├── finality.test.js
│   │   ├── local-deploy.test.js
│   │   └── fixtures.js
│   ├── integration/         # 로컬 체인 기반 E2E 통합 테스트
│   │   ├── aim.test.js      # AIM 프로세스 격리 및 기관 DB 차단 검증
│   │   ├── chain.test.js    # HTTP → SQLite → Anvil → RPC 감사 전체 파이프라인
│   │   ├── demo.test.js     # 로컬 5대 시나리오 생성 및 웹 감사 API 검증
│   │   ├── hosted.test.js   # 판단 요청 포털 세션 인증 및 큐 복구 검증
│   │   └── operator.test.js # 오퍼레이터 트랜잭션 저널링 및 재시작 멱등성 검증
│   ├── local-process.test.js # 종료된 프로세스 및 종료 신호 무시 시 정리 검증
│   ├── evidence.test.js     # 초기 v1 프로토타입 회귀 테스트
│   └── cli.test.js          # 초기 v1 CLI 회귀 테스트
├── examples/                # 실제 Base Sepolia 앵커링 산출물 샘플
│   └── aomi-base-sepolia/   # 실제 Aomi를 통해 Base Sepolia에 등록된 공개 감사 패키지
│       ├── trust.json       # 발행자, 컨트랙트 주소, 정책 해시, 서명 검증 키
│       ├── audit.json       # 전체 머클 배치 및 당시 상태 블롭 모음
│       ├── execution.json   # Aomi 세션 ID, 액션 ID, 온체인 트랜잭션 해시 기록
│       ├── audit-result.json# 감사 도구가 검증한 결과 보고서
│       └── profiles.json    # 신뢰 프로필 인덱스
├── package.json             # 프로젝트 스크립트 및 의존성 정의
├── foundry.toml             # Foundry 빌드 및 테스트 환경 설정
├── AIM-COVERAGE.md          # AIM 요구사항 항목별 상세 구현 대응 매핑 문서
└── README.md                # 프로젝트 설치, 빠른 시작 및 실행 가이드
```

---

## 2. 역할별 핵심 디렉터리 상세 설명

### 1) `src/common/` (공통 유틸리티 및 암호학 원천)
여러 도메인에서 공통으로 호출하는 순수 함수와 표준 라이브러리 인터페이스를 모아둔 모듈입니다.
- **`crypto.js`**:
  - `canonical(value)`: RFC 8785 (JSON Canonicalization Scheme) 준수. 키 정렬과 공백 제거로 해시·서명 바이트를 결정하고 올바른 유니코드 문자열인지 검사합니다. NFC 등의 문자 정규화는 하지 않습니다.
  - `parseWire(text)`: 수신된 JSON 텍스트가 정규화된 형태와 1바이트라도 다를 경우 `NON_CANONICAL_WIRE` 오류를 발생시켜 인코딩 변조 공격을 방어합니다.
  - `sign(domain, keyId, payload, privateKey)` & `verifySignature(...)`: Ed25519 비대칭키 기반의 도메인 분리 서명 엔벨로프를 생성하고 검증합니다.
  - `check(condition, code)` & `fields(value, expected)`: 엄격한 스키마 검증 및 방어적 단언(Assertion) 함수입니다.
- **`merkle.js`**:
  - `buildTree(records)`: RFC 6962 표준(Leaf 접두사 `0x00`, Branch 접두사 `0x01`, 2의 거듭제곱 분기)을 준수하는 이진 머클 트리를 생성하고 루트 해시를 산출합니다.
  - `verifyProof(record, index, count, proof, expectedRoot)`: 머클 감사 경로(Inclusion Proof)의 방향과 해시를 검증하여 해당 레코드가 온체인 루트에 정확히 포함되었는지 증명합니다.
- **`rpc.js`**:
  - `jsonRpc(url, options)`: 타임아웃과 응답 구조 검증을 제공하는 경량 표준 JSON-RPC 2.0 클라이언트입니다.
  - `quantity(value)`: 숫자 및 BigInt를 Ethereum RPC 규격의 16진수 수량(Quantity) 문자열(`0x...`)로 인코딩합니다.
- **`abi.js`**:
  - `RecordAnchor`: 온체인 머클 루트 및 배치 카운트 관리 컨트랙트 ABI.
  - `CreditState`: 차입자의 담보금과 부채를 기록하는 컨트랙트 ABI.

---

### 2) `src/policy/` (비즈니스 정책 및 의사결정)
대출 심사 정책을 평가하고 당시 상태 스냅샷을 구성하는 도메인 모듈입니다.
- **`policy.js`**:
  - `evaluate(...)`: USDC 준비금 정책(`usdc-reserve-v1`)에 따라 한도 초과(`LIMIT_EXCEEDED`) 또는 준비금 부족(`RESERVE_FLOOR`) 여부를 결정합니다.
  - `evaluatePolicy(...)`: 신용 LTV 정책(`credit-ltv-v1`)에 따라 차입자의 담보(`collateral`)와 부채(`debt`), 신청 금액(`borrowAmount`)을 기준으로 사후 LTV를 계산하고 `LTV_EXCEEDED` 또는 `NO_COLLATERAL` 여부를 결정합니다.
  - `makeDecision(...)`: 요청 접수 영수증(`receiptRef`) 시점의 블록 상태를 온체인에서 조회한 후, 정책에 따라 결정을 내리고 기관 키로 서명된 결정 레코드(`DECISION`)와 상태 스냅샷(`StateSnapshot`)을 생성합니다.
  - `validateDecision(...)`: 저장된 결정 레코드의 사유가 당시 블록의 상태 스냅샷 및 정책 규칙과 정확히 일치하는지 사후 검증합니다.

---

### 3) `src/verifier/` (독립 검증 엔진)
외부 감사관이나 요청자가 **기관의 서버나 데이터베이스를 전혀 신뢰하지 않고** 기록의 진위를 증명하는 핵심 모듈입니다.
- **`verify.js`**:
  - `verifyOne(bundle, trust, chain, runtime)`: 단 1건의 증거 번들(요청, 결정, 상태 스냅샷)을 검증합니다. 요청자/기관 서명 유효성, 온체인 머클 루트 포함 증명, 해당 블록 시점 상태 재현(Replay)을 종합 대조합니다.
  - `auditAll(archive, trust, chain)`: 온체인에 등록된 모든 배치 로그를 전수 조사하여 다음 이상 징후를 탐지합니다:
    - 위변조 탐지 (`TAMPERED_EXPORT`): 머클 루트 불일치
    - 자료 유실/삭제 탐지 (`DATA_UNAVAILABLE`): 온체인 등록 후 오프체인 파일 미보관
    - 접수 후 미등록 탐지 (`MISSING_AS_OF_H`): 90초 SLA 이내 미등록
    - 지연 등록 탐지 (`REGISTERED_LATE`): SLA 초과 등록
    - 허위 결정 탐지 (`POLICY_MISMATCH`): 유효한 서명이더라도 규칙과 다른 결정
  - `timing(requestMeta, decisionMeta, context)`: 온체인 앵커링 타임스탬프를 기준으로 SLA(90초) 준수 여부를 판별합니다.
- **`finality.js`**:
  - `auditView(reader)`: 온체인 블록의 `finalized` 상태를 검사하여 감사 기준 블록이 충분히 완결되었는지(`FINALIZED`), 아니면 재정렬 가능성이 있는 최신 블록(`PROVISIONAL`)인지 구분합니다.

---

### 4) `src/chain/` (블록체인 상호작용 및 런타임)
- **`reader.js`**:
  - `ChainReader` / `ChainView`: 특정 블록 해시(`requireCanonical: true`)에 뷰를 고정(Pin)하여 체인 재정렬(Reorg) 공격을 방어하면서 `RecordAnchor` 및 상태 컨트랙트를 조회합니다.
  - `anchorCall(...)`: 배치 머클 루트를 컨트랙트에 기록하기 위한 `anchorBatch` 트랜잭션 calldata를 생성합니다.
- **`rpc-runtime.js`**:
  - `RpcRuntimeAdapter`: 과거 특정 블록 높이(`blockNumber`)에서의 `CreditState` 상태를 오차 없이 재현하고, 로컬 Anvil 환경에서 트랜잭션을 사전 시뮬레이션 및 브로드캐스트합니다.

---

### 5) `src/storage/` (영속성 계층)
- **`store.js`**:
  - `EvidenceStore`: SQLite WAL 모드 기반으로 동작하며, 중복 요청 방지(멱등성 보장), 미등록 레코드의 머클 배치 집계 및 동결(Freezing)을 트랜잭션 단위로 관리합니다.
  - `Archive`: 제3자 감사관에게 전달할 공용 배치 파일(`batch-<id>.json`)과 상태 블롭(`blob-<hash>.json`)을 동일 ID의 다른 내용으로 덮어쓰지 않도록 저장합니다. 외부 파일 편집은 감사 시 탐지합니다.

---

### 6) `src/operator/` (기관 운영자)
- **`run.js`**:
  - 기관의 지갑 및 키 초기화, 컨트랙트 배포, 미처리 요청의 온체인 앵커링 주기(`cycle`), 크래시 발생 시 트랜잭션 저널 복구(`transact`)를 수행하는 독립 데몬입니다.
- **`aomi.js`**:
  - `@aomi-labs/client` SDK를 사용하여 Aomi 플랫폼과 SIWE(Sign-In With Ethereum) 인증을 맺고 세션을 관리합니다.
  - Aomi 트랜잭션 시뮬레이션 결과 및 가드레일(`guards`)을 엄격히 검증하여 안전한 배치 트랜잭션만 실행되도록 통제합니다.

---

### 7) `src/hosted/` (판단 요청 포털)
- **`server.js`**:
  - 접근 코드 기반 세션 인증, Rate Limiting, 안전한 원본 검사(Origin Check)를 수행하는 웹 서버입니다. 판단 요청 요청을 SQLite 작업 큐에 격리하여 순차 처리합니다.
- **`portal.html` / `portal.js`**:
  - 사용자가 판단 요청 금액을 입력하고 처리 진행 상태(대기 → Aomi 처리 중 → 기록 저장 완료)를 실시간으로 확인하며, 생성된 단건 증거 및 감사 패키지를 다운로드할 수 있는 웹 UI입니다.

---

### 8) `src/demo/` (시연 및 감사 웹 UI)
- **`local.js`**: 로컬 Anvil 노드에서 스마트 컨트랙트를 배포하고 5가지 시연 사례(정상 거절, 기록 변조, 자료 유실, 판단 미등록, 사유 불일치)를 자동 구축하는 시연 엔진입니다.
- **`aim.js`**: Node.js `--permission` 플래그를 사용하여 **기관 DB에 대한 읽기 권한을 원천 차단**한 격리 프로세스에서, 공개 파일과 RPC만으로 거절 레코드 검증 및 4개 공격 사례 탐지를 자동 수행하는 AIM 목표 확인용 시연 도구입니다.
- **`audit-server.js`**: 외부 감사관이 자신의 로컬 컴퓨터에서 실행하여 브라우저에서 감사 파일을 선택하여 검증할 수 있는 독립 웹 서버입니다.
- **`index.html` / `ui.js`**: 감사 보고서(상태, 타이밍, 정책 대조, 이슈 목록)를 시각적으로 보여주는 프론트엔드 UI입니다.

---

## 3. 스마트 컨트랙트 (`contracts/`)

- **`RecordAnchor.sol`**:
  - 오프체인 머클 배치를 온체인에 등록하는 앵커 컨트랙트입니다.
  - `anchorBatch(uint256 expectedBatchId, bytes32 root, uint256 count)`: 순차적인 배치 ID와 머클 루트, 배치 크기를 영구 기록하며, 블록 타임스탬프와 블록 높이를 바인딩합니다. 등록자(publisher) 권한 검사 및 덮어쓰기 방지 불변식을 내장하고 있습니다.
- **`CreditState.sol`**:
  - 차입자별 담보금(`collateral`)과 부채(`debt`)를 온체인에서 관리하는 레퍼런스 신용 상태 컨트랙트입니다.

---

## 4. 테스트 스위트 구조 (`test/`)

| 디렉터리 / 파일 | 실행 명령어 | 검증 목적 |
| --- | --- | --- |
| **단위 및 명세 검증** (`test/v3/*.test.js`) | `npm test` | RFC 8785 정규화, Ed25519 서명 검증, RFC 6962 머클트리 분기/증명, LTV 정책 경계값, SQLite 멱등성 및 재시작 복구 |
| **스마트 컨트랙트 검증** (`contracts/test/`) | `npm run test:contracts` | Foundry 기반 컨트랙트 보안, 권한 제어, Fuzzing 및 타임스탬프 보존 테스트 (8개 항목) |
| **AIM 프로세스 격리 검증** (`test/integration/aim.test.js`) | `npm run demo:aim` | 제3자 검증 프로세스의 기관 DB 접근을 운영체제/런타임 레벨에서 차단한 상태에서의 독립 검증 및 4개 공격 사례 탐지 |
| **E2E 파이프라인 통합 검증** (`test/integration/*.test.js`) | `npm run test:integration` | 실제 Anvil 로컬 블록체인 노드를 띄우고 전체 HTTP, DB, 컨트랙트 앵커링, 감사관 API 및 프로세스 정리 검증. 실제 Aomi 서비스 실행은 별도 시연으로 확인 |
