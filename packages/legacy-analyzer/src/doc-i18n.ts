// String tables of the generated documents (design document and wave plan), Japanese and
// English, in one place. Japanese follows the usual 設計書 vocabulary of enterprise IT.

export type DocLang = "ja" | "en";

export const DOC_LANGS: DocLang[] = ["ja", "en"];

export type GapKind =
  | "externalCalls"
  | "dynamicCalls"
  | "missingCopybooks"
  | "stepsWithoutSource"
  | "execNotModelled"
  | "unboundFiles"
  | "unboundDds"
  | "noEntry"
  | "unreferencedParagraphs"
  | "unknownLengths";

type Totals = {
  programs: number;
  copybooks: number;
  jobs: number;
  steps: number;
  paragraphs: number;
  statements: number;
  external: number;
};

const ACCESS_EN: Record<string, string> = {
  input: "input (SHR)",
  output: "output (NEW/MOD)",
  exclusive: "exclusive (OLD)",
  sysout: "SYSOUT",
  instream: "in-stream",
  unknown: "unknown",
};
const ACCESS_JA: Record<string, string> = {
  input: "入力 (SHR)",
  output: "出力 (NEW/MOD)",
  exclusive: "排他 (OLD)",
  sysout: "SYSOUT",
  instream: "インストリーム",
  unknown: "不明",
};

const RULE_EN: Record<string, string> = {
  condition: "condition",
  arithmetic: "arithmetic",
  rounding: "rounding",
  "condition-name": "condition name (88)",
  constant: "constant",
  "literal-assignment": "literal assignment",
};
const RULE_JA: Record<string, string> = {
  condition: "条件判定",
  arithmetic: "計算式",
  rounding: "端数処理",
  "condition-name": "条件名 (88)",
  constant: "定数",
  "literal-assignment": "リテラル代入",
};

const GAP_EN: Record<GapKind, [string, string]> = {
  externalCalls: [
    "CALL target without source",
    "Supply the source or confirm it is a system/vendor routine",
  ],
  dynamicCalls: ["Dynamic CALL", "Confirm the possible run-time targets"],
  missingCopybooks: ["Copybook not found", "Supply the copybook; its fields are not analysed"],
  stepsWithoutSource: [
    "Step runs a program without source",
    "Confirm the utility and its control statements",
  ],
  execNotModelled: [
    "EXEC block not modelled",
    "Review by hand (not in the graph or the CRUD matrix)",
  ],
  unboundFiles: [
    "SELECT without a DD in the step",
    "Confirm the data set (dynamic allocation, other JCL?)",
  ],
  unboundDds: ["DD not bound to a SELECT", "Confirm how the program uses it"],
  noEntry: [
    "Program not run by a step or called",
    "Confirm the entry point (online transaction, scheduler, other JCL?)",
  ],
  unreferencedParagraphs: [
    "Paragraph not PERFORMed or GO TO target",
    "Fall-through or dead code: confirm",
  ],
  unknownLengths: ["Field length not computable", "Confirm the PIC/USAGE"],
};
const GAP_JA: Record<GapKind, [string, string]> = {
  externalCalls: [
    "ソースのない CALL 先",
    "ソースの提供、またはシステム／製品ルーチンであることの確認",
  ],
  dynamicCalls: ["動的 CALL", "実行時に呼ばれうるプログラムの確認"],
  missingCopybooks: ["コピーブック未検出", "コピーブックの提供（項目は未解析）"],
  stepsWithoutSource: ["ソースのないプログラムを実行するステップ", "ユーティリティと制御文の確認"],
  execNotModelled: ["未モデル化の EXEC ブロック", "目視確認（グラフ・CRUD に未反映）"],
  unboundFiles: ["ステップに DD がない SELECT", "データセットの確認（動的割当て、別 JCL など）"],
  unboundDds: ["SELECT に対応しない DD", "プログラムでの使われ方の確認"],
  noEntry: [
    "ステップからも CALL からも起動されないプログラム",
    "起動方法の確認（オンライン、スケジューラ、別 JCL など）",
  ],
  unreferencedParagraphs: ["PERFORM／GO TO されない段落", "フォールスルーか未使用コードかの確認"],
  unknownLengths: ["長さを算出できない項目", "PIC／USAGE の確認"],
};

