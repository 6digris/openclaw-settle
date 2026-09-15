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
    if count >= DIAGNOSTIC_RECORDS - 1 or size + len(raw) + 512 > DIAGNOSTIC_BYTES - 1024:
        record = dict(emitter=record["emitter"], phase="overflow")
        raw = encoded_record(record)
        overflow = True
    return record, count + 1, size + len(raw) + 512, overflow


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
    count, size = len(records), len(prior) + 512 * len(records)
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
