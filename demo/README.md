# TRUST404 Demonstration & Showcase Runbook (`demo/`)

이 디렉터리는 **해커톤 발표, 심사위원 기술 평가, 시각적 브라우저 시연**을 위해 코어 시스템(`src/`) 외부에서 제공되는 전용 시연 도구 모음입니다.

실제 외부 블록체인 노드나 기관 인프라가 없어도, **로컬 머신에서 1초 만에 로컬 Anvil 체인과 스마트 컨트랙트를 자동 배포하고 5대 정상/공격 시나리오를 생성하여 실시간으로 검증**할 수 있습니다.

---

## 1. 디렉터리 구성 (Directory Layout)

```text
demo/
├── local.js             # [핵심 러너] 로컬 Anvil 기동, 5대 시나리오 자동 앵커링 & 감사 웹 서버
├── aim.js               # [기술 증명] OS 수준 기관 DB 읽기 차단 상태에서 독립 CLI 검증 시연
├── audit-server.js      # 감사관 전용 독립 감사 파일 업로드/검증 HTTP 서버
├── audit-file.js        # 업로드 감사 JSON 파일 규격 검사 및 정책 프로필 대조기
├── testnet.js           # Base Sepolia 테스트넷 연결 및 시연 스크립트
├── index.html           # 감사 콘솔 브라우저 UI (반응형 다크 테마)
├── ui.js                # 감사 콘솔 브라우저 클라이언트 로직
└── portal/              # [사용자/운영자 시연 포털]
    ├── server.js        # 대출 신청 접수, 영속 작업 대기열(jobs.sqlite), 증거 export 서버
    ├── portal.html      # 사용자 대출 신청 브라우저 화면
    └── portal.js        # 대출 신청 및 6종 증거 파일 다운로드 UI
```

---

## 2. 5대 시나리오 검증 매트릭스 (Scenario Runbook)

웹 UI(`http://127.0.0.1:4040`)의 **'샘플 파일 / 로컬 테스트 체인'** 섹션에서 제공되는 5가지 시연 파일의 검증 결과 대조표입니다:

| 시나리오 파일 | 시나리오 명칭 | 공격 / 상황 설명 | 브라우저 총평 (Verdict) | 탐지 코드 (Issue Code) |
| :--- | :--- | :--- | :--- | :--- |
| `audit-rejection.json` | **정상 거절** | 접수 당시 준비금(120)에서 50 지급 시 최소 잔액(100) 미달로 정당하게 거절됨. | **검증 완료**<br>`(VERIFIED)` | 사유: `최소 잔액 미달`<br>`(RESERVE_FLOOR)` |
| `audit-tamper.json` | **기록 변조** | 보관 파일의 판단 내용을 사후 조작하여 온체인 Merkle Root와 불일치 발생. | **이상 탐지**<br>`(FINDING)` | `보관 기록 변조`<br>`(TAMPERED_EXPORT)` |
| `audit-unavailable.json` | **자료 유실** | 온체인에는 등록되었으나, 기관이 해당 배치의 보관 파일을 분실/은폐함. | **판정 불가**<br>`(INCONCLUSIVE)` | `자료 없음`<br>`(DATA_UNAVAILABLE)` |
| `audit-missing.json` | **결과 미등록** | 요청 등록 후 90초(SLA 기한)가 경과했음에도 온체인에 판단 결과가 미등록됨. | **이상 탐지**<br>`(FINDING)` | `기한 내 결과 없음`<br>`(MISSING_AS_OF_H)` |
| `audit-wrong.json` | **잘못된 판단** | 기관이 허위로 승인 서명했으나, 당시 블록 상태 스냅샷으로 재계산하여 적발. | **이상 탐지**<br>`(FINDING)` | `정책 재검증 불일치`<br>`(POLICY_MISMATCH)` |

---

## 3. 실행 방법 (Step-by-Step Guides)

### 방법 1. 인터랙티브 웹 UI 시연 (발표 영상에 가장 추천)
```bash
npm run demo:local
# 또는 npm run demo
```
1. 위 명령어를 실행하면 격리된 로컬 Anvil 체인이 자동 기동되고 스마트 컨트랙트가 배포됩니다.
2. 브라우저에서 `http://127.0.0.1:4040`으로 접속합니다.
3. **'샘플 파일 / 로컬 테스트 체인'** 섹션을 펼쳐 원하는 시나리오 파일(예: `audit-rejection.json`, `audit-tamper.json`)을 다운로드합니다.
4. **'감사 파일 선택'**에 해당 파일을 넣고 **[파일 검증]** 버튼을 클릭합니다.
5. 1초 만에 상단 통계, 총평 색상(초록/주황/보라), 하단 세부 요청 매트릭스 및 탐지 사유가 실시간으로 갱신되는 것을 시연합니다.

---

### 방법 2. 기술 감사관용 무신뢰 격리 검증 시연 (CLI 기반 기술 증명)
```bash
npm run demo:aim
```
- Node.js 보안 플래그(`--permission`)를 활용하여 **검증 프로세스의 기관 SQLite DB 접근 권한을 OS 수준에서 원천 차단(`ERR_ACCESS_DENIED`)**합니다.
- 오직 공개 증거(`evidence.json`)와 온체인 RPC 정보만으로 단건 검증 통과 및 4대 위변조 공격이 적발되는 과정을 터미널 로그로 입증합니다.

---

### 방법 3. 대출 신청 및 영속 큐 포털 시연
```bash
npm run serve
```
- `http://127.0.0.1:8080` 접속 (기본 접속 코드: `.env`의 `DEMO_ACCESS_CODE` 또는 설정값).
- 사용자가 웹 화면에서 대출 신청(금액 입력)을 제출하면 백그라운드 워커가 순차 처리하고, 완료 시 `evidence.json`, `audit.json`, `trust.json` 등 6종의 증거 파일을 다운로드할 수 있는 포털을 제공합니다.

---

## 4. 문제 해결 (Troubleshooting)

- **포트 충돌 (`EADDRINUSE: 4040`)**:
  - 이전 데모 프로세스가 남아있는 경우:
    ```bash
    lsof -i :4040 | awk 'NR>1 {print $2}' | xargs kill -9
    ```
- **Foundry / Anvil 미설치 시**:
  - 로컬 체인 시연을 위해 Foundry 설치가 필요합니다:
    ```bash
    curl -L https://foundry.sh | bash && foundryup
    ```
