"""Read exact Windows process lifetimes for the checkout fixture."""
import ctypes as c
from ctypes import wintypes as w
import json
import os
import sys


DIAGNOSTIC_RECORDS = 256
DIAGNOSTIC_BYTES = 256 * 1024


def encoded_record(record):
    return (json.dumps(record, ensure_ascii=True) + "\n").encode("ascii")


def bounded_record(record, count, size, overflow):
    if overflow:
        return None, count, size, overflow
    raw = encoded_record(record)
    # Each producer reserves one record and 1 KiB for an explicit overflow.
    # Census consumers may add at most 512 bytes of caller-local request timing.
    allowance = 512 if record["emitter"] == "census" else 0
    if count >= DIAGNOSTIC_RECORDS - 1 or size + len(raw) + allowance > DIAGNOSTIC_BYTES - 1024:
        record = dict(emitter=record["emitter"], phase="overflow")
        raw = encoded_record(record)
        overflow = True
    return record, count + 1, size + len(raw) + allowance, overflow


def clock_sample(kernel):
    saved_error = c.get_last_error()
    try:
        values = []
        for name in ("QueryPerformanceCounter", "QueryPerformanceFrequency"):
            function = getattr(kernel, name)
            function.restype, function.argtypes = w.BOOL, [c.POINTER(c.c_int64)]
            value = c.c_int64()
            if not function(c.byref(value)):
                return values[0] if values else None, None, c.get_last_error()
            values.append(str(value.value))
        return *values, None
    finally:
        c.set_last_error(saved_error)


def read_processes(pids, sequence=None, job=None):
    kernel = c.WinDLL("kernel32", use_last_error=True)

    def bind(name, result, *arguments):
        function = getattr(kernel, name)
        function.restype, function.argtypes = result, arguments
        return function

    open_process = bind("OpenProcess", w.HANDLE, w.DWORD, w.BOOL, w.DWORD)
    process_times = bind("GetProcessTimes", w.BOOL, w.HANDLE,
                         *([c.POINTER(w.FILETIME)] * 4))
    wait = bind("WaitForSingleObject", w.DWORD, w.HANDLE, w.DWORD)
    close = bind("CloseHandle", w.BOOL, w.HANDLE)
    observations = []
    for pid in pids:
        if not isinstance(pid, int) or pid <= 0:
            raise ValueError("Expected a positive process id")
        native = None
        if sequence is not None:
            saved_error = c.get_last_error()
            native = dict(emitter="census", phase="sample", sequence=sequence, pid=pid,
                          start=None, end=None, frequency=None, clockError=None,
                          waitResult=None, openError=None, inJob=None, membershipError=None,
                          diagnosticError=False)
            try:
                native["start"], native["frequency"], native["clockError"] = clock_sample(kernel)
            except BaseException:
                native["diagnosticError"] = True
            finally:
                c.set_last_error(saved_error)
        # QUERY_LIMITED_INFORMATION reads birth; SYNCHRONIZE proves termination.
        handle = open_process(0x1000 | 0x100000, False, pid)
        if not handle:
            error = c.get_last_error()
            if error != 87:  # ERROR_INVALID_PARAMETER: the positive PID is absent.
                raise c.WinError(error)
            observation = dict(pid=pid, alive=False, creationTime=None)
            if native is not None:
                native["openError"] = error
                native.update(alive=False, creationTime=None)
                try:
                    native["end"], _, end_error = clock_sample(kernel)
                    if native["clockError"] is None:
                        native["clockError"] = end_error
                except BaseException:
                    native["diagnosticError"] = True
                observation["native"] = native
            observations.append(observation)
            continue
        try:
            result = wait(handle, 0)
            if result not in (0, 258):  # WAIT_OBJECT_0 / WAIT_TIMEOUT.
                raise c.WinError(c.get_last_error())
            times = [w.FILETIME() for _ in range(4)]
            if not process_times(handle, *(c.byref(value) for value in times)):
                raise c.WinError(c.get_last_error())
            creation = times[0].dwHighDateTime << 32 | times[0].dwLowDateTime
            observation = dict(pid=pid, alive=result == 258, creationTime=str(creation))
            if native is not None:
                saved_error = c.get_last_error()
                native.update(waitResult=result, alive=observation["alive"],
                              creationTime=observation["creationTime"])
                try:
                    if job is not None:
                        membership = bind("IsProcessInJob", w.BOOL, w.HANDLE, w.HANDLE, c.POINTER(w.BOOL))
                        member = w.BOOL()
                        if membership(handle, job, c.byref(member)):
                            native["inJob"] = bool(member.value)
                        else:
                            native["membershipError"] = c.get_last_error()
                    native["end"], _, end_error = clock_sample(kernel)
                    if native["clockError"] is None:
                        native["clockError"] = end_error
                except BaseException:
                    native["diagnosticError"] = True
                finally:
                    c.set_last_error(saved_error)
                observation["native"] = native
            observations.append(observation)
        finally:
            if not close(handle):
                raise c.WinError(c.get_last_error())
    return observations


