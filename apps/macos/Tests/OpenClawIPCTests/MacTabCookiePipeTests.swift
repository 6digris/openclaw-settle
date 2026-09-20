import Foundation
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct MacTabCookiePipeTests {
    @Test func `local pipe matches replies without inheriting Gateway or logging credentials`() async throws {
        let script = """
        import json,os,sys
        request=json.load(sys.stdin)
        assert '/usr/bin' in os.environ['PATH'].split(':')
        assert not any(k.startswith('OPENCLAW_GATEWAY_') for k in os.environ)
        print('synthetic-private-diagnostic',file=sys.stderr)
        json.dump({'version':1,'nonce':request['nonce'],'ok':True,'profiles':[]},sys.stdout)
        """
        let reply = try await CookieSyncManager.readForMacTabs(.init(action: "list"), isCurrent: { true }, launch: {
            .init(command: ["/usr/bin/python3", "-c", script], environment: ["PATH": "/synthetic/node/bin"])
        })
        #expect(reply.ok)
        #expect(reply.profiles == [])
    }

    @Test func `retired authority never launches the producer`() async {
        var launched = false
        do {
            _ = try await CookieSyncManager.readForMacTabs(.init(action: "read"), isCurrent: { false }, launch: {
                launched = true
                return .init(command: ["/usr/bin/false"])
            })
            Issue.record("Expected cancellation")
        } catch {}
        #expect(!launched)
    }

    @Test func `cookie transport errors never surface child output`() async {
        do {
            _ = try await CookieSyncManager.readForMacTabs(.init(action: "list"), isCurrent: { true }, launch: {
                .init(command: ["/usr/bin/python3", "-c", "print('synthetic-private-cookie'); raise SystemExit(1)"])
            })
            Issue.record("Expected a sanitized failure")
        } catch {
            #expect(!error.localizedDescription.contains("synthetic-private-cookie"))
        }
    }
}
