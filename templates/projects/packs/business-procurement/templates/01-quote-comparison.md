# Quote comparison / 相見積比較

Review draft only. A person decides; this worksheet is not an award or an order.
レビュー下書きです。人が決定します。この用紙は取引先の選定や発注の完了を示しません。

Request reference / 依頼参照:
Prepared by and date / 作成者・日付:
Currency and price basis (check they match) / 通貨・価格条件（同一条件を確認）:

## Requested scope / 依頼範囲

| Item code / 品目コード | Description / 内容 | Requested quantity / 依頼数量 |
| ---------------------- | ------------------ | ----------------------------- |

## Source offers / 見積原本

Record each supplier and item. Preserve missing items and quantity differences; never invent
prices or substitute zero. Check values against each source.
取引先・品目ごとに記入し、欠落や数量差を残します。価格の推測やゼロへの置き換えは行わず、原本と照合します。

| Supplier / 取引先 | Source and page / 原本・ページ | Item code / 品目 | Quoted quantity / 見積数量 | Unit price / 単価 | Tax rate / 税率 | Discounts / 値引き |
| ----------------- | ------------------------------ | ---------------- | -------------------------- | ----------------- | --------------- | ------------------ |

### Spreadsheet sources / 表計算ファイルの原本

Preserve the original and compared copy. Check imported values; do not omit refused rows.
Record the file and full returned SHA-256, or “not recorded”. A hash is not approval or authenticity.
After revisions, record and compare the offer again and have a person review the selection.
原本と比較用コピーを保存し、読込値を照合します。拒否された行を省略しません。
ファイルと完全なハッシュ（なければ「未記録」）を記録します。ハッシュは承認や真正性の証明ではありません。
改訂後は再登録・再比較し、人が選定を見直します。
Setup and ledger / 設定・記録表: [Procurement evidence](/business/procurement-evidence).

## Whole-request comparison / 依頼全体の比較

If `office_quote_compare` is available, compare at least two suppliers against the same scope.
Copy the result here; the tool does not save this worksheet.
Do not label an incomplete quote lowest overall. Item-level lowest prices do not establish
whole-request eligibility. Keep all ties; if none is complete, record “no comparable complete quote”.
officeプラグインで `office_quote_compare` が利用可能なら、2社以上と同じ依頼範囲を入力し、結果を転記します。
ツールはこの用紙を保存しません。不完全な見積を全体の最安にせず、品目ごとの最安と区別します。
同額の最安はすべて残し、完全な見積がなければ「比較可能な完全見積なし」と記録します。

| Supplier / 取引先 | Net before tax / 税抜純額 | Missing codes / 欠落品目 | Quantity differences / 数量差 | Complete / 完全 | Overall lowest / 全体最安 |
| ----------------- | ------------------------- | ------------------------ | ----------------------------- | --------------- | ------------------------- |

## Human review / 人による確認

| Supplier / 取引先 | Delivery / 納期 | Valid until / 有効期限 | Payment terms / 支払条件 | Quality and risks / 品質・リスク |
| ----------------- | --------------- | ---------------------- | ------------------------ | -------------------------------- |

Reviewer, decision and reason / 確認者・判断・理由:
Approval reference / 承認参照:
Order confirmation reference (only after a person places the order) / 発注確認参照（人による発注後のみ）:

Approval or lowest price does not prove ordering. This worksheet does not automate comparison,
update review fields or contact suppliers.
承認や最安表示は発注済みの証明ではありません。この用紙は自動比較・承認項目の更新・取引先への連絡を行いません。
