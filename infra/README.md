# AWS CDK deployment

この CDK app は `Foundation`、`ControlPlane`、`Image`、`Observability` の 4 stack を作成します。
MicroVMs の正式な CloudFormation type または SDK service model はまだ Gate 0 未完了のため、
存在しない API 名を custom resource に埋め込んでいません。`Image` stack は application source を
content-addressed CDK asset として発行し、正式な provider を追加できる状態までを管理します。

## 前提条件

* Node.js 20 以上
* AWS credentials と、対象 account/region での CDK bootstrap
* default region は `ap-northeast-1`
* production deploy は CI/CD と承認済み `cdk diff` からのみ実施

## 検証とデプロイ

```bash
npm ci --prefix infra
npm test --prefix infra
npm run lint --prefix infra
npm run build --prefix infra
npm --prefix infra exec cdk -- synth --context stage=dev
npm --prefix infra exec cdk -- diff --context stage=dev
npm --prefix infra exec cdk -- deploy --all --context stage=dev
```

stage は `dev`、`staging`、`production` のいずれかです。production では routing table、KMS key、
artifact bucket、log groups に retain policy を適用し、routing table の deletion protection も有効に
します。API URL、Cognito User Pool ID/client ID、artifact location は CloudFormation outputs から
取得してください。利用者には Cognito attribute `custom:tenant_id` を設定することを推奨します。
未設定時は Cognito `sub` が tenant identifier になります。

現状の proxy は Cognito 認証、tenant resolution、route lookup、access timestamp 更新までを行い、
MicroVM endpoint や token を response/log に含めません。正式な MicroVM control API と JWE schema
が検証されるまでは fail closed の `503` を返します。これは deploy failure ではなく、SPEC.md の
Gate 0 と「SDK call 名を推測しない」という安全要件を満たすための明示的な runtime guard です。
