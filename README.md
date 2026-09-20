# TRUST404 — 거절에도 검증 가능한 기록을

거절된 요청은 송금 내역에 남지 않습니다. TRUST404는 요청과 승인·거절 판단을 서명하고, 그 기록의 Merkle root를 체인에 등록합니다. 감사자는 기관의 서버·DB 없이 **감사 파일과 공개 체인 정보로 변조·누락·등록 지연을 확인하고 당시 정책을 다시 계산**합니다.

## 현재 구현

- **기록:** 요청 저장 → 요청 등록 거래 → 등록 블록의 상태로 판단 → 판단 등록 거래 → 감사 파일 생성.
- **감사:** 한국어 화면에서 JSON 파일 하나를 가져와 검증. 지갑 연결 불필요.
- **저장:** 원문·서명·상태 증거는 SQLite와 파일에, root·건수·등록 시점은 `RecordAnchor`에 저장.
- **실제 시연:** Base Sepolia에서 Aomi 경유 등록과 파일 감사 확인. 마지막 요청은 요청 등록부터 판단 등록까지 78초.

현재는 **테스트넷 시연용 프로토타입**입니다. 승인·거절 판단과 증거 등록을 수행하며 USDC를 실제 송금하지는 않습니다. 요청자·기관 키도 시연용이며, 고객 인증·운영용 키 관리·외부 공개 저장소는 미구현입니다.

목표별 구현 근거, 서명·증거 스키마와 신뢰 경계는 [AIM 목표와 검증 근거](AIM-COVERAGE.md)에 정리했습니다. 실제 고객의 부인 방지는 고객이 자신의 개인키를 독립적으로 통제한다는 전제가 필요하며, 서버가 역할별 키를 보관하는 현재 웹 데모는 이를 모의합니다.

## Aomi는 어디에 사용하는가

```text
우리 코드: 요청·배치 준비
  → Aomi Agent: ABI로 거래 구성 → 포크에서 시뮬레이션 → 실행 요청
  → 우리 signer: 원본과 거래 전체 대조 → 전용 지갑 서명·전송
  → 체인 receipt 확인 → 실행 결과를 Aomi에 반환 → 감사 파일 저장
```

공식 SDK `@aomi-labs/client`와 SIWE 지갑 로그인을 사용합니다. Aomi의 호스팅된 기본 Agent 런타임을 호출하며, 실패한 시뮬레이션이나 원본과 다른 거래는 서명하지 않습니다. 서명 키는 로컬 전용 테스트넷 지갑에 있습니다. **Privy hosted 자동 서명, 커스텀 App 배포, x402 결제를 사용한 구현은 아닙니다.**

판단 규칙은 LLM이 결정하지 않습니다. 우리 코드가 고정된 블록 상태로 계산하고, 감사자도 같은 규칙을 독립적으로 재실행합니다. Aomi 실행 이력은 보조 자료이며 감사 증명 자체를 대신하지 않습니다.

## 1. 다른 컴퓨터에서 설치