def install_owner_observer(namespace, root):
    """Observe the rendered test owner, never change its checked-in implementation."""
    if os.name != "nt":
        return
    filename = os.path.join(root, "windows-owner-diagnostic.jsonl")
    # Policy owners run sequentially. Seed once so their shared cap survives
    # owner replacement without rereading the journal on each drain sample.
    try:
        with open(filename, "rb") as stream:
            prior = stream.read(DIAGNOSTIC_BYTES + 1)
    except FileNotFoundError:
        prior = b""
    if len(prior) > DIAGNOSTIC_BYTES:
        return
    records = [json.loads(line) for line in prior.splitlines()]
    count, size = len(records), len(prior)
    overflow = any(row.get("phase") == "overflow" for row in records)
    if overflow:
        return
    generation = 0
    sequence = 0
    current_job = None
    bootstrap_pid = None
    owner_birth = read_processes([os.getpid()])[0]["creationTime"]
    exception_names = {"OSError", "RuntimeError", "SystemExit", "KeyboardInterrupt",
                       "FetchTimeout", "GitFailure"}

    def append(record):
        nonlocal count, size, overflow
        record, count, size, overflow = bounded_record(record, count, size, overflow)
        if record is not None:
            with open(filename, "ab") as stream:
                stream.write(encoded_record(record))

    def emit(phase, job, accounting=None, return_path=None, error=None):
        nonlocal sequence
        if overflow:
            return
        saved_error = c.get_last_error()
        try:
            sequence += 1
            actors, sentinel = [], None
            entries = sorted(os.listdir(os.path.join(root, "pids")))
            if len(entries) > 128:
                raise ValueError("diagnostic actor inventory bound")
            for name in entries:
                if not name.endswith(".json"):
                    continue
                with open(os.path.join(root, "pids", name), encoding="utf8") as stream:
                    raw = stream.read(4097)
                if len(raw) > 4096:
                    raise ValueError("diagnostic actor record bound")
                actor = json.loads(raw)
                if actor["role"] not in ("parent", "child", "grandchild", "sentinel"):
                    continue
                sample = read_processes([actor["pid"]], sequence, job)[0]
                row = dict(pid=actor["pid"], creationTime=actor.get("creationTime"),
                           role=actor["role"], attempt=actor["attempt"],
                           native=sample["native"])
                if actor["role"] == "sentinel":
                    sentinel = row
                else:
                    actors.append(row)
            record = dict(emitter="owner", phase=phase, ownerPid=os.getpid(),
                          ownerCreationTime=owner_birth, jobGeneration=generation,
                          jobHandle=str(job) if job is not None else None, sequence=sequence,
                          accounting=accounting, returnPath=return_path,
                          exceptionType=(type(error).__name__ if type(error).__name__ in exception_names
                                         else "other") if error is not None else None,
                          errorCode=getattr(error, "winerror", None),
                          actors=actors, sentinel=sentinel,
                          owner=read_processes([os.getpid()], sequence, job)[0]["native"],
                          bootstrap=(read_processes([bootstrap_pid], sequence, job)[0]["native"]
                                     if bootstrap_pid is not None else None))
            append(record)
        except BaseException:
            try:
                append(dict(emitter="owner", phase="observation-error",
                            ownerPid=os.getpid(), ownerCreationTime=owner_birth,
                            jobGeneration=generation, sequence=sequence))
            except BaseException:
                pass  # Report missing evidence; never replace the owner's error.
        finally:
            c.set_last_error(saved_error)

    original_create = namespace["create_job"]
    original_query = namespace["query_job"]
    original_drain = namespace["drain"]
    original_close = namespace["close_handle"]
    original_query_check = original_query.errcheck
    query_result = None

    def checked_query(value, function, arguments):
        nonlocal query_result
        # Capture the actual result before the original checked API can raise.
        query_result = (value, c.get_last_error())
        return original_query_check(value, function, arguments)

    original_query.errcheck = checked_query

    def create(*args):
        nonlocal generation, current_job, bootstrap_pid
        result = original_create(*args)
        generation += 1
        current_job = result
        bootstrap_pid = None
        emit("job-created", result)
        return result

    def query(*args):
        nonlocal query_result
        query_result = None
        try:
            result = original_query(*args)
        except BaseException as error:
            emit("accounting-error", args[0], accounting=(
                dict(result=query_result[0], active=None, total=None, terminated=None)
                if query_result is not None else None), return_path="exception", error=error)
            raise
        saved_error = c.get_last_error()
        try:
            accounting = c.cast(args[2], c.POINTER(namespace["Accounting"])).contents
            emit("accounting", args[0], accounting=dict(
                result=result, active=accounting.ActiveProcesses, total=accounting.TotalProcesses,
                terminated=accounting.TotalTerminatedProcesses))
        except BaseException:
            emit("accounting-error", args[0])
        finally:
            c.set_last_error(saved_error)
        return result

    def drain(child, job):
        nonlocal bootstrap_pid
        bootstrap_pid = child.pid
        emit("before-drain", job)
        try:
            result = original_drain(child, job)
        except BaseException as error:
            emit("after-drain", job, return_path="exception", error=error)
            raise
        emit("after-drain", job, return_path="normal")
        return result

    def close(job):
        if job == current_job:
            emit("before-job-close", job)
        return original_close(job)

    namespace.update(create_job=create, query_job=query, drain=drain, close_handle=close)


