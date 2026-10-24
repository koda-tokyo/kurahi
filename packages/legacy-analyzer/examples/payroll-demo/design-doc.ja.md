# 設計書（ソースコードから生成）：industry-legacy-cobol

> 本書の記載はすべてソースコードから決定的に抽出した事実です。各行の `path:line` は根拠となるソースの位置を示します。業務上の意図など、コードから導けない事項は「要確認」として明示し、担当者の記入を前提としています。
>
> 解析対象：7 ファイル、ソース指紋 sha256:5786adeb80741427

## 目次

1. システム概要
2. ジョブフロー
3. プログラム仕様書
4. データ項目定義書
5. CRUD マトリクス
6. カバレッジと要確認事項

## 1. システム概要

### 1.1 資産一覧

| 種別 | 名称 | ファイル | 行数 | 根拠 |
| --- | --- | --- | --- | --- |
| COBOL プログラム | PAYCALC | source/cobol/PAYCALC.cbl | 215 | `source/cobol/PAYCALC.cbl:1` |
| COBOL プログラム | PAYRND | source/cobol/PAYRND.cbl | 64 | `source/cobol/PAYRND.cbl:1` |
| COBOL プログラム | PAYRPT | source/cobol/PAYRPT.cbl | 315 | `source/cobol/PAYRPT.cbl:1` |
| COBOL プログラム | PAYVAL | source/cobol/PAYVAL.cbl | 178 | `source/cobol/PAYVAL.cbl:1` |
| コピーブック | EMPREC | source/copybook/EMPREC.cpy | 46 | `source/copybook/EMPREC.cpy:1` |
| コピーブック | PAYREC | source/copybook/PAYREC.cpy | 33 | `source/copybook/PAYREC.cpy:1` |
| JCL ジョブ | PY01MNTH | source/jcl/PY01MNTH.jcl | 49 | `source/jcl/PY01MNTH.jcl:1` |

上表とグラフの集計：プログラム 4 本、コピーブック 2 本、ジョブ／プロシージャ 1 本、ジョブステップ 4、段落 33、文 314、ソースのない呼出し先・実行プログラム 1。

### 1.2 プログラム関連図

```mermaid
flowchart LR
  n1["PAYCALC"]
  n2["PAYRND"]
  n3(["PY01MNTH.STEP010"])
  n4["PAYVAL"]
  n5(["PY01MNTH.STEP020"])
  n6[/"SORT"/]
  n7(["PY01MNTH.STEP030"])
  n8(["PY01MNTH.STEP040"])
  n9["PAYRPT"]
  n1 -->|static| n2
  n3 -->|EXEC| n4
  n5 -->|EXEC| n6
  n7 -->|EXEC| n1
  n8 -->|EXEC| n9
```

> 実線：静的 CALL またはステップの EXEC。破線：動的 CALL（呼出し先がデータ項目）。平行四辺形の枠：ソースのないプログラム、動的な呼出し先。各矢印の根拠行は次の表に記載しています。

### 1.3 関連一覧（根拠付き）

| 元 | 関係 | 先 | 件数 | 根拠 |
| --- | --- | --- | --- | --- |
| PAYCALC | CALL (static) | PAYRND | 9 | `source/cobol/PAYCALC.cbl:140` `source/cobol/PAYCALC.cbl:147` `source/cobol/PAYCALC.cbl:155` `source/cobol/PAYCALC.cbl:158` `source/cobol/PAYCALC.cbl:161` `source/cobol/PAYCALC.cbl:178` +3 |
| PY01MNTH.STEP010 | EXEC（ステップがプログラムを実行） | PAYVAL | 1 | `source/jcl/PY01MNTH.jcl:17` |
| PY01MNTH.STEP020 | EXEC（ステップがプログラムを実行） | SORT | 1 | `source/jcl/PY01MNTH.jcl:25` |
| PY01MNTH.STEP030 | EXEC（ステップがプログラムを実行） | PAYCALC | 1 | `source/jcl/PY01MNTH.jcl:35` |
| PY01MNTH.STEP040 | EXEC（ステップがプログラムを実行） | PAYRPT | 1 | `source/jcl/PY01MNTH.jcl:44` |

## 2. ジョブフロー

### 2.1 JCL ジョブ PY01MNTH (`source/jcl/PY01MNTH.jcl:1`)

| 記号パラメータ | 値 | 根拠 |
| --- | --- | --- |
| `PERIOD` | `202609` | `source/jcl/PY01MNTH.jcl:14` |

```mermaid
flowchart TD
  n1["STEP010: PAYVAL"]
  n2[("KZP.PY01.TIMECARD.M202609")]
  n3[("#38;#38;VALID (PY01MNTH)")]
  n4["STEP020: SORT"]
  n5[("#38;#38;SORTED (PY01MNTH)")]
  n6["STEP030: PAYCALC"]
  n7[("KZP.PY01.PAYCALC.M202609")]
  n8["STEP040: PAYRPT"]
  n2 -->|EMPIN| n1
  n1 -->|VALIDOUT| n3
  n1 ==> n4
  n3 -.->|SORTIN OLD| n4
  n4 -->|SORTOUT| n5
  n4 ==> n6
  n5 -->|PAYIN| n6
  n6 -->|PAYOUT| n7
  n6 ==> n8
  n7 -->|PAYIN| n8
```

| # | ステップ | プログラム | PARM | COND | 根拠 |
| --- | --- | --- | --- | --- | --- |
| 1 | STEP010 | PAYVAL |  |  | `source/jcl/PY01MNTH.jcl:17` |
| 2 | STEP020 | SORT (ソースなし) |  | `(8,LE,STEP010)` | `source/jcl/PY01MNTH.jcl:25` |
| 3 | STEP030 | PAYCALC | `202609` | `((8,LE,STEP010),(0,NE,STEP020))` | `source/jcl/PY01MNTH.jcl:35` |
| 4 | STEP040 | PAYRPT | `202609` | `((8,LE,STEP010),(0,NE,STEP030))` | `source/jcl/PY01MNTH.jcl:44` |

| ステップ | DD | データセット | DISP | アクセス（DISP より） | プログラムのファイル（SELECT） | 根拠 |
| --- | --- | --- | --- | --- | --- | --- |
| STEP010 | EMPIN | `KZP.PY01.TIMECARD.M202609` | `SHR` | 入力 (SHR) | PAYVAL.EMP-IN | `source/jcl/PY01MNTH.jcl:18` |
| STEP010 | VALIDOUT | `&&VALID (PY01MNTH)` | `(NEW,PASS)` | 出力 (NEW/MOD) | PAYVAL.VALID-OUT | `source/jcl/PY01MNTH.jcl:19` |
| STEP010 | ERRRPT | `SYSOUT=*` |  | SYSOUT | PAYVAL.ERR-RPT | `source/jcl/PY01MNTH.jcl:22` |
| STEP010 | SYSOUT | `SYSOUT=*` |  | SYSOUT |  | `source/jcl/PY01MNTH.jcl:23` |
| STEP020 | SORTIN | `&&VALID (PY01MNTH)` | `(OLD,DELETE)` | 排他 (OLD) |  | `source/jcl/PY01MNTH.jcl:26` |
| STEP020 | SORTOUT | `&&SORTED (PY01MNTH)` | `(NEW,PASS)` | 出力 (NEW/MOD) |  | `source/jcl/PY01MNTH.jcl:27` |
| STEP020 | SYSOUT | `SYSOUT=*` |  | SYSOUT |  | `source/jcl/PY01MNTH.jcl:30` |
| STEP020 | SYSIN |  |  | インストリーム |  | `source/jcl/PY01MNTH.jcl:31` |
| STEP030 | PAYIN | `&&SORTED (PY01MNTH)` | `(OLD,PASS)` | 排他 (OLD) | PAYCALC.PAY-IN | `source/jcl/PY01MNTH.jcl:37` |
| STEP030 | PAYOUT | `KZP.PY01.PAYCALC.M202609` | `(NEW,CATLG,DELETE)` | 出力 (NEW/MOD) | PAYCALC.PAY-OUT | `source/jcl/PY01MNTH.jcl:38` |
| STEP030 | SYSOUT | `SYSOUT=*` |  | SYSOUT |  | `source/jcl/PY01MNTH.jcl:42` |
| STEP040 | PAYIN | `KZP.PY01.PAYCALC.M202609` | `SHR` | 入力 (SHR) | PAYRPT.PAY-IN | `source/jcl/PY01MNTH.jcl:46` |
| STEP040 | RPTOUT | `SYSOUT=(A,,PY01)` |  | SYSOUT | PAYRPT.RPT-OUT | `source/jcl/PY01MNTH.jcl:47` |
| STEP040 | SYSOUT | `SYSOUT=*` |  | SYSOUT |  | `source/jcl/PY01MNTH.jcl:48` |

### 2.2 データセットの系譜

| データセット | 作成・更新・削除（C/U/D） | 参照（R/?） | 根拠 |
| --- | --- | --- | --- |
| `KZP.PY01.PAYCALC.M202609` | PAYCALC (C) | PAYRPT (R) | `source/cobol/PAYCALC.cbl:124` `source/cobol/PAYRPT.cbl:313` `source/jcl/PY01MNTH.jcl:38` `source/jcl/PY01MNTH.jcl:46` |
| `KZP.PY01.TIMECARD.M202609` | - | PAYVAL (R) | `source/cobol/PAYVAL.cbl:159` `source/jcl/PY01MNTH.jcl:18` |
| `&&SORTED (PY01MNTH)` | SORT (C) | PAYCALC (R) | `source/cobol/PAYCALC.cbl:208` `source/jcl/PY01MNTH.jcl:27` `source/jcl/PY01MNTH.jcl:37` |
| `&&VALID (PY01MNTH)` | PAYVAL (C) | SORT (?) | `source/cobol/PAYVAL.cbl:94` `source/jcl/PY01MNTH.jcl:19` `source/jcl/PY01MNTH.jcl:26` |

