# Sinatra on Lambda MicroVMs

SPEC.md の application contract を実装した Sinatra/Puma アプリケーションです。MicroVMs
固有 API と base image は一次資料で確認できていないため、このリポジトリはまずローカルで
検証可能な application image と lifecycle hook を提供します。

## ローカル実行

Ruby 3.4 と Bundler を用意し、次を実行します。

```bash
bundle install
LIFECYCLE_HOOK_SECRET=local-secret bundle exec puma -b tcp://127.0.0.1:8080 config.ru
```

```bash
curl http://127.0.0.1:8080/
curl http://127.0.0.1:8080/health/live
curl -X POST http://127.0.0.1:8080/aws/lambda-microvms/runtime/v1/ready \
  -H 'X-Lifecycle-Secret: local-secret'
curl -X POST http://127.0.0.1:8080/aws/lambda-microvms/runtime/v1/run \
  -H 'X-Lifecycle-Secret: local-secret' -H 'Content-Type: application/json' \
  -d '{"eventId":"local-run-1"}'
curl http://127.0.0.1:8080/health/ready
```

`run`、`suspend`、`resume`、`terminate` hook には JSON の `eventId` が必要です。同じ ID は
重複処理されません。hook は `LIFECYCLE_HOOK_SECRET` が設定され、かつ
`X-Lifecycle-Secret` が一致する場合だけ利用できます。不正アクセスに endpoint の存在を
開示しないため、それ以外は `404` です。本番ではこの共有 secret に加えて内部 ingress または
署名検証を利用してください。

`ready` hook は listener の起動だけを確認し、tenant request の readiness は変更しません。
`run` が成功すると初めて ready になります。`APP_GENERATION` または `MICROVM_ID` を設定した場合、
`run` と `resume` の payload にある `generation` / `microvmId` が一致しなければ `409` のまま
readiness を有効にしません。

## テスト

```bash
bundle exec rake test
```

ARM64 image は buildx で明示して作成します。

```bash
docker buildx build --platform linux/arm64 -t sinatra-microvm:test .
```

## AWS CDK

AWS infrastructure は `infra/` の CDK v2 application で管理します。routing table、暗号化された
artifact store、Cognito 認証付き proxy、reconciler、監視をデプロイできます。セットアップ、
検証、stage 別 deploy command は [`infra/README.md`](infra/README.md) を参照してください。
