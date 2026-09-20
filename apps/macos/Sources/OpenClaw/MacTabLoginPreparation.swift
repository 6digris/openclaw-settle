import Foundation

/// One setup operation precedes the first network navigation in this window.
/// Concurrent link opens join it; a retired document never consumes the offer.
@MainActor
final class MacTabLoginPreparation {
    private var completed = false
    private var pending: (id: UUID, task: Task<Void, Error>)?

    func prepare(force: Bool = false, _ operation: @escaping @MainActor () async throws -> Void) async throws {
        if let pending {
            try await pending.task.value
            return
        }
        if self.completed, !force {
            return
        }
        self.completed = false
        let id = UUID()
        let task = Task { try await operation() }
        self.pending = (id, task)
        do {
            try await task.value
            guard self.pending?.id == id, !Task.isCancelled else { throw CancellationError() }
            self.completed = true
            self.pending = nil
        } catch {
            if self.pending?.id == id {
                self.pending = nil
            }
            throw error
        }
    }

    func cancel() {
        // Retain the gate until non-cancellable WebKit writes and rollback finish.
        self.pending?.task.cancel()
    }
}
