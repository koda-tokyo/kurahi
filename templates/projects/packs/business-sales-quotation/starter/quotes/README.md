# 見積の設定 / Quotation setup

## 日本語

- `price-list.csv`：価格表（税抜単価）。列は 品番・品名・単価（必須）、単位・税率・原価（任意）。
  税率は 10% / 8% / 0%（空欄は 10%）。Excel で編集し、「CSV UTF-8」または「CSV」で保存できます。
  サンプルの行を自社の品目に置き換えてください。
- Excel ブック（`.xlsx`）も価格表として使用できます。人がこのフォルダーに保存し、
  見積作成時に `price_list: quotes/<ファイル名>.xlsx` で指定してください。
  列は CSV と同じです。最初の表示シートだけを読み取るため、対象の価格表を最初に置いてください。
  数式は再計算せず、保存された結果を読み取ります。表計算ソフトで再計算・保存してから使用し、
  保存結果のない数式やエラーセルがある行は修正してください。読み取りを拒否された場合は、
  元のブックを残して CSV に保存し、品番・単価・税率・原価を人が確認してから再指定してください。
- `company.json`：発行者名、住所、電話、適格請求書発行事業者登録番号（`registrationNumber`、T＋13桁）、
  端数処理（`lineRounding`・`taxRounding`：`floor` 切り捨て / `round` 四捨五入 / `ceil` 切り上げ）。
- 消費税は税率ごとに1回だけ端数処理します（インボイス制度）。単価と合計は Kurahi が計算し、
  エージェントは品目と数量だけを読み取ります。価格表にない品目は【要確認】になります。
- 価格表を変更したら、担当者が品番の重複、税抜単価、税率、原価を確認してください。
  単価と原価は小数第2位までです。表示上の丸めだけでは保存値は変わりません。
  桁数の多い値を自動で丸めることはないため、担当者が正しい値を確認して修正してください。
- 修正後は見積書を再作成し、価格表の問題と【要確認】の品目を確認してください。
  既存の見積書や返信の下書きは、価格表を保存しただけでは更新されません。
  承認・送信の前に、再作成した見積書の品目、数量、単価、税率と添付ファイルを確認してください。
- 価格の確認日、確認者、根拠となる価格表の版を案件に記録してください。
  ファイルの更新日時だけでは、価格が現在も有効かは確認できません。
- このフォルダーは読み取り専用です。価格の変更は人が行います。

## English

- `price-list.csv`: the price list (tax-exclusive unit prices). Columns 品番 / code, 品名 / name,
  単価 / unit price (required), 単位 / unit, 税率 / tax rate, 原価 / cost (optional). Tax rate 10, 8 or
  0 (blank = 10). Edit in Excel and save as CSV (UTF-8 or the Japanese default). Replace the samples.
- An Excel workbook (`.xlsx`) can also be the price list. A person saves it in this folder;
  select it when preparing the quotation with `price_list: quotes/<filename>.xlsx`.
  Use the same columns as CSV. Only the first visible sheet is read, so put the intended
  price sheet first. Formulas are not recalculated: Kurahi reads their saved results.
  Recalculate and save in your spreadsheet application before use; correct rows with
  missing formula results or error cells. If the workbook is refused, keep the original,
  save a CSV copy, and have a person check codes, prices, tax rates and costs before selecting it.
- `company.json`: issuer name, address, phone, qualified-invoice registration number
  (`registrationNumber`, T + 13 digits) and rounding (`floor`, `round`, `ceil`).
- Tax is rounded once per rate per document (qualified-invoice rule). Kurahi computes prices and
  totals; the agent only reads items and quantities. Items not in the price list are 【要確認】.
- After changing the list, a person checks duplicate item codes, tax-exclusive unit prices, tax
  rates and costs. Unit prices and costs allow at most two decimal places. Display formatting
  does not change the saved value. Excess precision is refused rather than rounded automatically;
  a person must confirm and correct the intended value.
- Prepare the quotation again after correcting the list and review price-list problems and
  【要確認】 items. Saving the list alone does not update existing quotations or reply drafts.
  Before approval and sending, check the regenerated quotation's items, quantities, prices,
  tax rates and attached files.
- Record the price confirmation date, reviewer and source price-list version in the case.
  A file's modification time alone does not establish that its prices are current.
- This folder is read-only for agents. People change prices.
