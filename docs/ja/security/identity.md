---
summary: "エンタープライズ ID：人のための OIDC / SAML シングルサインオン、SCIM 2.0 プロビジョニング、組織モデル（部門・チーム）、ロールとグループ対応付け、SSO 必須とブレイクグラス、ロールとゲートウェイスコープ・プロジェクト承認者の対応"
read_when:
  - Kurahi を Microsoft Entra ID、Okta、Google、Keycloak に接続する
  - SCIM で人のプロビジョニング・プロビジョニング解除を行う
  - 承認・管理・監査を誰に許可するか決める
  - サインイン、セッション、ブレイクグラスについてセキュリティレビューの質問に答える
title: "エンタープライズ ID"
---

# エンタープライズ ID

English: [Enterprise identity](/security/identity)

人は組織の ID プロバイダー（IdP）でゲートウェイと Work Console にサインインします。サインインした人は **パーソン・プリンシパル**（`person:<id>`）で、デバイス（ペアリング資格情報、デバイス鍵）やエージェント（バックエンドのツール接続）とは区別されます。人ができることはロールで決まります。人だけが行える操作（作業項目の決定、オートパイロットの承認、全体停止）は、どのロールを持っていてもエージェント接続を拒否します。

| 機能                | 内容                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------------ |
| OIDC サインイン     | PKCE（S256）付き認可コード、`state` と `nonce`。ディスカバリーを公開する任意のプロバイダー |
| SAML 2.0 サインイン | SP 起点。署名付きアサーション必須。オーディエンス、受信者、有効期間、リプレイを検査        |
| SSO セッション      | 不透明トークン `kss_…`、絶対有効期間とアイドルタイムアウト、ログアウト（OIDC は RP 起点）  |
| SCIM 2.0            | Entra ID / Okta のプロビジョニング用 Users と Groups。無効化でセッションを即時終了         |
| 組織                | 自社で定義する部門とチーム、ロール、IdP グループ → ロール対応。変更はすべて監査・封印      |
| SSO 必須            | 人は SSO 必須。ゲートウェイトークンは監査付きブレイクグラスとしてのみ有効                  |

## 設定

設定はすべて `gateway.identity` にあります。シークレット（OIDC クライアントシークレット、SCIM トークン）はシークレットストアへの参照で、`kolo.json` に平文で書きません。

```bash
kurahi secrets set identity.entra.clientSecret      # 求められたら値を貼り付け
kurahi secrets set identity.scim.token              # 32 文字以上のランダム文字列
```

```json5
{
  gateway: {
    identity: {
      // ゲートウェイの外部 https アドレス。リダイレクト URI、SAML ACS、メタデータに使用。
      publicUrl: "https://kurahi.example.com",
      providers: [
        {
          id: "entra",
          kind: "oidc",
          label: "会社アカウント",
          issuer: "https://login.microsoftonline.com/<tenant-id>/v2.0",
          clientId: "<application-client-id>",
          clientSecret: { $secret: "identity.entra.clientSecret" },
          groupsClaim: "groups",
        },
      ],
      session: { lifetimeMinutes: 480, idleMinutes: 60 },
      scim: { enabled: true, token: { $secret: "identity.scim.token" }, rateLimitPerMinute: 600 },
      ssoRequired: false,
    },
  },
}
```

