export const TUI_PTY_SESSION_FIXTURE_SCRIPT = `function sessionEntry(key = "main") {
        const isModeSource = key.endsWith(":mode-source");
        const isModeTarget = key.endsWith(":mode-target");
        const entryFastMode = isModeSource ? true : isModeTarget ? undefined : fastMode;
        const entryVerboseLevel = isModeSource ? "full" : isModeTarget ? undefined : verboseLevel;
        const entryTraceLevel = isModeSource ? "raw" : isModeTarget ? modeTargetTraceLevel : undefined;
        return {
          key,
          ...(isModeSource
            ? { displayName: "Production incident" }
            : isModeTarget
              ? {}
              : { displayName: key === pickerSessionKey ? pickerSessionDisplayName : "Main" }),
          model: currentModel,
          modelProvider: "fixture-provider",
          contextTokens: 128,
          ...(entryFastMode !== undefined ? { fastMode: entryFastMode } : {}),
          ...(currentThinkingLevel ? { thinkingLevel: currentThinkingLevel } : {}),
          ...(entryVerboseLevel ? { verboseLevel: entryVerboseLevel } : {}),
          ...(entryTraceLevel ? { traceLevel: entryTraceLevel } : {}),
          ...(isModeSource ? { reasoningLevel: "stream" } : {}),
          thinkingLevels,
        };
      }

      function fixtureSessions() {
        return enablePickerFixture
          ? [
              sessionEntry(sessionScope === "global" ? "agent:main:global" : "agent:main:" + sessionMainKey),
              {
                ...sessionEntry(pickerSessionKey),
                derivedTitle: pickerSessionTitle,
                lastMessagePreview: pickerSessionPreview,
              },
            ]
          : [];
      }

      function sessionDefaults() {
        return {
          model: currentModel,
          modelProvider: "fixture-provider",
          contextTokens: 128,
          thinkingLevels,
        };
      }`;