> 一時データセット（&&名前）はジョブ単位で区別しています。「?」はプログラムソースのないステップが DISP=OLD で使用していることを示し、参照か更新かは JCL からは判別できません。

## 3. プログラム仕様書

### 3.1 PAYCALC

#### 3.1.1 基本情報

| 項目 | 内容 | 根拠 |
| --- | --- | --- |
| プログラムID | `PAYCALC` | `source/cobol/PAYCALC.cbl:1` |
| ソース | source/cobol/PAYCALC.cbl (1〜215 行) | `source/cobol/PAYCALC.cbl:1` |
| 段落数／文数／データ項目数 | 9／92／71 | `source/cobol/PAYCALC.cbl:81` |
| 実行ジョブステップ | PY01MNTH.STEP030 | `source/jcl/PY01MNTH.jcl:35` |

#### 3.1.2 目的

- 業務目的：**要確認**。コードからは導けないため、業務を知る担当者による記入が必要です。 `source/cobol/PAYCALC.cbl:1`

> ソース冒頭のコメント（原文のまま引用。内容は未検証で、現状と異なる可能性があります）：
>
> `source/cobol/PAYCALC.cbl:5` KAZANAMI PRECISION WORKS (FICTIONAL - DEMO ONLY)  
> `source/cobol/PAYCALC.cbl:6` PAYCALC - STEP030 OF JOB PY01MNTH. CALCULATES MONTHLY GROSS  
> `source/cobol/PAYCALC.cbl:7` PAY WITH OVERTIME, HOLIDAY AND NIGHT PREMIUMS UNDER  
> `source/cobol/PAYCALC.cbl:8` LABOUR STANDARDS ACT (LSA) ART.37.  
> `source/cobol/PAYCALC.cbl:9` PARM    : PAY PERIOD AS YYYYMM (E.G. 202609).  
> `source/cobol/PAYCALC.cbl:10` INPUT   : PAYIN  - VALIDATED EMPREC RECORDS, SORTED DEPT/ID.  
> `source/cobol/PAYCALC.cbl:11` OUTPUT  : PAYOUT - PAYREC RECORDS, SAME ORDER.  

#### 3.1.3 入出力

| ファイル（SELECT/FD） | ASSIGN | 編成 | OPEN | 操作 | レコード | DD → データセット | 根拠 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `PAY-IN` | `PAYIN` | LINE SEQUENTIAL | INPUT | READ | EMP-RECORD | PAYIN → &&SORTED (PY01MNTH) | `source/cobol/PAYCALC.cbl:34` `source/cobol/PAYCALC.cbl:42` `source/cobol/PAYCALC.cbl:100` `source/cobol/PAYCALC.cbl:208` `source/jcl/PY01MNTH.jcl:37` |
| `PAY-OUT` | `PAYOUT` | LINE SEQUENTIAL | OUTPUT | WRITE | PAY-RECORD | PAYOUT → KZP.PY01.PAYCALC.M202609 | `source/cobol/PAYCALC.cbl:37` `source/cobol/PAYCALC.cbl:44` `source/cobol/PAYCALC.cbl:100` `source/cobol/PAYCALC.cbl:124` `source/jcl/PY01MNTH.jcl:38` |

#### 3.1.4 呼出し関係

| 方向 | プログラム | 種別 | USING | 段落 | 根拠 |
| --- | --- | --- | --- | --- | --- |
| 呼出し先 | `PAYRND` | static | `WS-RND-MODE WS-RND-IN WS-RND-OUT` | `3000-BASE-AND-RATE` | `source/cobol/PAYCALC.cbl:140` `source/cobol/PAYCALC.cbl:147` |
| 呼出し先 | `PAYRND` | static | `WS-RND-MODE WS-RND-IN WS-RND-OUT` | `4000-ROUND-HOURS` | `source/cobol/PAYCALC.cbl:155` `source/cobol/PAYCALC.cbl:158` `source/cobol/PAYCALC.cbl:161` |
| 呼出し先 | `PAYRND` | static | `WS-RND-MODE WS-RND-IN WS-RND-OUT` | `5000-PREMIUMS` | `source/cobol/PAYCALC.cbl:178` `source/cobol/PAYCALC.cbl:181` `source/cobol/PAYCALC.cbl:184` `source/cobol/PAYCALC.cbl:189` |

#### 3.1.5 PERFORM 構造

- `0000-MAIN` (先頭段落・入口) `source/cobol/PAYCALC.cbl:82`
  - PERFORM `1000-INITIALISE` `source/cobol/PAYCALC.cbl:83`
    - PERFORM `8000-READ-INPUT` `source/cobol/PAYCALC.cbl:106`
  - PERFORM `2000-PROCESS` `source/cobol/PAYCALC.cbl:84`
    - PERFORM `3000-BASE-AND-RATE` `source/cobol/PAYCALC.cbl:116`
    - PERFORM `4000-ROUND-HOURS` `source/cobol/PAYCALC.cbl:117`
    - PERFORM `5000-PREMIUMS` `source/cobol/PAYCALC.cbl:118`
    - PERFORM `6000-ALERTS` `source/cobol/PAYCALC.cbl:119`
    - PERFORM `8000-READ-INPUT` （上記で展開済み） `source/cobol/PAYCALC.cbl:126`
  - PERFORM `9000-TERMINATE` `source/cobol/PAYCALC.cbl:85`

#### 3.1.6 業務ルール候補

