//! Tray menu text in Japanese and English.

use serde::Deserialize;

use crate::health::GatewayCondition;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Lang {
    Ja,
    En,
}

/// Japanese when the OS locale is Japanese, else English.
pub fn lang_from_locale(locale: Option<&str>) -> Lang {
    match locale {
        Some(l) if l.to_ascii_lowercase().starts_with("ja") => Lang::Ja,
        _ => Lang::En,
    }
}

pub struct TrayText {
    pub open: &'static str,
    pub start: &'static str,
    pub stop: &'static str,
    pub quit: &'static str,
}

pub fn tray_text(lang: Lang) -> TrayText {
    match lang {
        Lang::Ja => TrayText {
            open: "Kurahi を開く",
            start: "サービスを開始",
            stop: "サービスを停止",
            quit: "終了",
        },
        Lang::En => TrayText {
            open: "Open Kurahi",
            start: "Start service",
            stop: "Stop service",
            quit: "Quit",
        },
    }
}

pub fn condition_text(lang: Lang, c: GatewayCondition) -> &'static str {
    match (lang, c) {
        (Lang::Ja, GatewayCondition::Running) => "稼働中",
        (Lang::Ja, GatewayCondition::Attention) => "要確認",
        (Lang::Ja, GatewayCondition::Unhealthy) => "異常",
        (Lang::Ja, GatewayCondition::Stopped) => "停止",
        (Lang::En, GatewayCondition::Running) => "Running",
        (Lang::En, GatewayCondition::Attention) => "Needs attention",
        (Lang::En, GatewayCondition::Unhealthy) => "Unhealthy",
        (Lang::En, GatewayCondition::Stopped) => "Stopped",
    }
}

pub fn busy_text(lang: Lang) -> &'static str {
    match lang {
        Lang::Ja => "処理中…",
        Lang::En => "Working…",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locale_mapping() {
        assert_eq!(lang_from_locale(Some("ja-JP")), Lang::Ja);
        assert_eq!(lang_from_locale(Some("ja_JP.UTF-8")), Lang::Ja);
        assert_eq!(lang_from_locale(Some("en-US")), Lang::En);
        assert_eq!(lang_from_locale(Some("pt-BR")), Lang::En);
        assert_eq!(lang_from_locale(None), Lang::En);
    }

    #[test]
    fn texts_exist_for_both() {
        assert_eq!(condition_text(Lang::Ja, GatewayCondition::Stopped), "停止");
        assert_eq!(tray_text(Lang::En).quit, "Quit");
        assert_eq!(serde_json::from_str::<Lang>("\"ja\"").unwrap(), Lang::Ja);
        assert!(serde_json::from_str::<Lang>("\"fr\"").is_err());
    }
}
