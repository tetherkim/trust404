# 데모 및 시연 장치 (Demonstration Harnesses)

이 디렉터리는 **해커톤 발표, 심사위원 기술 평가, 시각적 브라우저 시연**을 위해 코어 엔진 외부에서 제공되는 전용 시연 도구 모음입니다.

---

## 디렉터리 구성

```text
demo/
├── local.js             # 로컬 Anvil 기반 5대 시나리오 자동 생성 및 실시간 감사 웹 서버
├── aim.js               # AIM 심사용: OS 레벨 DB 차단 후 CLI 무신뢰 독립 검증 시연
├── audit-server.js      # 감사관용 감사 파일 업로드/검증 HTTP 서버
├── audit-file.js        # 업로드 파일 규격 검사 및 정책 프로필 대조기
├── testnet.js           # Base Sepolia 테스트넷 연결 시연 스크립트
├── index.html           # 감사관 브라우저 웹 UI
├── ui.js                # 감사관 브라우저 클라이언트 로직
└── portal/              # 대출 신청 및 영속 작업 큐 시연 포털
    ├── server.js        # 포털 백엔드 서버 (작업 대기열, 세션 관리, export 제공)
    ├── portal.html      # 사용자 대출 신청 브라우저 화면
    └── portal.js        # 포털 클라이언트 로직
```

---

## 주요 실행 명령어

### 1. 인터랙티브 웹 UI 시연 (가장 권장)
```bash
npm run demo:local
# 또는 npm run demo
```
- 로컬 Anvil 블록체인을 자동으로 띄우고 스마트 컨트랙트를 즉시 배포합니다.
- 정상 거절, 기록 변조, 자료 유실, 결과 미등록, 잘못된 판단의 5대 시나리오를 온체인에 기록합니다.
- `http://127.0.0.1:4040`에서 브라우저로 5개 시나리오를 클릭 한 번으로 검증하거나 감사 파일을 드래그 앤 드롭할 수 있습니다.

### 2. 기술 감사관용 무신뢰 격리 검증 시연
```bash
npm run demo:aim
```
- Node.js `--permission` 보안 플래그를 적용하여 **기관의 SQLite DB 파일 접근을 OS 레벨에서 원천 차단**합니다 (`ERR_ACCESS_DENIED`).
- 오직 공개 증거(`evidence.json`)와 컨트랙트 Root만으로 독립 검증 CLI(`src/cli.js`)가 정상 거절 및 4대 위변조 공격을 모두 적발해냄을 터미널에서 증명합니다.

### 3. 사용자 대출 신청 포털 시연
```bash
npm run serve
```
- 사용자가 웹 화면에서 대출을 신청하고, 백그라운드에서 오퍼레이터가 처리하여 온체인 배치 앵커링 및 독립 검증용 `evidence.json` 다운로드를 제공합니다.