| ID | 種別 | 段落 | 式（ソース原文） | 前提条件 | 名前付き定数 | 業務上の意味 | 根拠 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `PAYCALC-R001` | 条件判定 | `1000-INITIALISE` | `IF WS-PARM NOT NUMERIC` |  |  | 要確認 | `source/cobol/PAYCALC.cbl:90` |
| `PAYCALC-R002` | リテラル代入 | `1000-INITIALISE` | `MOVE 16 TO RETURN-CODE` | `IF WS-PARM NOT NUMERIC` |  | 要確認 | `source/cobol/PAYCALC.cbl:92` |
| `PAYCALC-R003` | 条件判定 | `1000-INITIALISE` | `IF WS-PERIOD < WS-SME-DEFERRAL-END` |  | WS-SME-DEFERRAL-END=202304 (source/cobol/PAYCALC.cbl:61) | 要確認 | `source/cobol/PAYCALC.cbl:97` `source/cobol/PAYCALC.cbl:61` |
| `PAYCALC-R004` | リテラル代入 | `1000-INITIALISE` | `MOVE 1.25 TO WS-OT2-RATE` | `IF WS-PERIOD < WS-SME-DEFERRAL-END` | WS-OT2-RATE=1.50 (source/cobol/PAYCALC.cbl:57) | 要確認 | `source/cobol/PAYCALC.cbl:98` `source/cobol/PAYCALC.cbl:57` |
| `PAYCALC-R005` | 条件判定 | `1000-INITIALISE` | `IF WS-FS-IN NOT = '00'` |  |  | 要確認 | `source/cobol/PAYCALC.cbl:101` |
| `PAYCALC-R006` | リテラル代入 | `1000-INITIALISE` | `MOVE 16 TO RETURN-CODE` | `IF WS-FS-IN NOT = '00'` |  | 要確認 | `source/cobol/PAYCALC.cbl:103` |
| `PAYCALC-R007` | 計算式 | `2000-PROCESS` | `ADD 1 TO WS-READ-CNT` |  |  | 要確認 | `source/cobol/PAYCALC.cbl:109` |
| `PAYCALC-R008` | 計算式 | `2000-PROCESS` | `COMPUTE PAY-GROSS-AMT = PAY-BASE-AMT + PAY-ALLOW-AMT + PAY-OT1-AMT + PAY-OT2-AMT + PAY-HOL-AMT + PAY-NIGHT-AMT` |  |  | 要確認 | `source/cobol/PAYCALC.cbl:120` |
| `PAYCALC-R009` | 計算式 | `2000-PROCESS` | `ADD PAY-GROSS-AMT TO WS-GROSS-TOTAL` |  |  | 要確認 | `source/cobol/PAYCALC.cbl:123` |
| `PAYCALC-R010` | 計算式 | `2000-PROCESS` | `ADD 1 TO WS-WRITE-CNT` |  |  | 要確認 | `source/cobol/PAYCALC.cbl:125` |
| `PAYCALC-R011` | 計算式 | `3000-BASE-AND-RATE` | `COMPUTE PAY-ALLOW-AMT = EMP-ALLOW-INCL + EMP-ALLOW-EXCL` |  |  | 要確認 | `source/cobol/PAYCALC.cbl:135` |
| `PAYCALC-R012` | 条件判定 | `3000-BASE-AND-RATE` | `IF EMP-PART-TIME` |  |  | 要確認 | `source/cobol/PAYCALC.cbl:136` |
| `PAYCALC-R013` | 計算式 | `3000-BASE-AND-RATE` | `COMPUTE WS-RND-IN = WS-RATE * EMP-REG-MIN / 60` | `IF EMP-PART-TIME` |  | 要確認 | `source/cobol/PAYCALC.cbl:138` |
| `PAYCALC-R014` | 計算式 | `3000-BASE-AND-RATE` | `COMPUTE WS-RND-IN = (EMP-BASE-PAY + EMP-ALLOW-INCL) / EMP-SCHED-HRS` | `ELSE OF IF EMP-PART-TIME` |  | 要確認 | `source/cobol/PAYCALC.cbl:144` |
| `PAYCALC-R015` | 条件判定 | `5000-PREMIUMS` | `IF NOT EMP-MANAGER` |  |  | 要確認 | `source/cobol/PAYCALC.cbl:169` |
| `PAYCALC-R016` | 条件判定 | `5000-PREMIUMS` | `IF WS-OT-HRS > WS-OT-TIER-HOURS` | `IF NOT EMP-MANAGER` | WS-OT-TIER-HOURS=060 (source/cobol/PAYCALC.cbl:60) | 要確認 | `source/cobol/PAYCALC.cbl:170` `source/cobol/PAYCALC.cbl:60` |
| `PAYCALC-R017` | 計算式 | `5000-PREMIUMS` | `COMPUTE PAY-OT2-HRS = WS-OT-HRS - WS-OT-TIER-HOURS` | `IF NOT EMP-MANAGER`<br>`IF WS-OT-HRS > WS-OT-TIER-HOURS` | WS-OT-TIER-HOURS=060 (source/cobol/PAYCALC.cbl:60) | 要確認 | `source/cobol/PAYCALC.cbl:172` `source/cobol/PAYCALC.cbl:60` |
| `PAYCALC-R018` | 計算式 | `5000-PREMIUMS` | `COMPUTE WS-RND-IN = WS-RATE * PAY-OT1-HRS * WS-OT1-RATE` | `IF NOT EMP-MANAGER` | WS-OT1-RATE=1.25 (source/cobol/PAYCALC.cbl:56) | 要確認 | `source/cobol/PAYCALC.cbl:177` `source/cobol/PAYCALC.cbl:56` |
| `PAYCALC-R019` | 計算式 | `5000-PREMIUMS` | `COMPUTE WS-RND-IN = WS-RATE * PAY-OT2-HRS * WS-OT2-RATE` | `IF NOT EMP-MANAGER` | WS-OT2-RATE=1.50 (source/cobol/PAYCALC.cbl:57) | 要確認 | `source/cobol/PAYCALC.cbl:180` `source/cobol/PAYCALC.cbl:57` |
| `PAYCALC-R020` | 計算式 | `5000-PREMIUMS` | `COMPUTE WS-RND-IN = WS-RATE * WS-HOL-HRS * WS-HOL-RATE` | `IF NOT EMP-MANAGER` | WS-HOL-RATE=1.35 (source/cobol/PAYCALC.cbl:58) | 要確認 | `source/cobol/PAYCALC.cbl:183` `source/cobol/PAYCALC.cbl:58` |
| `PAYCALC-R021` | 計算式 | `5000-PREMIUMS` | `COMPUTE WS-RND-IN = WS-RATE * WS-NIGHT-HRS * WS-NIGHT-RATE` |  | WS-NIGHT-RATE=0.25 (source/cobol/PAYCALC.cbl:59) | 要確認 | `source/cobol/PAYCALC.cbl:188` `source/cobol/PAYCALC.cbl:59` |
| `PAYCALC-R022` | 条件判定 | `6000-ALERTS` | `IF NOT EMP-MANAGER` |  |  | 要確認 | `source/cobol/PAYCALC.cbl:197` |
| `PAYCALC-R023` | 条件判定 | `6000-ALERTS` | `IF EMP-OT-MIN > WS-LIMIT-45H-MIN` | `IF NOT EMP-MANAGER` | WS-LIMIT-45H-MIN=02700 (source/cobol/PAYCALC.cbl:63) | 要確認 | `source/cobol/PAYCALC.cbl:198` `source/cobol/PAYCALC.cbl:63` |
| `PAYCALC-R024` | 計算式 | `6000-ALERTS` | `COMPUTE WS-OT-HOL-MIN = EMP-OT-MIN + EMP-HOL-MIN` | `IF NOT EMP-MANAGER` |  | 要確認 | `source/cobol/PAYCALC.cbl:201` |
| `PAYCALC-R025` | 条件判定 | `6000-ALERTS` | `IF WS-OT-HOL-MIN >= WS-LIMIT-100H-MIN` | `IF NOT EMP-MANAGER` | WS-LIMIT-100H-MIN=06000 (source/cobol/PAYCALC.cbl:64) | 要確認 | `source/cobol/PAYCALC.cbl:202` `source/cobol/PAYCALC.cbl:64` |
| `PAYCALC-R026` | 条件名 (88) |  | `EMP-REGULAR = 'R' (of EMP-TYPE)` |  |  | 要確認 | `source/copybook/EMPREC.cpy:34` |
| `PAYCALC-R027` | 条件名 (88) |  | `EMP-PART-TIME = 'P' (of EMP-TYPE)` |  |  | 要確認 | `source/copybook/EMPREC.cpy:35` |
| `PAYCALC-R028` | 条件名 (88) |  | `EMP-MANAGER = 'M' (of EMP-TYPE)` |  |  | 要確認 | `source/copybook/EMPREC.cpy:36` |
| `PAYCALC-R029` | 条件名 (88) |  | `EMP-TYPE-VALID = 'R' OR 'P' OR 'M' (of EMP-TYPE)` |  |  | 要確認 | `source/copybook/EMPREC.cpy:37` |
| `PAYCALC-R030` | 条件名 (88) |  | `PAY-OVER-45H = '*' (of PAY-ALERT-45)` |  |  | 要確認 | `source/copybook/PAYREC.cpy:30` |
| `PAYCALC-R031` | 条件名 (88) |  | `PAY-AT-100H = '!' (of PAY-ALERT-100)` |  |  | 要確認 | `source/copybook/PAYREC.cpy:32` |
| `PAYCALC-R032` | 条件名 (88) |  | `END-OF-INPUT = 'Y' (of WS-EOF-SW)` |  |  | 要確認 | `source/cobol/PAYCALC.cbl:51` |
| `PAYCALC-R033` | 定数 |  | `WS-OT1-RATE VALUE 1.25` |  | WS-OT1-RATE=1.25 (source/cobol/PAYCALC.cbl:56) | 要確認 | `source/cobol/PAYCALC.cbl:56` `source/cobol/PAYCALC.cbl:56` |
| `PAYCALC-R034` | 定数 |  | `WS-OT2-RATE VALUE 1.50` |  | WS-OT2-RATE=1.50 (source/cobol/PAYCALC.cbl:57) | 要確認 | `source/cobol/PAYCALC.cbl:57` `source/cobol/PAYCALC.cbl:57` |
| `PAYCALC-R035` | 定数 |  | `WS-HOL-RATE VALUE 1.35` |  | WS-HOL-RATE=1.35 (source/cobol/PAYCALC.cbl:58) | 要確認 | `source/cobol/PAYCALC.cbl:58` `source/cobol/PAYCALC.cbl:58` |
| `PAYCALC-R036` | 定数 |  | `WS-NIGHT-RATE VALUE 0.25` |  | WS-NIGHT-RATE=0.25 (source/cobol/PAYCALC.cbl:59) | 要確認 | `source/cobol/PAYCALC.cbl:59` `source/cobol/PAYCALC.cbl:59` |
| `PAYCALC-R037` | 定数 |  | `WS-OT-TIER-HOURS VALUE 060` |  | WS-OT-TIER-HOURS=060 (source/cobol/PAYCALC.cbl:60) | 要確認 | `source/cobol/PAYCALC.cbl:60` `source/cobol/PAYCALC.cbl:60` |
| `PAYCALC-R038` | 定数 |  | `WS-SME-DEFERRAL-END VALUE 202304` |  | WS-SME-DEFERRAL-END=202304 (source/cobol/PAYCALC.cbl:61) | 要確認 | `source/cobol/PAYCALC.cbl:61` `source/cobol/PAYCALC.cbl:61` |
| `PAYCALC-R039` | 定数 |  | `WS-LIMIT-45H-MIN VALUE 02700` |  | WS-LIMIT-45H-MIN=02700 (source/cobol/PAYCALC.cbl:63) | 要確認 | `source/cobol/PAYCALC.cbl:63` `source/cobol/PAYCALC.cbl:63` |
| `PAYCALC-R040` | 定数 |  | `WS-LIMIT-100H-MIN VALUE 06000` |  | WS-LIMIT-100H-MIN=06000 (source/cobol/PAYCALC.cbl:64) | 要確認 | `source/cobol/PAYCALC.cbl:64` `source/cobol/PAYCALC.cbl:64` |

> ルールエンジンが抽出した候補です（ソース原文とリテラル値）。業務上の意味は担当者による確認が必要です。

### 3.2 PAYRND

#### 3.2.1 基本情報

| 項目 | 内容 | 根拠 |
| --- | --- | --- |
| プログラムID | `PAYRND` | `source/cobol/PAYRND.cbl:1` |
| ソース | source/cobol/PAYRND.cbl (1〜64 行) | `source/cobol/PAYRND.cbl:1` |
| 段落数／文数／データ項目数 | 3／20／8 | `source/cobol/PAYRND.cbl:35` |
| PROCEDURE DIVISION USING | `LK-MODE LK-IN-VALUE LK-OUT-VALUE` | `source/cobol/PAYRND.cbl:35` |

#### 3.2.2 目的

- 業務目的：**要確認**。コードからは導けないため、業務を知る担当者による記入が必要です。 `source/cobol/PAYRND.cbl:1`

> ソース冒頭のコメント（原文のまま引用。内容は未検証で、現状と異なる可能性があります）：
>
> `source/cobol/PAYRND.cbl:5` KAZANAMI PRECISION WORKS (FICTIONAL - DEMO ONLY)  
> `source/cobol/PAYRND.cbl:6` PAYRND - SHARED ROUNDING ROUTINE FOR THE PY01 PAYROLL SYSTEM.  

#### 3.2.3 入出力

ファイル・SQL・CICS の入出力はありません。

#### 3.2.4 呼出し関係

| 方向 | プログラム | 種別 | USING | 段落 | 根拠 |
| --- | --- | --- | --- | --- | --- |
| 呼出し元 | `PAYCALC` | static |  | `3000-BASE-AND-RATE` | `source/cobol/PAYCALC.cbl:140` `source/cobol/PAYCALC.cbl:147` |
| 呼出し元 | `PAYCALC` | static |  | `4000-ROUND-HOURS` | `source/cobol/PAYCALC.cbl:155` `source/cobol/PAYCALC.cbl:158` `source/cobol/PAYCALC.cbl:161` |
| 呼出し元 | `PAYCALC` | static |  | `5000-PREMIUMS` | `source/cobol/PAYCALC.cbl:178` `source/cobol/PAYCALC.cbl:181` `source/cobol/PAYCALC.cbl:184` `source/cobol/PAYCALC.cbl:189` |

