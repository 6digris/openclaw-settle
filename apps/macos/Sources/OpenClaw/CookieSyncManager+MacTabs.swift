import Darwin
import Foundation

extension CookieSyncManager {
    struct MacTabRequest: Encodable {
        let version = 1
        let nonce = UUID().uuidString
        let action: String
        var browser: String?
        var profile: String?
    }

    struct MacTabReply: Decodable {
        let version: Int
        let nonce: String
        let ok: Bool
        let profiles: [MacTabCookieImport.Profile]?
        let batch: MacTabCookieImport.Batch?
    }

    /// Reuses the same plugin producer as remote cookie-sync. The destination is
    /// this app's anonymous pipe, never the Gateway or a command/log capture API.
    static func readForMacTabs(
        _ request: MacTabRequest,
        isCurrent: @escaping @MainActor () -> Bool,
        launch: () throws -> MacNodeHostWorkerLaunch = { try BundledNodeWorker.cookieImportLaunch() }) async throws
        -> MacTabReply
    {
        guard isCurrent(), !Task.isCancelled else { throw CancellationError() }
        let operation = CookieSyncPipeRequest()
        let command = try launch()
        let input = try JSONEncoder().encode(request)
        let data = try await withTaskCancellationHandler {
            try await operation.run(launch: command, input: input, isCurrent: isCurrent)
        } onCancel: {
            Task { @MainActor in operation.cancel() }
        }
        guard isCurrent(), !Task.isCancelled else { throw CancellationError() }
        guard let reply = try? JSONDecoder().decode(MacTabReply.self, from: data),
              reply.version == 1, reply.nonce == request.nonce, reply.ok
        else {
            throw MacTabCookieImport.ImportError.unavailable
        }
        return reply
    }
}

@MainActor
private final class CookieSyncPipeRequest {
    private let process = Process()
    private var reader: PipeReadStream?
    private var output = Data()
    private var continuation: CheckedContinuation<Data, Error>?
    private var deadline: Task<Void, Never>?
    private var cancelled = false

    func run(launch: MacNodeHostWorkerLaunch, input: Data, isCurrent: () -> Bool) async throws -> Data {
        guard !self.cancelled, !Task.isCancelled, isCurrent(), let executable = launch.command.first else {
            throw CancellationError()
        }
        let stdin = Pipe()
        let stdout = Pipe()
        defer {
            try? stdin.fileHandleForReading.close()
            try? stdin.fileHandleForWriting.close()
            try? stdout.fileHandleForReading.close()
            try? stdout.fileHandleForWriting.close()
            self.output.resetBytes(in: 0..<self.output.count)
            self.output.removeAll()
        }
        self.process.executableURL = URL(fileURLWithPath: executable)
        self.process.arguments = Array(launch.command.dropFirst())
        self.process.currentDirectoryURL = launch.currentDirectoryURL
        // Do not inherit Gateway credentials, Node startup hooks, or debug/log settings.
        self.process.environment = [
            "HOME": FileManager.default.homeDirectoryForCurrentUser.path,
            "PATH": [launch.environment["PATH"], "/usr/bin:/bin:/usr/sbin:/sbin"]
                .compactMap(\.self).joined(separator: ":"),
        ]
        self.process.standardInput = stdin
        self.process.standardOutput = stdout
        self.process.standardError = FileHandle.nullDevice
        self.reader = try PipeReadStream(handle: stdout.fileHandleForReading, queue: .main) { [weak self] data in
            MainActor.assumeIsolated {
                guard let self, !self.cancelled else { return }
                guard self.output.count + data.count <= 16 * 1024 * 1024 else { self.cancel()
                    return
                }
                self.output.append(data)
            }
        }
        self.process.terminationHandler = { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                await self.reader?.finish()
                self.finish()
            }
        }
        return try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
            do {
                guard isCurrent(), !Task.isCancelled, !self.cancelled else { throw CancellationError() }
                try self.process.run()
                try stdout.fileHandleForWriting.close()
                try stdin.fileHandleForReading.close()
                try stdin.fileHandleForWriting.write(contentsOf: input)
                try stdin.fileHandleForWriting.close()
                self.deadline = Task { [weak self] in
                    do { try await Task.sleep(for: .seconds(120)) } catch { return }
                    self?.cancel()
                }
            } catch {
                self.cancelled = true
                if self.process.isRunning { self.cancel() } else { self.finish() }
            }
        }
    }

    func cancel() {
        self.cancelled = true
        guard self.process.isRunning else { return }
        self.process.terminate()
        self.deadline?.cancel()
        self.deadline = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(2)) } catch { return }
            guard let self, self.process.isRunning else { return }
            _ = Darwin.kill(self.process.processIdentifier, SIGKILL)
        }
    }

    private func finish() {
        guard let continuation = self.continuation else { return }
        self.continuation = nil
        self.deadline?.cancel()
        self.reader?.close()
        if self.cancelled || self.process.terminationStatus != 0 {
            continuation.resume(throwing: MacTabCookieImport.ImportError.unavailable)
        } else {
            continuation.resume(returning: self.output)
        }
    }
}
