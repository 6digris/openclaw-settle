type ConnectedTestClient = {
  invalidated: boolean;
  invalidatedReason?: string;
  connect: {
    client: {
      id: string;
      version: string;
      platform: string;
      mode: string;
    };
    role: "operator";
    scopes: string[];
  };
  connId: string;
  usesSharedGatewayAuth: false;
};

export function createConnectedTestClient(params: {
  connId: string;
  invalidated?: boolean;
  invalidatedReason?: string;
}): ConnectedTestClient {
  return {
    invalidated: params.invalidated ?? false,
    ...(params.invalidatedReason ? { invalidatedReason: params.invalidatedReason } : {}),
    connect: {
      client: {
        id: "openclaw-control-ui",
        version: "dev",
        platform: "test",
        mode: "ui",
      },
      role: "operator",
      scopes: [],
    },
    connId: params.connId,
    usesSharedGatewayAuth: false,
  };
}
