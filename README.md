# TRUST404 — 거절에도 검증 가능한 기록을 (Verifiable Rejections)

> **"승인된 송금 내역만 블록체인에 남는 세상에서, 보이지 않는 곳에서 거절당한 판단은 어떻게 신뢰할 수 있을까요?"**  
> **TRUST404**는 금융기관의 오프체인 심사 판단(승인/거절)을 **기관 내부 데이터베이스나 서버를 전혀 신뢰하지 않고도, 누구나 온체인 앵커와 공개키만으로 독립 검증할 수 있는 무신뢰(Zero-Trust) 감사 인프라**입니다.

---

## 1. 왜 TRUST404인가? (Problem & Solution)

### 1) 기존 금융 및 오프체인 심사의 한계 (The Problem)
- **거절의 블랙박스화**: 대출이나 결제가 거절되면 온체인 트랜잭션이 발생하지 않으므로 영수증이 남지 않습니다. 거절 사유와 심사 기록은 기관 내부 DB에만 보관되어 **사후 은폐, 사후 위변조, 차별적 담합**에 취약합니다.
- **독립 검증의 불가능**: 고객이나 감사 기관이 이의를 제기하더라도, 기관이 일방적으로 보여주는 내부 로그에만 의존해야 하므로 "기관 DB를 믿지 않는 독립적인 검증"이 원천적으로 불가능했습니다.

### 2) TRUST404의 해결 방식 (Our Solution)
- **선(先)요청 앵커링 (Commitment-First)**: 판단을 내리기 전에 사용자의 요청을 먼저 온체인(스마트 컨트랙트)에 배치로 앵커링합니다. 따라서 기관이 불리한 요청을 사후에 은폐하거나 결과를 누락(Censorship)하는 행위가 즉시 적발됩니다.
- **2계층 독립 검증 (2-Layer Verification)**:
  1. **Layer 1 (기록 무결성)**: Ed25519 전자서명과 RFC 6962 머클 증명을 통해 원문 위변조(`TAMPERED_EXPORT`) 및 누락을 수학적으로 검증합니다.
  2. **Layer 2 (결정론적 정책 재평가)**: 요청 당시 온체인 블록 상태(담보, 부채, 준비금)를 스냅샷으로 고정하고, 제3자 검증기가 동일한 정책을 직접 재실행하여 기관의 판단 사유(`POLICY_MISMATCH`)가 진실인지 검증합니다.
- **Zero-Trust DB**: 기관의 서버나 DB에 일절 접근하지 않고, 공개된 단건 증거(`evidence.json`)와 온체인 RPC 정보만으로 완전한 검증을 종결합니다.

---

## 2. 3대 핵심 실증 성과 (Key Highlights)

1. **기관 DB 차단 환경에서의 무신뢰 독립 검증 입증**  
   - Node.js OS 권한 격리(`--permission`) 환경에서 기관 DB 접근을 완전히 차단한 채, 단건 거절 검증 및 4대 공격 사례를 100% 탐지 (`npm run demo:aim`).
2. **원클릭 브라우저 감사 대시보드 제공**  
   - 외부 감사관이 지갑 연결이나 블록체인 지식 없이도 웹 UI에서 감사 JSON 파일을 드래그 앤 드롭하여 1초 만에 이상 여부를 판정 (`npm run demo:local`).