#### 3.2.5 PERFORM 構造

- `0000-MAIN` (先頭段落・入口) `source/cobol/PAYRND.cbl:36`
  - PERFORM `1000-ROUND-YEN` `source/cobol/PAYRND.cbl:39`
  - PERFORM `2000-ROUND-HOURS` `source/cobol/PAYRND.cbl:41`

#### 3.2.6 業務ルール候補

| ID | 種別 | 段落 | 式（ソース原文） | 前提条件 | 名前付き定数 | 業務上の意味 | 根拠 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `PAYRND-R001` | 条件判定 | `0000-MAIN` | `EVALUATE LK-MODE WHEN 'Y'` | `EVALUATE LK-MODE` |  | 要確認 | `source/cobol/PAYRND.cbl:38` |
| `PAYRND-R002` | 条件判定 | `0000-MAIN` | `EVALUATE LK-MODE WHEN 'H'` | `EVALUATE LK-MODE` |  | 要確認 | `source/cobol/PAYRND.cbl:40` |
| `PAYRND-R003` | リテラル代入 | `0000-MAIN` | `MOVE 16 TO RETURN-CODE` | `EVALUATE LK-MODE WHEN OTHER` |  | 要確認 | `source/cobol/PAYRND.cbl:45` |
| `PAYRND-R004` | 計算式 | `1000-ROUND-YEN` | `COMPUTE WS-FRACTION = LK-IN-VALUE - WS-WHOLE` |  |  | 要確認 | `source/cobol/PAYRND.cbl:51` |
| `PAYRND-R005` | 条件判定 | `1000-ROUND-YEN` | `IF WS-FRACTION >= 0.5` |  |  | 要確認 | `source/cobol/PAYRND.cbl:52` |
| `PAYRND-R006` | 計算式 | `1000-ROUND-YEN` | `ADD 1 TO WS-WHOLE` | `IF WS-FRACTION >= 0.5` |  | 要確認 | `source/cobol/PAYRND.cbl:53` |
| `PAYRND-R007` | 計算式 | `2000-ROUND-HOURS` | `DIVIDE WS-MINUTES BY 60 GIVING WS-HOURS REMAINDER WS-REMAINDER` |  |  | 要確認 | `source/cobol/PAYRND.cbl:59` |
| `PAYRND-R008` | 条件判定 | `2000-ROUND-HOURS` | `IF WS-REMAINDER >= 30` |  |  | 要確認 | `source/cobol/PAYRND.cbl:61` |
| `PAYRND-R009` | 計算式 | `2000-ROUND-HOURS` | `ADD 1 TO WS-HOURS` | `IF WS-REMAINDER >= 30` |  | 要確認 | `source/cobol/PAYRND.cbl:62` |

> ルールエンジンが抽出した候補です（ソース原文とリテラル値）。業務上の意味は担当者による確認が必要です。

### 3.3 PAYRPT

#### 3.3.1 基本情報

| 項目 | 内容 | 根拠 |
| --- | --- | --- |
| プログラムID | `PAYRPT` | `source/cobol/PAYRPT.cbl:1` |
| ソース | source/cobol/PAYRPT.cbl (1〜315 行) | `source/cobol/PAYRPT.cbl:1` |
| 段落数／文数／データ項目数 | 13／133／117 | `source/cobol/PAYRPT.cbl:139` |
| 実行ジョブステップ | PY01MNTH.STEP040 | `source/jcl/PY01MNTH.jcl:44` |

#### 3.3.2 目的

- 業務目的：**要確認**。コードからは導けないため、業務を知る担当者による記入が必要です。 `source/cobol/PAYRPT.cbl:1`

> ソース冒頭のコメント（原文のまま引用。内容は未検証で、現状と異なる可能性があります）：
>
> `source/cobol/PAYRPT.cbl:5` KAZANAMI PRECISION WORKS (FICTIONAL - DEMO ONLY)  
> `source/cobol/PAYRPT.cbl:6` PAYRPT - STEP040 OF JOB PY01MNTH. PRINTS THE MONTHLY PAYROLL  
> `source/cobol/PAYRPT.cbl:7` REGISTER WITH DEPARTMENT SUBTOTALS, A GRAND TOTAL  
> `source/cobol/PAYRPT.cbl:8` AND THE 36-AGREEMENT ALERT LIST FOR HR.  
> `source/cobol/PAYRPT.cbl:9` PARM    : PAY PERIOD AS YYYYMM.  
> `source/cobol/PAYRPT.cbl:10` INPUT   : PAYIN  - PAYREC RECORDS SORTED BY DEPT/ID.  
> `source/cobol/PAYRPT.cbl:11` OUTPUT  : RPTOUT - 132-COLUMN REPORT.  

#### 3.3.3 入出力

| ファイル（SELECT/FD） | ASSIGN | 編成 | OPEN | 操作 | レコード | DD → データセット | 根拠 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `PAY-IN` | `PAYIN` | LINE SEQUENTIAL | INPUT | READ | PAY-RECORD | PAYIN → KZP.PY01.PAYCALC.M202609 | `source/cobol/PAYRPT.cbl:16` `source/cobol/PAYRPT.cbl:23` `source/cobol/PAYRPT.cbl:157` `source/cobol/PAYRPT.cbl:313` `source/jcl/PY01MNTH.jcl:46` |
| `RPT-OUT` | `RPTOUT` | LINE SEQUENTIAL | OUTPUT | WRITE | RPT-LINE | RPTOUT → SYSOUT | `source/cobol/PAYRPT.cbl:19` `source/cobol/PAYRPT.cbl:25` `source/cobol/PAYRPT.cbl:157` `source/cobol/PAYRPT.cbl:294` `source/cobol/PAYRPT.cbl:302` `source/cobol/PAYRPT.cbl:305` +3 |

#### 3.3.4 呼出し関係

CALL 関係はありません。

#### 3.3.5 PERFORM 構造

- `0000-MAIN` (先頭段落・入口) `source/cobol/PAYRPT.cbl:140`
  - PERFORM `1000-INITIALISE` `source/cobol/PAYRPT.cbl:141`
    - PERFORM `8000-READ-INPUT` `source/cobol/PAYRPT.cbl:163`
  - PERFORM `2000-PROCESS` `source/cobol/PAYRPT.cbl:142`
    - PERFORM `2100-ACCUMULATE` `source/cobol/PAYRPT.cbl:189`
    - PERFORM `2200-SAVE-ALERT` `source/cobol/PAYRPT.cbl:191`
    - PERFORM `3000-DEPT-BREAK` `source/cobol/PAYRPT.cbl:167`
      - PERFORM `3100-FORMAT-TOTAL` `source/cobol/PAYRPT.cbl:224`
      - PERFORM `7000-PRINT-DETAIL` `source/cobol/PAYRPT.cbl:227`
        - PERFORM `7100-PRINT-LINE` `source/cobol/PAYRPT.cbl:291`
        - PERFORM `7200-PAGE-HEADING` `source/cobol/PAYRPT.cbl:288`
      - PERFORM `7100-PRINT-LINE` （上記で展開済み） `source/cobol/PAYRPT.cbl:229`
    - PERFORM `7000-PRINT-DETAIL` （上記で展開済み） `source/cobol/PAYRPT.cbl:188`
    - PERFORM `8000-READ-INPUT` （上記で展開済み） `source/cobol/PAYRPT.cbl:193`
  - PERFORM `3000-DEPT-BREAK` （上記で展開済み） `source/cobol/PAYRPT.cbl:144`
  - PERFORM `4000-GRAND-TOTAL` `source/cobol/PAYRPT.cbl:146`
    - PERFORM `3100-FORMAT-TOTAL` （上記で展開済み） `source/cobol/PAYRPT.cbl:250`
    - PERFORM `7000-PRINT-DETAIL` （上記で展開済み） `source/cobol/PAYRPT.cbl:252`
    - PERFORM `7100-PRINT-LINE` （上記で展開済み） `source/cobol/PAYRPT.cbl:248`
  - PERFORM `5000-ALERT-LIST` `source/cobol/PAYRPT.cbl:147`
    - PERFORM `7100-PRINT-LINE` （上記で展開済み） `source/cobol/PAYRPT.cbl:259`

#### 3.3.6 業務ルール候補

