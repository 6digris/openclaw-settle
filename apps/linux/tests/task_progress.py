"""Candidate-only native Quick Chat proof; the shared Node fixture owns Gateway RPC.

No provider, model or worker command runs. All observations come from the app's
AT-SPI tree/X11 window and the synthetic Gateway's sanitized wire evidence.
"""

import hashlib
import json
from pathlib import Path
import re
import subprocess
from urllib.request import Request, urlopen

from gateway_switch import GatewaySwitchFixture


SESSION = "agent:main:main"
PROMPT = "Show synthetic worker progress while I keep an editable draft."
DRAFT = "Keep this draft editable"
PARENT = "Parent yielded; synthetic worker continues."
YIELDED = "Prepared worker commentary: reviewing synthetic notes."
WORKING = "Prepared worker commentary: checking synthetic evidence."
COMMAND = "printf synthetic-progress-check"
UNKNOWN_COMMAND = "printf synthetic-outcome-unavailable"
TERMINAL = "Synthetic worker failed; no command was executed."
CHECKLIST = (
    "Authored checklist; worker updates do not rewrite these steps.",
    "in progress — Review synthetic notes",
    "pending — Report synthetic result",
)


class TaskProgressFixture(GatewaySwitchFixture):
    capture_prefix = "task-progress"

    def __init__(self, artifacts_dir, node):
        super().__init__(artifacts_dir)
        self.node = node
        self.gateway = None
        self.gateway_output = None
        self.gateway_port = None
        self.gateway_log = artifacts_dir / "task-progress-gateway.log"
        self.closed = False
        self.app = None
        self.Atspi = None
        self.quickchat_root = None
        self.quick_input = None
        self.captures = []
        self.stages = []
        self.sources = {}
        self.evidence = None
        self.capture_errors = []

    def request(self, path, payload=None):
        if self.gateway.poll() is not None:
            raise RuntimeError(f"Synthetic Gateway exited with {self.gateway.returncode}; see {self.gateway_log}")
        request = Request(
            f"http://127.0.0.1:{self.gateway_port}/task-progress/{path}",
            data=json.dumps(payload).encode() if payload is not None else None,
            headers={"Content-Type": "application/json"},
        )
        with urlopen(request, timeout=5) as response:
            return json.load(response)

    @staticmethod
    def sha256(path):
        digest = hashlib.sha256()
        with path.open("rb") as source:
            for block in iter(lambda: source.read(1024 * 1024), b""):
                digest.update(block)
        return digest.hexdigest()

    def start(self):
        root = Path(__file__).resolve().parents[3]
        script = root / "scripts/test-ios-sidebar-attention-gateway.mjs"
        self.sources["gatewayFixture"] = {"path": str(script), "sha256": self.sha256(script)}
        try:
            self.gateway_output = self.gateway_log.open("wb")
            self.gateway = subprocess.Popen(
                [str(self.node), str(script), "--port", "0"], cwd=root,
                stdin=subprocess.DEVNULL, stdout=self.gateway_output, stderr=subprocess.STDOUT,
            )

            def listening():
                if self.gateway.poll() is not None:
                    raise RuntimeError(f"Synthetic Gateway failed to start; see {self.gateway_log}")
                with self.gateway_log.open("rb") as log:
                    banner = re.search(rb"Synthetic attention Gateway listening on loopback:(\d+)", log.read(65536))
                return int(banner.group(1)) if banner else None

            self.gateway_port = self.chrome.until(listening, "the shared synthetic Gateway listening banner")
            reset = self.request("reset", {})
            if reset.get("sessionKey") != SESSION:
                raise RuntimeError("Synthetic Gateway reset returned a different task session")
            # Keep the maintained window manager, vault, dashboard and cleanup owners.
            # Only this task's saved remote endpoint changes; the 501 fixtures stay intact.
            super().start()
            config = Path.home() / ".openclaw/openclaw.json"
            config.write_text(json.dumps({"gateway": {"mode": "remote", "remote": {
                "transport": "direct", "url": f"ws://127.0.0.1:{self.gateway_port}/",
            }}}))
            self.config_hash = self.primary_hash()
        except BaseException:
            self.close()
            raise

    def nodes(self):
        pending = [(self.quickchat_root, "0")]
        visited = 0
        while pending:
            node, path = pending.pop()
            if node is None:
                continue
            visited += 1
            if visited > 500:
                raise RuntimeError("Quick Chat accessibility tree exceeded 500 nodes")
            yield node, path
            pending.extend((node.get_child_at_index(index), f"{path}/{index}")
                           for index in reversed(range(node.get_child_count())))

    def text(self, node):
        interface = node.get_text_iface()
        return self.Atspi.Text.get_text(interface, 0, -1) if interface is not None else ""

    def hierarchy(self):
        rows = []
        for node, path in self.nodes():
            state = node.get_state_set()
            component = node.get_component_iface()
            bounds = component.get_extents(self.Atspi.CoordType.SCREEN) if component is not None else None
            rows.append({
                "path": path, "role": node.get_localized_role_name(),
                "name": node.get_name(), "text": self.text(node),
                "states": [name.lower() for name in ("VISIBLE", "SHOWING", "EDITABLE", "ENABLED", "SENSITIVE", "FOCUSED")
                           if state.contains(getattr(self.Atspi.StateType, name))],
                "bounds": {key: getattr(bounds, key) for key in ("x", "y", "width", "height")} if bounds is not None else None,
            })
        return rows

    def wait_ui(self, required, *, forbidden=(), draft=None):
        from gi.repository import GLib

        def observed():
            if self.app.poll() is not None:
                raise RuntimeError("Native app exited during task progress proof")
            if self.gateway.poll() is not None:
                raise RuntimeError("Synthetic Gateway exited during task progress proof")
            try:
                rows = self.hierarchy()
                text = "\n".join(row["name"] + "\n" + row["text"] for row in rows)
                if not all(value in text for value in required) or any(value in text for value in forbidden):
                    return None
                if draft is not None:
                    state = self.quick_input.get_state_set()
                    if self.text(self.quick_input) != draft or not all(state.contains(getattr(self.Atspi.StateType, name))
                                                                       for name in ("EDITABLE", "ENABLED", "SENSITIVE")):
                        return None
                return rows
            except GLib.Error:
                # WebKit can replace accessible objects while applying a Gateway event.
                return None

        return self.chrome.until(observed, "native Quick Chat: " + ", ".join(required))

    def reveal(self, text):
        candidates = [(len(content), node) for node, _ in self.nodes()
                      if text in (content := self.text(node)) and node.get_component_iface() is not None]
        if not candidates:
            raise RuntimeError(f"No native text to scroll into view: {text}")
        _, node = min(candidates, key=lambda candidate: candidate[0])
        node.get_component_iface().scroll_to(self.Atspi.ScrollType.ANYWHERE)

    def capture(self, name):
        # reply-state is aria-hidden in the real app. Header truth needs pixel
        # inspection; its absence from this hierarchy is not an assertion.
        super().capture(name)
        if self.quickchat_root is not None:
            try:
                hierarchy = self.hierarchy()
                path = self.artifacts_dir / f"task-progress-{name}-hierarchy.json"
                path.write_text(json.dumps(hierarchy, indent=2) + "\n")
                self.captures.append({"screenshot": f"task-progress-{name}.png", "hierarchy": path.name})
            except Exception as error:
                if name != "failed":
                    raise
                self.capture_errors.append(str(error))
        if name == "failed" and self.gateway_port is not None:
            try:
                self.save_evidence(name)
            except Exception as error:
                self.capture_errors.append(str(error))

    def save_evidence(self, stage):
        self.evidence = self.request("evidence")
        path = self.artifacts_dir / f"task-progress-{stage}-gateway.json"
        path.write_text(json.dumps(self.evidence, indent=2) + "\n")
        return self.evidence

    def observe_stage(self, stage, detail, *, forbidden=(), draft=DRAFT):
        self.wait_ui((PARENT, detail, *CHECKLIST), forbidden=forbidden, draft=draft)
        capture_name = "terminal-failed" if stage == "failed" else stage
        self.reveal(detail)
        self.capture(capture_name)
        self.reveal(CHECKLIST[-1])
        self.capture(capture_name + "-checklist")
        evidence = self.save_evidence(capture_name)
        if evidence.get("stage") != stage or not evidence.get("parentYielded"):
            raise RuntimeError(f"Synthetic Gateway did not record yielded parent at {stage}")
        task = evidence["task"]
        if (task["runtime"], task["agentId"], task["sessionKey"], task["ownerKey"]) != (
            "subagent", "worker", SESSION, SESSION,
        ):
            raise RuntimeError("Worker execution and requester ownership were not kept separate")
        if "progressSummary" in task or "lastActivity" in task:
            raise RuntimeError("Prepared worker detail was duplicated into legacy progress fields")
        if self.stages and evidence["card"] != self.stages[0]["card"]:
            raise RuntimeError("Worker updates rewrote the independently authored checklist")
        self.stages.append({"stage": stage, "draft": self.text(self.quick_input), "card": evidence["card"]})
        self.chrome.record(stage + " native task, checklist and editable draft", True)
        return evidence

    def exercise(self, app, binary, wait, Atspi):
        self.app = app
        self.Atspi = Atspi
        self.sources["binary"] = {"path": str(binary), "sha256": self.sha256(binary)}
        wait("OpenClaw", ("frame", "window"))
        self.quick_input = self.open_quickchat(app, wait, Atspi)
        self.quickchat_root = self.quick_input
        while (parent := self.quickchat_root.get_parent()) is not None and parent.get_localized_role_name() != "application":
            self.quickchat_root = parent
        self.chrome.command("xdotool", "type", "--clearmodifiers", "--delay", "10", PROMPT)
        wait("Send message", ("button", "push button"), predicate=lambda node:
             self.in_active_window(node, Atspi) and node.get_state_set().contains(Atspi.StateType.SENSITIVE))
        self.chrome.command("xdotool", "key", "Return")
        self.wait_ui((PARENT, "Synthetic worker — running", YIELDED, *CHECKLIST))
        self.reveal(PARENT)
        self.capture("parent-yielded")
        self.quick_input = self.focus_input(wait, Atspi, "Quick Chat message")
        self.chrome.command("xdotool", "type", "--clearmodifiers", "--delay", "10", DRAFT)
        wait("Send message", ("button", "push button"), predicate=lambda node:
             self.in_active_window(node, Atspi) and node.get_state_set().contains(Atspi.StateType.SENSITIVE))
        self.observe_stage("yielded", YIELDED)

        self.request("advance", {"stage": "working"})
        self.wait_ui((WORKING, COMMAND), forbidden=(YIELDED,), draft=DRAFT)
        self.observe_stage("working", COMMAND, forbidden=(YIELDED,))
        self.request("advance", {"stage": "unknown"})
        unknown_rows = self.wait_ui(("Synthetic worker — unknown", UNKNOWN_COMMAND), forbidden=(COMMAND,), draft=DRAFT)
        if not any(UNKNOWN_COMMAND in row["text"].splitlines() for row in unknown_rows):
            raise RuntimeError("The native tool row invented a status for an absent outcome")
        unknown = self.observe_stage("unknown", UNKNOWN_COMMAND, forbidden=(COMMAND,))
        command = next(item for item in unknown["task"]["progress"]["items"] if item["title"] == UNKNOWN_COMMAND)
        if "status" in command:
            raise RuntimeError("Unknown tool outcome was not absent in the Gateway evidence")
        self.request("advance", {"stage": "failed"})
        self.wait_ui(("Synthetic worker — failed", TERMINAL), draft=DRAFT)
        terminal = self.observe_stage("failed", TERMINAL)
        if terminal["task"]["status"] != "failed":
            raise RuntimeError("Native terminal state disagrees with the Gateway task")
        requests = terminal["requests"]
        if sum(request["method"] == "chat.send" for request in requests) != 1:
            raise RuntimeError("The retained child required another parent send or submitted the draft")
        for method in ("chat.send", "tasks.list", "progressCard.get"):
            if not any(request["method"] == method and request.get("sessionKey") == SESSION for request in requests):
                raise RuntimeError(f"No real native {method} request for the task session")
        if not any(connection.get("taskProgress") for connection in terminal["connections"]):
            raise RuntimeError("No native connection advertised task-progress support")
        events = terminal["events"]
        yielded = next((event for event in events if event["event"] == "chat" and event.get("yielded")), None)
        working = next((event for event in events if event["event"] == "task" and event["stage"] == "working"
                        and event["taskProgressRecipients"] > 0), None)
        final = next((event for event in events if event["event"] == "chat" and event["stage"] == "failed"
                      and event.get("state") == "final"), None)
        if not yielded or not working or not final or not yielded["seq"] < working["seq"] < final["seq"]:
            raise RuntimeError("Gateway evidence did not retain post-yield worker events and a separate terminal final")
        messages = terminal["assistantMessages"]
        if [message["text"] for message in messages] != [
            PARENT, "Synthetic final: failed fixture result; no command was executed.",
        ] or messages[0]["id"] == messages[1]["id"]:
            raise RuntimeError("The synthetic final replaced the yielded parent instead of remaining separate")
        if self.primary_hash() != self.config_hash:
            raise RuntimeError("Quick Chat changed the task-owned remote Gateway configuration")
        self.passed = True
        print("PASS: native Quick Chat retained synthetic worker progress, draft and independent checklist", flush=True)

    def write_results(self):
        (self.artifacts_dir / "task-progress-results.json").write_text(json.dumps({
            "passed": self.passed,
            "scope": "Actual Rust/Tauri/WebKit Quick Chat with synthetic Gateway data; no model or worker command execution; candidate-only, not a before/after comparison.",
            "sources": self.sources, "checks": self.chrome.checks, "stages": self.stages,
            "captures": self.captures, "captureErrors": self.capture_errors,
            "gatewayEvidence": self.evidence,
            "inspection": "Inspect native PNGs separately; aria-hidden reply headers are not covered by AT-SPI assertions.",
        }, indent=2) + "\n")

    def close(self):
        if self.closed:
            return
        self.closed = True
        try:
            super().close()
        finally:
            if self.gateway is not None:
                if self.gateway.poll() is None:
                    self.gateway.terminate()
                try:
                    self.gateway.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    self.gateway.kill()
                    self.gateway.wait(timeout=5)
            if self.gateway_output is not None:
                self.gateway_output.close()