const en = {
  tbc: "needs confirmation",
  title: (name: string) => `Design document (generated from code): ${name}`,
  preamble:
    'Every statement in this document is extracted deterministically from the source code. The `path:line` on each line is the source location it comes from. What code cannot tell, such as business intent, is marked "needs confirmation" for a person to fill in.',
  provenance: (files: number, fp: string) =>
    `Source: ${files} files analysed, source fingerprint sha256:${fp}.`,
  toc: "Contents",
  overview: "System overview",
  inventory: "Inventory",
  kindProgram: "COBOL program",
  kindCopybook: "Copybook",
  kindJob: "JCL job",
  kindProc: "JCL procedure",
  totals: (t: Totals) =>
    `Totals of the table above and the graph: programs ${t.programs}, copybooks ${t.copybooks}, jobs/procedures ${t.jobs}, job steps ${t.steps}, paragraphs ${t.paragraphs}, statements ${t.statements}, called or executed programs without source ${t.external}.`,
  callDiagram: "Program relationships",
  diagramNote:
    "Solid arrows: static CALL or step EXEC. Dashed: dynamic CALL (target is a data item). Parallelogram boxes: programs without source or dynamic targets. Each arrow is listed with its source lines in the next table.",
  relations: "Relationships with sources",
  relExec: "EXEC (step runs program)",
  relCall: "CALL",
  jobFlow: "Job flow",
  programSpecs: "Program specifications",
  dictionary: "Data dictionary",
  crud: "CRUD matrix",
  coverage: "Coverage and open questions",
  none: "None found.",
  noneShort: "-",
  colKind: "Kind",
  colName: "Name",
  colFile: "File",
  colLines: "Lines",
  colSource: "Source",
  colFrom: "From",
  colRelation: "Relation",
  colTo: "To",
  colCount: "Occurrences",
  sqlTable: "SQL table",
  cicsFile: "CICS file",
  noDd: "no DD",
  dynamic: "dynamic",
  noJobs: "No JCL found.",
  colSymbol: "Symbol",
  colValue: "Value",
  noSource: "no source",
  colStep: "Step",
  colProgram: "Program",
  colDataset: "Data set",
  colAccess: "Access (from DISP)",
  access: (a: string) => ACCESS_EN[a] ?? a,
  colBoundFile: "Program file (SELECT)",
  lineage: "Data set lineage",
  colProducers: "Written by (C/U/D)",
  colConsumers: "Read by (R/?)",
  lineageNote:
    'Temporary data sets (&&NAME) are scoped to their job. "?" means a step without program source opens the data set with DISP=OLD: read or rewrite cannot be told from JCL.',
  basics: "Basic information",
  purpose: "Purpose",
  io: "Inputs and outputs",
  callRelations: "Calls",
  performStructure: "PERFORM structure",
  businessRules: "Business-rule candidates",
  fProgramId: "PROGRAM-ID",
  fSource: "Source",
  linesRange: (a: number, b: number) => `lines ${a}-${b}`,
  fCounts: "Paragraphs / statements / data items",
  counts: (p: number, st: number, d: number) => `${p} / ${st} / ${d}`,
  fRunBy: "Run by job step",
  colItem: "Item",
  colContent: "Content",
  purposeLine:
    "Business purpose: **needs confirmation**. It cannot be derived from code; a person who knows the system must state it.",
  headerCommentNote:
    "Header comment of the source, quoted as written (not verified; comments may be out of date):",
  colFileDef: "File (SELECT/FD)",
  colOrganization: "Organisation",
  colOps: "Operations",
  colRecords: "Records",
  colBoundDd: "DD → data set",
  colTarget: "Target",
  colParagraph: "Paragraph",
  noIo: "No file, SQL or CICS I/O found.",
  callsOut: "calls",
  callsIn: "called by",
  colDirection: "Direction",
  colPartner: "Program",
  noCalls: "No CALL relations.",
  noParagraphs: "No paragraphs.",
  recursive: "(cycle)",
  seenAbove: "(expanded above)",
  entry: "first paragraph, entry point",
  unreferenced: "not PERFORMed or GO TO target (fall-through or unused: needs confirmation)",
  noRules: "No rule candidates.",
  ruleKind: (k: string) => RULE_EN[k] ?? k,
  colId: "ID",
  colExpression: "Expression (source text)",
  colGuards: "Under condition",
  colConstants: "Named constants",
  colMeaning: "Business meaning",
  rulesNote:
    "Candidates from the rules engine: exact source text and literal values. Their business meaning needs confirmation by a person.",
  noCopybooks: "No copybooks found.",
  cannotRead: "Cannot read the copybook",
  usedBy: "Used by",
  usedByNone: "Not used by any analysed program",
  recordLength: (name: string, len?: number) =>
    `Record ${name}: ${len === undefined ? "length not computable" : `${len} bytes`}`,
  unknown: "unknown",
  colLevel: "Level",
  colBytes: "Bytes",
  colPosition: "Position",
  colValues: "VALUE / 88",
  colDescription: "Description (from comments)",
  dictionaryNote:
    "Bytes are storage bytes (for OCCURS, of all occurrences). Positions are 1-based within the 01 record. Descriptions are copied from comments, not verified. SYNCHRONIZED alignment is not applied; OCCURS DEPENDING ON uses the maximum.",
  noCrud: "No data access found.",
  crudLegend:
    "C = WRITE / SQL INSERT / CICS WRITE / DD NEW. R = READ, START / SQL SELECT, FETCH / CICS READ / DD SHR. U = REWRITE / SQL UPDATE. D = DELETE. ? = DISP=OLD on a step without program source.",
  crudEvidence: "Evidence",
  colOp: "Op",
  colVia: "Statement / clause",
  parsedFiles: "Files analysed",
  colContains: "Contains",
  fileKind: (k: string): string =>
    k === "cobol" ? "COBOL" : k === "copybook" ? "copybook" : "JCL",
  notParsed: "Not analysed",
  colReason: "Reason",
  otherFiles: (n: number) =>
    `${n} other files under the folder were not analysed (not a COBOL, copybook or JCL extension):`,
  nothingSkipped: "Every file under the folder was analysed.",
  excludedDirs:
    "Never read by policy: folders named _answer-keys, .legacy-index, .kurahi, .git and node_modules.",
  diagnostics: "Parser diagnostics",
  colSeverity: "Severity",
  colMessage: "Message",
  noDiagnostics: "No diagnostics.",
  openQuestions: "Open questions found in the code",
  gapKind: (k: GapKind) => GAP_EN[k][0],
  gapAction: (k: GapKind) => GAP_EN[k][1],
  colGap: "Gap",
  colSubject: "Subject",
  colDetail: "Detail",
  colAction: "To do",
  noGaps: "None.",
  humanInput: "To be supplied by people",
  purposeQuestion: (p: string) => `Business purpose of ${p}: needs confirmation`,
  limits: "Limits of the analysis",
  limitNotes: [
    "Static analysis only. Run-time values (dynamic CALL targets, data set names set at run time, PARM values) are not known.",
    "COBOL: fixed and free format COBOL-85 with common later extensions. Vendor-specific syntax, REPLACE and conditional compilation are analysed as written or not at all; see the diagnostics.",
    "EXEC SQL: table names and the first keyword only (SELECT/DECLARE/FETCH = R, INSERT = C, UPDATE = U, DELETE = D). Dynamic SQL (PREPARE/EXECUTE) targets are unknown. INCLUDE members are not expanded.",
    "EXEC CICS: file commands with a literal FILE/DATASET and LINK/XCTL with a literal PROGRAM. Maps, queues, START/RETURN TRANSID and channels are not modelled.",
    "JCL: JOB, EXEC, DD, SET, PROC/PEND and symbols. JCL IF/THEN/ELSE, INCLUDE, cataloged procedures without source and scheduler dependencies between jobs are not analysed.",
    "Not analysed: IMS DL/I, assembler, REXX/CLIST, utility control statements, scheduler definitions. Java, SQL DDL, FORTRAN and PL/I sources have their own sections when the document covers them.",
    'Business intent and the meaning of rules are never inferred; every "needs confirmation" is for a person to answer.',
  ],
};

