import Foundation
import OpenClawKit

enum ChromeExtensionSetup {
    // Decode and re-encode only the public setup projection, never installer paths or credentials.
    struct Result: Codable, Equatable {
        struct Target: Codable, Equatable {
            let kind: String
            let platform: String
            let hostname: String
            let profile: String
            let relayPort: Int
        }

        struct Installation: Codable, Equatable {
            let nativeHostRegistered: Bool
            let installRequested: Bool
            let discoveredProfiles: Int
            let awaitingApproval: Bool
            let automaticBootstrapSupported: Bool
        }

        struct Connection: Codable, Equatable {
            enum State: String, Codable {
                case notChecked = "not_checked", unavailable
                case waitingForExtension = "waiting_for_extension", connected
            }

            let state: State
            let extensionVersion: String?
        }

        enum Phase: String, Codable {
            case inspectionRequired = "inspection_required", preparing
            case needsBrowserAction = "needs_browser_action", waitingForConnection = "waiting_for_connection"
            case ready, blocked
        }

        enum NextAction: String, Codable {
            case none, install, openChrome = "open_chrome", approveExtension = "approve_extension"
            case installFromStore = "install_from_store", checkConnection = "check_connection"
            case repairNativeHost = "repair_native_host", unsupported
        }

        let action: ChromeExtensionSetupAction
        let target: Target
        let phase: Phase
        let reason: String
        let installation: Installation
        let connection: Connection
        let nextAction: NextAction
    }

    enum SetupError: LocalizedError {
        case missingCLI, unavailable, retired

        var errorDescription: String? {
            switch self {
            case .missingCLI: "Install the OpenClaw CLI on this Mac, then try setup again."
            case .unavailable:
                "Chrome setup could not finish. Run openclaw browser extension setup on this Mac for details."
            case .retired: "The device settings document is no longer available."
            }
        }
    }

    static func readResult(_ stdout: String, action: ChromeExtensionSetupAction) throws -> Result {
        let result = try JSONDecoder().decode(Result.self, from: Data(stdout.utf8))
        guard result.action == action, result.target.kind == "local-host", result.target.platform == "darwin",
              result.target.profile == "chrome", (1...65535).contains(result.target.relayPort),
              !result.target.hostname.isEmpty, result.target.hostname.count <= 255,
              result.installation.discoveredProfiles >= 0,
              result.reason.range(of: "^[a-z][a-z0-9_]{0,79}$", options: .regularExpression) != nil,
              result.connection.extensionVersion.map({ $0.count <= 128 }) ?? true
        else { throw SetupError.unavailable }
        return result
    }

    @MainActor
    static func run(action: ChromeExtensionSetupAction, isCurrent: () -> Bool) async throws -> Result {
        // The ordinary command resolver follows SSH Gateway settings. This action always owns this Mac.
        let executable: String? = if case let .ready(location, _) = await CLIInstaller.status() {
            location
        } else {
            CommandResolver.findExecutable(named: "openclaw", searchPaths: CommandResolver.preferredPaths())
        }
        guard isCurrent(), !Task.isCancelled else { throw SetupError.retired }
        guard let executable else { throw SetupError.missingCLI }
        let command = AppProfile.current.localCLICommand(
            prefix: [executable], arguments: [
                "browser", "extension", "setup", "--action", action.rawValue,
                "--json", "--browser-profile", "chrome", "--wait-ms", "1000",
            ])
        var environment = ProcessInfo.processInfo.environment
        environment["PATH"] = CommandResolver.preferredPaths().joined(separator: ":")
        let output = await ShellExecutor.runDetailed(command: command, cwd: nil, env: environment, timeout: 30)
        guard isCurrent(), !Task.isCancelled else { throw SetupError.retired }
        // Pending/blocked setup states are successful structured results, not process failures.
        guard output.success, !output.timedOut,
              let result = try? self.readResult(output.stdout, action: action) else { throw SetupError.unavailable }
        return result
    }
}