def install_membership_probe(namespace, root):
    """One fixture-only snapshot falsification probe, never cleanup authority."""
    if os.name != "nt":
        return
    # Independent bindings: class 3 must never enter the Accounting observer.
    kernel = c.WinDLL("kernel32", use_last_error=True)

    def bind(name, result, *arguments):
        function = getattr(kernel, name)
        function.restype, function.argtypes = result, arguments
        return function

    current = bind("GetCurrentProcess", w.HANDLE)
    duplicate = bind("DuplicateHandle", w.BOOL, w.HANDLE, w.HANDLE, w.HANDLE,
                     c.POINTER(w.HANDLE), w.DWORD, w.BOOL, w.DWORD)
    opened = bind("OpenProcess", w.HANDLE, w.DWORD, w.BOOL, w.DWORD)
    closed = bind("CloseHandle", w.BOOL, w.HANDLE)
    wait = bind("WaitForSingleObject", w.DWORD, w.HANDLE, w.DWORD)
    times = bind("GetProcessTimes", w.BOOL, w.HANDLE, *([c.POINTER(w.FILETIME)] * 4))
    member = bind("IsProcessInJob", w.BOOL, w.HANDLE, w.HANDLE, c.POINTER(w.BOOL))
    query = bind("QueryInformationJobObject", w.BOOL, w.HANDLE, c.c_int,
                 c.c_void_p, w.DWORD, c.POINTER(w.DWORD))

    class ProcessList(c.Structure):
        _fields_ = [("assigned", c.c_uint32), ("count", c.c_uint32),
                    ("pids", c.c_size_t * 256)]

    original_drain = namespace["drain"]
    selected = False

    def drain(child, job):
        nonlocal selected
        if selected or not os.path.isfile(os.path.join(root, "ready-2.json")):
            return original_drain(child, job)
        selected = True
        deadline = namespace["time"].monotonic() + namespace["cleanup_seconds"]
        report = dict(status="inconclusive", reason="no-pending-interval", snapshots=[], errors=[],
                      retentionCanAffectAccounting=True, released=False,
                      releaseErrorCode=None, probeGateException=False,
                      pendingExitObserved=False, python=list(sys.version_info[:3]))
        handles = []
        release_attempted, release_error = False, None
        original_kill, original_wait = child.kill, child.wait
        original_terminate = namespace["terminate_job"]
        overrides = {name: child.__dict__.get(name) for name in ("kill", "wait")}

        def guard(action):
            saved = c.get_last_error()
            try:
                return action()
            except BaseException as error:
                report.update(status="invalid", reason="observation-error")
                if len(report["errors"]) < 3:
                    code = getattr(error, "winerror", None)
                    report["errors"].append(dict(code=code if type(code) is int else None))
            finally:
                c.set_last_error(saved)

        def checked(value):
            if not value:
                raise c.WinError(c.get_last_error())
            return value

        def sample(entry):
            role, pid, birth, handle = entry
            start, frequency, clock_error = clock_sample(kernel)
            result = wait(handle, 0)
            if result not in (0, 258):
                raise c.WinError(c.get_last_error())
            values, in_job = [w.FILETIME() for _ in range(4)], w.BOOL()
            checked(times(handle, *(c.byref(value) for value in values)))
            actual_birth = str(values[0].dwHighDateTime << 32 | values[0].dwLowDateTime)
            checked(member(handle, job, c.byref(in_job)))
            end, _, end_error = clock_sample(kernel)
            if birth is not None and birth != actual_birth:
                raise ValueError("oracle birth mismatch")
            if role == "sentinel" and in_job.value:
                raise ValueError("sentinel entered observed Job")
            if frequency is None or clock_error is not None or end_error is not None:
                raise ValueError("oracle clock unavailable")
            return dict(role=role, pid=pid, birth=actual_birth, wait=result,
                        inJob=bool(in_job.value), start=start, end=end, frequency=frequency)

        def acquire():
            entries = []
            names = os.listdir(os.path.join(root, "pids"))
            if len(names) > 128:
                raise ValueError("actor inventory bound")
            for name in names:
                if not name.endswith(".json"):
                    continue
                with open(os.path.join(root, "pids", name), encoding="utf8") as stream:
                    raw = stream.read(4097)
                if len(raw) > 4096:
                    raise ValueError("actor record bound")
                actor = json.loads(raw)
                if (actor["role"] in ("parent", "child", "grandchild") and actor["attempt"] == 2
                        or actor["role"] == "sentinel"):
                    entries.append(actor)
            if sorted(entry["role"] for entry in entries) != ["child", "grandchild", "parent", "sentinel"]:
                raise ValueError("oracle roles")
            # CPython retains hp in Popen._handle. Duplicate that exact object,
            # never reopen its PID or close the source; the duplicate cannot inherit.
            target = w.HANDLE()
            report["retentionStart"] = clock_sample(kernel)[0]
            checked(duplicate(current(), int(child._handle), current(), c.byref(target), 0, False, 2))
            handles.append(("bootstrap", child.pid, None, target.value))
            for actor in entries:
                pid, birth = actor["pid"], actor["creationTime"]
                if type(pid) is not int or pid <= 0 or not isinstance(birth, str) or not birth.isdecimal():
                    raise ValueError("oracle identity")
                handle = checked(opened(0x1000 | 0x100000, False, pid))
                handles.append((actor["role"], pid, birth, handle))
            for index, entry in enumerate(handles):
                row = sample(entry)
                if row["inJob"] != (row["role"] != "sentinel") or row["wait"] != 258:
                    raise ValueError("oracle not live in expected membership")
                handles[index] = (entry[0], entry[1], row["birth"], entry[3])

        def release():
            nonlocal release_attempted, release_error
            if release_attempted:
                return
            release_attempted = True
            saved = c.get_last_error()
            try:
                for entry in handles[:]:
                    try:
                        checked(closed(entry[3]))
                    except BaseException as error:
                        if release_error is None:
                            release_error = error
                            code = getattr(error, "winerror", None)
                            report["releaseErrorCode"] = code if type(code) is int else None
                        report.update(status="invalid", reason="oracle-close-failed")
                    else:
                        handles.remove(entry)
                report["released"] = not handles
                if report["released"]:
                    report["retentionEnd"] = clock_sample(kernel)[0]
            finally:
                c.set_last_error(saved)

        def snapshot(phase):
            if report["status"] == "invalid":
                return
            if namespace["time"].monotonic() >= deadline:
                raise ValueError("probe deadline")
            before = [sample(entry) for entry in handles]
            listing, length = ProcessList(), w.DWORD()
            result = query(job, 3, c.byref(listing), c.sizeof(listing), c.byref(length))
            error = c.get_last_error() if not result else None
            after = [sample(entry) for entry in handles]
            count, assigned = listing.count, listing.assigned
            complete = bool(result and count == assigned and count <= 256
                            and 8 + count * c.sizeof(c.c_size_t) <= length.value <= c.sizeof(listing))
            pids = list(listing.pids[:count]) if complete else []
            complete = complete and len(set(pids)) == count and all(pid > 0 for pid in pids)
            accounting = namespace["Accounting"]()
            checked(query(job, 1, c.byref(accounting), c.sizeof(accounting), None))
            row = dict(phase=phase, result=result, error=error, assigned=assigned, count=count,
                       returnedBytes=length.value, complete=complete, pids=pids,
                       before=before, after=after, status="inconclusive",
                       active=accounting.ActiveProcesses, total=accounting.TotalProcesses,
                       terminated=accounting.TotalTerminatedProcesses)
            pending = [a for a, b in zip(before, after) if a["role"] != "sentinel"
                       and a["inJob"] and b["inJob"] and a["wait"] == b["wait"] == 258]
            if phase == "after-termination" and complete and pending:
                report["pendingExitObserved"] = True
            if not complete:
                row["status"] = "invalid"
                report.update(status="invalid", reason="incomplete-membership-list")
            elif any(actor["pid"] not in pids for actor in pending):
                row["status"] = "falsified"
                report.update(status="falsified", reason="omitted-nonsignaled-member")
            elif phase == "after-termination" and pending and report["reason"] == "no-pending-interval":
                report["reason"] = "pending-members-listed-not-universal"
            report["snapshots"].append(row)

        def kill(*args, **kwargs):
            guard(acquire)
            guard(lambda: snapshot("before-bootstrap-stop"))
            if report["status"] == "invalid":
                guard(release)
            try:
                return original_kill(*args, **kwargs)
            except BaseException:
                guard(release)
                raise

        def joined(*args, **kwargs):
            try:
                result = original_wait(*args, **kwargs)
            except BaseException:
                guard(release)
                raise
            guard(lambda: snapshot("after-bootstrap-join"))
            if report["status"] == "invalid":
                guard(release)
            return result

        def terminated(*args, **kwargs):
            try:
                result = original_terminate(*args, **kwargs)
            except BaseException:
                guard(release)
                raise
            guard(lambda: snapshot("after-termination"))
            guard(release)
            # Failed probe cleanup must fence the owner before ordinary Accounting;
            # never replace an exception from the original kill/wait/terminate.
            if handles or not report["released"]:
                report["probeGateException"] = True
                if release_error is not None:
                    raise release_error
                raise RuntimeError("Oracle release did not complete")
            return result

        child.kill, child.wait = kill, joined
        namespace["terminate_job"] = terminated
        failed = True
        try:
            result = original_drain(child, job)
            failed = False
            return result
        finally:
            report["originalReturnPath"] = "exception" if failed else "normal"
            guard(release)
            namespace["terminate_job"] = original_terminate
            for name, override in overrides.items():
                if override is None:
                    child.__dict__.pop(name, None)
                else:
                    setattr(child, name, override)

            def publish():
                raw = encoded_record(report)
                if len(raw) > 64 * 1024 or len(report["snapshots"]) + len(report["errors"]) + 2 > 8:
                    raw = encoded_record(dict(status="invalid", reason="probe-output-bound",
                                              released=report["released"]))
                fd = os.open(os.path.join(root, "windows-membership-probe.json"),
                             os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(fd, "wb") as stream:
                    stream.write(raw)
            guard(publish)

    namespace["drain"] = drain


if __name__ == "__main__":
    print(json.dumps(dict(ready=True)), flush=True)
    diagnostic_count, diagnostic_size, diagnostic_overflow = 0, 0, False
    diagnostics = len(sys.argv) == 2 and sys.argv[1] == "--checkout-diagnostics"
    runtime_sent = False
    # EOF retires the sampler even if its Node supervisor was killed.
    for line in sys.stdin:
        request = json.loads(line)
        collect = diagnostics and not diagnostic_overflow
        observations = read_processes(request["pids"], request["id"] if collect else None)
        if collect:
            for observation in observations:
                native = observation.pop("native")
                if not runtime_sent:
                    native["python"] = list(sys.version_info[:3])
                    runtime_sent = True
                record, diagnostic_count, diagnostic_size, diagnostic_overflow = bounded_record(
                    native, diagnostic_count, diagnostic_size, diagnostic_overflow)
                if record is not None:
                    observation["native"] = record
        print(json.dumps(dict(id=request["id"],
                              observations=observations)), flush=True)
