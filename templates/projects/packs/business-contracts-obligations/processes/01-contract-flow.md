# Contract flow / 契約業務

1. Register: a person fills contracts/register.md, checks source references and documentVersion and records co-register (request). contract-coordinator reviews the register; historical start/end dates are allowed.
   台帳: 人が register.md を記入し原本と documentVersion を確認、co-register に登録。contract-coordinator が確認。過去の契約期間も登録可。
2. Review: capture a specific question and documentVersion in co-review; legal-reviewer reviews. Record decisions against the exact source version, and obtain any company-required approvals outside this starter route.
   レビュー: co-review に確認事項と版を記録。legal-reviewer が確認。会社規程上の追加承認は別途取得。
3. Renewal: owner verifies renewalOn, noticeBy and noticeMethod against the contract in co-renewals; contract-reviewer checks. Human schedules and sends notices. Already overdue notice dates fail submission checks and require separate escalation.
   更新: 担当者が更新日・通知期限・通知方法を原本と照合、contract-reviewer が確認。予定登録・送付は人。過去の通知期限は検証失敗となるため別途エスカレーション。
4. Obligations: create one co-obligations request per obligation with an owner, dueOn and evidenceRequired; obligation-reviewer reviews. Owner tracks fulfillment and attaches evidence manually.
   履行義務: 義務ごとに担当者・期限・必要証跡を記録、obligation-reviewer が確認。履行追跡・証跡登録は人。
5. Signature: after human approvals, co-signature references approvedVersion and authorizedSigner. signature-coordinator checks the handoff only. An authorized human signs externally and records the signed version and evidence; route approval never proves signature.
   署名: 人の承認後、co-signature に承認版と署名権限者を記録。signature-coordinator は引継ぎ確認のみ。署名と署名済み原本・証跡登録は人が外部で実施。経路承認は署名完了を意味しない。

Preserve the true overdue date in the source and escalation record; never move it forward just to pass validation.
期限超過の場合も原本・エスカレーション記録に実際の期限を保持し、検証を通すために未来の日付へ変更しない。

Use the manual evidence sections in contracts/renewals.md and contracts/obligations.md to record source clauses, date reasoning, human follow-up and confirmed outcomes. These notes are not automatically imported or validated.
renewals.md と obligations.md の手動証跡欄に原本条項・日付の根拠・人の追跡対応・確認済み結果を記録。メモの自動取込・検証はしません。

Use the manual decision record in contracts/review.md to retain the reviewed version, findings and approval references. Changed source terms require a new review request and any required human reapproval; the starter does not detect changes or invalidate previous decisions automatically.
review.md の手動判断記録に確認した版・所見・承認参照を保持します。原本の条件変更時は新しいレビュー依頼と必要な人の再承認が必要です。変更検出や以前の判断の自動失効処理はありません。
