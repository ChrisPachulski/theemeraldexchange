//! node-cron schedules for the services' recurring jobs (DB snapshots, the
//! iptv sync and sweeps). Times are local, as node-cron's were.

use std::future::Future;

use chrono::Local;
use croner::Cron;
use croner::parser::{CronParser, Seconds};

/// node-cron syntax: five fields, or six with leading seconds.
pub fn parse_cron(expr: &str) -> Option<Cron> {
    CronParser::builder()
        .seconds(Seconds::Optional)
        .build()
        .parse(expr)
        .ok()
}

/// `expr`, or `default` with an error log naming `env_var` when it does not
/// parse. `default` must parse.
pub fn cron_or_default(env_var: &str, expr: &str, default: &str) -> Cron {
    parse_cron(expr).unwrap_or_else(|| {
        tracing::error!("invalid {env_var} {expr:?}; using {default}");
        parse_cron(default).expect("default cron parses")
    })
}

/// Run `job` at every occurrence of `cron`, one at a time. A run that overlaps
/// the next occurrence skips it.
pub async fn every<F, Fut>(cron: Cron, mut job: F)
where
    F: FnMut() -> Fut,
    Fut: Future<Output = ()>,
{
    let mut last = Local::now();
    loop {
        // From the later of now and the last fire, so a wake a hair early never
        // fires the same occurrence twice.
        let from = Local::now().max(last);
        let Ok(next) = cron.find_next_occurrence(&from, false) else {
            return tracing::error!("cron has no next occurrence; job stopped");
        };
        tokio::time::sleep((next - Local::now()).to_std().unwrap_or_default()).await;
        last = next;
        job().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_node_cron_syntax_and_falls_back_on_garbage() {
        assert!(parse_cron("*/5 * * * *").is_some());
        assert!(
            parse_cron("0 0 */6 * * *").is_some(),
            "six fields with seconds"
        );
        assert!(parse_cron("not a cron").is_none());
        let fallback = cron_or_default("X_CRON", "not a cron", "30 3 * * *");
        let at = Local::now();
        assert_eq!(
            fallback.find_next_occurrence(&at, false).unwrap(),
            parse_cron("30 3 * * *")
                .unwrap()
                .find_next_occurrence(&at, false)
                .unwrap()
        );
    }
}
