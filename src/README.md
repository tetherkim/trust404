# 소스 코드 안내

본 프로젝트는 **오프체인 의사결정(승인/거절)을 제3자가 기관의 서버나 DB를 신뢰하지 않고 독립적으로 검증할 수 있는 신뢰 인프라**입니다. ([AIM 대응 문서](../AIM-COVERAGE.md), [QNA](../../QNA.md) 참고)

전체 제품 흐름은 **요청 접수 및 서명 → 결정 생성 및 오프체인 기록 → 머클 배치 집계 및 온체인 앵커링(Aomi/Direct RPC) → 공개 증거/아카이브 export → 독립 제3자 검증**으로 구성됩니다.

---

## 역할별 디렉터리 구조

코드의 응집도와 가독성을 높이기 위해 역할 및 책임별로 디렉터리가 모듈화되어 있으며, 공통 모듈은 `src/common`에 통합되어 있습니다.

```
src/
├── common/             # 공통 암호학, 머클 트리, RPC, 컨트랙트 ABI
│   ├── crypto.js       # 정규 JSON (RFC 8785 JCS), SHA-256, Ed25519 서명/검증, 스키마 검사
│   ├── merkle.js       # RFC 6962 호환 머클 트리 빌더 및 감사 경로(Inclusion Proof) 검증
│   ├── rpc.js          # 경량 JSON-RPC 2.0 클라이언트 및 16진수 수량 변환기
│   ├── abi.js          # RecordAnchor, CreditState, ERC20 인터페이스 ABI
│   └── index.js        # common 배럴 export
├── policy/             # 비즈니스 결정 정책 및 스키마 평가
│   └── policy.js       # USDC 준비금 정책, 신용 LTV 정책, 상태 스냅샷, 결정 생성 및 평가
├── verifier/           # 독립 제3자 검증 및 감사 엔진
│   ├── verify.js       # 단건 독립 검증(verifyOne), 전수 누락/위변조 감사(auditAll), SLA 타이밍
│   └── finality.js     # 감사 기준 체인 확정(Finalized) 뷰 결정기
├── chain/              # 블록체인 상태 조회 및 런타임
│   ├── reader.js       # 온체인 배치/상태 검증기 (ChainReader, ChainView, anchorCall)
│   └── rpc-runtime.js  # 과거 블록 상태 재생(Replay) 및 로컬 시뮬레이션/트랜잭션 실행기
├── storage/            # 영속성 저장소 및 공개 아카이브
│   └── store.js        # SQLite WAL 기반 레코드 저장소(EvidenceStore), 동일 ID 덮어쓰기를 거부하는 파일 아카이브(Archive)
├── server/             # 내부 증거 관리 HTTP API
│   └── server.js       # 서명된 요청 접수, 배치 준비, 의사결정 평가용 하위 HTTP 서비스
├── operator/           # 기관 운영자(트랜잭션 앵커링 및 Aomi)
│   ├── run.js          # 지갑/키 관리, 배치 앵커링, 복구 저널, 증거 export 데몬
│   └── aomi.js         # Aomi SDK 및 SIWE 인증 연동, 트랜잭션 시뮬레이션
├── hosted/             # 사용자 판단 요청 웹 포털
│   ├── server.js       # 접근 코드 인증, 작업 대기열, 세션 관리
│   ├── portal.html     # 사용자 판단 요청 포털 UI
│   └── portal.js       # 포털 클라이언트 로직
├── demo/               # 검증 시연 및 감사 UI
│   ├── local.js        # Anvil 기반 정상/공격 5대 시나리오 시연 환경
│   ├── aim.js          # AIM 평가용 독립 프로세스 검증 시연
│   ├── audit-server.js # 감사관 로컬 감사 서버
│   ├── audit-file.js   # 업로드 파일 규격 검사 및 감사 실행기
│   └── ui.js           # 브라우저 기반 감사 UI
└── v3/                 # 하위 호환성 유지 파사드 (기존 import 및 CLI 지원)
    └── cli.js          # 단건 검증 및 전수 감사 CLI (verify, audit, serve)
```

---

## 공통 모듈 (`src/common/`)

- **`crypto.js`**:
  - `canonical(value)`: RFC 8785 (JCS) 표준에 따른 엄격한 정규화 JSON 직렬화. 키 정렬과 올바른 유니코드 문자열 검사를 수행하며 NFC 등의 문자 정규화는 하지 않음.
  - `parseWire(text)`: 수신된 텍스트가 정규화된 형태와 100% 일치하는지 검사하여 불법 인코딩 공격 차단.
  - `hash(domain, payload)`: 도메인 분리(Domain Separation)가 적용된 SHA-256 해시 계산.
  - `sign(domain, keyId, payload, privateKey)` & `verifySignature(...)`: Ed25519 기반 메시지 엔벨로프 서명 및 검증.
  - `check(condition, code)` & `fields(value, expected)`: 불변식 및 엄격한 스키마 검증.
- **`merkle.js`**:
  - `buildTree(records)`: RFC 6962 방식(Leaf: `0x00`, Branch: `0x01`, Power-of-2 split)의 머클 트리 생성 및 루트 해시 도출.
  - `verifyProof(record, index, count, proof, root)`: 특정 요청이나 결정이 온체인 루트에 포함되어 있음을 검증하는 감사 경로 증명.
- **`rpc.js`**:
  - `jsonRpc(url, options)`: 타임아웃 및 표준 오류 검증을 내장한 JSON-RPC 2.0 요청 헬퍼.
- **`abi.js`**:
  - `RecordAnchor`: 온체인 머클 루트 및 배치 카운트 관리 컨트랙트 ABI.
  - `CreditState`: 차입자 담보(collateral) 및 부채(debt) 상태 컨트랙트 ABI.

---

## 실행 흐름과 주요 진입점

| 목적 | 진입점 | 주요 역할 |
| --- | --- | --- |
| **단건 증거 독립 검증** | `src/v3/cli.js verify <config> <evidence>` | 기관 DB 없이 서명, 머클 포함 증명, 블록 당시 정책 및 온체인 상태를 대조하여 단건 거절/승인 검증 |
| **전체 감사 (사후 조작/삭제 탐지)** | `src/v3/cli.js audit <config> <archive>` | 온체인 앵커 로그 전체를 검사하여 누락(omission), 삭제(deletion), 위변조(tampering) 탐지 |
| **AIM 독립 프로세스 시연** | `npm run demo:aim` | 기관 DB 접근 권한이 완전히 차단된 격리 프로세스에서 정상 거절 및 4개 공격 사례 탐지 시연 |
| **로컬 시나리오 시연 웹 서버** | `npm run demo:local` | Anvil 로컬 체인 기반 5개 시나리오 생성 및 웹 UI 감사 화면 제공 |
| **기관 Operator 실행** | `npm run operator` | 지갑 초기화, 요청 처리, 온체인 배치 앵커링 및 공용 증거 파일 export |
| **웹 판단 요청 포털** | `npm run serve` | 사용자 요청 접수, 백그라운드 큐 처리 및 감사 자료 다운로드 |