- [Node.js](https://nodejs.org/en/download) **22.22.2 이상**과 npm.
- 인터넷 연결: 패키지 설치, Base Sepolia 조회, Aomi 실행에 필요.
- 코드 테스트·새 기록 생성에는 [Foundry의 `forge`와 `anvil`](https://getfoundry.sh/introduction/installation/)도 필요. Windows는 WSL에서 실행.

```sh
git clone https://github.com/tetherkim/trust404.git
cd trust404
git switch develop
npm ci
```

아래 명령은 모두 저장소 루트에서 실행합니다. 감사만 하는 사람은 Foundry·지갑·test ETH가 필요 없습니다.

### 환경변수와 Aomi 인증

[.env.example](.env.example)에 실제 사용하는 설정을 정리했습니다. **기존 파일 감사와 CLI의 Aomi 실행에는 `.env`가 필수가 아닙니다.** 로컬 웹 요청 화면까지 사용할 때 복사합니다.

```sh
cp .env.example .env
```

`DEMO_ACCESS_CODE`에 24자 이상의 임의 값을 넣습니다. `npm run operator`와 `npm run serve`는 저장소 루트의 `.env`를 자동으로 읽습니다. 이미 주입된 환경변수가 우선하며, 파일 감사 명령 `audit:serve`는 이 설정을 사용하지 않습니다.

| 설정 | 필요한 경우 / 의미 |
| --- | --- |
| `DEMO_ACCESS_CODE` | 웹 서버 필수. 팀 접속 코드 |
| `HOST`, `PORT`, `PUBLIC_ORIGIN` | 웹 서버 주소. 예제는 `http://127.0.0.1:8080` |
| `DATA_DIR`, `OPERATOR_DIR` | 대기열과 운영 지갑·기록 저장 경로. `OPERATOR_DIR`은 `DATA_DIR/operator`와 일치시킴 |
| Aomi API 키·모델 API 키 | 현재 경로에서는 입력 불필요. 전용 지갑의 SIWE 로그인 사용 |

4절의 지갑 생성·충전·계약 배포를 마친 후 `npm run serve`를 실행하면 웹에서 요청할 수 있습니다. Aomi 인증 세션은 `OPERATOR_DIR/aomi-session`에 자동 저장·갱신됩니다. API 키 입력이 없다는 뜻이며, Aomi 서비스의 이용 가능 여부·크레딧과 체인 가스는 별개입니다.

`.env`와 운영 지갑 폴더는 Git에 올리지 않습니다. 이 예제는 로컬 실행용이며 공개 배포 설정은 포함하지 않습니다.

## 2. 가장 빠른 시연: 실제 기록 파일 감사

```sh
npm run audit:serve -- examples/aomi-base-sepolia/profiles.json
```

1. 브라우저에서 http://127.0.0.1:4040 을 엽니다.
2. `examples/aomi-base-sepolia/audit.json`을 선택하고 **파일 검증**을 누릅니다.
3. 요청별 기록·정책·등록 시점 결과를 확인합니다.

이 파일은 실제 기록 **배치 1–8**을 담습니다. 감사 기준 블록은 서버 설정인 `profiles.json`에 고정되어 있으며, 이후 등록된 배치는 범위 밖입니다. 결과를 하드코딩하지 않고 파일의 기록을 해당 블록의 체인 정보와 대조합니다. 배치 5–8은 Aomi 경유, 배치 1–4는 직접 RPC 경로로 등록했습니다.

**예상 결과:** 마지막 요청은 `VALID / MATCH / REGISTERED_ON_TIME`. 앞선 복구 요청 1건은 `REGISTERED_LATE`이므로 **전체 `ok: false`가 맞는 결과**입니다. 지연 이력을 숨기지 않습니다. `PROVISIONAL`은 아직 최종 확정 전, `FINALIZED`는 최종 확정된 상태입니다.

변조·누락도 확인하려면 `audit.json`을 복사한 뒤 다음과 같이 수정하고 다시 가져옵니다. 원본은 보관합니다.

| 파일 수정 | 예상 결과 |
| --- | --- |
| `batches["8"][0].decision.payload.reason`을 `FORGED`로 변경 | `TAMPERED_EXPORT` |
| `batches`에서 `"8"` 항목 전체 삭제 | `DATA_UNAVAILABLE` |

포트가 사용 중이면 명령 끝에 `4042`를 붙이고 http://127.0.0.1:4042 을 엽니다. 서버 종료는 `Ctrl+C`입니다.

## 3. 코드 테스트

AIM의 핵심 시연은 다음 한 명령으로 재현합니다. **기관 DB는 보존하되 별도 검증 프로세스의 접근 권한을 차단**하고, 전달받은 증거와 로컬 체인만으로 거절 한 건·변조·삭제·미등록 판단을 확인합니다. 이 명령이 만든 임시 자료만 종료 시 정리합니다. Aomi 계정이나 test ETH는 필요 없습니다.

```sh
npm run demo:aim
```

Foundry가 필요합니다. 일부 Node 테스트도 컨트랙트 산출물과 Anvil을 사용하므로 먼저 빌드합니다. test ETH는 필요 없습니다.

```sh
forge build
npm test
npm run test:contracts
npm run test:integration
```

서명·정책·감사, 컨트랙트, 로컬 체인과 파일 감사의 통합 흐름을 검사합니다. 로컬 테스트 성공만으로 Aomi나 공개 테스트넷의 가용성을 보장하지는 않습니다.

## 4. 자기 지갑으로 새 기록 생성: Aomi E2E

Foundry 설치 후 전용 지갑을 생성합니다. 개인 MetaMask 키를 가져오지 않습니다.

```sh
forge build
npm run operator -- init
```

출력된 `address`에 **Base Sepolia test ETH**를 보냅니다. [Base 공식 faucet 목록](https://docs.base.org/base-chain/tools/network-faucets)에서 받을 수 있으며, 제공자별 이용 조건이 다릅니다. 실제 ETH는 사용하지 않습니다. Aomi 서비스 크레딧과 체인 가스용 test ETH는 별개입니다.

```sh
npm run operator -- status
npm run operator -- deploy
npm run operator -- aomi-submit 50000000 demo-1
```

- `deploy`: 이 컴퓨터의 전용 지갑을 등록 주체로 하는 계약을 최초 한 번 배포. 배포 자체는 직접 RPC 경로입니다.
- `aomi-submit`: 전용 지갑의 SIWE 로그인 → Aomi를 통한 요청·판단 등록 → 파일 저장. 별도 브라우저 로그인이나 MetaMask 반복 서명 불필요.
- `50000000`: 50 USDC에 대한 판단 요청. 1 USDC는 1000000 최소 단위. test ETH만 충전한 새 지갑은 USDC 준비금이 없어 거절됩니다.
- `demo-1`: 중복 방지 키. 새 요청에는 `demo-2` 등 새 키를 사용합니다.

완료 출력의 `status: RECORDED`는 기록 저장 완료, `auditOk`는 감사 결과입니다. Aomi·RPC가 일시적으로 실패하면 **같은 명령과 같은 키**로 재실행합니다. 저장된 거래를 확인해 재개하며, 다른 금액에 같은 키를 쓰면 거부합니다. Aomi 실패 시 직접 RPC로 자동 우회하지 않습니다. 모델·네트워크 지연으로 90초 기한을 넘기면 `REGISTERED_LATE`로 탐지하며, 기한 내 완료를 보장하지 않습니다.

성공하면 `.local-demo/operator/exports/demo-1/`에 다음 파일이 생깁니다.

| 파일 | 용도 |
| --- | --- |
| `audit.json` | 감사 화면에 가져올 요청·판단·상태 증거 |
| `evidence.json` | 해당 요청 한 건의 요청·판단 서명, Merkle 포함 증명, 상태 증거 |
| `verify-config.json` | 단건 CLI 검증 설정. 상대 경로의 `trust.json`과 생성 시점의 기준 블록 참조 |
| `trust.json` | 공개키·정책·계약 등 감사자가 별도 경로로 확인할 신뢰 기준 |
| `profiles.json` | 감사 서버 설정. `trust.json`을 상대 경로로 참조 |
| `audit-result.json` | 생성 당시 감사 결과 |
| `execution.json` | Aomi 세션·실행 요청 ID·거래 hash·응답 확인 기록 |

## 5. 생성한 기록을 다른 사람에게 전달

**`exports/demo-1` 폴더만** 전달합니다. 받은 사람은 저장소를 복제하고 `npm ci`를 마친 뒤, 폴더를 저장소의 `received/demo-1`에 넣고 실행합니다.

```sh
npm run audit:serve -- received/demo-1/profiles.json
```

브라우저에서 받은 `audit.json`을 가져옵니다. 발급자의 DB·개인키·Aomi 계정은 필요 없습니다. 감사자는 공개키·정책·계약의 진위를 별도 경로로 확인해야 하며, 파일을 받았다는 사실만으로 그 기준을 신뢰하면 안 됩니다. 업로드 파일이 스스로 신뢰 기준이나 RPC를 선택하지는 못합니다.

**한 건만 독립 검증**하려면 받은 `trust.json`과 `verify-config.json`의 공개키·계약·RPC·기준 블록을 별도 경로로 확인한 뒤 실행합니다. 기관 서버에 접속하지 않으며 파일과 공개 체인 RPC만 사용합니다.

```sh
npm run evidence -- verify received/demo-1/verify-config.json received/demo-1/evidence.json
```

설정 안의 파일 경로는 설정 파일이 있는 폴더 기준입니다. 단건 파일은 서명 검증용 정규 JSON으로 내보내므로 그대로 전달합니다. `ok: true`, `outcome: REJECTED`는 거절 기록·규칙이 일치한다는 뜻입니다. 등록 지연은 `timing`, 최종 확정 여부는 `finality`로 따로 확인합니다. 단건 검증만으로 전체 기록의 누락 여부를 판단하지 않습니다. 기존 export에 단건 파일이 없다면 전체 `audit.json` 감사를 사용하거나, 기존 요청과 같은 금액·중복 방지 키로 다시 export합니다.

새로 생성한 export는 최신 등록 범위를 감사합니다. 이후 배치가 추가됐다면 예전 파일은 누락으로 표시될 수 있으므로 최신 export를 전달합니다. 처음부터 외부에 등록되지 않은 요청은 이 방식으로 탐지할 수 없습니다.

`.local-demo/operator` 전체는 공유하거나 삭제하지 마세요. 이 폴더에는 개인키·인증 세션·DB·거래 복구 기록이 있습니다. 시연용 키는 권한 0600의 평문 파일로 저장되며 운영용 보안 저장소가 아닙니다. 실행 중인 worker는 하나만 유지하고, 강제 종료 후 잠금이 남으면 해당 프로세스 종료 여부를 확인한 뒤 `operator.lock`만 제거합니다.

## 6. 선택 사항: 로컬 요청 화면

데모는 로컬에서 실행하며 별도 클라우드 배포가 필요 없습니다. 위 파일 감사·CLI 기록 생성만으로 시연할 수 있습니다. 금액 입력 → Aomi 처리 → 파일 다운로드 → 감사 화면을 한 화면에서 보여주려면 `src/hosted/`의 로컬 서버를 실행합니다.

```sh
forge build
export DATA_DIR="$PWD/.local-demo/hosted"
export OPERATOR_DIR="$DATA_DIR/operator"
# 직접 정한 24자 이상의 접속 코드로 바꿉니다.
export DEMO_ACCESS_CODE='replace-with-your-own-demo-code'
npm run operator -- init
```

출력된 주소에 Base Sepolia test ETH를 충전한 뒤 **같은 터미널**에서 실행합니다. 4절의 CLI 지갑과 별도의 시연 지갑이며, 서버는 항상 `DATA_DIR/operator`를 사용합니다.

```sh
npm run operator -- status
npm run operator -- deploy
npm run serve
```

1. http://127.0.0.1:8080 에 접속하고 설정한 접속 코드를 입력합니다.
2. 금액을 입력해 요청을 등록합니다. 최초 요청 때 Aomi에 로그인하며, 계약 초기화 전에는 요청을 받지 않습니다.
3. 기록 완료 후 감사 파일을 내려받아 감사 화면에서 확인합니다. **기록 저장 완료와 감사 통과는 별개**이며, 지연·체인 확정 대기를 화면에 표시합니다.

서버는 기본적으로 `127.0.0.1`에 바인딩합니다. 포트를 바꾸려면 `PORT=8081 npm run serve`로 실행하고 해당 포트에 접속합니다. 종료는 `Ctrl+C`입니다. Aomi 실행·공개 체인 조회에는 인터넷 연결이 필요합니다.

- 요청은 하나씩 처리합니다. 24시간 동안 최대 20건, 대기·실행·실패 합계 5건, 요청당 최대 10,000 USDC입니다.
- 실패하면 다음 요청 처리를 멈춥니다. 누적 시도 횟수 3회 미만일 때 같은 요청을 수동 재개할 수 있으며, 서버 중단 시 실행 중인 요청은 재시작 후 같은 ID로 재개합니다.
- `.local-demo/hosted`에는 대기열·개인키·인증 세션·증거가 남습니다. 폴더 전체를 공유하거나 삭제하지 말고, 필요한 export 파일만 전달합니다.
- 같은 저장 경로를 사용하는 서버와 worker·수동 등록 명령을 동시에 실행하지 마세요. 강제 종료 후 잠금이 남으면 해당 프로세스가 종료되었는지 확인한 뒤 `operator.lock`만 제거합니다.

## 코드 위치와 실행 근거

디렉터리별 책임, 명령별 실행 흐름, 이전 구현과 정리 후보는 [소스 코드 안내](src/README.md)에 정리했습니다.

| 경로 | 역할 |
| --- | --- |
| `contracts/RecordAnchor.sol` | 등록 권한과 Merkle root 기록 |
| `src/operator/` | 지갑·요청 처리·Aomi 연동·export |
| `src/v3/store.js`, `src/v3/policy.js` | 기록 저장과 정책 판단 |
| `src/v3/verify.js` | 독립 감사 |
| `src/demo/audit-server.js` | 파일 가져오기 서버 |
| `src/hosted/` | 로컬 요청 화면·영속 대기열·파일 다운로드 |
| `examples/aomi-base-sepolia/` | 실제 공개 시연 자료와 `execution-check.json` 검증 기록 |

실제 Aomi 경유 거래: [요청 등록](https://sepolia.basescan.org/tx/0xa9f05001d2efd00adb2a2e4af2e7c36863be2cd024311baa28bf77e4a4d6335b) · [판단 등록](https://sepolia.basescan.org/tx/0xe1aa2ff6408a937c7fbb5dc540902ed3d380db5ef3b5b5e8a40441754b4cd43e).

`submit`·`tick`·`run`은 Aomi를 사용하지 않는 직접 RPC 명령입니다. `src/cli.js`와 `npm run demo`는 파일 형식이 다른 초기 오프라인 프로토타입입니다. 현재 시연은 위 절차를 사용합니다.
