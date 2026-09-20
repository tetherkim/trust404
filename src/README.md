# 소스 코드 안내

현재 제품 흐름은 **요청·판단 증거 생성 → Aomi를 통한 체인 등록 → 파일 전달 → 독립 검증**이다. 시작은 `operator/run.js`, 판단 규칙은 `v3/policy.js`, 검증은 `v3/verify.js`를 읽으면 된다. 설치·시연 절차는 [루트 README](../README.md), 목표와 증거 스키마는 [AIM 대응 문서](../AIM-COVERAGE.md)를 참고한다.

## 디렉터리 역할

| 경로 | 역할 | 주요 사용처 |
| --- | --- | --- |
| `v3/` | 현재 증거 형식의 서명·정책·저장·체인 조회·독립 검증 | 모든 현재 기록 생성·감사 흐름 |
| `operator/` | 전용 지갑, 요청 처리, 거래 복구, Aomi 연결, 증거 export | `npm run operator`, 요청 포털의 작업 처리 |
| `hosted/` | 접속 코드가 있는 요청 화면, 영속 대기열, 파일 다운로드 | `npm run serve` |
| `demo/` | 공용 파일 감사 화면, 로컬 시연, AIM 검증 시연, 이전 수동 시연 | `audit:serve`, `demo:local`, `demo:aim` |
| 루트 `cli.js`, `evidence.js` | 초기 파일 기반 오프라인 프로토타입 | `npm run demo`, 초기 회귀 테스트 |

`v3`는 현재 증거 형식의 버전명이다. 이전 구현이라는 뜻이 아니다. `hosted`는 예전 서버 배포 준비 당시의 이름이며 현재 기본 실행은 `127.0.0.1` 로컬 서버다. Render나 Docker 배포를 요구하지 않는다. `demo/`에는 현재 감사에 필요한 공용 파일도 있으므로 디렉터리 전체를 제거하면 안 된다.

## 실행 흐름

| 목적 | 진입점 | 이어지는 코드와 외부 의존성 |
| --- | --- | --- |
| 실제 Aomi 기록 생성 | `operator/run.js`의 `aomi-submit` | `operator/aomi.js` → Aomi 구성·시뮬레이션 → 제한된 로컬 signer → Base Sepolia 등록 → 증거 export |
| 웹에서 요청 입력 | `hosted/server.js` | `portal.html/js` → SQLite 대기열 → 별도 `operator/run.js aomi-submit` 프로세스 |
| 받은 전체 파일 감사 | `demo/audit-server.js` | `index.html`, `ui.js` → `audit-file.js` → `v3/verify.js`와 공개 RPC |
| 받은 단건 증거 검증 | `v3/cli.js`의 `verify` | `verifyOne` → 서명·포함 증명·당시 정책·체인 조회 |
| 로컬 공격 사례 시연 | `demo/local.js` | Anvil과 실제 테스트 계약을 생성하고 정상·조작·삭제·미등록·허위 판단 사례 제공 |
| AIM 자동 시연 | `demo/aim.js` | 로컬 시연 생성 → 공개 증거 복사 → 기관 DB 접근 권한 없는 별도 CLI 검증 |

Aomi는 `operator/aomi.js`에서만 연결한다. `v3/rpc-runtime.js`는 Aomi 어댑터가 아니다. 독립 감사에는 Aomi 계정이나 기관의 DB가 필요하지 않으며, 별도로 확인한 신뢰 기준과 공개 체인 조회를 사용한다.

## `v3/`: 증거 생성과 검증

| 파일 | 책임 |
| --- | --- |
| `crypto.js` | 정규 JSON, 도메인 해시, Ed25519 서명과 검증, 기본 형식 검사 |
| `merkle.js` | 배치의 Merkle root와 포함 증명 생성·검증 |
| `policy.js` | 요청·판단 스키마, USDC 준비금·LTV 규칙, 당시 상태와 판단의 일치 확인 |
| `store.js` | SQLite 기록, 중복 방지, 배치 고정, 파일 archive, 단건 증거 묶음 |
| `chain.js` | 지정 블록의 계약·배치·상태 조회, 체인·계약·publisher 확인 |
| `finality.js` | 전체 등록 로그가 포함되는 감사 기준 블록 선택, 확정 여부 구분 |
| `verify.js` | 단건 검증 `verifyOne`과 전체 누락 감사 `auditAll` |
| `server.js` | 서명된 요청 접수·배치 준비·판단·증거 조회를 위한 하위 HTTP API |
| `cli.js` | `serve`, `verify`, `audit` 명령. 설정 파일 경로는 설정 위치 기준 |
| `rpc-runtime.js` | LTV 상태의 과거 블록 조회와 로컬 체인 거래 실행 보조 어댑터. 현재 명시적 생성·주입은 테스트에서 사용 |

`server.js`는 사용자가 보는 요청 포털이 아니다. 포털은 작업을 대기열에 넣고 operator를 실행하며, 이 하위 API는 로컬 시연과 `npm run evidence -- serve ...`에서 사용한다.

## `operator/`: 기록 생성과 Aomi 실행