| ID | 種別 | 段落 | 式（ソース原文） | 前提条件 | 名前付き定数 | 業務上の意味 | 根拠 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `PAYRPT-R001` | 条件判定 | `0000-MAIN` | `IF WS-PREV-DEPT NOT = SPACES` |  |  | 要確認 | `source/cobol/PAYRPT.cbl:143` |
| `PAYRPT-R002` | 条件判定 | `1000-INITIALISE` | `IF WS-FS-IN NOT = '00'` |  |  | 要確認 | `source/cobol/PAYRPT.cbl:158` |
| `PAYRPT-R003` | リテラル代入 | `1000-INITIALISE` | `MOVE 16 TO RETURN-CODE` | `IF WS-FS-IN NOT = '00'` |  | 要確認 | `source/cobol/PAYRPT.cbl:160` |
| `PAYRPT-R004` | 条件判定 | `2000-PROCESS` | `IF PAY-DEPT NOT = WS-PREV-DEPT AND WS-PREV-DEPT NOT = SPACES` |  |  | 要確認 | `source/cobol/PAYRPT.cbl:166` |
| `PAYRPT-R005` | 条件判定 | `2000-PROCESS` | `IF PAY-OVER-45H OR PAY-AT-100H` |  |  | 要確認 | `source/cobol/PAYRPT.cbl:190` |
| `PAYRPT-R006` | 条件判定 | `2100-ACCUMULATE` | `PERFORM VARYING WS-IDX FROM 1 BY 1 UNTIL WS-IDX > 2` |  |  | 要確認 | `source/cobol/PAYRPT.cbl:196` |
| `PAYRPT-R007` | 計算式 | `2100-ACCUMULATE` | `ADD 1 TO T-COUNT(WS-IDX)` | `PERFORM VARYING WS-IDX FROM 1 BY 1 UNTIL WS-IDX > 2` |  | 要確認 | `source/cobol/PAYRPT.cbl:197` |
| `PAYRPT-R008` | 計算式 | `2100-ACCUMULATE` | `ADD PAY-BASE-AMT TO T-BASE(WS-IDX)` | `PERFORM VARYING WS-IDX FROM 1 BY 1 UNTIL WS-IDX > 2` |  | 要確認 | `source/cobol/PAYRPT.cbl:198` |
| `PAYRPT-R009` | 計算式 | `2100-ACCUMULATE` | `ADD PAY-ALLOW-AMT TO T-ALLOW(WS-IDX)` | `PERFORM VARYING WS-IDX FROM 1 BY 1 UNTIL WS-IDX > 2` |  | 要確認 | `source/cobol/PAYRPT.cbl:199` |
| `PAYRPT-R010` | 計算式 | `2100-ACCUMULATE` | `ADD PAY-OT-HRS TO T-OT-HRS(WS-IDX)` | `PERFORM VARYING WS-IDX FROM 1 BY 1 UNTIL WS-IDX > 2` |  | 要確認 | `source/cobol/PAYRPT.cbl:200` |
| `PAYRPT-R011` | 計算式 | `2100-ACCUMULATE` | `ADD PAY-OT1-AMT TO T-OT1(WS-IDX)` | `PERFORM VARYING WS-IDX FROM 1 BY 1 UNTIL WS-IDX > 2` |  | 要確認 | `source/cobol/PAYRPT.cbl:201` |
| `PAYRPT-R012` | 計算式 | `2100-ACCUMULATE` | `ADD PAY-OT2-AMT TO T-OT2(WS-IDX)` | `PERFORM VARYING WS-IDX FROM 1 BY 1 UNTIL WS-IDX > 2` |  | 要確認 | `source/cobol/PAYRPT.cbl:202` |
| `PAYRPT-R013` | 計算式 | `2100-ACCUMULATE` | `ADD PAY-HOL-HRS TO T-HOL-HRS(WS-IDX)` | `PERFORM VARYING WS-IDX FROM 1 BY 1 UNTIL WS-IDX > 2` |  | 要確認 | `source/cobol/PAYRPT.cbl:203` |
| `PAYRPT-R014` | 計算式 | `2100-ACCUMULATE` | `ADD PAY-HOL-AMT TO T-HOL(WS-IDX)` | `PERFORM VARYING WS-IDX FROM 1 BY 1 UNTIL WS-IDX > 2` |  | 要確認 | `source/cobol/PAYRPT.cbl:204` |
| `PAYRPT-R015` | 計算式 | `2100-ACCUMULATE` | `ADD PAY-NIGHT-HRS TO T-NIGHT-HRS(WS-IDX)` | `PERFORM VARYING WS-IDX FROM 1 BY 1 UNTIL WS-IDX > 2` |  | 要確認 | `source/cobol/PAYRPT.cbl:205` |
| `PAYRPT-R016` | 計算式 | `2100-ACCUMULATE` | `ADD PAY-NIGHT-AMT TO T-NIGHT(WS-IDX)` | `PERFORM VARYING WS-IDX FROM 1 BY 1 UNTIL WS-IDX > 2` |  | 要確認 | `source/cobol/PAYRPT.cbl:206` |
| `PAYRPT-R017` | 計算式 | `2100-ACCUMULATE` | `ADD PAY-GROSS-AMT TO T-GROSS(WS-IDX)` | `PERFORM VARYING WS-IDX FROM 1 BY 1 UNTIL WS-IDX > 2` |  | 要確認 | `source/cobol/PAYRPT.cbl:207` |
| `PAYRPT-R018` | 条件判定 | `2200-SAVE-ALERT` | `IF WS-ALERT-CNT < 100` |  |  | 要確認 | `source/cobol/PAYRPT.cbl:211` |
| `PAYRPT-R019` | 計算式 | `2200-SAVE-ALERT` | `ADD 1 TO WS-ALERT-CNT` | `IF WS-ALERT-CNT < 100` |  | 要確認 | `source/cobol/PAYRPT.cbl:212` |
| `PAYRPT-R020` | リテラル代入 | `3000-DEPT-BREAK` | `MOVE 1 TO WS-IDX` |  |  | 要確認 | `source/cobol/PAYRPT.cbl:223` |
| `PAYRPT-R021` | リテラル代入 | `4000-GRAND-TOTAL` | `MOVE 2 TO WS-IDX` |  |  | 要確認 | `source/cobol/PAYRPT.cbl:249` |
| `PAYRPT-R022` | 条件判定 | `5000-ALERT-LIST` | `IF WS-ALERT-CNT = ZERO` |  |  | 要確認 | `source/cobol/PAYRPT.cbl:264` |
| `PAYRPT-R023` | 条件判定 | `5000-ALERT-LIST` | `PERFORM VARYING WS-IDX FROM 1 BY 1 UNTIL WS-IDX > WS-ALERT-CNT` |  |  | 要確認 | `source/cobol/PAYRPT.cbl:268` |
| `PAYRPT-R024` | 条件判定 | `5000-ALERT-LIST` | `IF AL-100(WS-IDX) = '!'` | `PERFORM VARYING WS-IDX FROM 1 BY 1 UNTIL WS-IDX > WS-ALERT-CNT` |  | 要確認 | `source/cobol/PAYRPT.cbl:275` |
| `PAYRPT-R025` | 条件判定 | `7000-PRINT-DETAIL` | `IF WS-LINE-CNT >= WS-LINES-PER-PAGE` |  | WS-LINE-CNT=99 (source/cobol/PAYRPT.cbl:34); WS-LINES-PER-PAGE=060 (source/cobol/PAYRPT.cbl:36) | 要確認 | `source/cobol/PAYRPT.cbl:287` `source/cobol/PAYRPT.cbl:34` `source/cobol/PAYRPT.cbl:36` |
| `PAYRPT-R026` | 計算式 | `7100-PRINT-LINE` | `ADD 1 TO WS-LINE-CNT` |  | WS-LINE-CNT=99 (source/cobol/PAYRPT.cbl:34) | 要確認 | `source/cobol/PAYRPT.cbl:295` `source/cobol/PAYRPT.cbl:34` |
| `PAYRPT-R027` | 計算式 | `7200-PAGE-HEADING` | `ADD 1 TO WS-PAGE-CNT` |  |  | 要確認 | `source/cobol/PAYRPT.cbl:298` |
| `PAYRPT-R028` | 条件判定 | `7200-PAGE-HEADING` | `IF WS-PAGE-CNT > 1` |  |  | 要確認 | `source/cobol/PAYRPT.cbl:300` |
| `PAYRPT-R029` | リテラル代入 | `7200-PAGE-HEADING` | `MOVE 3 TO WS-LINE-CNT` |  | WS-LINE-CNT=99 (source/cobol/PAYRPT.cbl:34) | 要確認 | `source/cobol/PAYRPT.cbl:310` `source/cobol/PAYRPT.cbl:34` |
| `PAYRPT-R030` | 条件名 (88) |  | `PAY-OVER-45H = '*' (of PAY-ALERT-45)` |  |  | 要確認 | `source/copybook/PAYREC.cpy:30` |
| `PAYRPT-R031` | 条件名 (88) |  | `PAY-AT-100H = '!' (of PAY-ALERT-100)` |  |  | 要確認 | `source/copybook/PAYREC.cpy:32` |
| `PAYRPT-R032` | 条件名 (88) |  | `END-OF-INPUT = 'Y' (of WS-EOF-SW)` |  |  | 要確認 | `source/cobol/PAYRPT.cbl:31` |
| `PAYRPT-R033` | 定数 |  | `WS-LINE-CNT VALUE 99` |  | WS-LINE-CNT=99 (source/cobol/PAYRPT.cbl:34) | 要確認 | `source/cobol/PAYRPT.cbl:34` `source/cobol/PAYRPT.cbl:34` |
| `PAYRPT-R034` | 定数 |  | `WS-LINES-PER-PAGE VALUE 060` |  | WS-LINES-PER-PAGE=060 (source/cobol/PAYRPT.cbl:36) | 要確認 | `source/cobol/PAYRPT.cbl:36` `source/cobol/PAYRPT.cbl:36` |

> ルールエンジンが抽出した候補です（ソース原文とリテラル値）。業務上の意味は担当者による確認が必要です。

### 3.4 PAYVAL

#### 3.4.1 基本情報

| 項目 | 内容 | 根拠 |
| --- | --- | --- |
| プログラムID | `PAYVAL` | `source/cobol/PAYVAL.cbl:1` |
| ソース | source/cobol/PAYVAL.cbl (1〜178 行) | `source/cobol/PAYVAL.cbl:1` |
| 段落数／文数／データ項目数 | 8／69／51 | `source/cobol/PAYVAL.cbl:71` |
| 実行ジョブステップ | PY01MNTH.STEP010 | `source/jcl/PY01MNTH.jcl:17` |

#### 3.4.2 目的

- 業務目的：**要確認**。コードからは導けないため、業務を知る担当者による記入が必要です。 `source/cobol/PAYVAL.cbl:1`

