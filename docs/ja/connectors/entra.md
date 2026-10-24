---
summary: "Microsoft Entra ID 業務コネクター：ゲートウェイとデスクトップのための OpenID Connect サインイン検証（発行者、テナント、対象者、JWKS）と、追加で有効にできる読み取り専用のディレクトリ参照。アプリ登録、スコープ、データの扱い、ゲートウェイ SSO の残作業"
read_when:
  - Kurahi のサインインを組織の Microsoft Entra ID と結び付けたい
  - エージェントにディレクトリのユーザーやグループを参照させたい
  - シングル サインオンのどこまでが実装済みかを確認したい
title: "Microsoft Entra ID"
---

# Microsoft Entra ID コネクター

English: [Microsoft Entra ID connector](/connectors/entra)

Entra コネクターの役割は次の 2 つで、この順に提供します。

1. **サインイン。** テナントが発行した OpenID Connect の ID トークンを検証し、「この人は組織の
   アカウントでサインインした」ことを Kurahi が信頼できるようにします。
2. **ディレクトリの参照（追加で有効化）。** エージェントがユーザーを、上位のレベルではグループと
   所属も参照できます。読み取り専用です。

| 項目                   | 内容                                                                                     |
| ---------------------- | ---------------------------------------------------------------------------------------- |
| プラグイン ID          | `entra`（同梱、**既定は無効**）                                                          |
| サインインのスコープ   | `openid`、`profile`、`email`、`offline_access`、`User.Read`                              |
| ディレクトリのスコープ | `User.ReadBasic.All`（basic）または `Directory.Read.All`（full、管理者の同意が必要）     |
| 書き込み               | なし。ディレクトリを変更することはありません                                             |
| 状態                   | 検証処理は実装済みで、ローカルで生成した署名鍵でテスト済み。実テナントでの検証はまだです |

## 管理者が Microsoft Entra で行う設定

1. **アプリの登録 > 新規登録** でシングル テナントのアプリを作ります（グループ内の複数テナントから
   サインインさせる場合だけマルチテナントにし、`allowedTenants` に列挙します）。
2. リダイレクト URI：**パブリック クライアント/ネイティブ (モバイルとデスクトップ)**、`http://localhost`。
3. **認証** で **パブリック クライアント フローを許可する** を **はい** にします（デバイス コードでの
   サインイン用）。**トークン構成** は必須ではありません（`email` は任意）。
4. **API のアクセス許可 > Microsoft Graph > 委任されたアクセス許可**：`openid`、`profile`、`email`、
   `offline_access`、`User.Read`。ディレクトリ参照には `User.ReadBasic.All`（basic）または
   `Directory.Read.All`（full）を追加します。`Directory.Read.All` には必ず **管理者の同意を与えます** が必要です。
5. **アプリケーション (クライアント) ID** と **ディレクトリ (テナント) ID** を控えます。クライアント
   シークレットは不要です。

Microsoft 365 コネクターのアプリ登録にこれらのアクセス許可を追加して、共用することもできます。

## Kurahi の設定

```bash
kurahi plugins enable entra
kurahi config set plugins.entries.entra.config '{
  "tenantId": "<ディレクトリ (テナント) ID>",
  "clientId": "<アプリケーション (クライアント) ID>",
  "directory": "basic"
}' --json
kurahi entra login              # サインインし、ID トークンを検証（nonce 付き）
kurahi entra probe              # テナントの署名鍵の取得とサインインの有効性を確認
kurahi entra verify-token < id_token.txt
```

| キー                   | 既定値           | 意味                                                                                   |
| ---------------------- | ---------------- | -------------------------------------------------------------------------------------- |
| `tenantId`             | なし             | テナント GUID または確認済みドメイン。`organizations` は `allowedTenants` と併用時のみ |
| `clientId`             | なし             | アプリケーション (クライアント) ID。ID トークンの `aud` として期待する値               |
| `allowedTenants`       | 設定したテナント | サインインを認めるテナント GUID                                                        |
| `directory`            | `off`            | `off`、`basic`（ユーザー）、`full`（ユーザーとグループ）                               |
| `redirectPort`         | ランダム         | ループバックのポートを固定                                                             |
| `probeIntervalMinutes` | 15               | 接続確認の間隔（分）                                                                   |

## ID トークンの検証内容

`EntraOidcValidator`（`src/connectors/business/oidc.ts`）は、次のすべてを満たすトークンだけを受け入れます。

