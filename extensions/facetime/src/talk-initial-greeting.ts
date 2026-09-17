export function createFaceTimeInitialGreeting(params: { delayMs: number; speak: () => void }): {
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
    schedule() {
      if (dismissed || timer) {
        return;
      }
      timer = setTimeout(() => {
        timer = undefined;
        dismissed = true;
        params.speak();
      }, params.delayMs);
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
