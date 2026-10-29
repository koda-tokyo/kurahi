# Request flow / 依頼手順

1. Select this Project template. A person fills a requests/\*.md form. These are Markdown
   forms, not dedicated UI forms. Copy facts into source.fields using workitems.create/update.
   本テンプレートで作成し、人が申請書を記入。専用UIではなくMarkdown原本。
   workitems.create/update で項目を転記する。
2. Mail intake is disabled until an operator configures the dedicated mailbox, mail read,
   mail draft opt-in and routine enablement. It creates er-triage items and drafts only.
   メール受付は既定で無効。専用受信箱・読取・下書き許可・ルーチン有効化を設定。
3. A coordinator reviews mail identity and flags, chooses the category, and updates the SAME
   item's queue and source.fields with expectedRevision. Preserve existing source fields (including mail/run attribution); fields updates replace the map. Do not duplicate the mail item.
   担当者が本人・フラグを確認し、同一項目のキューと項目を版指定で更新。既存のメール・実行参照項目を保持（fields は全体置換）。重複登録しない。
4. Category routing / 分類先: equipment/IT → er-equipment (IT), business cards → er-cards
   (General Affairs), rooms/facilities → er-facilities, certificates → er-certificates (HR).
   Unclear requests remain er-triage until clarified. Triage review is not category approval.
   不明な依頼は受付に残し確認。受付確認を各カテゴリの承認とみなさない。
5. Required fields and dates must pass for normal approval. Target lead time is 2 calendar days,
   not business days. SLA: triage 24h; equipment/cards 48h; facilities/certificates 72h.
   不足・日付を確認。希望日は2暦日以上先。受付24時間、備品・名刺48時間、施設・証明書72時間。
6. Submit for the configured reviewer route. Equipment above JPY 100,000 requires a distinct
   budget approver; above JPY 500,000 blocks normal approval. Company thresholds are examples.
   担当者承認へ提出。備品10万円超は別人の予算承認、50万円超は通常承認を停止。金額は設定例。
   The engine permits an authorized policy override with a recorded reason; this is not an absolute spending cap.
   既存エンジンは理由を記録した権限者の例外承認を許すため、絶対的な支出上限ではない。
7. A person sends the acknowledgement, performs approved work in the system of record,
   records the actual outcome in requests/fulfillment.md, and marks done after verification.
   Queue status is not delivery confirmation.
   人が送信・実施し、requests/fulfillment.md に結果を記録・確認して完了。キュー状態は配送・交付の確認ではない。

No automatic notifications, bookings, linked cases, HR issuance or accounting writes ship here.
The coordinator checks overdue items and contacts reviewers manually. Routine mail ownership is
not the authenticated employee's My requests identity. Do not promise employee self-service
tracking for mail intake. Calendar slots and same-day bookings need a separate manual check.
通知・予約・案件連携・証明書交付・会計書込は自動化しない。期限超過は担当者が連絡。
メール受付の所有者は申請者本人の認証IDではない。「自分の申請」への自動反映を約束しない。
