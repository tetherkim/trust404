# Aomi Pipeline 재승인 없는 진단

기준: trust404 `4c5a77e`. 재현 시각: 2026-09-20 04:28:27–04:28:51 UTC.

## 확인 결과

- 설치 버전 0.7.6, 실행 파일은 `.git/aomi-tools/node_modules/@aomi-labs/client/dist/cli-custody-diagnostic.js`. 원본 CLI 대신 commit 시 custody scope를 요청하도록 한 기존 진단용 복사본이다.
- 설치 소스 `createOAuthProvider()`의 accountBearer 우선 분기는 존재한다. 하지만 현재 환경변수와 저장된 두 세션 모두 override가 없고 활성 세션은 2다. override 제거용 복사본이나 로그아웃이 필요하지 않았다.
- fetch 직전 Authorization 토큰과 활성 Pipeline OAuth grant의 SHA-256 지문이 stage/simulate/commit 모두 일치했다. 원문 토큰은 출력·저장소 포함하지 않았다.
- Pipeline JWT의 디코딩된 audience는 `https://chat.aomi.dev/v1/pipeline`, scope는 `pipeline:catalog offline_access pipeline:execute custody:delegate`. Agent/Pipeline subject도 같았다. 이는 로컬 디코딩 결과이며 JWT 서명 검증이나 서버 principal 확인을 대신하지 않는다.
- 새 Build의 송신 주소는 `0xb88122f378189b3dac4efea164181e2191489726`, chain ID는 84532, broadcaster는 hosted다. 대상은 `0x4b2ac7775fccc52b9b87a49163077b2e19273d96`의 value=0 `publisher()` 조회다. 이 호출은 anchorBatch의 publisher 제한을 받지 않는다.
- stage 200, simulate 200, commit 422. Build나 attestation을 수정하지 않았다. transaction hash 및 receipt를 받지 못했다.
- 04:31:41 UTC 공개 RPC에서 chain 84532, 잔액 0.001 ETH, latest/pending nonce 0을 확인했다. 이 관측만으로 provider 서명 시도나 모든 전송 시도의 부재를 증명하지 않는다.

## 위임 확인의 한계

이전 Portal 검증에서는 해당 Privy 지갑 Auto와 2026-09-27 위임 만료가 표시됐다. 이번 CLI `account whoami`는 `/api/account`에 대해 두 번 401 Authentication required를 받고 기본 결과로 돌아왔다. 따라서 빈 정책/위임 목록으로 해석해서는 안 된다. Pipeline 토큰을 쓰는 요청은 stage/simulate에서 200이었다.

이번 Portal에서는 해당 Privy 지갑의 Linked/Connected 표시까지 읽었으나 signing settings가 로딩 상태였고 후속 읽기는 timeout이었다. Aside도 시도했으나 Aside 자체 인증이 만료되어 시작하지 못했다. 현재 backend의 policy/delegation 전체를 다시 확인한 것은 아니다. 위임 불일치가 입증되지 않아 reconciliation 또는 signer 재설치는 하지 않았다.

## Aomi 서버 로그에서 필요한 항목

commit request ID: `072c636e-bca1-4e45-8916-599bff8c504c`

- endpoint: `POST https://chat.aomi.dev/v1/pipeline/evm/commit`
- response UTC: `2026-09-20T04:28:51.910Z`
- 응답: `{"error":{"code":"backend_rejected","message":"backend rejected the request with status 422 Unprocessable Entity","details":{"error":"pipeline_commit_failed"}}}`
- backend가 인식한 principal/resource/scope, 특히 custody:delegate 전달 여부.
- 선택된 송신 지갑·signing policy·provider wallet·활성 delegation의 일치 여부.
- Privy 서명 요청 도달 여부와 원래 오류 코드. 미도달이면 어느 commit gate가 거절했는지.
- 전송 시도가 있었다면 chain/RPC, 거래 hash, receipt 또는 전송 오류.
- 배포 backend revision과 CLI 0.7.6 호환 여부.

[기계 판독용 재현 기록](aomi-pipeline-diagnostic.json)에 요청 ID·시각·Build digest·토큰 지문 대조 결과를 보존했다. 토큰, refresh token, private key, attestation은 포함하지 않는다. 외부 지원팀에는 아직 보내지 않았다.
