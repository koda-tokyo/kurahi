# インシデント対応の流れ / Incident response

1. **検知 / Detect** — Guardian の検査・スキャン・ランサムウェアシールド・Defender のアラートが案件を作成します。
   Guardian checks, scans, the ransomware shield or Defender alerts open a case.
2. **初動 / First response** — 情報セキュリティ担当が 4 時間以内に確認します。重大度が high 以上は経営層へ。
   IT security reviews within 4 hours; high and critical go to management.
3. **封じ込め / Contain** — Kurahi が自動で行うのは、Kurahi 内のエージェント停止と隔離用コピーのみです。
   端末の隔離・バックアップからの復元・ファイルの移動や削除は、必ず人が判断します。
   Kurahi only stops its own agents and stores quarantine copies; isolating machines, restoring backups,
   moving or deleting files are always decided by a person.
4. **報告 / Report** — 証跡（Kurahi の署名付き記録）を添えて、社内規程と法令（個人情報保護委員会への報告等）に従い報告します。
   Report with the signed evidence, following company rules and the law (e.g. the PPC breach report).
