# Sinatra on AWS Lambda MicroVMs

Sinatra/Puma application を AWS Lambda MicroVMs 上で tenant ごとの一時 Web application として
実行する検証実装です。固定 URL の API Gateway + Cognito proxy が tenant route を DynamoDB で
管理し、必要な MicroVM を 1 台だけ起動して、port-scoped JWE を server side で発行・更新しながら
request を転送します。

Lambda MicroVMs は 2026-06-22 に東京リージョンを含めて提供開始され、CloudFormation、
AWS CDK L1、AWS SDK for JavaScript v3 から利用できます。この repository は正式な
`AWS::Lambda::MicrovmImage`、`AWS::Lambda::NetworkConnector`、
`@aws-sdk/client-lambda-microvms` を使用します。

## Application contract

```bash
bundle install
bundle exec puma -b tcp://127.0.0.1:8080 config.ru
```

```bash
curl http://127.0.0.1:8080/
curl http://127.0.0.1:8080/health/live
curl -X POST http://127.0.0.1:8080/aws/lambda-microvms/runtime/v1/ready
curl -X POST http://127.0.0.1:8080/aws/lambda-microvms/runtime/v1/run \
  -H 'Content-Type: application/json' \
  -d '{"microvmId":"mvm-local","runHookPayload":"{\"generation\":1}"}'
curl http://127.0.0.1:8080/health/ready
```

`run` payload は AWS の正式な contract に合わせ、service が付与する `microvmId` と
`RunMicrovm` に渡した文字列 `runHookPayload` を受け取ります。`suspend`、`resume`、
`terminate` に独自 `eventId` は要求しません。hook は Lambda が image definition に設定した
内部 lifecycle call で使用します。public proxy は hook prefix を常に `404` にし、MicroVM endpoint
と JWE を client に公開しません。

## Test and image build

```bash
bundle exec rake test
npm ci --prefix infra
npm test --prefix infra
npm run lint --prefix infra
npm run build --prefix infra
npm run synth --prefix infra -- --context stage=dev
docker buildx build --platform linux/arm64 --target test --load -t sinatra-microvm:test-suite .
docker run --rm --platform linux/arm64 sinatra-microvm:test-suite
docker buildx build --platform linux/arm64 --load -t sinatra-microvm:test .
```

Dockerfile は公式 `public.ecr.aws/lambda/microvms:al2023-minimal` を使用し、Ruby 3.4、
Puma single worker、non-root UID 10001 で port 8080 を listen します。

## AWS deployment

MicroVM managed base image version は region ごとに deploy 前に確認します。初期値 `0` は
`infra/cdk.json` にあります。2026-07-30 の東京リージョンへのread-only API確認ではversion
`0`と`1`が返りましたが、提供状況は変わるためdeployごとに再確認します。

```bash
aws lambda-microvms list-managed-microvm-image-versions \
  --image-identifier arn:aws:lambda:ap-northeast-1:aws:microvm-image:al2023-1 \
  --region ap-northeast-1
```

結果が異なる場合は `--context microvmBaseImageVersion=VERSION` で上書きします。

```bash
npm ci --prefix infra
npm run synth --prefix infra -- \
  --context stage=dev \
  --context microvmBaseImageVersion=0
npm --prefix infra exec cdk -- deploy --all \
  --context stage=dev \
  --context microvmBaseImageVersion=0
```

default egress は AWS managed `INTERNET_EGRESS` です。private RDS 等へ接続する場合は
`--context microvmEgressMode=vpc` を指定すると、Foundation stack が作成する isolated subnet の
Lambda Network Connector を `RunMicrovm` に渡します。必要な VPC endpoint、private resource、
または NAT route は application 要件に合わせて追加してください。

初回 request は conditional lease の winner が `RunMicrovm` を呼びます。10 秒以内に
`RUNNING` へ遷移しない場合は `202` と `Retry-After: 2` を返し、同じ tenant の後続 request は
同じ generation/client token を監視するため重複起動しません。詳細な stack、設定値、運用上の
注意は [infra/README.md](infra/README.md) と [SPEC.md](SPEC.md) を参照してください。
