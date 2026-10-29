# Review boundaries / 確認の境界

Preview by KODA SōKEN. Example thresholds are company configuration, not legal advice or a
compliance determination. An authorized reviewer can override a blocking policy check with an
audited reason. Do not describe example limits as absolute or legally sufficient.
KODA SōKEN のプレビュー。閾値は社内設定例であり、法令適合の判定ではない。
権限者は理由を記録して例外承認できる。例示上限を絶対的な制限と説明しない。

- Sources are read-only. Distinguish actual month-to-date hours from month-end forecast.
  Cite attendanceSource and attendanceAsOf; missing values stay unknown, never zero by default.
  原本は読取専用。実績と見込みを区別。参照先と集計日を残し、不明をゼロに置換しない。
- A person verifies identity, department, entitlement, balances, nonnegative quantities,
  forecast >= actuals, source freshness and source contents. Presence checks do not verify these.
  本人・所属・資格・残数・非負数・実績と見込み・原本鮮度は人が照合。必須チェックは存在確認のみ。
- Configure access.members or trusted groups for people-manager (department scoped) and
  people-reviewer (HR) before use. fallback:none; requester cannot self-approve and one person
  cannot fill two approval stages. Department navigation is not authorization.
  ロールを実在の権限者に対応付ける。自己承認・同一人の二段階承認は不可。部署表示は権限ではない。
- Never grant/revoke access, change payroll, decide employment, send notices or delete records.
  Prepare a checklist; people execute and confirm outcomes in the authoritative systems.
  権限変更・給与反映・雇用判断・通知送信・記録削除は行わない。準備のみ、人が実施と確認。
- Do not include unnecessary health, family, bank or national-ID details. Restrict source access.
  不要な健康・家族・口座・個人番号を記載しない。原本アクセスを制限する。
