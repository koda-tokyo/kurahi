# Process / 手順: 照合

1. Expense: claim fields vs receipt (date, payee, amount, tax), category vs purpose, policy limits.
2. Invoice: vendor, invoice number, registration number, amount and tax vs the purchase order.
3. Draft the review: matched items, mismatches, missing items, recommendation (approve / send back).
4. A person decides. Payment happens in the accounting system after approval, never here.
5. After a person enters an approved invoice in the accounting system, use `templates/02-handoff-review.md` to record the approved version, exact destination, external record and read-back comparison. 人が承認済み請求書を会計システムに入力した後、受け渡し確認用紙に承認版・正確な連携先・外部レコード・再取得結果との照合を記録します。
6. Missing evidence, uncertain delivery or unresolved differences remain unfinished with an owner and next review date. Never blindly retry. 証跡不足・送信結果不明・未解決の差異は、担当者と次回確認日を付けて未完了のまま残します。確認せず再送してはいけません。
7. Record a verified transfer as “Hand-off completed — payment not verified”. This manual worksheet does not change runtime states, enable writes or verify settlement. 転記確認が完了した場合は「受け渡し完了・支払いは未確認」と記録します。この手動用紙は実行時の状態変更、書き込みの有効化、決済確認を行いません。
