//! Local CLI adapter only. The browser plugin owns setup policy and result state.
use crate::cli::{CliError, OpenClawCli};
use serde::Deserialize;
use serde_json::Value;

#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Action {
    Inspect,
    Install,
    Verify,
}

#[derive(Deserialize)]
#[serde(tag = "type", deny_unknown_fields)]
enum Request {
    #[serde(rename = "chrome-setup")]
    ChromeSetup { action: Action },
}

pub fn parse_request(message: Value) -> Result<Action, String> {
    let Request::ChromeSetup { action } = serde_json::from_value(message)
        .map_err(|_| "Invalid Chrome setup action. Choose inspect, install, or verify.")?;
    Ok(action)
}

fn arguments(action: Action) -> [&'static str; 10] {
    [
        "browser",
        "extension",
        "setup",
        "--action",
        match action {
            Action::Inspect => "inspect",
            Action::Install => "install",
            Action::Verify => "verify",
        },
        "--json",
        "--browser-profile",
        "chrome",
        "--wait-ms",
        "1000",
    ]
}

pub fn run(cli: &OpenClawCli, action: Action) -> Result<Value, String> {
    // Pending and blocked are successful canonical JSON results, not transport
    // failures. Do not infer readiness or bootstrap support from this platform.
    cli.json(arguments(action)).map_err(cli_error)
}

pub fn cli_error(error: CliError) -> String {
    // CLI diagnostics may contain local paths or configuration. Only canonical
    // setup results cross into a potentially remote dashboard, never raw stderr.
    match error {
        CliError::Missing => "OpenClaw CLI is not installed on this computer.",
        CliError::Environment(_) | CliError::Spawn(_) => {
            "Could not run OpenClaw CLI on this computer. Check the local CLI installation."
        }
        CliError::CommandFailed(_) => {
            "Chrome setup failed on this computer. Check the local CLI installation and try again."
        }
        CliError::InvalidJson(_) => {
            "OpenClaw CLI returned an invalid Chrome setup result. Update the local CLI and try again."
        }
    }
    .into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn accepts_only_explicit_setup_actions_and_no_caller_selected_targets() {
        for (name, action) in [
            ("inspect", Action::Inspect),
            ("install", Action::Install),
            ("verify", Action::Verify),
        ] {
            assert_eq!(
                parse_request(json!({"type": "chrome-setup", "action": name})).unwrap(),
                action
            );
            assert_eq!(
                arguments(action),
                [
                    "browser",
                    "extension",
                    "setup",
                    "--action",
                    name,
                    "--json",
                    "--browser-profile",
                    "chrome",
                    "--wait-ms",
                    "1000"
                ]
            );
        }
        for message in [
            json!({"type": "chrome-setup"}),
            json!({"type": "chrome-setup", "action": "install --url https://other.example"}),
            json!({"type": "chrome-setup", "action": "pair"}),
            json!({"type": "chrome-setup", "action": "inspect", "profile": "remote"}),
            json!({"type": "chrome-setup", "action": "install", "command": "other"}),
            json!({"type": "chrome-setup", "action": "install", "url": "https://other.example"}),
            json!({"type": "open-link", "action": "install"}),
        ] {
            assert!(parse_request(message).is_err());
        }
    }

    #[test]
    fn transport_errors_do_not_expose_cli_diagnostics() {
        for error in [
            CliError::Environment("fixture-private-value".into()),
            CliError::Spawn("fixture-private-value".into()),
            CliError::CommandFailed("fixture-private-value".into()),
            CliError::InvalidJson("fixture-private-value".into()),
        ] {
            assert!(!cli_error(error).contains("fixture-private-value"));
        }
    }
}
