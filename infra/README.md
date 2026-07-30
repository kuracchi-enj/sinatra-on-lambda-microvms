# AWS CDK deployment

この CDK app は `Foundation`、`Image`、`ControlPlane`、`Observability` の 4 stack を作成します。

- `Foundation`: KMS、DynamoDB routing table、artifact bucket、isolated VPC、Lambda Network Connector
- `Image`: source asset、build/runtime role、logs、正式な `AWS::Lambda::MicrovmImage`
- `ControlPlane`: Cognito + API Gateway + WAF、routing proxy、reconciler、DLQ
- `Observability`: CloudWatch dashboard/alarms、SNS topic

tenant ごとの MicroVM は ephemeral runtime なので CloudFormation resource にしません。
proxy が DynamoDB conditional lease と idempotent `RunMicrovm` client token を使って起動し、
reconciler が service state と route を照合します。`hard_expires_at`到達時はrequestの有無に
かかわらずconditional leaseを取得して次generationを起動します。

## Prerequisites

- Node.js 20 以上
- AWS CLI/SDK が Lambda MicroVMs に対応していること
- 対象 account/region で CDK bootstrap 済みであること
- 東京リージョンの Lambda MicroVMs quota が利用可能であること

managed base image version は固定値を推測せず、deploy 前に確認してください。

```bash
aws lambda-microvms list-managed-microvm-image-versions \
  --image-identifier arn:aws:lambda:ap-northeast-1:aws:microvm-image:al2023-1 \
  --region ap-northeast-1
```

## Validation and deploy

```bash
npm ci --prefix infra
npm test --prefix infra
npm run lint --prefix infra
npm run build --prefix infra
npm run synth --prefix infra -- \
  --context stage=dev \
  --context microvmBaseImageVersion=0
npm --prefix infra exec cdk -- diff --all \
  --context stage=dev \
  --context microvmBaseImageVersion=0
npm --prefix infra exec cdk -- deploy --all \
  --context stage=dev \
  --context microvmBaseImageVersion=0
```

stage は `dev`、`staging`、`production` のいずれかです。production では routing table、KMS key、
artifact bucket、log groups、MicroVM image に retain policy を適用し、routing table の deletion
protection も有効にします。

## Context

| Key | Default | Description |
| --- | --- | --- |
| `stage` | `dev` | deploy stage |
| `microvmBaseImageVersion` | `0` | `list-managed-microvm-image-versions` で確認した version |
| `microvmMemoryMiB` | `512` | baseline memory |
| `maximumDurationSeconds` | `3600` | VM maximum duration |
| `maxIdleDurationSeconds` | `300` | auto-suspend までの idle |
| `suspendedDurationSeconds` | `1800` | suspended retention |
| `hardExpiryMarginSeconds` | `600` | platform expiry 前の置換開始 margin |
| `tokenTtlMinutes` | `5` | server-side JWE cache TTL |
| `microvmEgressMode` | `internet` | `internet` または `vpc` |

`vpc` mode の subnet は NAT を持たない isolated subnet です。private RDS/ElastiCache 接続向けで、
public internet access が必要なら VPC route/NAT を別途設計するか `internet` mode を使用します。

## Runtime behavior

API URL、Cognito User Pool ID/client ID、MicroVM image ARN/version は CloudFormation outputs から
取得します。Cognito user には `custom:tenant_id` を設定してください。未設定時は `sub` を
tenant ID として使います。

proxy は次を行います。

1. Cognito claim から tenant を決定し、raw tenant ID を log に出さない。
2. conditional write で tenant generation の lease を 1 caller だけが取得する。
3. 正式な `RunMicrovm`、`GetMicrovm`、`CreateMicrovmAuthToken` を呼ぶ。
4. endpoint/JWE を response/log に出さず、request を port 8080 へ転送する。
5. 401/403 は token を 1 回更新し、network/5xx は idempotent method だけ 1 回 retry する。
6. lifecycle hook prefix への public request は `404` にする。

provisioning が API Gateway の同期 window 内に完了しない場合は `202 Retry-After` を返します。
reconciler は 1 分ごとに PENDING/RUNNING/SUSPENDED/TERMINATED の service state と DynamoDB route を
照合し、stale mapping と世代交代後の旧 VM を cleanup します。初期PoCでは世代交代中のrouteを
`PROVISIONING`にするため、短い`202 Retry-After`窓が発生します。無停止切替が必要なproductionでは
active/pending generationを別々に保持する拡張が必要です。