- `run.js`: 지갑·역할별 시연 키 초기화, 계약 배포, 요청 저장, 판단 생성, 거래 journal과 재시작 복구, 감사 파일·단건 증거 export.
- `aomi.js`: SDK·SIWE 로그인, Aomi 세션 복구, 거래 구성·시뮬레이션 결과 검증, 승인한 거래와의 일치 확인, 실행 결과 전달.

`aomi-submit`이 Aomi 경로다. `submit`, `tick`, `run`은 직접 RPC 경로이고 테스트 및 별도 실행용으로 남아 있다. Aomi 실패 시 이 경로로 자동 우회하지 않는다. `request`는 worker와 별도로 요청을 파일에 접수하는 명령이다.

## `hosted/`: 요청 포털

- `server.js`: 접속 코드·세션·출처 확인, SQLite 대기열, 순차 작업 실행, 재시도, 공개 파일 다운로드, 감사 API.
- `portal.html`: 금액 입력·처리 상태·자료 다운로드 화면.
- `portal.js`: 로그인, 요청 제출, 상태 갱신, 저장 완료와 감사 결과 표시.

이 서버도 `demo/index.html`, `demo/ui.js`, `demo/audit-file.js`를 공유한다. 요청자 서명은 현재 서버의 시연 키로 생성하며 실제 고객 직접 서명 기능은 아니다.

## `demo/`: 현재 감사와 시연, 이전 수동 흐름

| 파일 | 상태와 용도 |
| --- | --- |
| `audit-file.js` | 현재 사용. 업로드 크기·형식 검사, 사전 설정된 신뢰 기준으로 전체 감사 |
| `audit-server.js` | 현재 사용. 받은 파일을 검증자가 자기 컴퓨터에서 감사하는 서버 |
| `index.html`, `ui.js` | 현재 사용. 감사 결과 화면. 감사 서버·로컬 시연·요청 포털이 공유 |
| `local.js` | 현재 사용. Anvil 기반 5개 사례 생성과 감사 화면. AIM 시연도 이 코드를 사용 |
| `aim.js` | 현재 사용. 기관 DB를 보존하면서 읽기 권한이 없는 별도 프로세스로 검증 |
| `deploy.html`, `deploy.js` | 선택 기능. `local.js`의 `/operator/deploy`에서 제공하는 MetaMask 계약 배포 화면. `WALLET_ADDRESS` 설정 필요 |
| `testnet.js`, `testnet-ui.js` | 정리 후보. 이전 MetaMask 수동 등록 시연. 현재 npm 명령·다른 진입점·테스트에 연결되지 않음 |

여기서 `deploy`는 **체인에 계약을 배포**하는 기능이다. 제거한 Render 웹 서버 배포와는 다르다.

## 불필요하거나 중복된 부분 점검

이번 점검은 npm 진입점, 정적·동적 import, 서버의 HTML·스크립트 제공 경로, 테스트 참조를 대조했다. 실제로 도달하지 않는 분기와 해당 분기에서만 사용하는 import는 제거했다. 독립 실행 가능한 스크립트는 참조가 없다는 이유만으로 죽은 코드로 단정하지 않았으며 파일 삭제는 하지 않았다.

| 대상 | 확인한 사실 | 정리 판단 |
| --- | --- | --- |
| `demo/testnet.js`, `testnet-ui.js` | 현재 흐름에서 호출하지 않음. `.local-demo/base-sepolia-deployed.json`이 필요하지만 이를 생성하는 코드는 저장소에서 찾지 못함. 수동 브라우저 서명을 사용하고 Aomi를 호출하지 않음 | 우선 제거 후보. 현재 `operator`·포털을 사용하면 필요하지 않음 |
| `demo/deploy.html`, `deploy.js` | `local.js`가 실제 라우트에서 제공하며, 배포 정보 API는 통합 테스트로 확인함 | 미사용으로 단정할 수 없음. 수동 MetaMask 배포를 폐기한다면 라우트·설정·테스트까지 함께 정리 |
| 루트 `cli.js`, `evidence.js` | 현재 v3와 별도 증거 형식이지만 `npm run demo`와 초기 테스트가 사용함 | 초기 오프라인 시연을 유지하는 동안 보존. 제거 시 해당 명령·테스트·안내를 함께 변경 |
| `v3/rpc-runtime.js` | 현재 operator에서는 사용하지 않지만 LTV 상태 재현·HTTP 검증 테스트에서 사용함 | 보존. `chain.js`의 상태 조회와 겹치는 부분은 통합 후보이나 로컬 거래 실행 기능도 있어 단순 삭제 불가 |
| `operator/run.js`의 두 번째 `command === 'request'` 분기 | 앞의 동일 명령 처리에서 항상 종료되므로 도달하지 않음. `randomBytes`도 이 분기만 사용했음 | 분기와 import 제거 완료. 앞쪽의 worker 동시 접수 경로와 `Operator.request()`는 유지 |

현재 핵심에서 반드시 유지할 부분은 `operator/aomi.js`, `v3`의 증거·검증 로직, 공용 감사 화면이다. 디렉터리 이름 변경이나 선택 기능 삭제는 이 설명 추가와 별도의 변경으로 진행하는 편이 참조 누락을 확인하기 쉽다.
