export function requiresFreshGatewayProcess(reason: string | undefined): boolean {
  return (
    reason === "update.run" || reason === "update.auto" || reason === "runtime.generation.changed"
  );
}
