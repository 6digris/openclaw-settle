import { formatPermissionApprovalDescription } from "./native-hook-relay-approval-presentation.js";
import {
  clearNativeHookRelayBridgesForTests,
  clearNativeHookRelayBridgesSynchronouslyForTests,
  isRetryableNativeHookRelayBridgeLookupError,
  readNativeHookRelayBridgeRecordIfExists,
  readNativeHookRelayBridgeRecordSynchronouslyIfExists,
} from "./native-hook-relay-bridge.js";
import {
  clearNativeHookRelayPermissionsForTests,
  permissionRequestContentFingerprintForTests,
  permissionRequestToolInputKeyFingerprintForTests,
  setNativeHookRelayDeferredToolApprovalRequesterForTests,
  setNativeHookRelayPermissionApprovalRequesterForTests,
} from "./native-hook-relay-permissions.js";
import type { NativeHookRelayDeferredToolApprovalRequester } from "./native-hook-relay-permissions.js";
import { nativeHookRelayState } from "./native-hook-relay-state.js";
import type {
  ActiveNativeHookRelayRegistration,
  NativeHookRelayInvocation,
  NativeHookRelayPermissionApprovalRequester,
  NativeHookRelayRegistration,
} from "./native-hook-relay-types.js";

/** Two testing contracts share the same relay owner; only the internal reset promises a drain. */
export function createNativeHookRelayTesting(
  unregister: (
    relayId: string,
    registration: ActiveNativeHookRelayRegistration,
  ) => (() => void) | undefined,
) {
  const { relays, relayBridges, invocations } = nativeHookRelayState;
  const unregisterAll = () => {
    for (const [relayId, registration] of relays) {
      unregister(relayId, registration);
    }
  };
  const clearTransientState = () => {
    invocations.length = 0;
    clearNativeHookRelayPermissionsForTests();
  };
  const testing = {
    async clearNativeHookRelaysForTests(): Promise<void> {
      unregisterAll();
      await clearNativeHookRelayBridgesForTests();
      clearTransientState();
    },
    getNativeHookRelayInvocationsForTests(): NativeHookRelayInvocation[] {
      return [...invocations];
    },
    getNativeHookRelayRegistrationForTests(
      relayId: string,
    ): NativeHookRelayRegistration | undefined {
      return relays.get(relayId);
    },
    getNativeHookRelayBridgeDirForTests(): string {
      throw new Error("native hook relay bridge files were retired");
    },
    getNativeHookRelayBridgeRegistryPathForTests(relayId: string): string {
      void relayId;
      throw new Error("native hook relay bridge files were retired");
    },
    async getNativeHookRelayBridgeRecordForTests(
      relayId: string,
    ): Promise<Record<string, unknown> | undefined> {
      const record = await readNativeHookRelayBridgeRecordIfExists(relayId);
      return record ? { ...record } : undefined;
    },
    isNativeHookRelayBridgeLookupRetryableForTests(error: unknown, elapsedMs = 0): boolean {
      return isRetryableNativeHookRelayBridgeLookupError({ error, elapsedMs });
    },
    formatPermissionApprovalDescriptionForTests: formatPermissionApprovalDescription,
    permissionRequestContentFingerprintForTests,
    permissionRequestToolInputKeyFingerprintForTests,
    setNativeHookRelayPermissionApprovalRequesterForTests(
      requester: NativeHookRelayPermissionApprovalRequester,
    ): void {
      setNativeHookRelayPermissionApprovalRequesterForTests(requester);
    },
    setNativeHookRelayDeferredToolApprovalRequesterForTests(
      requester: NativeHookRelayDeferredToolApprovalRequester,
    ): void {
      setNativeHookRelayDeferredToolApprovalRequesterForTests(requester);
    },
  } as const;
  const sdkSynchronousTesting = {
    clearNativeHookRelaysForTests(): void {
      const bridges = [...relayBridges.values()];
      unregisterAll();
      clearNativeHookRelayBridgesSynchronouslyForTests(bridges);
      clearTransientState();
    },
    getNativeHookRelayBridgeRecordForTests(relayId: string): Record<string, unknown> | undefined {
      const record = readNativeHookRelayBridgeRecordSynchronouslyIfExists(relayId);
      return record ? { ...record } : undefined;
    },
  } as const;
  return { testing, sdkSynchronousTesting };
}
