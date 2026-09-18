/** Enter the backend scheduler before the binding lease and reject an obsolete owner snapshot. */
export async function withNativeSessionBindingOwnership<TBinding, TResult>(
  params: {
    snapshot: TBinding | undefined;
    schedule: (run: () => Promise<TResult>) => Promise<TResult>;
    withLease: (run: () => Promise<TResult>) => Promise<TResult>;
    readBinding: () => TBinding | undefined;
    assertBinding?: (binding: TBinding | undefined) => void;
    isSameOwner: (binding: TBinding | undefined, snapshot: TBinding | undefined) => boolean;
    onChanged: (binding: TBinding | undefined) => TResult;
    assertCurrent?: () => void;
  },
  run: (binding: TBinding | undefined) => Promise<TResult>,
): Promise<TResult> {
  return await params.schedule(() =>
    params.withLease(async () => {
      const binding = params.readBinding();
      params.assertBinding?.(binding);
      if (!params.isSameOwner(binding, params.snapshot)) {
        return params.onChanged(binding);
      }
      params.assertCurrent?.();
      return await run(binding);
    }),
  );
}
