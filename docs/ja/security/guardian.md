---
summary: "Kurahi Guardian：共有フォルダへのランサムウェアシールド、定期的なウイルス検査（ClamAV・Microsoft Defender・YARA、失敗時は要確認）、夜間のセキュリティ点検、インシデント案件、SIEM 連携、JPCERT/CC・IPA の注意喚起、Microsoft Defender のアラート"
read_when:
  - Kurahi で社内の共有フォルダをランサムウェアから守る
  - 定期ウイルス検査、バックアップ・復元確認、セキュリティ点検を設定する
  - Kurahi の監査ログとセキュリティイベントを SIEM に送る
  - Guardian ができること・しないことについてセキュリティレビューの質問に答える
title: "Kurahi Guardian"
---

# Kurahi Guardian

English: [Kurahi Guardian](/security/guardian)

Guardian は Kurahi Core のセキュリティ機能で、すべてのエディションで使えます。実績のあるエンジンと
決定的な検査が問題を見つけ、エージェントが日本語または英語で説明し、すべての検知が署名付きの証跡を
持つインシデント案件になります。対応を決めるのは人です。

Guardian は EDR（Microsoft Defender for Endpoint、CrowdStrike など）を**補完**するものです。EDR や
認定ウイルス対策製品ではなく、検知率の約束もしません。

## 原則

1. **判定は検査、説明は AI。** マルウェアかどうか、検査に合格したかを AI が決めることはありません。
   検査は `verdict OK` または `verdict ESCALATE` で終わり、コードが判定します。
2. **実績のあるエンジン。** 検査は ClamAV、Microsoft Defender、YARA で行います。
3. **失敗は要確認。** タイムアウト、異常終了、読めない結果、未設定、`enabled: false` は `ESCALATE`
   であり、`OK` にはなりません。
4. **封じ込めは限定的。** 自動で行うのは Kurahi 内のことだけです（ランサムウェアシールドによる全
   エージェントの停止、共有フォルダ検査での隔離コピーの保存）。端末の隔離、バックアップからの復元、
   社内ファイルの移動・削除は人が決めます。Kurahi はファイルを削除しません。
5. **すべてに証跡。** 検査、スキャン、シールドの作動、判断はハッシュチェーンの監査ログに残ります。

## 設定

ゲートウェイ設定の `guardian` にまとめて記述します。設定例と各項目は
[英語版](/security/guardian#configuration) と同じです。

| 項目                          | 既定値       | 意味                                                                     |
| ----------------------------- | ------------ | ------------------------------------------------------------------------ |
| `enabled`                     | `true`       | `false` ですべての検査が `ESCALATE` になり、共有フォルダはシールド対象外に |
| `shares[]`                    | なし         | ランサムウェアシールドと検査の対象となる社内フォルダ（絶対パス）         |
| `scan.engine`                 | `auto`       | 検査エンジン。YARA は明示したときだけ                                    |
| `scan.quarantine.mode`        | `copy`       | `copy` は原本を残す。`move` は原本も隔離フォルダへ移動（同一ドライブのみ）|
| `posture.backups[]`           | なし         | バックアップの鮮度（`maxAgeHours`、既定 26 時間）と任意の復元テスト      |
| `posture.secretScanRoots`     | なし         | 鍵・トークン・パスワードの置き忘れを探すフォルダ                         |
| `posture.allowedPorts`        | なし         | 待ち受けを許可する TCP ポート。それ以外は検知                            |
| `posture.credentialWarnDays`  | 14           | この日数以内に期限切れとなる Kurahi のサインインを検知                   |
| `siem`                        | 無効         | 監査ログと Guardian のイベントを syslog で送信                           |
| `advisories`                  | 無効         | JPCERT/CC・IPA の注意喚起と、照合する製品名                              |

## 共有フォルダのランサムウェアシールド

シールド（おとりファイル、エントロピーの急上昇、脅迫文）は 2.0 から Kurahi 自身のフォルダを守って
きました。`guardian.shares` を設定すると、社内の共有フォルダも守ります。作動するとすべての
エージェントを停止して記録します。サーバー上の他のプログラムには触れません。

## 検査

| 検査                    | 内容                                                                          |
| ----------------------- | ----------------------------------------------------------------------------- |
| `guardian_backup`       | 各バックアップが `maxAgeHours` より新しいか                                   |
| `guardian_restore_test` | `restoreTest` のバックアップからサンプルを復元し、ハッシュが一致するか（tar・zip）|
| `guardian_secrets`      | `secretScanRoots` 内のファイルに残った鍵・トークン・パスワード                |
| `guardian_ports`        | 待ち受け中の TCP ポートと `allowedPorts` の照合                               |
| `guardian_integrity`    | Kurahi 自身のファイルの完全性                                                 |
| `guardian_credentials`  | Kurahi が保存するサインインの有効期限                                         |
| `guardian_scan`         | 共有フォルダの差分検査。感染ファイルは SHA-256 とシグネチャで記載             |

## インシデント案件：core-guardian パック

**セキュリティ — Kurahi Guardian**（`core-guardian`）からプロジェクトを作成します。

- **セキュリティインシデント** キュー（情報システム部門、目標 24 時間）
- チェック：概要と証跡が必須。人が確認する前に「駆除済み」「復旧済み」「安全」と書くことを拒否
- 承認ルート：情報セキュリティ担当が 4 時間以内に確認（8 時間で部門長へエスカレーション）。
  優先度 `high`・`urgent` は経営層の判断も必要
- 要確認となった検査は必ず案件になります。AI が取り上げなかった場合も、Kurahi が検査結果を添えて起票します。
  共有フォルダ検査で問題がなければ、AI は呼び出しません。
- ルーチン（L1 準備のみ）：**guardian-posture** 毎晩 2:15、**guardian-shares** 毎晩 1:30

## SIEM 連携

`guardian.siem` を設定すると、ゲートウェイが記録する監査ログと Guardian の検査結果を、RFC 5424
（構造化データ `kurahi@32473`）または CEF 形式の syslog で、TCP・TLS（`ca` 指定）・UDP により送信
します。送信がゲートウェイを止めることはなく、値は送信前にマスクされます。

## 注意喚起（JPCERT/CC・IPA）

`guardian_advisories` は許可された URL の JPCERT/CC と IPA のフィードだけを読み（リダイレクト不可）、
`advisories.products` の製品名を含む注意喚起に印を付けます。

## Microsoft Defender のアラート

Microsoft 365 コネクタのオプション `security.alerts` を `true` にすると、`m365_security_alerts`
（Microsoft Graph Security `alerts_v2`、読み取りのみ、権限 `SecurityAlert.Read.All`）が使えます。

## Guardian がしないこと

- 端末の EDR やウイルス対策ソフトの代わりにはなりません。
- ファイルの削除・駆除・復元、端末の隔離は行いません。
- サインイン情報の更新や書き換えは行いません。
