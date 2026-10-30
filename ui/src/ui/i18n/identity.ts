// Built-in sign-in (passkeys, one-time codes) on the overview page.
export const identityEn = {
  "identity.passkey.signIn": "Sign in with a passkey",
  "identity.passkey.add": "Add a passkey",
  "identity.passkey.added": "Passkey added. You can sign in with it from now on.",
  "identity.totp.toggle": "Use a one-time code instead",
  "identity.totp.userName": "User name or e-mail",
  "identity.totp.code": "6-digit code",
  "identity.totp.submit": "Sign in",
  "identity.enroll.title": "Set up your sign-in",
  "identity.enroll.body":
    "An administrator invited you to sign in to Kurahi with a passkey. Create one on this device: your fingerprint, face or device PIN unlocks it, and no password is needed.",
  "identity.enroll.label": "Name for this passkey (optional)",
  "identity.enroll.passkey": "Create a passkey",
  "identity.enroll.totp": "Use an authenticator app instead",
  "identity.enroll.totpBody":
    "Add this key to your authenticator app (Microsoft Authenticator, Google Authenticator, …), then enter the 6-digit code it shows.",
  "identity.enroll.secret": "Key",
  "identity.enroll.confirm": "Confirm",
  "identity.enroll.done": "Sign-in is set up. You can now sign in.",
  "identity.enroll.badLink": "This enrollment link is incomplete. Open the full link again.",
  "identity.error.cancelled": "The passkey request was cancelled or timed out.",
  "identity.error.unsupported":
    "This browser cannot use passkeys here. Use a one-time code or another browser.",
  "identity.error.unknown_credential":
    "This passkey is not registered for this organisation. Use one you enrolled here.",
  "identity.error.code_refused": "That code did not work. Wait for the next code and try again.",
  "identity.error.locked": "Too many wrong codes. Wait a few minutes, then try again.",
  "identity.error.enrollment_invalid":
    "This enrollment link is no longer valid. Ask an administrator for a new one.",
  "identity.error.user_not_verified":
    "Your device did not confirm it is you (PIN or biometrics). Try again.",
  "identity.error.ceremony_unknown": "The request expired. Start again.",
  "identity.error.inactive": "Your account is deactivated.",
  "identity.error.no_role":
    "Sign-in worked, but no role is assigned to your account. Ask an administrator.",
  "identity.error.other": "Sign-in was refused ({reason}).",
  "identity.error.step_up_required":
    "Confirm it's you first: changing how you sign in needs a fresh sign-in (a passkey or a code from your authenticator app to replace the app).",
  "identity.error.has_authenticators":
    "You already have a passkey or an authenticator app. Sign in and add more devices from your own account.",
} as const;

export const identityJa: Record<keyof typeof identityEn, string> = {
  "identity.passkey.signIn": "パスキーでサインイン",
  "identity.passkey.add": "パスキーを追加",
  "identity.passkey.added": "パスキーを追加しました。次回からこのパスキーでサインインできます。",
  "identity.totp.toggle": "ワンタイムコードを使う",
  "identity.totp.userName": "ユーザー名またはメールアドレス",
  "identity.totp.code": "6桁のコード",
  "identity.totp.submit": "サインイン",
  "identity.enroll.title": "サインインの設定",
  "identity.enroll.body":
    "管理者から Kurahi へのパスキーによるサインインに招待されています。このデバイスでパスキーを作成してください。指紋・顔認証・デバイスの PIN で解除でき、パスワードは不要です。",
  "identity.enroll.label": "このパスキーの名前（任意）",
  "identity.enroll.passkey": "パスキーを作成",
  "identity.enroll.totp": "認証アプリを使う",
  "identity.enroll.totpBody":
    "このキーを認証アプリ（Microsoft Authenticator、Google 認証システムなど）に追加し、表示された6桁のコードを入力してください。",
  "identity.enroll.secret": "キー",
  "identity.enroll.confirm": "確認",
  "identity.enroll.done": "サインインの設定が完了しました。サインインできます。",
  "identity.enroll.badLink": "登録リンクが不完全です。リンク全体をもう一度開いてください。",
  "identity.error.cancelled": "パスキーの操作がキャンセルされたか、時間切れになりました。",
  "identity.error.unsupported":
    "このブラウザーではパスキーを使用できません。ワンタイムコードか別のブラウザーをご利用ください。",
  "identity.error.unknown_credential":
    "このパスキーはこの組織に登録されていません。ここで登録したパスキーを使ってください。",
  "identity.error.code_refused":
    "コードが正しくありません。次のコードが表示されてから再度お試しください。",
  "identity.error.locked": "誤ったコードが多すぎます。数分待ってから再度お試しください。",
  "identity.error.enrollment_invalid":
    "この登録リンクは無効になっています。管理者に新しいリンクを依頼してください。",
  "identity.error.user_not_verified":
    "デバイスで本人確認（PIN または生体認証）が行われませんでした。もう一度お試しください。",
  "identity.error.ceremony_unknown": "要求の有効期限が切れました。最初からやり直してください。",
  "identity.error.inactive": "アカウントが無効化されています。",
  "identity.error.no_role":
    "サインインできましたが、アカウントにロールが割り当てられていません。管理者にお問い合わせください。",
  "identity.error.other": "サインインが拒否されました（{reason}）。",
  "identity.error.step_up_required":
    "先に本人確認をしてください。サインイン方法の変更には直前のサインインが必要です（認証アプリの置き換えにはパスキーまたは認証アプリのコード）。",
  "identity.error.has_authenticators":
    "すでにパスキーまたは認証アプリが登録されています。サインインして、ご自身のアカウントからデバイスを追加してください。",
};