> ソース冒頭のコメント（原文のまま引用。内容は未検証で、現状と異なる可能性があります）：
>
> `source/cobol/PAYVAL.cbl:5` KAZANAMI PRECISION WORKS (FICTIONAL - DEMO ONLY)  
> `source/cobol/PAYVAL.cbl:6` PAYVAL - STEP010 OF JOB PY01MNTH. VALIDATES THE MONTHLY TIME  
> `source/cobol/PAYVAL.cbl:7` AND PAY FILE. GOOD RECORDS GO TO VALIDOUT, BAD ONES  
> `source/cobol/PAYVAL.cbl:8` ARE LISTED ON ERRRPT AND EXCLUDED FROM THE RUN.  
> `source/cobol/PAYVAL.cbl:9` RETURN CODES: 0 = ALL VALID, 4 = SOME REJECTED,  
> `source/cobol/PAYVAL.cbl:10` 8 = NO VALID RECORDS (LATER STEPS ARE SKIPPED).  

#### 3.4.3 入出力

| ファイル（SELECT/FD） | ASSIGN | 編成 | OPEN | 操作 | レコード | DD → データセット | 根拠 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `EMP-IN` | `EMPIN` | LINE SEQUENTIAL | INPUT | READ | EMP-RECORD | EMPIN → KZP.PY01.TIMECARD.M202609 | `source/cobol/PAYVAL.cbl:20` `source/cobol/PAYVAL.cbl:31` `source/cobol/PAYVAL.cbl:79` `source/cobol/PAYVAL.cbl:159` `source/jcl/PY01MNTH.jcl:18` |
| `VALID-OUT` | `VALIDOUT` | LINE SEQUENTIAL | OUTPUT | WRITE | VALID-RECORD | VALIDOUT → &&VALID (PY01MNTH) | `source/cobol/PAYVAL.cbl:23` `source/cobol/PAYVAL.cbl:33` `source/cobol/PAYVAL.cbl:79` `source/cobol/PAYVAL.cbl:94` `source/jcl/PY01MNTH.jcl:19` |
| `ERR-RPT` | `ERRRPT` | LINE SEQUENTIAL | OUTPUT | WRITE | ERR-LINE | ERRRPT → SYSOUT | `source/cobol/PAYVAL.cbl:26` `source/cobol/PAYVAL.cbl:35` `source/cobol/PAYVAL.cbl:79` `source/cobol/PAYVAL.cbl:87` `source/cobol/PAYVAL.cbl:156` `source/cobol/PAYVAL.cbl:167` +1 |

#### 3.4.4 呼出し関係

CALL 関係はありません。

#### 3.4.5 PERFORM 構造

- `0000-MAIN` (先頭段落・入口) `source/cobol/PAYVAL.cbl:72`
  - PERFORM `1000-INITIALISE` `source/cobol/PAYVAL.cbl:73`
    - PERFORM `8000-READ-INPUT` `source/cobol/PAYVAL.cbl:88`
  - PERFORM `2000-PROCESS` `source/cobol/PAYVAL.cbl:74`
    - PERFORM `3000-VALIDATE` `source/cobol/PAYVAL.cbl:92`
      - PERFORM `3100-CROSS-CHECKS` `source/cobol/PAYVAL.cbl:134`
    - PERFORM `4000-WRITE-ERROR` `source/cobol/PAYVAL.cbl:97`
    - PERFORM `8000-READ-INPUT` （上記で展開済み） `source/cobol/PAYVAL.cbl:100`
  - PERFORM `9000-TERMINATE` `source/cobol/PAYVAL.cbl:75`

#### 3.4.6 業務ルール候補

| ID | 種別 | 段落 | 式（ソース原文） | 前提条件 | 名前付き定数 | 業務上の意味 | 根拠 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `PAYVAL-R001` | 条件判定 | `1000-INITIALISE` | `IF WS-FS-IN NOT = '00'` |  |  | 要確認 | `source/cobol/PAYVAL.cbl:82` |
| `PAYVAL-R002` | リテラル代入 | `1000-INITIALISE` | `MOVE 16 TO RETURN-CODE` | `IF WS-FS-IN NOT = '00'` |  | 要確認 | `source/cobol/PAYVAL.cbl:84` |
| `PAYVAL-R003` | 計算式 | `2000-PROCESS` | `ADD 1 TO WS-READ-CNT` |  |  | 要確認 | `source/cobol/PAYVAL.cbl:91` |
| `PAYVAL-R004` | 条件判定 | `2000-PROCESS` | `IF WS-ERR-CODE = SPACES` |  |  | 要確認 | `source/cobol/PAYVAL.cbl:93` |
| `PAYVAL-R005` | 計算式 | `2000-PROCESS` | `ADD 1 TO WS-VALID-CNT` | `IF WS-ERR-CODE = SPACES` |  | 要確認 | `source/cobol/PAYVAL.cbl:95` |
| `PAYVAL-R006` | 計算式 | `2000-PROCESS` | `ADD 1 TO WS-REJECT-CNT` | `ELSE OF IF WS-ERR-CODE = SPACES` |  | 要確認 | `source/cobol/PAYVAL.cbl:98` |
| `PAYVAL-R007` | 条件判定 | `3000-VALIDATE` | `EVALUATE TRUE WHEN EMP-ID NOT NUMERIC` | `EVALUATE TRUE` |  | 要確認 | `source/cobol/PAYVAL.cbl:108` |
| `PAYVAL-R008` | 条件判定 | `3000-VALIDATE` | `EVALUATE TRUE WHEN NOT EMP-TYPE-VALID` | `EVALUATE TRUE` |  | 要確認 | `source/cobol/PAYVAL.cbl:111` |
| `PAYVAL-R009` | 条件判定 | `3000-VALIDATE` | `EVALUATE TRUE WHEN EMP-BASE-PAY NOT NUMERIC OR EMP-BASE-PAY = ZERO` | `EVALUATE TRUE` |  | 要確認 | `source/cobol/PAYVAL.cbl:114` |
| `PAYVAL-R010` | 条件判定 | `3000-VALIDATE` | `EVALUATE TRUE WHEN EMP-ALLOW-INCL NOT NUMERIC OR EMP-ALLOW-EXCL NOT NUMERIC OR EMP-OT-MIN NOT NUMERIC OR EMP-HOL-MIN NOT NUMERIC OR EMP-NIGHT-MIN NOT NUMERIC OR EMP-REG-MIN NOT NUMERIC` | `EVALUATE TRUE` |  | 要確認 | `source/cobol/PAYVAL.cbl:119` |
| `PAYVAL-R011` | 条件判定 | `3000-VALIDATE` | `EVALUATE TRUE WHEN NOT EMP-PART-TIME AND (EMP-SCHED-HRS NOT NUMERIC OR EMP-SCHED-HRS = ZERO)` | `EVALUATE TRUE` |  | 要確認 | `source/cobol/PAYVAL.cbl:128` |
| `PAYVAL-R012` | 計算式 | `3100-CROSS-CHECKS` | `COMPUTE WS-WORKED-MIN = EMP-OT-MIN + EMP-HOL-MIN` |  |  | 要確認 | `source/cobol/PAYVAL.cbl:138` |
| `PAYVAL-R013` | 条件判定 | `3100-CROSS-CHECKS` | `IF EMP-PART-TIME` |  |  | 要確認 | `source/cobol/PAYVAL.cbl:139` |
| `PAYVAL-R014` | 計算式 | `3100-CROSS-CHECKS` | `ADD EMP-REG-MIN TO WS-WORKED-MIN` | `IF EMP-PART-TIME` |  | 要確認 | `source/cobol/PAYVAL.cbl:140` |
| `PAYVAL-R015` | 計算式 | `3100-CROSS-CHECKS` | `COMPUTE WS-WORKED-MIN = WS-WORKED-MIN + (EMP-SCHED-HRS * 60)` | `ELSE OF IF EMP-PART-TIME` |  | 要確認 | `source/cobol/PAYVAL.cbl:142` |
| `PAYVAL-R016` | 条件判定 | `3100-CROSS-CHECKS` | `IF EMP-NIGHT-MIN > WS-WORKED-MIN` |  |  | 要確認 | `source/cobol/PAYVAL.cbl:145` |
| `PAYVAL-R017` | 条件判定 | `9000-TERMINATE` | `EVALUATE TRUE WHEN WS-VALID-CNT = ZERO` | `EVALUATE TRUE` |  | 要確認 | `source/cobol/PAYVAL.cbl:172` |
| `PAYVAL-R018` | リテラル代入 | `9000-TERMINATE` | `MOVE 8 TO RETURN-CODE` | `EVALUATE TRUE WHEN WS-VALID-CNT = ZERO` |  | 要確認 | `source/cobol/PAYVAL.cbl:173` |
| `PAYVAL-R019` | 条件判定 | `9000-TERMINATE` | `EVALUATE TRUE WHEN WS-REJECT-CNT > ZERO` | `EVALUATE TRUE` |  | 要確認 | `source/cobol/PAYVAL.cbl:174` |
| `PAYVAL-R020` | リテラル代入 | `9000-TERMINATE` | `MOVE 4 TO RETURN-CODE` | `EVALUATE TRUE WHEN WS-REJECT-CNT > ZERO` |  | 要確認 | `source/cobol/PAYVAL.cbl:175` |
| `PAYVAL-R021` | 条件名 (88) |  | `EMP-REGULAR = 'R' (of EMP-TYPE)` |  |  | 要確認 | `source/copybook/EMPREC.cpy:34` |
| `PAYVAL-R022` | 条件名 (88) |  | `EMP-PART-TIME = 'P' (of EMP-TYPE)` |  |  | 要確認 | `source/copybook/EMPREC.cpy:35` |
| `PAYVAL-R023` | 条件名 (88) |  | `EMP-MANAGER = 'M' (of EMP-TYPE)` |  |  | 要確認 | `source/copybook/EMPREC.cpy:36` |
| `PAYVAL-R024` | 条件名 (88) |  | `EMP-TYPE-VALID = 'R' OR 'P' OR 'M' (of EMP-TYPE)` |  |  | 要確認 | `source/copybook/EMPREC.cpy:37` |
| `PAYVAL-R025` | 条件名 (88) |  | `END-OF-INPUT = 'Y' (of WS-EOF-SW)` |  |  | 要確認 | `source/cobol/PAYVAL.cbl:45` |

