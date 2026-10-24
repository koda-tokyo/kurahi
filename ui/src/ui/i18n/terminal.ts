export const terminalEn = {
  "terminal.title": "Project terminal",
  "terminal.open": "Open terminal",
  "terminal.close": "Close terminal and stop command",
  "terminal.cancel": "Stop command",
  "terminal.refresh": "Refresh output",
  "terminal.send": "Send line",
  "terminal.input": "Command or program input",
  "terminal.offline": "Disconnected. Commands may still be running. Reconnect to recover output.",
  "terminal.read": "Terminal input is unavailable in Read mode.",
  "terminal.other":
    "A terminal is open in another project. Return to that project to close it first.",
  "terminal.error":
    "Terminal request failed. Check the service and terminal permissions, then refresh output. A submitted command may already have run; it will not be sent again automatically.",
  "terminal.empty":
    "Open a project-bound terminal. Commands use the project's mode and approval rules.",
  "terminal.closed": "Terminal closed",
  "terminal.syncing": "Recovering output…",
  "terminal.ready": "Output up to date",
  "terminal.truncated": "Some earlier output is unavailable or omitted from this bounded view.",
  "terminal.approval": "Awaiting approval in the approval dialog. No input can approve a command.",
  "terminal.sandbox": "Container sandbox",
  "terminal.host": "Host execution: approved programs run with the service user's permissions.",
  "terminal.output": "Terminal output",
  "terminal.lineHint":
    "Send one line at a time. Use Stop command to cancel. Interactive screen applications are not supported by this text view.",
} as const;
export const terminalJa: Record<keyof typeof terminalEn, string> = {
  "terminal.title": "プロジェクト端末",
  "terminal.open": "端末を開く",
  "terminal.close": "端末を閉じてコマンドを停止",
  "terminal.cancel": "コマンドを停止",
  "terminal.refresh": "出力を更新",
  "terminal.send": "行を送信",
  "terminal.input": "コマンドまたはプログラムへの入力",
  "terminal.offline":
    "切断されています。コマンドは実行中の可能性があります。再接続して出力を復元してください。",
  "terminal.read": "参照モードでは端末に入力できません。",
  "terminal.other":
    "別のプロジェクトで端末が開いています。そのプロジェクトに戻って端末を閉じてください。",
  "terminal.error":
    "端末への要求に失敗しました。サービスと端末の権限を確認し、出力を更新してください。送信したコマンドは実行済みの可能性があり、自動で再送信されません。",
  "terminal.empty":
    "プロジェクト専用の端末を開きます。プロジェクトのモードと承認ルールが適用されます。",
  "terminal.closed": "端末は閉じられました",
  "terminal.syncing": "出力を復元中…",
  "terminal.ready": "出力は最新です",
  "terminal.truncated": "過去の出力の一部は利用できないか、表示上限により省略されています。",
  "terminal.approval": "承認ダイアログでの承認を待っています。端末への入力では承認できません。",
  "terminal.sandbox": "コンテナーサンドボックス",
  "terminal.host": "ホストで実行：承認したプログラムはサービスの実行ユーザーの権限で動作します。",
  "terminal.output": "端末出力",
  "terminal.lineHint":
    "1行ずつ送信します。中止するには「コマンドを停止」を使ってください。このテキスト表示は対話型の画面アプリに対応していません。",
};
