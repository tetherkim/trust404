# AIM 목표와 검증 근거

제품의 기준은 `../AIM.md`의 **오프체인 승인·거절 판단에 대한 검증 가능한 증거 생성**이며, 독립 검증의 의미는 `../QNA.md`의 설명을 따른다. 금액·통화·판단 규칙·체인·실행 도구는 시연 구현의 선택 사항이다. 실제 자금 이동은 하지 않는다.

## 목표별 구현

| AIM 목표 | 구현 | 검증 근거 |
| --- | --- | --- |
| 거절을 신뢰 가능한 기록으로 저장 | 요청 서명 → 요청 root 등록 → 판단 서명 → 판단 root 등록 → 공개 증거 export | `src/operator/run.js`, `src/storage/store.js`, `contracts/RecordAnchor.sol` |
| 거절 레코드 스키마 | 요청·정책·접수 블록·상태·판단을 해시와 서명으로 연결 | 아래 스키마, `src/policy/policy.js`, `src/common/crypto.js` |
| 단건 독립 검증 | `evidence.json`의 두 서명·포함 증명·판단 규칙을 별도 CLI에서 검증 | `src/verifier/verify.js:verifyOne`, `test/integration/operator.test.js` |
| 불변성 | 원문 변경 시 서명 또는 체인에 고정된 root와 불일치 | `TAMPERED_EXPORT`, `INVALID_INCLUSION`, `INVALID_SIGNATURE` |
| 완전성 | 감사 기준 블록의 배치 수·root와 전체 자료를 대조하고 요청별 판단 확인 | `auditAll`, `DATA_UNAVAILABLE`, `MISSING_AS_OF_H` |
| 기관 서버·DB를 신뢰 근거로 삼지 않는 검증 | 제시받은 기록을 별도로 확인한 공개키·정책 및 온체인 root와 대조 | `verifyOne`, `auditAll`; `demo:aim`은 DB 접근 없이도 성립함을 추가 확인 |
| 부인 방지 | 서로 다른 요청자·기관 키로 서명하고 공개키별 검증 | `request-v3`, `decision-v3`; 실제 신원과 키 소유의 연결은 아래 한계 참조 |

## 서명·해시·증거 스키마

정규 JSON은 JCS(`canonicalize`)를 사용한다. 서명은 Ed25519, 해시는 SHA-256이며, 해시는 `0x`로 시작하는 hex, 서명은 base64다. 금액·체인 ID·블록 번호 등 정수 필드는 해당 스키마에 따라 십진 문자열로 표현한다.

- 서명 envelope: `{domain, keyId, payload, signature}`. 서명 바이트는 `JCS({domain, keyId, payload})`의 UTF-8이다.
- 도메인 해시: `SHA256(UTF8(JCS({domain, payload})))`. 요청 ID는 `request-id-v3`, 정책은 `policy-v3`, 상태 증거는 `state-v3` 도메인을 사용한다.
- 공통 scope: `version: 3`, `logId`, `chainId`, `anchorAddress`를 포함해 다른 로그·체인의 기록 혼용을 막는다.
- 요청 레코드: `{kind: "REQUEST", requestId, request: envelope}`. `request-v3`로 서명한다. USDC 정책의 payload는 공통 scope와 `requesterId, institutionId, token, treasury, recipient, amountAtomic, createdAtMs, policyHash`다.
- 판단 레코드: `{kind: "DECISION", decision: envelope}`. `decision-v3`로 서명한다. USDC 정책의 payload는 공통 scope와 `requestId, policyHash, receiptRef, stateHash, outcome, reason`이다. `receiptRef`는 `batchId, leafIndex, blockNumber, blockHash`로 요청 등록 위치를 고정한다. 상태 조회 없이 한도 초과로 거절하면 `stateHash`는 `null`이다.
- LTV 정책도 같은 서명 구조를 사용한다. 요청에는 `subject, creditStateAddress, borrowAmountAtomic`이 들어가며, 상태에는 해당 블록의 담보·부채가, 판단에는 계산된 `derived`가 포함된다. 정확한 허용 필드는 `src/policy/policy.js`가 검증한다.
- Merkle leaf는 `SHA256(0x00 || UTF8(JCS(record)))`, 내부 노드는 `SHA256(0x01 || leftHashBytes || rightHashBytes)`다. 순서·위치·건수를 검증하며 배치당 최대 32건이다.
- 체인에는 `root, count, blockNumber, anchoredAt`을 저장한다. 원문·개인키는 올리지 않는다.
- 단건 `evidence.json`: `{request, decision, snapshot}`. request와 decision은 각각 `{batchId, record, count, index, proof}`이며 proof 항목은 `{side, hash}`다. CLI 입력은 정규 JSON이므로 export된 파일을 그대로 전달한다.
- 전체 `audit.json`: `{format: "trust404-audit-v1", profileId, batches, blobs}`. 모든 배치 원문과 상태 증거를 담으며 단건 증거와 용도가 다르다.