1. 3 つの部分からなるコンパクト形式の JWS で、16 KB 以下。
2. `alg` が `RS256`。`none` や HMAC 系のアルゴリズムは拒否。
3. `kid` がテナントの JWKS にある鍵を指す。鍵はテナントの OpenID 構成
   （`https://login.microsoftonline.com/<テナント>/v2.0/.well-known/openid-configuration`）から取得し、
   6 時間キャッシュします。未知の `kid`（鍵の更新）があれば再取得しますが、5 分に 1 回までです。
   鍵の文書は `login.microsoftonline.com` から HTTPS で取得したものだけを受け入れます。
4. ヘッダーとペイロードに対する RSA 署名。
5. `iss` がテナントの発行者（`https://login.microsoftonline.com/<tid>/v2.0`）と一致。
6. `tid` が `allowedTenants` に含まれる（既定は設定したテナントのみ）。
7. `aud` が `clientId` と一致。
8. `exp`、`nbf`、`iat` が 2 分の時刻ずれの範囲内。
9. 呼び出し側が nonce を送った場合は `nonce` が一致（login コマンドは常に送ります）。

拒否した場合は理由を 1 つ（`wrong_audience`、`expired`、`bad_signature` など）だけ返し、
トークンの内容は返しません。

## ゲートウェイとデスクトップのシングル サインオン：実装済みの部分と残り

実装済み：

- 上記の検証処理。正常、期限切れ、有効期間前、対象者違い、発行者違い、テナント違い、署名不正、
  `alg` の取り違え、鍵の更新、Microsoft 以外の鍵文書について、テストがあります。
- `kurahi entra login`：実際の対話型サインイン（PKCE、nonce）。ID トークンが検証に通らない限り
  サインインを受け入れません。
- `kurahi entra verify-token`：標準入力から受け取った ID トークンを検証します。

未実装：ゲートウェイの接続時の認証で使えるのは、ゲートウェイ トークン、パスワード、ペアリング済み
デバイスのトークン、確認済みの Tailscale の ID で、外部の ID プロバイダーを組み込む拡張点が
ありません。Entra をゲートウェイとデスクトップのサインインにするために残っている作業は次のとおりです。

1. ゲートウェイ認証（`src/gateway/auth.ts` の `authorizeGatewayConnect`）に `oidc` 方式を追加し、
   `connect` フレームのトークンを検証処理に渡す。
2. 検証済みの ID（`tid` と `oid`）を Kurahi のロールとスコープに対応付ける。管理者が管理する
   許可リストを設ける（ディレクトリ参照によるグループ所属の利用も一案）。
3. デスクトップ：システムのブラウザーで PKCE サインインを行い、リフレッシュ トークンを OS の
   キーリングに保存し、期限前に ID トークンを更新する。
4. 検証済みのサインインを短期間有効なペアリング済みデバイスのトークンに交換し、既存のセッション
   管理と取り消しの仕組みを唯一の経路として保つ。

## ディレクトリのツール

| ツール                | レベル | 内容                                                       |
| --------------------- | ------ | ---------------------------------------------------------- |
| `entra_users_search`  | basic  | 名前、メール、サインイン名が検索語で始まるユーザー         |
| `entra_user_get`      | basic  | オブジェクト ID またはユーザー プリンシパル名で 1 人を参照 |
| `entra_groups_search` | full   | 名前が検索語で始まるグループ                               |
| `entra_group_members` | full   | グループの直接のメンバー                                   |
| `entra_user_groups`   | full   | ユーザーが直接所属するグループ                             |

`basic` で返すのは名前、メール、サインイン名だけです（`User.ReadBasic.All` で取得できる範囲）。
`full` では役職と部署も返します。

## データの扱い

- ディレクトリの名前はテナント内の人が設定するものなので、信頼できない外部コンテンツの境界の
  内側でモデルに渡します。
- 監査ログ（`connector.entra.<操作>`）にはオブジェクト ID と件数だけを記録し、名前やアドレスは
  記録しません。対話型サインインが成功した場合は、テナントとオブジェクト ID を記録します。
- トークンは Kurahi のシークレット ストアに保存します。ID トークンは保存しません。
- 通信先は `login.microsoftonline.com` と `graph.microsoft.com` のみです。

## 状態と取り消し

接続確認ではテナントの署名鍵を取得し、`GET /me` を呼び出します。デスクトップのカタログが
**稼働中** と表示するのは、25 時間以内の確認が成功した場合だけです。`kurahi entra logout` は保存した
トークンを削除します。発行元でアクセスを止めるには、Microsoft Entra で同意またはセッションを
取り消してください。

## このリリースの制限

- グローバルの Microsoft クラウドのみ。
- ゲートウェイとデスクトップのサインインはまだ Entra と結び付いていません（上記参照）。
- 実テナントでの検証はまだです。テストはローカルで生成した署名鍵と記録済みの応答を使っています。