3. **Base Sepolia & Aomi AI 에이전트 실전 연동 완료**  
   - 실제 퍼블릭 테스트넷에서 Aomi Agent 경유 트랜잭션 시뮬레이션 및 온체인 배치 앵커링 실행 완료 ([Basescan 실제 트랜잭션 증빙](#5-aomi-ai-에이전트--base-sepolia-실전-증빙)).

---

## 3. 빠른 시작 (Quick Start)

Node.js (>=22.22.2) 및 Foundry가 설치되어 있어야 합니다.

```bash
# 1. 저장소 복제 및 의존성 설치
git clone https://github.com/tetherkim/trust404.git
cd trust404
npm ci

# 2. 컨트랙트 빌드
forge build
```

### 1) 대화형 웹 감사 콘솔 시연 (권장)
```bash
npm run demo:local
# 또는 npm run demo
```
- 백그라운드에서 로컬 Anvil 체인을 기동하고 스마트 컨트랙트를 자동 배포합니다.
- 브라우저에서 `http://127.0.0.1:4040`에 접속하여, **5가지 시나리오 샘플 파일을 1초 만에 검증**할 수 있습니다.

### 2) 기술 감사관용 무신뢰 격리 검증 시연 (CLI 기반 기술 증명)
```bash
npm run demo:aim
```
- OS 수준에서 기관 SQLite DB 파일 접근을 차단(`ERR_ACCESS_DENIED`)한 격리 프로세스에서, 공개 증거 파일만으로 독립 검증을 수행합니다.

---

## 4. 5대 공격 시나리오 및 탐지 매트릭스

TRUST404는 금융기관이 시도할 수 있는 모든 형태의 사후 조작과 누락을 수학적으로 적발합니다:

| 시나리오 | 기관의 공격 / 비정상 행위 | 탐지 매커니즘 | 최종 결과 및 탐지 코드 |
| :--- | :--- | :--- | :--- |
| **정상 거절** | 준비금(120)에서 50 대출 요청 시 최소 잔액(100) 미달 | 정규 서명, 머클 증명, 정책 재평가 100% 일치 | **검증 완료** (`RESERVE_FLOOR`) |
| **기록 변조** | 기관이 사후에 판단 파일의 거절 사유를 위변조함 | 온체인에 기록된 Merkle Root와 불일치 | **이상 탐지** (`TAMPERED_EXPORT`) |
| **자료 유실** | 온체인에는 앵커링했으나, 해당 원문 배치를 은폐/삭제함 | 배치 데이터 누락 감지 | **판정 불가** (`DATA_UNAVAILABLE`) |
| **결과 미등록** | 요청 등록 후 약정 시간(90초) 내에 온체인 결과를 미등록함 | 요청 블록과 현재 감사 블록 간의 SLA 타이밍 계산 | **이상 탐지** (`MISSING_AS_OF_H`) |
| **잘못된 판단** | 준비금이 부족함에도 기관이 마음대로 '승인'으로 허위 서명함 | N번 블록 당시의 상태 스냅샷으로 정책 직접 재실행 | **이상 탐지** (`POLICY_MISMATCH`) |

---

## 5. Aomi AI 에이전트 & Base Sepolia 실전 증빙

TRUST404는 오프체인 인텐트 처리와 안전한 트랜잭션 실행을 위해 **Aomi Agent**를 연동하였습니다.

```text
[우리 코드: 배치 빌더]
   │ (ABI 및 호출 인자 구조화)
   ▼
[Aomi Agent: 인텐트 분석]
   │ (온체인 시뮬레이션 및 안전성 검증)
   ▼
[우리 전용 Signer]
   │ (시뮬레이션 성공 확인 후 서명 & 가스 전송)
   ▼
[Base Sepolia 컨트랙트: RecordAnchor] ───► 실제 영구 앵커링 완료!
```

- **공식 SDK 연동**: `@aomi-labs/client` 및 SIWE(Sign-In with Ethereum) 세션 인증 적용.
- **권한 격리**: Aomi에게 프라이빗 키를 위임하지 않으며, Aomi가 시뮬레이션에 성공한 트랜잭션만 우리 Signer가 최종 서명합니다.
- **실제 Base Sepolia 트랜잭션 증빙**:
  - [요청 등록 트랜잭션 (Basescan)](https://sepolia.basescan.org/tx/0xa9f05001d2efd00adb2a2e4af2e7c36863be2cd024311baa28bf77e4a4d6335b)
  - [판단 등록 트랜잭션 (Basescan)](https://sepolia.basescan.org/tx/0xe1aa2ff6408a937c7fbb5dc540902ed3d380db5ef3b5b5e8a40441754b4cd43e)

---

## 6. 테스트 검증 (Test Suite)

코드의 무결성은 총 38개의 단위, 컨트랙트, 통합 테스트를 통해 100% 검증됩니다:

```bash
# 단위 테스트 (20개 PASS - 암호학, 정책 엔진, RPC 런타임, SQLite 스토어)
npm test

# 스마트 컨트랙트 테스트 (8개 PASS - RecordAnchor, CreditState)
npm run test:contracts

# 통합 E2E 테스트 (10개 PASS - AIM 무신뢰 격리, 체인 파이프라인, 포털)
npm run test:integration
```

---

## 7. 프로젝트 상세 안내서 네비게이션

프로젝트의 심층 분석을 위해 역할별 상세 문서를 제공합니다:

- **[코어 소스코드 아키텍처 명세서](src/README.md)**: `src/common/`, `src/policy/`, `src/verifier/`, `src/chain/`, `src/storage/` 모듈별 상세 설계 및 암호학 규격
- **[데모 및 시연 상세 런북](demo/README.md)**: 대화형 웹 콘솔, AIM 격리 검증기, 사용자 대출 포털의 상세 실행 가이드
- **[AIM 목표 및 검증 근거](AIM-COVERAGE.md)**: 해커톤 평가 기준, 위협 모델, 신뢰 경계(Security Assumptions) 상세