> ルールエンジンが抽出した候補です（ソース原文とリテラル値）。業務上の意味は担当者による確認が必要です。

## 4. データ項目定義書

### 4.1 EMPREC (`source/copybook/EMPREC.cpy:1`)

- 使用プログラム: `PAYCALC` `source/cobol/PAYCALC.cbl:43`
- 使用プログラム: `PAYVAL` `source/cobol/PAYVAL.cbl:32`
- レコード EMP-RECORD：80 バイト `source/copybook/EMPREC.cpy:27`

| レベル | 名称 | PIC | USAGE | バイト数 | 位置 | OCCURS | REDEFINES | VALUE／88 | 説明（コメントより） | 根拠 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 01 | `EMP-RECORD` |  | DISPLAY | 80 | 1-80 |  |  |  |  | `source/copybook/EMPREC.cpy:27` |
| 05 | &nbsp;&nbsp;`EMP-ID` | `X(06)` | DISPLAY | 6 | 1-6 |  |  |  | NUMERIC STAFF NUMBER | `source/copybook/EMPREC.cpy:28` |
| 05 | &nbsp;&nbsp;`EMP-ID-N` | `9(06)` | DISPLAY | 6 | 1-6 |  | `EMP-ID` |  |  | `source/copybook/EMPREC.cpy:29` |
| 05 | &nbsp;&nbsp;`EMP-DEPT` | `X(03)` | DISPLAY | 3 | 7-9 |  |  |  | ASM/MCH/QAC/LOG/ADM | `source/copybook/EMPREC.cpy:31` |
| 05 | &nbsp;&nbsp;`EMP-NAME` | `X(20)` | DISPLAY | 20 | 10-29 |  |  |  | ROMANISED, FAMILY NAME FIRST | `source/copybook/EMPREC.cpy:32` |
| 05 | &nbsp;&nbsp;`EMP-TYPE` | `X(01)` | DISPLAY | 1 | 30-30 |  |  |  | R=MONTHLY P=HOURLY M=MANAGER | `source/copybook/EMPREC.cpy:33` |
| 88 | &nbsp;&nbsp;&nbsp;&nbsp;`EMP-REGULAR` |  |  |  |  |  |  | `'R'` |  | `source/copybook/EMPREC.cpy:34` |
| 88 | &nbsp;&nbsp;&nbsp;&nbsp;`EMP-PART-TIME` |  |  |  |  |  |  | `'P'` |  | `source/copybook/EMPREC.cpy:35` |
| 88 | &nbsp;&nbsp;&nbsp;&nbsp;`EMP-MANAGER` |  |  |  |  |  |  | `'M'` |  | `source/copybook/EMPREC.cpy:36` |
| 88 | &nbsp;&nbsp;&nbsp;&nbsp;`EMP-TYPE-VALID` |  |  |  |  |  |  | `'R' 'P' 'M'` |  | `source/copybook/EMPREC.cpy:37` |
| 05 | &nbsp;&nbsp;`EMP-BASE-PAY` | `9(07)` | DISPLAY | 7 | 31-37 |  |  |  | MONTHLY BASE (R,M) / HOURLY RATE (P) | `source/copybook/EMPREC.cpy:38` |
| 05 | &nbsp;&nbsp;`EMP-ALLOW-INCL` | `9(06)` | DISPLAY | 6 | 38-43 |  |  |  | JOB+SKILL ALLOWANCE (IN OT BASE) | `source/copybook/EMPREC.cpy:39` |
| 05 | &nbsp;&nbsp;`EMP-ALLOW-EXCL` | `9(06)` | DISPLAY | 6 | 44-49 |  |  |  | FAMILY+COMMUTING (NOT IN OT BASE) | `source/copybook/EMPREC.cpy:40` |
| 05 | &nbsp;&nbsp;`EMP-SCHED-HRS` | `9(03)V9(02)` | DISPLAY | 5 | 50-54 |  |  |  | AVG MONTHLY SCHEDULED HRS 999V99 | `source/copybook/EMPREC.cpy:41` |
| 05 | &nbsp;&nbsp;`EMP-OT-MIN` | `9(05)` | DISPLAY | 5 | 55-59 |  |  |  | STATUTORY OVERTIME MINUTES | `source/copybook/EMPREC.cpy:42` |
| 05 | &nbsp;&nbsp;`EMP-HOL-MIN` | `9(05)` | DISPLAY | 5 | 60-64 |  |  |  | STATUTORY HOLIDAY WORK MINUTES | `source/copybook/EMPREC.cpy:43` |
| 05 | &nbsp;&nbsp;`EMP-NIGHT-MIN` | `9(05)` | DISPLAY | 5 | 65-69 |  |  |  | NIGHT MINUTES 22:00-05:00 | `source/copybook/EMPREC.cpy:44` |
| 05 | &nbsp;&nbsp;`EMP-REG-MIN` | `9(05)` | DISPLAY | 5 | 70-74 |  |  |  | SCHEDULED MINUTES WORKED (P ONLY) | `source/copybook/EMPREC.cpy:45` |
| 05 | &nbsp;&nbsp;`FILLER` | `X(06)` | DISPLAY | 6 | 75-80 |  |  |  |  | `source/copybook/EMPREC.cpy:46` |

### 4.2 PAYREC (`source/copybook/PAYREC.cpy:1`)

- 使用プログラム: `PAYCALC` `source/cobol/PAYCALC.cbl:45`
- 使用プログラム: `PAYRPT` `source/cobol/PAYRPT.cbl:24`
- レコード PAY-RECORD：120 バイト `source/copybook/PAYREC.cpy:11`

| レベル | 名称 | PIC | USAGE | バイト数 | 位置 | OCCURS | REDEFINES | VALUE／88 | 説明（コメントより） | 根拠 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 01 | `PAY-RECORD` |  | DISPLAY | 120 | 1-120 |  |  |  |  | `source/copybook/PAYREC.cpy:11` |
| 05 | &nbsp;&nbsp;`PAY-ID` | `X(06)` | DISPLAY | 6 | 1-6 |  |  |  |  | `source/copybook/PAYREC.cpy:12` |
| 05 | &nbsp;&nbsp;`PAY-DEPT` | `X(03)` | DISPLAY | 3 | 7-9 |  |  |  |  | `source/copybook/PAYREC.cpy:13` |
| 05 | &nbsp;&nbsp;`PAY-NAME` | `X(20)` | DISPLAY | 20 | 10-29 |  |  |  |  | `source/copybook/PAYREC.cpy:14` |
| 05 | &nbsp;&nbsp;`PAY-TYPE` | `X(01)` | DISPLAY | 1 | 30-30 |  |  |  |  | `source/copybook/PAYREC.cpy:15` |
| 05 | &nbsp;&nbsp;`PAY-HOURLY-RATE` | `9(05)` | DISPLAY | 5 | 31-35 |  |  |  |  | `source/copybook/PAYREC.cpy:16` |
| 05 | &nbsp;&nbsp;`PAY-BASE-AMT` | `9(07)` | DISPLAY | 7 | 36-42 |  |  |  |  | `source/copybook/PAYREC.cpy:17` |
| 05 | &nbsp;&nbsp;`PAY-ALLOW-AMT` | `9(07)` | DISPLAY | 7 | 43-49 |  |  |  |  | `source/copybook/PAYREC.cpy:18` |
| 05 | &nbsp;&nbsp;`PAY-OT-HRS` | `9(03)` | DISPLAY | 3 | 50-52 |  |  |  |  | `source/copybook/PAYREC.cpy:19` |
| 05 | &nbsp;&nbsp;`PAY-OT1-HRS` | `9(03)` | DISPLAY | 3 | 53-55 |  |  |  |  | `source/copybook/PAYREC.cpy:20` |
| 05 | &nbsp;&nbsp;`PAY-OT2-HRS` | `9(03)` | DISPLAY | 3 | 56-58 |  |  |  |  | `source/copybook/PAYREC.cpy:21` |
| 05 | &nbsp;&nbsp;`PAY-OT1-AMT` | `9(07)` | DISPLAY | 7 | 59-65 |  |  |  |  | `source/copybook/PAYREC.cpy:22` |
| 05 | &nbsp;&nbsp;`PAY-OT2-AMT` | `9(07)` | DISPLAY | 7 | 66-72 |  |  |  |  | `source/copybook/PAYREC.cpy:23` |
| 05 | &nbsp;&nbsp;`PAY-HOL-HRS` | `9(03)` | DISPLAY | 3 | 73-75 |  |  |  |  | `source/copybook/PAYREC.cpy:24` |
| 05 | &nbsp;&nbsp;`PAY-HOL-AMT` | `9(07)` | DISPLAY | 7 | 76-82 |  |  |  |  | `source/copybook/PAYREC.cpy:25` |
| 05 | &nbsp;&nbsp;`PAY-NIGHT-HRS` | `9(03)` | DISPLAY | 3 | 83-85 |  |  |  |  | `source/copybook/PAYREC.cpy:26` |
| 05 | &nbsp;&nbsp;`PAY-NIGHT-AMT` | `9(07)` | DISPLAY | 7 | 86-92 |  |  |  |  | `source/copybook/PAYREC.cpy:27` |
| 05 | &nbsp;&nbsp;`PAY-GROSS-AMT` | `9(08)` | DISPLAY | 8 | 93-100 |  |  |  |  | `source/copybook/PAYREC.cpy:28` |
| 05 | &nbsp;&nbsp;`PAY-ALERT-45` | `X(01)` | DISPLAY | 1 | 101-101 |  |  |  |  | `source/copybook/PAYREC.cpy:29` |
| 88 | &nbsp;&nbsp;&nbsp;&nbsp;`PAY-OVER-45H` |  |  |  |  |  |  | `'*'` |  | `source/copybook/PAYREC.cpy:30` |
| 05 | &nbsp;&nbsp;`PAY-ALERT-100` | `X(01)` | DISPLAY | 1 | 102-102 |  |  |  |  | `source/copybook/PAYREC.cpy:31` |
| 88 | &nbsp;&nbsp;&nbsp;&nbsp;`PAY-AT-100H` |  |  |  |  |  |  | `'!'` |  | `source/copybook/PAYREC.cpy:32` |
| 05 | &nbsp;&nbsp;`FILLER` | `X(18)` | DISPLAY | 18 | 103-120 |  |  |  |  | `source/copybook/PAYREC.cpy:33` |