export type Strings = typeof en;

const ja: Strings = {
  tbc: "要確認",
  title: (name: string) => `設計書（ソースコードから生成）：${name}`,
  preamble:
    "本書の記載はすべてソースコードから決定的に抽出した事実です。各行の `path:line` は根拠となるソースの位置を示します。業務上の意図など、コードから導けない事項は「要確認」として明示し、担当者の記入を前提としています。",
  provenance: (files: number, fp: string) => `解析対象：${files} ファイル、ソース指紋 sha256:${fp}`,
  toc: "目次",
  overview: "システム概要",
  inventory: "資産一覧",
  kindProgram: "COBOL プログラム",
  kindCopybook: "コピーブック",
  kindJob: "JCL ジョブ",
  kindProc: "JCL プロシージャ",
  totals: (t: Totals) =>
    `上表とグラフの集計：プログラム ${t.programs} 本、コピーブック ${t.copybooks} 本、ジョブ／プロシージャ ${t.jobs} 本、ジョブステップ ${t.steps}、段落 ${t.paragraphs}、文 ${t.statements}、ソースのない呼出し先・実行プログラム ${t.external}。`,
  callDiagram: "プログラム関連図",
  diagramNote:
    "実線：静的 CALL またはステップの EXEC。破線：動的 CALL（呼出し先がデータ項目）。平行四辺形の枠：ソースのないプログラム、動的な呼出し先。各矢印の根拠行は次の表に記載しています。",
  relations: "関連一覧（根拠付き）",
  relExec: "EXEC（ステップがプログラムを実行）",
  relCall: "CALL",
  jobFlow: "ジョブフロー",
  programSpecs: "プログラム仕様書",
  dictionary: "データ項目定義書",
  crud: "CRUD マトリクス",
  coverage: "カバレッジと要確認事項",
  none: "該当なし。",
  noneShort: "-",
  colKind: "種別",
  colName: "名称",
  colFile: "ファイル",
  colLines: "行数",
  colSource: "根拠",
  colFrom: "元",
  colRelation: "関係",
  colTo: "先",
  colCount: "件数",
  sqlTable: "SQL テーブル",
  cicsFile: "CICS ファイル",
  noDd: "DD なし",
  dynamic: "動的",
  noJobs: "JCL はありません。",
  colSymbol: "記号パラメータ",
  colValue: "値",
  noSource: "ソースなし",
  colStep: "ステップ",
  colProgram: "プログラム",
  colDataset: "データセット",
  colAccess: "アクセス（DISP より）",
  access: (a: string) => ACCESS_JA[a] ?? a,
  colBoundFile: "プログラムのファイル（SELECT）",
  lineage: "データセットの系譜",
  colProducers: "作成・更新・削除（C/U/D）",
  colConsumers: "参照（R/?）",
  lineageNote:
    "一時データセット（&&名前）はジョブ単位で区別しています。「?」はプログラムソースのないステップが DISP=OLD で使用していることを示し、参照か更新かは JCL からは判別できません。",
  basics: "基本情報",
  purpose: "目的",
  io: "入出力",
  callRelations: "呼出し関係",
  performStructure: "PERFORM 構造",
  businessRules: "業務ルール候補",
  fProgramId: "プログラムID",
  fSource: "ソース",
  linesRange: (a: number, b: number) => `${a}〜${b} 行`,
  fCounts: "段落数／文数／データ項目数",
  counts: (p: number, st: number, d: number) => `${p}／${st}／${d}`,
  fRunBy: "実行ジョブステップ",
  colItem: "項目",
  colContent: "内容",
  purposeLine:
    "業務目的：**要確認**。コードからは導けないため、業務を知る担当者による記入が必要です。",
  headerCommentNote:
    "ソース冒頭のコメント（原文のまま引用。内容は未検証で、現状と異なる可能性があります）：",
  colFileDef: "ファイル（SELECT/FD）",
  colOrganization: "編成",
  colOps: "操作",
  colRecords: "レコード",
  colBoundDd: "DD → データセット",
  colTarget: "対象",
  colParagraph: "段落",
  noIo: "ファイル・SQL・CICS の入出力はありません。",
  callsOut: "呼出し先",
  callsIn: "呼出し元",
  colDirection: "方向",
  colPartner: "プログラム",
  noCalls: "CALL 関係はありません。",
  noParagraphs: "段落はありません。",
  recursive: "（循環）",
  seenAbove: "（上記で展開済み）",
  entry: "先頭段落・入口",
  unreferenced: "PERFORM／GO TO されていません（フォールスルーか未使用か：要確認）",
  noRules: "業務ルール候補はありません。",
  ruleKind: (k: string) => RULE_JA[k] ?? k,
  colId: "ID",
  colExpression: "式（ソース原文）",
  colGuards: "前提条件",
  colConstants: "名前付き定数",
  colMeaning: "業務上の意味",
  rulesNote:
    "ルールエンジンが抽出した候補です（ソース原文とリテラル値）。業務上の意味は担当者による確認が必要です。",
  noCopybooks: "コピーブックはありません。",
  cannotRead: "コピーブックを読み込めません",
  usedBy: "使用プログラム",
  usedByNone: "解析対象のプログラムからは使われていません",
  recordLength: (name: string, len?: number) =>
    `レコード ${name}：${len === undefined ? "長さ算出不可" : `${len} バイト`}`,
  unknown: "不明",
  colLevel: "レベル",
  colBytes: "バイト数",
  colPosition: "位置",
  colValues: "VALUE／88",
  colDescription: "説明（コメントより）",
  dictionaryNote:
    "バイト数は記憶域上の長さです（OCCURS は全出現分）。位置は 01 レコード内の 1 起点です。説明はコメントからの転記で、未検証です。SYNCHRONIZED の境界調整は考慮せず、OCCURS DEPENDING ON は最大値で計算しています。",
  noCrud: "データアクセスはありません。",
  crudLegend:
    "C＝WRITE／SQL INSERT／CICS WRITE／DD NEW、R＝READ・START／SQL SELECT・FETCH／CICS READ／DD SHR、U＝REWRITE／SQL UPDATE、D＝DELETE、?＝プログラムソースのないステップでの DISP=OLD。",
  crudEvidence: "根拠一覧",
  colOp: "操作",
  colVia: "文・句",
  parsedFiles: "解析したファイル",
  colContains: "内容",
  fileKind: (k: string) => (k === "cobol" ? "COBOL" : k === "copybook" ? "コピーブック" : "JCL"),
  notParsed: "解析対象外",
  colReason: "理由",
  otherFiles: (n: number) =>
    `フォルダ内の次の ${n} ファイルは解析していません（COBOL・コピーブック・JCL の拡張子ではないため）：`,
  nothingSkipped: "フォルダ内のファイルはすべて解析しました。",
  excludedDirs: "方針により読み込まないフォルダ：_answer-keys、.legacy-index、.kurahi、.git、node_modules。",
  diagnostics: "解析時の診断",
  colSeverity: "重要度",
  colMessage: "メッセージ",
  noDiagnostics: "診断はありません。",
  openQuestions: "コードから検出した要確認事項",
  gapKind: (k: GapKind) => GAP_JA[k][0],
  gapAction: (k: GapKind) => GAP_JA[k][1],
  colGap: "区分",
  colSubject: "対象",
  colDetail: "詳細",
  colAction: "確認事項",
  noGaps: "なし。",
  humanInput: "担当者による記入事項",
  purposeQuestion: (p: string) => `${p} の業務目的：要確認`,
  limits: "解析の限界",
  limitNotes: [
    "静的解析のみです。実行時の値（動的 CALL の呼出し先、実行時に決まるデータセット名、PARM の値）は確定しません。",
    "COBOL：固定形式・自由形式の COBOL-85 と一般的な後続規格の拡張を対象とします。ベンダー固有の構文、REPLACE 文、条件付きコンパイルは原文のまま解析するか、解析しません（診断を参照）。",
    "EXEC SQL：テーブル名と先頭キーワードのみ（SELECT・DECLARE・FETCH＝R、INSERT＝C、UPDATE＝U、DELETE＝D）。動的 SQL（PREPARE／EXECUTE）の対象は不明です。INCLUDE メンバーは展開しません。",
    "EXEC CICS：FILE／DATASET がリテラルのファイル操作と、PROGRAM がリテラルの LINK／XCTL のみ。マップ、キュー、START／RETURN TRANSID、チャネルはモデル化していません。",
    "JCL：JOB、EXEC、DD、SET、PROC／PEND、記号パラメータ。JCL の IF／THEN／ELSE、INCLUDE、ソースのないカタログ式プロシージャ、スケジューラによるジョブ間の依存関係は解析しません。",
    "対象外：IMS DL/I、アセンブラ、REXX／CLIST、ユーティリティの制御文、スケジューラ定義。Java・SQL DDL・FORTRAN・PL/I のソースは、文書の対象に含まれる場合それぞれの章で扱います。",
    "業務上の意図やルールの意味は推論しません。「要確認」はすべて担当者が回答する事項です。",
  ],
};

export function strings(lang: DocLang): Strings {
  return lang === "en" ? en : ja;
}

export function parseLang(v: unknown): DocLang | undefined {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  return s === "ja" || s === "en" ? s : undefined;
}