| キー                               | 既定値                           | 意味                                                                                                          |
| ---------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `publicUrl`                        | なし                             | SSO に必須。`https://`（`http://` はテスト用にループバックのみ）                                              |
| `providers[]`                      | なし                             | 最大 10 件の OIDC / SAML プロバイダー。`id` は URL に入る（`a-z`、`0-9`、`-`。`scim` と `legacy` は予約済み） |
| `session.lifetimeMinutes`          | 480（最大 1440）                 | セッションの絶対有効期間。SAML の `SessionNotOnOrAfter` があれば短縮                                          |
| `session.idleMinutes`              | 60                               | この時間リクエストのないセッションは終了                                                                      |
| `clockSkewSeconds`                 | 120（最大 300）                  | トークンとアサーションで許容する時刻のずれ                                                                    |
| `defaultRole`                      | なし                             | 割り当ても対応グループもない人のロール。なしの場合サインインを拒否                                            |
| `requireProvisioned`               | SCIM 有効時 true、それ以外 false | SCIM でプロビジョニングされた有効な人だけがサインイン可能                                                     |
| `scim.enabled` / `scim.token`      | 無効                             | 両方そろったときだけ SCIM エンドポイントが応答                                                                |
| `ssoRequired`                      | false                            | [SSO 必須とブレイクグラス](#sso-必須とブレイクグラス) を参照                                                  |
| `breakGlass.localOnly`             | true                             | ブレイクグラスはゲートウェイホストからのみ                                                                    |
| `providers[].trustEmailForLinking` | false                            | [アカウントの結び付け](#アカウントの結び付け) を参照                                                          |
| `localPersons`                     | 下記参照                         | [人とみなす接続](#人とみなす接続) を参照                                                                      |
| `configRoles`                      | なし                             | `operator.config`（ホストレベルのメソッド）も与えるロール。[ロール](#組織、ロール、グループ対応付け) を参照   |

使えないプロバイダー（`publicUrl` がないなど）は、起動時に `identity: …` としてログに出ます。

設定が無効な場合、ゲートウェイは起動しません。稼働中に `kolo.json` が読めなくなったり無効になったりした場合、ID 設定はフェイルクローズします。最後に読み込めた設定が、ファイルが再び読み込めるまで有効なままです（SSO 必須は必須のまま、ローカルの人は無効のまま）。最初の失敗は `identity.config.load_failed` として監査されます。各 HTTP リクエストは、そのリクエスト自身が読み込んだ設定スナップショットで判断します。

## プロバイダーの設定

各プロバイダーのアドレス（`<id>` はプロバイダー id）：

| 用途                                | URL                                                  |
| ----------------------------------- | ---------------------------------------------------- |
| OIDC リダイレクト URI               | `<publicUrl>/api/identity/sso/<id>/callback`         |
| SAML ACS（HTTP-POST）               | `<publicUrl>/api/identity/sso/<id>/acs`              |
| SAML SP エンティティ ID・メタデータ | `<publicUrl>/api/identity/sso/<id>/metadata`         |
| サインイン開始                      | `<publicUrl>/api/identity/sso/<id>/login?returnTo=/` |
| SCIM ベース URL                     | `<publicUrl>/scim/v2`                                |

### Microsoft Entra ID（OIDC）

1. Entra ID でアプリケーションを登録します（シングルテナント）。**Web** のリダイレクト URI に `<publicUrl>/api/identity/sso/entra/callback` を追加します。
2. クライアントシークレットを作成し、`kurahi secrets set identity.entra.clientSecret` で保存します。
3. **トークン構成** で **groups** クレーム（セキュリティグループ、グループ ID）を追加します。多数のグループに属する利用者がいる場合は、アプリに割り当てたグループだけを出すか、SCIM を使います。
4. プロバイダーに `issuer: "https://login.microsoftonline.com/<tenant-id>/v2.0"` を設定します。

マルチテナントのアプリは `issuer: "https://login.microsoftonline.com/organizations/v2.0"` と `allowedTenants: ["<tenant-id>", …]` を使います。トークンの `tid` が一覧にある必要があります。

SCIM プロビジョニングは、同じアプリを **エンタープライズアプリケーション → プロビジョニング → 自動** に追加します。テナント URL は `<publicUrl>/scim/v2`、シークレットトークンは SCIM トークンです。Entra ID は `userName`（UPN）で利用者を照合し、プロビジョニング解除では `active: "False"` を送ります。

### Okta（OIDC または SAML）

OIDC：**OIDC Web Application** を作成し、サインインのリダイレクト URI を `<publicUrl>/api/identity/sso/okta/callback`、`issuer` を認可サーバー（`https://<org>.okta.com/oauth2/default`）にします。ID トークンに **groups** クレームを追加します（例：フィルター `Matches regex .*`）。

SAML：**SAML 2.0** アプリを作成します。シングルサインオン URL = ACS URL、オーディエンス URI = SP エンティティ ID（`<publicUrl>/api/identity/sso/okta/metadata`）、Name ID 形式 EmailAddress、アサーションを SHA-256 で署名、グループ属性ステートメント名 `groups`。そのうえで：

```json5
{
  id: "okta",
  kind: "saml",
  label: "Okta",
  idpEntityId: "http://www.okta.com/<app-id>",
  idpSsoUrl: "https://<org>.okta.com/app/<app>/<app-id>/sso/saml",
  idpCertificates: ["-----BEGIN CERTIFICATE-----\n…\n-----END CERTIFICATE-----"],
}
```

Okta の SCIM：**SCIM provisioning** を有効にし、ベース URL `<publicUrl>/scim/v2`、一意識別子フィールド `userName`、認証は **HTTP Header** で SCIM トークンを Bearer として設定し、ユーザーの作成・更新・無効化と Push Groups を有効にします。

### Google Workspace（OIDC）

Google Cloud で OAuth クライアント（ウェブアプリケーション）を作成し、リダイレクト URI を `<publicUrl>/api/identity/sso/google/callback`、`issuer: "https://accounts.google.com"`、自社の Workspace ドメインだけがサインインできるよう `allowedDomains: ["example.com"]` を設定します。Google の ID トークンにはグループが含まれないため、メール割り当て（`email:alice@example.com`。Google プロバイダーに `trustEmailForLinking: true` が必要）か `defaultRole` でロールを与えます。

### Keycloak（OIDC または SAML）

OIDC：上記のリダイレクト URI を持つ機密クライアント、`issuer: "https://keycloak.example.com/realms/<realm>"`、名前 `groups` の **Group Membership** マッパー（フルパスはオフ）。SAML：ACS URL を持つ SAML クライアント、「Sign assertions」オン、署名アルゴリズム RSA_SHA256、名前 `groups` のグループリストマッパー。

## アカウントの結び付け

サインインは次の順で人に結び付きます。

1. このプロバイダー・発行者・サブジェクトの既存のリンク（以前のサインイン、または管理者が `identity.persons.link` で作成したもの）。
2. `externalId` が IdP のサブジェクト（OIDC の `sub`、SAML の NameID）と一致する、まだリンクのない SCIM プロビジョニング済みの人。ただしサインインが `scim.providerId` のプロバイダーからの場合に限ります（既定：プロバイダーが 1 つだけならそのプロバイダー。複数あって未設定なら管理者がリンクします）。
3. `trustEmailForLinking: true` のプロバイダーで、IdP が検証したメールの場合に限り、そのメール（`userName` または主メール）を持つ、まだリンクのない既存の人。
4. それ以外は新しい人（ジャストインタイム）。ただし `requireProvisioned` が有効なら拒否。

手順 3 が当てはまらないのにメールで既存の人と一致したサインイン、またはすでにリンクのある人（別のサブジェクトや別のプロバイダー）に結び付こうとするサインインは `link_conflict` で拒否し、監査します（`identity.sso.link`）。別のプロバイダーにリンク済みの人に ID を結び付けられるのは、管理者のリンク（`identity.persons.link`）だけです。`identity.persons.unlink` はリンクを外し、そのリンクで開いたセッションを終了します。

検証済みメールとみなすもの：OIDC では、ID トークンに `email_verified: true` がある場合だけ `email` クレーム（または `emailClaim`）を使います。`preferred_username` と `upn` をメールとして使うことはありません。SAML では、署名済みアサーションのメール属性、または Format が `emailAddress` の NameID です。`trustEmailForLinking` は、そのメールドメインを所有する IdP（自社の Workspace や Entra テナント。一般消費者向けプロバイダーではない）でだけ有効にしてください。Microsoft Entra ID は既定では `email_verified` を送りません。Entra の利用者は SCIM（`externalId` = サブジェクト）か管理者のリンクで結び付け、ロールはグループ対応で与えます。

`email:` のロール割り当ては、SCIM または `trustEmailForLinking` のプロバイダーが保証したメールとだけ一致します。未検証・信頼されていないメールは何とも一致しません。

## ゲートウェイが検査すること

**OIDC**：ディスカバリーは https のみで、文書の `issuer` が設定値と一致する場合だけ使います。`state` は 1 回限りで 10 分で失効し、PKCE ベリファイアをトークンエンドポイントに送ります。ID トークンは、プロバイダーの JWKS の鍵で署名されている（`RS256`、`PS256`、`ES256`。`none` と HMAC は拒否。未知の `kid` では回数制限付きで鍵を 1 回再取得）、設定した発行者（または許可したテナント）、オーディエンスが当方のクライアント ID（複数の場合は `azp`）、`exp` / `nbf` / `iat` が時刻のずれの範囲内でサインイン開始より前に発行されていない、このサインインの nonce を持つ、ことが必要です。nonce は 1 回だけ受け付けます。IdP へのリクエスト（ディスカバリー、JWKS、トークンエンドポイント）はすべて 10 秒でタイムアウトします。

**SAML**：レスポンスはこのゲートウェイが送った要求への応答である必要があり（IdP 起点のサインインは受け付けません）、最初の使用で消費されます。アサーション自体が設定済みの IdP 証明書で署名されている必要があります（署名付きレスポンスに包まれた未署名アサーションは拒否）。署名アルゴリズムは RSA-SHA256/512 と ECDSA-SHA256、ダイジェストは SHA-256/512（SHA-1 は拒否）。鍵をメッセージから取ることはありません。オーディエンスは当方の SP エンティティ ID、bearer のサブジェクト確認は受信者が当方の ACS URL、`InResponseTo` がこの要求、`NotOnOrAfter` が将来であること、条件は時刻のずれの範囲内で成立、`AudienceRestriction`、`OneTimeUse`、`ProxyRestriction` 以外の条件は拒否（`unsupported_condition`）、アサーションには `AuthnStatement` が必要（`no_authn_statement`）、アサーション ID は 1 回だけ受け付けます。NameID は人を結び付けるサブジェクトなので、Format は安定したものである必要があります。既定では `persistent` または `emailAddress`、あるいはプロバイダーの `nameIdFormats` に挙げた形式です。transient、unspecified、Format なしは拒否します（`nameid_format`）。暗号化アサーションには対応していません。

**共通**：`allowedDomains` は、ただ 1 つの `@` の後ろの部分と比較します。`@` を複数含むアドレス（`someone@example.com@other.test`）にはドメインがなく、拒否されます。

署名ラッピング攻撃は構造的に防ぎます。メッセージ全体でアサーションはちょうど 1 つで、レスポンスの直下にあること。`ID` 属性の重複はどこにあっても拒否。署名は署名対象要素の直下にあり、その要素自身の ID を参照すること。値（サブジェクト、メール、グループ）はすべて検証済みの要素からだけ読み取ります。メッセージは、DOCTYPE、エンティティ、コメント、CDATA、処理命令を拒否する厳格なパーサーで解析します。

SAML ライブラリを使わない理由：信頼経路では汎用 XML スタックではなく、`node:crypto` と `src/identity/saml/` の小さな厳格パーサーと排他的正規化を使います。これにより新しい依存関係がサインイン経路に入らず、受け付ける文法の外側は一切解釈しません。正規化は libxml2（lxml）で独立に署名したフィクスチャでテストしています。

## セッション

サインインに成功すると、ブラウザーは元の Console のパスに戻り、URL フラグメントで渡されるのはセッショントークンではなくワンタイムコード（`#sso_code=…`）です。Console はコードをすぐにアドレスバーから取り除き、`POST /api/identity/sso/exchange` でセッショントークンと交換して、セッションストレージに保持します。コードは 1 回だけ、60 秒間、サインインを開始したブラウザーのバインディングクッキーと一緒の場合にだけ使えます。拒否・再利用・期限切れのコードは無効になり、そのセッションは終了します（`identity.sso.exchange` として監査）。拒否は `#sso_error=<理由>`（`no_role`、`not_provisioned`、`deprovisioned`、`link_conflict`、`inactive`、`state_unknown` など）で戻ります。

戻り先（`returnTo`）は Console のルートである必要があります。ローカルのパス（先頭は `/` 1 つ、ドットセグメント（`%2e%2e` などのパーセントエンコードも含む）、バックスラッシュ、エンコードされたスラッシュ、制御文字を含まず、正規化後もローカル）で、コントロール UI のベースパス（`gateway.controlUi.basePath`）の下にあり、通常のルートセグメントだけで構成され（ファイル名は不可）、ゲートウェイ自身が配信するパス（API、Canvas と A2UI、アバター、プラグインとチャネルの Webhook、フック）ではないこと。それ以外は Console のルートに戻ります。そのため、コードが Console 以外のスクリプトのページに届くことはありません。最終的な `Location` ヘッダーも再検査します。

- サインイン開始時に HttpOnly クッキー（`kurahi_sso_bind`、パス `/api/identity/sso`、10 分、`SameSite=None; Secure`）を設定します。OIDC コールバックと SAML ACS は、このクッキーなしで戻ったサインインを拒否します（`browser_mismatch`）。別のブラウザーでサインインを完了させることはできません。サインイン成功後、このクッキーはコードの交換のために（60 秒）残り、交換で消去されます。
- セッションは接続時と各リクエストで検査します。開いている WebSocket 接続は、さらに 30 秒ごとと、ディレクトリ（人、グループ、組織単位、ロールの割り当て、グループ対応付け）が変更されたときに直ちに再検査します。そのため、リクエストを送らない接続にもロールの変更（受け取るイベントを含む）が直ちに反映されます。イベントの受信はアクティビティではないため、リクエストを送らない接続もアイドルタイムアウトに達します。
- 有効期間の満了、アイドルタイムアウト、ログアウト、SCIM による無効化・削除、管理者による失効（`identity.sessions.revoke`）、またはそのプロバイダーが設定されなくなった・使えなくなった後の次の検査（`provider_removed`）で終了します。削除されたプロバイダーがサインイン時に示したグループは、グループ対応付けとプロジェクトのアクセスで直ちに数えられなくなります。そのセッションの接続は WebSocket クローズコード 4001 で閉じます。失効とディレクトリの変更では直ちに、有効期間の満了とアイドルタイムアウトでは 30 秒以内に閉じます。
- `POST /api/identity/logout` でセッションを終了します。`end_session_endpoint` を公開する OIDC プロバイダーでは、応答に `endSessionUrl`（RP 起点ログアウト）が含まれます。SAML のログアウトはローカルのみです。
- 人にはデバイストークンを発行しません。保存されたデバイストークンが SSO セッションより長く残るためです。
- セッショントークンは SHA-256 ハッシュだけを保存します（`<KOLO_HOME>/identity/sessions.json`、0600）。RP 起点ログアウト用の OIDC ID トークンはメモリにだけ保持します。ゲートウェイの再起動後のログアウト URL は、`id_token_hint` なしで `client_id` を送ります。
- サインイン開始は接続元ごとに毎分 30 回まで、ゲートウェイ全体で毎分 300 回まで（429 と `Retry-After`）、進行中のサインインは接続元ごとに 20 件まで（新しいものがその接続元の最も古いものを置き換えます）です。ゲートウェイ全体の進行中サインインが満杯のときは、他の人のサインインを追い出さず、新しい開始を拒否します（`too_many_pending`）。

## SCIM 2.0

Bearer トークンは `gateway.identity.scim.token` です。`scim.rateLimitPerMinute` を超えるリクエストは 429 になります。`scim.enabled` とトークンがない場合、エンドポイントは 401 を返します。`scim.providerId` は、ディレクトリの `externalId` がどのプロバイダーのサブジェクトかを示します。ほかのプロバイダーのサブジェクトが一致することはありません。

| エンドポイント                                               | 操作                                                              |
| ------------------------------------------------------------ | ----------------------------------------------------------------- |
| `/scim/v2/Users`                                             | GET（フィルター `userName eq`、`externalId eq`）、POST            |
| `/scim/v2/Users/{id}`                                        | GET、PUT、PATCH（`active: false` でプロビジョニング解除）、DELETE |
| `/scim/v2/Groups`                                            | GET（フィルター `displayName eq`、`externalId eq`）、POST         |
| `/scim/v2/Groups/{id}`                                       | GET、PUT、PATCH（メンバーの追加・削除）、DELETE                   |
| `/scim/v2/ServiceProviderConfig`、`ResourceTypes`、`Schemas` | GET                                                               |

ページングは `startIndex` と `count`（最大 200）です。この範囲外の属性（エンタープライズ拡張、電話番号、住所、役職など）は受け付けて無視します。

プロビジョニング解除は安全側に倒れます。

- PATCH のパスにスキーマ URN（`urn:ietf:params:scim:schemas:core:2.0:User:active`）が付いていても取り除いて扱います。対応・無視する属性以外のパスや操作は 400（`invalidPath`、`invalidSyntax`、`mutability`）で、黙って成功することはなく、リクエスト全体が適用されません。グループの PATCH は `members`（追加、削除、置換、`members[value eq "…"]`）、`displayName`、`externalId` に対応します。
- `active` のない PUT は現在の状態を保ちます。置換で人が再び有効になることはありません。
- 属性名は大文字と小文字を区別しません（RFC 7643）。PUT の `Active: false` は `active: false` と同様に無効化します（User と Group の本文、PatchOp メッセージ、複数値の要素）。大文字・小文字だけが異なる同じ属性が 2 つあれば 400 です。各要素がメンバー（`{"value": "<id>"}`）を指さないメンバー削除は、黙って何もしないのではなく 400 です。
- `scim.enabled` のとき `requireProvisioned` の既定は true です（SCIM トークンがまだない間も同じ）。ディレクトリが知らない人はジャストインタイムでサインインできません。許可するには `requireProvisioned: false` を設定します。
- DELETE は、人、グループのメンバーシップ、ロール割り当て（`person:<id>` と、その人のメールまたは userName への `email:` 割り当て）を削除し、セッションを終了し、**墓標（トゥームストーン）** を残します。墓標に一致する後のサインイン（同じリンク、サブジェクト = 以前の `externalId`、または同じメール）は、人を再作成せず `deprovisioned` で拒否します。org-admin は `identity.persons.restore` で解除できます（墓標は `identity.org.get` に一覧されます）。SCIM が同じ `userName` または `externalId` を再作成した場合も解除されます。復元された人は以前の権限を持たずに始まります。墓標の上限は 50,000 件です。上限で最も古い墓標を捨てるのは `requireProvisioned` が有効な間だけです（未知の人はどのみちサインインできません）。`requireProvisioned: false` では墓標を捨てず、満杯の場合 SCIM の DELETE は人を削除する代わりに無効化し、削除と同様に締め出します。

SCIM トークンはディレクトリに対して管理者と同等です。保持者は人を作成し、メールを設定し（SCIM が保証するメールになる）、グループのメンバーシップ、つまり対応するロールを変更できます。シークレットストアに保存し、IdP のプロビジョニングコネクターにだけ渡し、漏えいした場合はローテーションしてください。

プロビジョニングされた人は、最初のサインイン時に `externalId` = サブジェクト（`scim.providerId` のプロバイダー経由のみ）、または `trustEmailForLinking` のプロバイダーならメールで結び付けられます（[アカウントの結び付け](#アカウントの結び付け) を参照）。無効化と削除で、その人のセッションはすべて直ちに失効します。

## 組織、ロール、グループ対応付け

組織には自社で定義する **組織単位** があります。部門（作業キュー用に `finance` などのビジネス部門 ID と結び付け可能）と、部門の下のチームです。ロール：

| ロール               | ゲートウェイスコープ | 承認 | 典型的な担当者                                                |
| -------------------- | -------------------- | ---- | ------------------------------------------------------------- |
| `org-admin`          | attach               | あり | ＋ID 管理：組織単位、ロール割り当て、グループ対応、セッション |
| `security-admin`     | attach               | あり | ＋セッション、ペアリング、ポリシーのキルスイッチ              |
| `auditor`            | observe              | なし | 読み取り専用。監査チェーンとエビデンス（HTTP）も閲覧          |
| `department-manager` | attach               | あり | 部門長（組織単位に限定）                                      |
| `approver`           | attach               | あり | 作業キューの承認者（資格のみ）                                |
| `operator`           | attach               | あり | エージェントとルーティンを運用                                |
| `member`             | attach               | なし | エージェントとプロジェクトで作業                              |
| `viewer`             | observe              | なし | 閲覧                                                          |

人のスコープは持っているロールの中で最も高いものです。「承認」は承認系メソッド（`operator.approvals`）を使う資格のことで、それだけで作業項目のステージを決めることはありません。

ゲートウェイの `admin` スコープや `operator.admin` を与えるロールはありません。2 つの管理ロールは、代わりに限定された **管理領域** を開きます（`identity.whoami` の `adminAreas`）。

| 領域       | スコープ            | メソッド                                                                                                                                                     | ロール                           |
| ---------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------- |
| `identity` | `operator.identity` | `identity.*` の管理メソッド（ハンドラーが org-admin を確認）                                                                                                 | org-admin                        |
| `sessions` | `operator.identity` | `identity.sessions.list` / `.revoke`                                                                                                                         | org-admin、security-admin        |
| `pairing`  | `operator.pairing`  | `device.pair.*`、`node.pair.*`、`device.token.*`、`node.rename`                                                                                              | security-admin                   |
| `policy`   | `operator.policy`   | `policy.kill` / `policy.release`（`kill.mayFlip` では admin）                                                                                                | security-admin                   |
| `config`   | `operator.config`   | ホストレベルのメソッド：`config.*`、`wizard.*`、`update.*`、cron の編集、`skills.install` / `.update`、`sessions.patch` / `.delete`、`exec.approvals.*` など | `configRoles` に挙げたロールのみ |

`pairing` 領域にはスコープの上限があります。`device.pair.approve` と `device.token.rotate` は、呼び出し元自身が持つスコープ（`operator.write` は `operator.read` を含む）でだけデバイストークンを発行します。そのため security-admin が `operator.admin` や `operator.config` を与えることはできません。呼び出し元のスコープを超える要求は `scope_ceiling` で拒否し（監査）、トークンは返しません。

それ以外の場合、ホストレベルのメソッドには所有者（ゲートウェイホスト上のゲートウェイトークン）が必要です。人がホストの設定を変更できるようにするには、`gateway.identity.configRoles`（既定は空）で明示的に指定します。

ロールは **割り当て**（`person:<id>`、または初回サインイン前なら `email:<アドレス>` に対して。メールは信頼されたものとだけ一致。組織単位に限定可能）と **グループ対応付け**（下記）から来ます。管理メソッドは org-admin のみ（セッションは org-admin または security-admin）で、すべて監査され、`<KOLO_HOME>/identity/evidence/` にエビデンスとして封印されます。

| メソッド                                 | 用途                                                                  |
| ---------------------------------------- | --------------------------------------------------------------------- |
| `identity.whoami`                        | 人、ロール、組織単位、スコープ、セッション                            |
| `identity.org.get`                       | 組織単位。org-admin、security-admin、auditor には割り当て・対応・人も |
| `identity.org.update`                    | 組織名                                                                |
| `identity.units.upsert` / `.remove`      | 部門とチーム                                                          |
| `identity.roles.assign` / `.revoke`      | ロール割り当て                                                        |
| `identity.groupMappings.set` / `.remove` | IdP グループ → ロールと組織単位                                       |
| `identity.sessions.list` / `.revoke`     | SSO セッション                                                        |
| `identity.persons.link` / `.unlink`      | IdP の ID を人に結び付ける（管理者の承認）、またはリンクを外す        |
| `identity.persons.restore`               | SCIM で削除された人の墓標を解除                                       |

最初の org-admin ができるまでは、所有者（ゲートウェイトークン）がブートストラップ管理者としてこれらを変更できます。その後は org-admin か、ブレイクグラスのログインだけです。エージェントが ID を管理することはありません。

### グループ対応付け

グループ対応付けは **ソース** と **不変のグループ ID** を指定します。

| `source`        | `group`                                                 | 一致する人                                                 |
| --------------- | ------------------------------------------------------- | ---------------------------------------------------------- |
| `scim`          | SCIM グループの `id` または `externalId`                | SCIM がそのグループのメンバーにした人                      |
| プロバイダー id | そのプロバイダーが送る値（`groups` クレームまたは属性） | そのプロバイダーでの最後のサインインがその値を含んでいた人 |

```json5
// identity.groupMappings.set
{ source: "scim", group: "6f1c…-group-id", roles: ["approver"], units: ["finance"] }
{ source: "entra", group: "<Entra のグループオブジェクト ID>", roles: ["org-admin"] }
```

あるプロバイダーが送った値が別のプロバイダーの対応付けに一致することはなく、プロバイダーのクレームが `scim` の対応付けに一致することもありません。SCIM の表示名とは一致させません（IdP でグループ名を変更できる人なら誰でも変えられるため）。ただし SCIM の対応付けに限り、`matchDisplayName: true` で明示的に有効にできます。トークンでもグループのオブジェクト ID を使ってください（Entra ID は既定で ID を出します）。名前しか送らないプロバイダーでは名前がそのまま照合されるため、そこでグループを作成・改名できる人を制限してください。このスコープ導入前に書かれた対応付けは `source: "legacy"` として読み込まれ、設定し直すまで何とも一致しません。

### プロジェクトのアクセスと承認者

誰が承認するかは、これまでどおり作業項目のステージが決めます。プロジェクトのアクセスポリシーは、パーソン・プリンシパルを直接指定するか（`access.members[].principal: person:<id>`）、人が持つ次のグループにプロジェクトのロールを与えます。

| グループ ID                 | 持つ人                                                     |
| --------------------------- | ---------------------------------------------------------- |
| `role:<role>`               | そのロールを持つ全員                                       |
| `role:<role>@<unit>`        | その組織単位またはその上位の単位でそのロールを持つ人       |
| `unit:<unit>`               | その組織単位とその下のすべての単位のメンバー               |
| `group:scim:<id>`           | その SCIM グループ（id または externalId）のメンバー       |
| `group:<プロバイダー>:<値>` | そのプロバイダーでの最後のサインインがその値を含んでいた人 |

```yaml
access:
  groups:
    "role:approver": { roles: [approver] }
    "role:department-manager@sales": { roles: [approver], departments: [sales] }
```

したがって組織の `approver` ロールは、プロジェクトが対応付けた場所でだけ資格になり、部門フィールドのあるステージでは引き続きその部門が必要です。

## 人とみなす接続

人だけが行える操作（`workitems.decide`・`.delegate`・`.clearFlag`、オートパイロットの承認、`pause` / `resume`、`stopAll` / `startAll`、`autonomy.accept` / `.decline`、`reportError`、朝のブリーフ）は、接続が認証に使った資格情報で人かどうかを決めます。クライアントが自己申告する値（`client.mode`、`client.id`、`displayName`）では決めません。

| 接続                                                                      | ID 未設定          | ID 設定済み    |
| ------------------------------------------------------------------------- | ------------------ | -------------- |
| SSO セッション（`kss_…`）                                                 | 人                 | 人             |
| 理由付きのゲートウェイトークン・パスワード（ブレイクグラス、監査）        | 人                 | 人             |
| ゲートウェイトークン、パスワード、Tailscale、デバイストークン、ペアリング | 人（ローカルの人） | 人ではない     |
| エージェント：`mode: "backend"`、`gateway-client`、`agent`                | 常に人ではない     | 常に人ではない |

「ID 設定済み」とは、`gateway.identity` にプロバイダー、SCIM の有効化、`ssoRequired` のいずれかがある状態です。どれもない単一ユーザーの環境はこれまでどおり動作し、所有者がローカルの人です。`localPersons: true` を設定すると ID 設定済みでもこの動作を保ちます（SSO の導入中など）。`ssoRequired` では無視されます。自己申告のエージェント値は、人であることを取り消す方向にだけ働きます。

ID 設定済みで SSO 必須でない場合も、所有者は理由を明記すれば人として操作できます。CLI の `KOLO_BREAK_GLASS` または `connect.auth.breakGlass` に、ゲートウェイトークンかパスワードで、ゲートウェイホストから（`breakGlass.localOnly: false` の場合を除く）。下記のブレイクグラスと同様に監査・封印されます。

ブレイクグラスと `localPersons` が証明するのは、呼び出し元がゲートウェイトークンかパスワードを持っていることだけで、人がその場にいることではありません。ゲートウェイホストでシェルを使えるエージェントはトークンを読み、`KOLO_BREAK_GLASS` 付きで CLI を実行できます。そのため ID 設定済みでは、影響の大きい判断に SSO セッションが必要です：`workitems.decide`、`workitems.clearFlag`、`autopilot.approvals.create` / `.revoke`、`autopilot.autonomy.accept`、`autopilot.startAll`。ブレイクグラスの所有者は管理と復旧の権限（ID 管理、`pause`、`autopilot.stopAll`、その他の人だけが行える操作）を保ちます。`stopAll` は意図的に残しています：IdP 障害中でも緊急停止が効く必要があるためです。ID 設定のない単一ユーザーの環境は変わらず、所有者がこれまでどおり判断します。

## SSO 必須とブレイクグラス

`ssoRequired: true` では、人は SSO でサインインする必要があります。人によるゲートウェイトークン、パスワード、ペアリング資格情報、デバイストークン、Tailscale のログインは拒否します。引き続き受け付けるのは、SSO セッション、ペアリング済みデバイスのノード接続（ノードのデバイストークン、またはその後デバイスペアリングを通るデバイス ID。ゲートウェイトークンだけではノードは接続できず、`identity.sso_required.node` として監査）、ゲートウェイホスト自身からのエージェント接続です（エージェント接続は毎回 `identity.sso_required.agent` として監査され、人とはみなしません）。HTTP では、ゲートウェイトークンとペアリング資格情報はゲートウェイホストからだけ使えます。そこでのゲートウェイトークンもブレイクグラス扱いで、各リクエストに `X-KoLo-Break-Glass: <理由>`（非 ASCII はパーセントエンコード）が必要で、`identity.breakglass.http` として監査されます。ない場合は 401 で拒否します。CLI の HTTP コマンドは `KOLO_BREAK_GLASS` をこのヘッダーとして送ります。共有シークレットを受け付けるすべての HTTP パス（宣言済みルート、`/api/admin/*` と `/metrics`、Canvas・A2UI・アバターのルート）に同じ検査を適用します。別のホストからのゲートウェイトークンは、理由の有無にかかわらず拒否します（有効なトークンの拒否は `identity.sso_required` として監査）。Canvas・A2UI・アバターのルートは代わりに SSO セッションを受け付けます。`/api/admin/*` の従来の管理セッション（`kolo_session`）はゲートウェイホストからのみ受け付けます。

**ブレイクグラス** は、理由を明記したゲートウェイトークンまたはパスワードによるログインで、ゲートウェイホストからのみ可能です（`breakGlass.localOnly: false` の場合を除く）。ブレイクグラスのログインごとに、理由付きで `identity.breakglass.login` の監査記録とエビデンスバンドルを残します。CLI は理由を環境変数から送ります。

```bash
KOLO_BREAK_GLASS="IdP 障害、変更チケット 4711" kurahi status
```

WebSocket のハンドシェイクでは、理由は `connect.auth.breakGlass` です。ブレイクグラスの所有者は ID 管理メソッドを使えます。

**「ゲートウェイホスト」の意味**：ソケットの接続元がループバックで、`Host` が `localhost`、`127.0.0.1`、`::1` または `*.ts.net` の名前であり、かつ転送ヘッダー（`X-Forwarded-For`、`X-Real-IP`、`X-Forwarded-Host`）を含まないか、接続元が `gateway.trustedProxies` にあり、そのプロキシが転送したクライアントアドレスもループバックであるリクエストを、ゲートウェイホストからとみなします。転送ヘッダーを送ってもクライアントアドレスを示さない信頼済みプロキシ（`X-Forwarded-Host` のみ）は、リクエストをローカルにしません。

**プロキシの背後のクライアントアドレス**：クライアントアドレスはすべての箇所（ゲートウェイホスト判定、認証試行リミッター、HTTP と WebSocket のスロットル、デバイスの自動承認、監査記録）で一つのリゾルバーが決めます。ソケットの接続元が `gateway.trustedProxies` にない限り、接続元がクライアントです。ある場合は `X-Forwarded-For` を右から読み、信頼済みプロキシのエントリーを飛ばして、最初の信頼されていないエントリーをクライアントとします。クライアント自身がヘッダーに書いた値（例：`X-Forwarded-For: 127.0.0.1`）は信用されません。`X-Forwarded-For` がない場合は `X-Real-IP` を使います。アドレスは正規化して比較します（`::ffff:127.0.0.1` は `127.0.0.1`、ポートと角括弧は無視）。`gateway.trustedProxies` の値も同様です。すべてのプロキシのホップを `gateway.trustedProxies` に登録し、プロキシを次のように設定してください。

- `X-Forwarded-For` を受け付けた接続元のアドレスで上書きする（または右端のエントリーになるよう追記する）。`X-Real-IP` と `X-Forwarded-Host` は上書きする。
- クライアントの `Host` をそのまま渡さず、プロキシ自身が `Host` を設定する。

注意：同じホスト上のリバースプロキシがループバックで接続し、`X-Forwarded-For` を付けない（または `Host` を `localhost` に書き換える）と、プロキシ経由のすべてのリクエストがローカルに見えます。その場合「ゲートウェイホストからのみ」のブレイクグラス、ローカルのエージェント例外、ローカルの HTTP 規則がリモートの利用者に適用されてしまいます。同じホストのプロキシの背後では、`X-Forwarded-For` を送らせ、`gateway.trustedProxies` に登録してください。

## HTTP エンドポイント

| メソッドとパス                              | 認証           | 用途                                                   |
| ------------------------------------------- | -------------- | ------------------------------------------------------ |
| `GET /api/identity/sso`                     | なし           | 表示するプロバイダー、SSO 必須かどうか                 |
| `GET /api/identity/sso/{provider}/login`    | なし           | サインイン開始                                         |
| `GET /api/identity/sso/{provider}/callback` | なし           | OIDC リダイレクト URI                                  |
| `POST /api/identity/sso/{provider}/acs`     | なし           | SAML ACS                                               |
| `GET /api/identity/sso/{provider}/metadata` | なし           | SAML SP メタデータ                                     |
| `POST /api/identity/sso/exchange`           | なし           | ワンタイムコードをセッショントークンに交換（1 回のみ） |
| `GET /api/identity/session`                 | SSO セッション | サインイン中の人                                       |
| `POST /api/identity/logout`                 | SSO セッション | セッション終了                                         |

SSO セッショントークンは、エビデンスと監査チェーンのルートでも `Authorization: Bearer` として受け付けます。auditor は observe スコープでもこれらを閲覧できます。人がジョブのエビデンス（`/api/jobs/{id}/evidence…`、`/evidence/{id}`）を閲覧できるのは、次の場合だけです。

- 組織単位に限定されない `org-admin` または `auditor` を持つ（すべてのジョブ）。
- ジョブがプロジェクトのセッションで実行され、そのプロジェクトのアクセスポリシーが、`access.members` で直接、または `access.groups` のエクスポートされたグループ（`role:<role>`、`role:<role>@<unit>`、`unit:<unit>`、`group:<IdP グループ>`）を通じて本人を挙げている。プロジェクトのメンバー、組織単位のメンバー、プロジェクトが指定する承認者と管理者が含まれます。
- 組織単位に限定された `auditor` または `org-admin` を持ち、プロジェクトの `access.groups` がその組織単位またはその下位の単位（`unit:<unit>` または `role:<role>@<unit>`）を挙げている。

それ以外のジョブ（プロジェクトなし、または本人を挙げていないプロジェクト）は 404 になります。ペアリング資格情報とゲートウェイトークンには従来の規則が適用されます。失敗したサインインは、接続元ごとの認証試行の上限に数えられます。スキーマ全体は [OpenAPI 文書](/gateway/protocol) にあります。

## Console

ゲートウェイに SSO プロバイダーがあると、概要ページに **Sign in with …** ボタンが表示されます。サインイン後は、人、ロール、セッションの終了時刻と **Sign out** が表示されます。サインイン後のリダイレクトで Console に戻るには、Console をゲートウェイから配信する必要があります（既定の構成）。