> バイト数は記憶域上の長さです（OCCURS は全出現分）。位置は 01 レコード内の 1 起点です。説明はコメントからの転記で、未検証です。SYNCHRONIZED の境界調整は考慮せず、OCCURS DEPENDING ON は最大値で計算しています。

## 5. CRUD マトリクス

> C＝WRITE／SQL INSERT／CICS WRITE／DD NEW、R＝READ・START／SQL SELECT・FETCH／CICS READ／DD SHR、U＝REWRITE／SQL UPDATE、D＝DELETE、?＝プログラムソースのないステップでの DISP=OLD。

| プログラム | `KZP.PY01.PAYCALC.M202609` | `KZP.PY01.TIMECARD.M202609` | `&&SORTED (PY01MNTH)` | `&&VALID (PY01MNTH)` | `PAYRPT.RPT-OUT (SYSOUT)` | `PAYVAL.ERR-RPT (SYSOUT)` | 根拠 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `PAYCALC` | C |  | R |  |  |  | `source/cobol/PAYCALC.cbl:124` `source/cobol/PAYCALC.cbl:208` |
| `PAYRPT` | R |  |  |  | C |  | `source/cobol/PAYRPT.cbl:294` `source/cobol/PAYRPT.cbl:302` `source/cobol/PAYRPT.cbl:305` `source/cobol/PAYRPT.cbl:307` `source/cobol/PAYRPT.cbl:309` `source/cobol/PAYRPT.cbl:313` |
| `PAYVAL` |  | R |  | C |  | C | `source/cobol/PAYVAL.cbl:87` `source/cobol/PAYVAL.cbl:94` `source/cobol/PAYVAL.cbl:156` `source/cobol/PAYVAL.cbl:159` `source/cobol/PAYVAL.cbl:167` |
| `SORT` |  |  | C | ? |  |  | `source/jcl/PY01MNTH.jcl:26` `source/jcl/PY01MNTH.jcl:27` |

### 5.1 根拠一覧

| プログラム | 対象 | 操作 | 文・句 | 段落 | ステップ | 根拠 |
| --- | --- | --- | --- | --- | --- | --- |
| `PAYCALC` | `&&SORTED (PY01MNTH)` | R | READ | `8000-READ-INPUT` | PY01MNTH.STEP030 | `source/cobol/PAYCALC.cbl:208` `source/jcl/PY01MNTH.jcl:37` |
| `PAYCALC` | `KZP.PY01.PAYCALC.M202609` | C | WRITE | `2000-PROCESS` | PY01MNTH.STEP030 | `source/cobol/PAYCALC.cbl:124` `source/jcl/PY01MNTH.jcl:38` |
| `PAYRPT` | `KZP.PY01.PAYCALC.M202609` | R | READ | `8000-READ-INPUT` | PY01MNTH.STEP040 | `source/cobol/PAYRPT.cbl:313` `source/jcl/PY01MNTH.jcl:46` |
| `PAYRPT` | `PAYRPT.RPT-OUT (SYSOUT)` | C | WRITE | `7100-PRINT-LINE` |  | `source/cobol/PAYRPT.cbl:294` |
| `PAYRPT` | `PAYRPT.RPT-OUT (SYSOUT)` | C | WRITE | `7200-PAGE-HEADING` |  | `source/cobol/PAYRPT.cbl:302` |
| `PAYRPT` | `PAYRPT.RPT-OUT (SYSOUT)` | C | WRITE | `7200-PAGE-HEADING` |  | `source/cobol/PAYRPT.cbl:305` |
| `PAYRPT` | `PAYRPT.RPT-OUT (SYSOUT)` | C | WRITE | `7200-PAGE-HEADING` |  | `source/cobol/PAYRPT.cbl:307` |
| `PAYRPT` | `PAYRPT.RPT-OUT (SYSOUT)` | C | WRITE | `7200-PAGE-HEADING` |  | `source/cobol/PAYRPT.cbl:309` |
| `PAYVAL` | `KZP.PY01.TIMECARD.M202609` | R | READ | `8000-READ-INPUT` | PY01MNTH.STEP010 | `source/cobol/PAYVAL.cbl:159` `source/jcl/PY01MNTH.jcl:18` |
| `PAYVAL` | `PAYVAL.ERR-RPT (SYSOUT)` | C | WRITE | `1000-INITIALISE` |  | `source/cobol/PAYVAL.cbl:87` |
| `PAYVAL` | `PAYVAL.ERR-RPT (SYSOUT)` | C | WRITE | `4000-WRITE-ERROR` |  | `source/cobol/PAYVAL.cbl:156` |
| `PAYVAL` | `PAYVAL.ERR-RPT (SYSOUT)` | C | WRITE | `9000-TERMINATE` |  | `source/cobol/PAYVAL.cbl:167` |
| `PAYVAL` | `&&VALID (PY01MNTH)` | C | WRITE | `2000-PROCESS` | PY01MNTH.STEP010 | `source/cobol/PAYVAL.cbl:94` `source/jcl/PY01MNTH.jcl:19` |
| `SORT` | `&&VALID (PY01MNTH)` | ? | DISP=(OLD,DELETE) (SORTIN) |  | PY01MNTH.STEP020 | `source/jcl/PY01MNTH.jcl:26` |
| `SORT` | `&&SORTED (PY01MNTH)` | C | DISP=(NEW,PASS) (SORTOUT) |  | PY01MNTH.STEP020 | `source/jcl/PY01MNTH.jcl:27` |

## 6. カバレッジと要確認事項

### 6.1 解析したファイル

| ファイル | 種別 | 行数 | 内容 | 根拠 |
| --- | --- | --- | --- | --- |
| source/cobol/PAYCALC.cbl | COBOL | 215 | PAYCALC | `source/cobol/PAYCALC.cbl:1` |
| source/cobol/PAYRND.cbl | COBOL | 64 | PAYRND | `source/cobol/PAYRND.cbl:1` |
| source/cobol/PAYRPT.cbl | COBOL | 315 | PAYRPT | `source/cobol/PAYRPT.cbl:1` |
| source/cobol/PAYVAL.cbl | COBOL | 178 | PAYVAL | `source/cobol/PAYVAL.cbl:1` |
| source/copybook/EMPREC.cpy | コピーブック | 46 |  | `source/copybook/EMPREC.cpy:1` |
| source/copybook/PAYREC.cpy | コピーブック | 33 |  | `source/copybook/PAYREC.cpy:1` |
| source/jcl/PY01MNTH.jcl | JCL | 49 | PY01MNTH | `source/jcl/PY01MNTH.jcl:1` |

### 6.2 解析対象外

> フォルダ内の次の 8 ファイルは解析していません（COBOL・コピーブック・JCL の拡張子ではないため）：
>
> `PACK.json`, `README.md`, `data/TIMECARD.M202609.dat`, `docs/expected/PAYCALC.M202609.dat`, `docs/expected/PAYRPT.M202609.txt`, `docs/expected/PAYVAL-ERRRPT.M202609.txt`, `output/.gitkeep`, `source/scripts/run-local.sh`

> 方針により読み込まないフォルダ：_answer-keys、.legacy-index、.kurahi、.git、node_modules。

### 6.3 解析時の診断

診断はありません。

### 6.4 コードから検出した要確認事項 (1)

| 区分 | 対象 | 詳細 | 確認事項 | 根拠 |
| --- | --- | --- | --- | --- |
| ソースのないプログラムを実行するステップ | `PY01MNTH.STEP020` | SORT | ユーティリティと制御文の確認 | `source/jcl/PY01MNTH.jcl:25` |

### 6.5 担当者による記入事項

- PAYCALC の業務目的：要確認 `source/cobol/PAYCALC.cbl:1`
- PAYRND の業務目的：要確認 `source/cobol/PAYRND.cbl:1`
- PAYRPT の業務目的：要確認 `source/cobol/PAYRPT.cbl:1`
- PAYVAL の業務目的：要確認 `source/cobol/PAYVAL.cbl:1`

### 6.6 解析の限界

> 静的解析のみです。実行時の値（動的 CALL の呼出し先、実行時に決まるデータセット名、PARM の値）は確定しません。
>
> COBOL：固定形式・自由形式の COBOL-85 と一般的な後続規格の拡張を対象とします。ベンダー固有の構文、REPLACE 文、条件付きコンパイルは原文のまま解析するか、解析しません（診断を参照）。
>
> EXEC SQL：テーブル名と先頭キーワードのみ（SELECT・DECLARE・FETCH＝R、INSERT＝C、UPDATE＝U、DELETE＝D）。動的 SQL（PREPARE／EXECUTE）の対象は不明です。INCLUDE メンバーは展開しません。
>
> EXEC CICS：FILE／DATASET がリテラルのファイル操作と、PROGRAM がリテラルの LINK／XCTL のみ。マップ、キュー、START／RETURN TRANSID、チャネルはモデル化していません。
>
> JCL：JOB、EXEC、DD、SET、PROC／PEND、記号パラメータ。JCL の IF／THEN／ELSE、INCLUDE、ソースのないカタログ式プロシージャ、スケジューラによるジョブ間の依存関係は解析しません。
>
> 対象外：IMS DL/I、アセンブラ、REXX／CLIST、ユーティリティの制御文、スケジューラ定義。Java・SQL DDL・FORTRAN・PL/I のソースは、文書の対象に含まれる場合それぞれの章で扱います。
>
> 業務上の意図やルールの意味は推論しません。「要確認」はすべて担当者が回答する事項です。
