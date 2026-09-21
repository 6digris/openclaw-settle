---
summary: "Email conversations through the official AgentMail plugin on ClawHub"
read_when:
  - You want an email inbox connected to OpenClaw
  - You are installing or troubleshooting the AgentMail channel
title: "AgentMail"
---

OpenClaw connects to AgentMail through the official, externally maintained
`@agentmail/agentmail` plugin on ClawHub. Its plugin and channel id is `agentmail`.
The same package includes a CLI-backed AgentMail skill.

The channel implementation lives in
[AgentMail's plugin repository](https://github.com/agentmail-to/openclaw-plugin),
not in OpenClaw core. See the
[AgentMail integration guide](https://www.agentmail.to/docs/integrations/openclaw)
for the complete channel configuration and vendor behavior.

## Install

Install the catalog-pinned package from ClawHub:

```bash
openclaw plugins install clawhub:@agentmail/agentmail@0.2.1
openclaw plugins enable agentmail
```

The shipped catalog binds this package to the `agentmail` plugin id. It does not
endorse an npm package with the same name, a local archive, or a local checkout.

Follow the [plugin application result](/plugins/manage-plugins#apply-changes-and-inspect)
if a reload or restart is required, then inspect the recorded installation:

```bash
openclaw plugins inspect agentmail --runtime --json
```

## Configure an inbox

Set `AGENTMAIL_API_KEY` in the environment that runs the Gateway. The CLI-backed
skill uses this environment variable too. Keep the credential out of command-line
arguments and shared configuration examples.

Configure one inbox and its allowed senders under `channels.agentmail`:

```json5 validate=false
{
  channels: {
    agentmail: {
      inboxId: "agent@example.com",
      dmPolicy: "allowlist",
      allowFrom: ["person@example.com"],
    },
  },
}
```

Per AgentMail's documentation, the channel denies all senders when the allowlist
is empty and replies only to the triggering message. Without
`AGENTMAIL_WEBHOOK_SECRET`, it uses WebSocket ingress; setting that variable enables
signed webhook ingress. Account-specific settings belong under
`channels.agentmail.accounts.<id>`.

## Trusted plugin state refused

The channel needs the plugin-scoped `openKeyedStore` and
`openChannelIngressQueue` APIs. These require a catalog-backed official install;
`plugins.allow` alone does not grant that trust.

If inspection reports `provenance-missing` for an older ClawHub installation, run
`openclaw doctor --fix` with the Gateway's state and config paths. If the installed
OpenClaw version does not include AgentMail in its shipped catalog, update
OpenClaw first. For other recorded reasons, follow
[Trusted plugin state refused](/tools/plugin#trusted-plugin-state-refused).
