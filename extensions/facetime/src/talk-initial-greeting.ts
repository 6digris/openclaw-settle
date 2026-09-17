// The carrier can report active before its newly enabled media route is audible.
// Give that route one short settling window, and abandon the greeting if the
// caller starts speaking first so it cannot collide with their opening words.
const FACETIME_INITIAL_GREETING = "Say exactly: Hi, I'm here and listening.";
const FACETIME_GREETING_MEDIA_SETTLE_MS = 750;

export function createFaceTimeInitialGreeting(params: {
  delayMs?: number;
  speak: (instructions: string) => void;
}): {
  readonly instructions: string;
  schedule(): void;
  pause(): void;
  cancel(): void;
} {
  let timer: NodeJS.Timeout | undefined;
  let dismissed = false;

  const clear = () => {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  return {
    instructions: FACETIME_INITIAL_GREETING,
    schedule() {
      if (dismissed || timer) {
        return;
      }
      timer = setTimeout(() => {
        timer = undefined;
        dismissed = true;
        params.speak(FACETIME_INITIAL_GREETING);
      }, params.delayMs ?? FACETIME_GREETING_MEDIA_SETTLE_MS);
      timer.unref?.();
    },
    pause() {
      clear();
    },
    cancel() {
      dismissed = true;
      clear();
    },
  };
}
