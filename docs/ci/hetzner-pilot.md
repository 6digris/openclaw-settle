---
summary: "A bounded Hetzner dedicated-vCPU comparison with Blacksmith using preserved CI workloads"
title: "Hetzner CI pilot"
read_when:
  - You are evaluating Hetzner runners for CI
---

This pilot compares a Hetzner Cloud CCX43 with Blacksmith's
`blacksmith-32vcpu-ubuntu-2404` label in one GitHub Actions run. It does not change
normal CI routing. Measurement is pending; no performance recommendation is
established yet.

## Host and cost

The pilot provisioned server `166705257` (`5.161.68.106`) in Ashburn (`ash`) on
September 21, 2026 at 05:41:55 UTC: CCX43, 16 dedicated AMD vCPUs, 64 GB RAM,
360 GB local storage, and Ubuntu 24.04. The Cloud API quotes €0.4479/hour net
plus €0.0008/hour for IPv4, or €0.53844/hour including its quoted 20% VAT.
The monthly caps total €279.99 net (€335.988 including VAT). Billing rounds
partial hours up; the total pilot budget is €20.

Two unprivileged systemd template services register ephemeral runners named
`hetzner-ccx-1` and `hetzner-ccx-2`. Each has eight disjoint CPU affinities and
a 28 GiB memory limit. They re-register after each job using a short-lived
repository registration token; no general GitHub credential is installed on
the host. Default runner labels are disabled: the sole custom label is
`openclaw-hetzner-ccx`. Only this guarded benchmark workflow requests it.

The host uses kernel `mitigations=off` after a reboot, Node 24.19.0,
the repository's pinned pnpm through Corepack, build-essential, and a 16 GiB
tmpfs mounted at `/tmp`. Workspaces reside on the local root disk, exposed
to the guest as a QEMU disk; physical NVMe backing is not independently visible
inside the guest. The firewall is a task-owned clone with TCP restricted to
SSH from the existing operator allowlist, plus ICMP. The pilot deletes the
host, task SSH key, and firewall after measurement unless retention is justified.

## Method

The source selection is successful main CI run
[35562872373](https://github.com/openclaw/openclaw/actions/runs/35562872373),
commit `befbed6bd6ef93fe6fb92230a034642f3183df5a`. Its two longest compact jobs
were `checks-node-compact-large-1` (1,180s job / 1,070s tests) and
`checks-node-compact-large-14` (991s / 946s). This takes the literal two longest
compact jobs; the preceding R2 pilot selected the longest large and small bins.
The fixture preserves their complete group inventories, per-group worker pins,
and the first job's `qaRuntime` build prerequisite. Two additional cells run
the complete cron and gateway-core configs.

The matrix contains two providers × four workloads × three independent samples.
All cells check out the same PR head and use Node 24.19.0, an eight-worker ceiling,
serial group execution, and fresh dependency/compile/transform caches. Existing
lower worker limits remain. The R2 phase observer is reused unchanged. The
single-core probe runs the historical 300-million-iteration `sum += i % 7`
loop after one identical warmup and verifies checksum `899999997`.

The workflow runs only when this same-repository, owner-authored pilot PR opens,
with `run_attempt == 1`. Three samples are matrix rows, never failed-job reruns.
Report pushes do not buy another benchmark. Matrix concurrency is four; the
Hetzner host admits two jobs. The maximum extra registrations are 24 job runners
plus two final idle ephemeral registrations. The pooled quota probe reported a
20,000-registration limit; it does not establish organization-wide free capacity.

Job/step timestamps supply checkout, setup, wall, and created-to-start intervals;
the latter includes matrix admission and is not pure provider assignment latency.
The observer supplies install, build, and test wall seconds. Failed samples stay
in the report, with failing file names, and are not used as successful throughput.
The report will distinguish per-job resource affinity from the host's capacity.

## AX102

No Hetzner Robot login or webservice credential was found in the authorized
credential inventory, so no AX102 was ordered and there is no order ID.
The [AX102 product page](https://www.hetzner.com/dedicated-rootserver/ax102/)
currently advertises Falkenstein and Helsinki, not Ashburn: Ryzen 9 7950X3D,
128 GB DDR5 ECC, and two 1.92 TB NVMe drives in the default configuration.

To order, sign in to [Hetzner Robot](https://robot.hetzner.com/), open the AX102
configuration from the product page, choose Falkenstein (`FSN 1`) if available,
retain the default CPU/RAM/disks, choose Ubuntu 24.04 or the Linux rescue
installation path, add no optional hardware or services, review the displayed
setup/hourly price and terms, and submit the order. Record its order ID and wait
for provisioning. Cloud API credentials cannot place this Robot order.

An AX102 timing estimate remains a projection until the same probe and workloads
run on that hardware. A measured CCX-to-Blacksmith ratio alone does not establish
the AX102's single-core speed. Any numeric projection must state its assumed or
independently measured AX102 ratio and retain setup/I/O time separately.