## 독립 검증과 신뢰 경계

**QNA의 기준은 기관 서버·DB를 신뢰의 근거로 삼지 않는 것이다.** 기관이 제시한 기록을 열람하거나 전달받는 것은 허용된다. 진위 판단은 기관의 응답이나 DB 내용 자체가 아니라 별도로 확인한 공개키·정책, 서명, 체인에 등록된 Merkle root에서 나온다. 기관 DB 삭제나 접근 금지는 필수 요건이 아니다.

`demo:aim`은 이 독립성을 더 직접적으로 확인하는 보조 시연이다. 기관 DB와 원본 자료를 유지하고, 별도 Node 검증 프로세스에 프로그램 코드·감사자에게 전달한 공개 파일의 읽기 권한만 허용한다. 기관 DB 읽기가 `ERR_ACCESS_DENIED`로 실패하는 것을 먼저 확인한 뒤, 같은 권한으로 실제 단건 검증과 전체 감사를 실행한다. 감사 중 파일 쓰기 권한도 필요 없다. 시연 종료 시에만 이 명령이 만든 임시 자료를 정리한다.

감사자는 `trust.json`의 공개키·정책·체인·계약·publisher·계약 코드 해시와 검증 설정의 RPC·감사 기준 블록을 별도 경로로 확인해야 한다. 검증 대상 증거 파일이 스스로 신뢰 기준을 선택하지 않는다. 함께 전달된 설정 파일을 검토 없이 신뢰하는 것은 독립 검증을 보장하지 않는다. 공개 RPC의 응답과 체인 정합성을 신뢰하는 구조이며 자체 합의 검증 노드는 아니다.

요청자 서명은 요청 사실, 기관 서명은 판단 사실을 증명한다. 요청자가 판단에 동의했다는 뜻은 아니다. 현재 operator·웹 데모는 역할별 키를 서버가 함께 보관하므로 **실제 고객 본인의 부인 방지를 완성한 제품은 아니다**. AIM의 서명 기반 구조를 시연하며, 실제 당사자 부인 방지는 각 당사자의 독립적인 개인키 통제와 사전 공개키 확인을 전제로 한다. 접속 코드나 Aomi 로그인은 고객 서명을 대신하지 않는다.

완전성은 선택한 감사 기준 블록까지 외부 등록된 요청에 한정된다. 어디에도 등록되지 않은 요청은 탐지하지 못한다. 등록 자료가 없으면 `DATA_UNAVAILABLE`로 탐지하지만 원문 복구는 보장하지 않는다. 자료 유실로 판단 유무를 알 수 없으면 `UNKNOWN`, 자료가 완전한데 기한 후 판단이 없으면 `MISSING_AS_OF_H`로 구분한다.

단건 검증의 `ok: true`는 해당 기록·서명·정책의 일치를 뜻하며 전체 누락 없음, 등록 기한 준수, 체인 최종 확정을 보장하지 않는다. `timing`과 `finality`를 함께 확인하고, 전체 누락 검사는 `audit.json`으로 수행한다. `PROVISIONAL`은 최종 확정 대기 상태다.

## 재현

```sh
npm ci
npm run demo:aim
```

Node.js 22.22.2 이상과 Foundry가 필요하다. 로컬 Anvil을 사용하므로 공개 테스트넷 가스·Aomi 계정·클라우드 배포는 필요 없다. 최초 설치와 컴파일러 준비에는 인터넷이 필요할 수 있다. 검증 결과를 미리 정해 반환하지 않고 매번 계약·증거를 생성한다.

출력은 기관 DB 접근 차단, 정상 거절 단건 검증, 사후 조작, 자료 삭제, 접수 후 판단 누락, 유효한 기관 서명을 가진 허위 판단 탐지 순서다. 하나라도 기대와 다르면 종료 코드 1로 실패한다. CI의 `test/integration/aim.test.js`도 같은 흐름을 실행한다.
