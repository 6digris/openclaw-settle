package ai.openclaw.app.chat

internal enum class ChatToolKind { Command, Read, Edit, Write, Search, Fetch, Progress, Other }

internal fun chatToolKind(name: String): ChatToolKind =
  when (name.trim().lowercase()) {
    "bash", "exec", "shell", "run_command", "run_terminal_cmd", "terminal", "exec_command" -> ChatToolKind.Command
    "read", "read_file", "readfile", "notebookread", "notebook_read" -> ChatToolKind.Read
    "edit", "edit_file", "multiedit", "multi_edit", "apply_patch", "applypatch", "patch" -> ChatToolKind.Edit
    "write", "write_file", "create_file" -> ChatToolKind.Write
    "grep", "find", "glob", "ls", "list", "codebase_search", "web_search", "memory_search", "sessions_search" -> ChatToolKind.Search
    "web_fetch", "webfetch", "fetch" -> ChatToolKind.Fetch
    "progress_card" -> ChatToolKind.Progress
    else -> ChatToolKind.Other
  }
