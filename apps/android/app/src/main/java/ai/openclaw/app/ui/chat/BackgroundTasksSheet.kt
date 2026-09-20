package ai.openclaw.app.ui.chat

import ai.openclaw.app.MainViewModel
import ai.openclaw.app.chat.BackgroundTask
import ai.openclaw.app.chat.BackgroundTaskDisplayStatus
import ai.openclaw.app.chat.BackgroundTaskEvent
import ai.openclaw.app.chat.ChatAgentActivity
import ai.openclaw.app.chat.ChatProgressCard
import ai.openclaw.app.chat.CoalescedBackgroundTaskEvent
import ai.openclaw.app.chat.coalesceBackgroundTaskEvent
import ai.openclaw.app.chat.mergeBackgroundTasks
import ai.openclaw.app.chat.newestBackgroundTaskSnapshot
import ai.openclaw.app.chat.replayBackgroundTaskEvents
import ai.openclaw.app.i18n.nativeString
import ai.openclaw.app.ui.AppModalBottomSheet
import ai.openclaw.app.ui.design.ClawStatus
import ai.openclaw.app.ui.design.ClawStatusPill
import ai.openclaw.app.ui.design.ClawTheme
import ai.openclaw.app.ui.foldAwareSheet
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

private class BackgroundTaskReads {
  var disposed = false
  var listToken: Any? = null
  var detailToken: Any? = null
  var listJob: Job? = null
  var detailJob: Job? = null
  var listEvents: MutableMap<String, CoalescedBackgroundTaskEvent>? = null
  var detailEvents: MutableMap<String, CoalescedBackgroundTaskEvent>? = null
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun BackgroundTasksSheet(
  viewModel: MainViewModel,
  opening: ChatModelPickerSession,
  admit: () -> Boolean,
  onDismiss: () -> Unit,
) {
  var tasks by remember(opening) { mutableStateOf<List<BackgroundTask>>(emptyList()) }
  var selectedTask by remember(opening) { mutableStateOf<BackgroundTask?>(null) }
  var loading by remember(opening) { mutableStateOf(true) }
  var detailLoading by remember(opening) { mutableStateOf(false) }
  var listError by remember(opening) { mutableStateOf<String?>(null) }
  var detailError by remember(opening) { mutableStateOf<String?>(null) }
  val reads = remember(opening) { BackgroundTaskReads() }
  val scope = rememberCoroutineScope()
  val progressCard by viewModel.chatProgressCard.collectAsState()

  // Reads can finish before first placement or after a same-owner disconnect.
  // Only user actions require placed geometry; neither completion gate requires a live socket.
  fun isCurrent() = !reads.disposed && !opening.geometry.revoked && viewModel.isCurrentChatComposerOwner(opening.composerOwner)

  fun loadTasks() {
    if (!isCurrent()) return
    val token = Any()
    val pendingEvents = mutableMapOf<String, CoalescedBackgroundTaskEvent>()
    reads.listToken = token
    reads.listEvents = pendingEvents
    reads.listJob?.cancel()
    loading = true
    listError = null
    reads.listJob =
      scope.launch {
        if (!isCurrent() || reads.listToken !== token) return@launch
        try {
          val result = viewModel.listBackgroundTasks(opening.composerOwner.agentId)
          if (isCurrent() && reads.listToken === token) {
            val knownIds = (result + tasks).mapTo(mutableSetOf()) { it.id }
            val admittedEvents =
              pendingEvents.filterValues { event ->
                event !is CoalescedBackgroundTaskEvent.Upserted ||
                  event.task.agentId == opening.composerOwner.agentId || event.task.id in knownIds
              }
            tasks = backgroundTaskWindow(replayBackgroundTaskEvents(result, admittedEvents))
          }
        } catch (failure: Exception) {
          if (failure is CancellationException) throw failure
          if (isCurrent() && reads.listToken === token) {
            listError = failure.message ?: nativeString("Couldn’t load background tasks")
          }
        } finally {
          if (isCurrent() && reads.listToken === token) {
            reads.listEvents = null
            loading = false
          }
        }
      }
  }

  fun selectTask(task: BackgroundTask) {
    if (!isCurrent()) return
    val token = Any()
    val pendingEvents = mutableMapOf<String, CoalescedBackgroundTaskEvent>()
    reads.detailToken = token
    reads.detailEvents = pendingEvents
    reads.detailJob?.cancel()
    selectedTask = task
    detailLoading = true
    detailError = null
    reads.detailJob =
      scope.launch {
        if (!isCurrent() || reads.detailToken !== token) return@launch
        try {
          val result = viewModel.getBackgroundTask(task.id)
          if (isCurrent() && reads.detailToken === token) {
            selectedTask = replayBackgroundTaskEvents(listOf(result), pendingEvents).singleOrNull { it.id == task.id }
          }
        } catch (failure: Exception) {
          if (failure is CancellationException) throw failure
          if (isCurrent() && reads.detailToken === token) {
            detailError = failure.message ?: nativeString("Couldn’t load task details")
          }
        } finally {
          if (isCurrent() && reads.detailToken === token) {
            reads.detailEvents = null
            detailLoading = false
          }
        }
      }
  }

  LaunchedEffect(opening) {
    launch(start = CoroutineStart.UNDISPATCHED) {
      viewModel.backgroundTaskEvents().collect { event ->
        if (!isCurrent()) return@collect
        when (event) {
          is BackgroundTaskEvent.Upserted -> {
            val task = event.task
            val alreadyVisible = tasks.any { it.id == task.id } || selectedTask?.id == task.id
            if (task.agentId != null && task.agentId != opening.composerOwner.agentId) return@collect
            reads.listEvents?.let { coalesceBackgroundTaskEvent(it, event) }
            if (task.agentId == null && !alreadyVisible) return@collect
            tasks = backgroundTaskWindow(mergeBackgroundTasks(tasks, listOf(task)))
            selectedTask?.takeIf { it.id == task.id }?.let { previous ->
              reads.detailEvents?.let { coalesceBackgroundTaskEvent(it, event) }
              selectedTask = newestBackgroundTaskSnapshot(previous, task)
            }
          }

          is BackgroundTaskEvent.Deleted -> {
            reads.listEvents?.let { coalesceBackgroundTaskEvent(it, event) }
            tasks = tasks.filterNot { it.id == event.taskId }
            if (selectedTask?.id == event.taskId) {
              reads.detailToken = null
              reads.detailEvents = null
              reads.detailJob?.cancel()
              selectedTask = null
            }
          }

          BackgroundTaskEvent.Restored -> {
            tasks = tasks.map { it.copy(progress = null, executionState = null) }
            selectedTask = selectedTask?.copy(progress = null, executionState = null)
            loadTasks()
            selectedTask?.let(::selectTask)
          }
        }
      }
    }
    loadTasks()
  }
  DisposableEffect(opening) {
    onDispose {
      reads.disposed = true
      reads.listToken = null
      reads.listEvents = null
      reads.detailToken = null
      reads.detailEvents = null
      reads.listJob?.cancel()
      reads.detailJob?.cancel()
    }
  }

  AppModalBottomSheet(
    modifier = Modifier.foldAwareSheet(opening.geometry),
    onDismissRequest = onDismiss,
    sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
    containerColor = ClawTheme.colors.surface,
    contentColor = ClawTheme.colors.text,
  ) {
    if (selectedTask != null) {
      BackgroundTaskDetail(
        task = selectedTask!!,
        loading = detailLoading,
        error = detailError,
        progressCard = progressCard?.takeIf { selectedTask?.sessionKey == opening.sessionKey },
        onBack = {
          if (admit()) {
            // Retire the detail result before cancellation or deferred Compose removal.
            reads.detailToken = null
            reads.detailEvents = null
            reads.detailJob?.cancel()
            selectedTask = null
            detailLoading = false
            detailError = null
          }
        },
      )
    } else {
      BackgroundTaskList(
        tasks = tasks,
        loading = loading,
        error = listError,
        progressCard = progressCard,
        onRefresh = { if (admit()) loadTasks() },
        onSelect = { if (admit()) selectTask(it) },
      )
    }
  }
}

private fun backgroundTaskWindow(tasks: List<BackgroundTask>): List<BackgroundTask> = tasks.filterNot(BackgroundTask::isTerminal).take(100) + tasks.filter(BackgroundTask::isTerminal).take(50)

@Composable
private fun BackgroundTaskList(
  tasks: List<BackgroundTask>,
  loading: Boolean,
  error: String?,
  progressCard: ChatProgressCard?,
  onRefresh: () -> Unit,
  onSelect: (BackgroundTask) -> Unit,
) {
  val running = tasks.filterNot(BackgroundTask::isTerminal)
  val finished = tasks.filter(BackgroundTask::isTerminal)
  LazyColumn(
    modifier = Modifier.fillMaxWidth().heightIn(max = 620.dp),
    contentPadding = PaddingValues(bottom = 28.dp),
  ) {
    item {
      Row(
        modifier = Modifier.fillMaxWidth().padding(start = 20.dp, end = 10.dp, bottom = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
      ) {
        Text(
          text = nativeString("Background tasks"),
          style = ClawTheme.type.title,
          modifier = Modifier.weight(1f),
        )
        if (loading) {
          CircularProgressIndicator(modifier = Modifier.padding(12.dp), strokeWidth = 2.dp)
        } else {
          IconButton(onClick = onRefresh) {
            Icon(Icons.Default.Refresh, contentDescription = nativeString("Refresh background tasks"))
          }
        }
      }
    }
    progressCard?.let { card ->
      item { BackgroundTaskChecklist(card) }
    }
    error?.let { message ->
      item {
        Text(
          text = message,
          style = ClawTheme.type.caption,
          color = ClawTheme.colors.danger,
          modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp),
        )
      }
    }
    if (backgroundTasksEmptyStateVisible(loading, error, tasks.size)) {
      item {
        Text(
          text = nativeString("No background tasks for this agent."),
          style = ClawTheme.type.body,
          color = ClawTheme.colors.textMuted,
          modifier = Modifier.padding(horizontal = 20.dp, vertical = 24.dp),
        )
      }
    }
    taskSection(nativeString("Active"), running, onSelect)
    taskSection(nativeString("Finished"), finished, onSelect)
  }
}

internal fun backgroundTasksEmptyStateVisible(
  loading: Boolean,
  error: String?,
  taskCount: Int,
): Boolean = !loading && error == null && taskCount == 0

private fun androidx.compose.foundation.lazy.LazyListScope.taskSection(
  title: String,
  tasks: List<BackgroundTask>,
  onSelect: (BackgroundTask) -> Unit,
) {
  if (tasks.isEmpty()) return
  item(key = "section-$title") {
    Text(
      text = title,
      style = ClawTheme.type.caption,
      color = ClawTheme.colors.textMuted,
      modifier = Modifier.padding(start = 20.dp, top = 16.dp, end = 20.dp, bottom = 6.dp),
    )
  }
  items(tasks, key = BackgroundTask::id) { task ->
    val statusLabel = backgroundTaskStatusLabel(task)
    Surface(
      onClick = { onSelect(task) },
      modifier = Modifier.fillMaxWidth(),
      color = Color.Transparent,
      contentColor = ClawTheme.colors.text,
    ) {
      Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 13.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(12.dp),
      ) {
        Column(modifier = Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(6.dp)) {
          Text(
            text = task.displayTitle,
            style = ClawTheme.type.body,
            maxLines = 2,
            overflow = TextOverflow.Ellipsis,
          )
          Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
            ClawStatusPill(
              text = statusLabel,
              status =
                when {
                  task.isActive -> ClawStatus.Warning
                  task.displayStatus == BackgroundTaskDisplayStatus.Completed -> ClawStatus.Success
                  task.displayStatus == BackgroundTaskDisplayStatus.Unknown -> ClawStatus.Warning
                  else -> ClawStatus.Danger
                },
            )
            Text(task.runtime, style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted)
          }
          task.progress?.items?.lastOrNull()?.let { activity ->
            Text(
              text = activity.progressText?.takeIf(String::isNotBlank) ?: activity.title,
              style = ClawTheme.type.caption,
              color = ClawTheme.colors.textMuted,
              maxLines = 2,
              overflow = TextOverflow.Ellipsis,
            )
          }
          task.output?.let { output ->
            Text(
              text = output,
              style = ClawTheme.type.caption,
              color = ClawTheme.colors.textMuted,
              maxLines = 2,
              overflow = TextOverflow.Ellipsis,
            )
          }
        }
        Icon(Icons.Default.ChevronRight, contentDescription = null, tint = ClawTheme.colors.textMuted)
      }
    }
    HorizontalDivider(color = ClawTheme.colors.border, thickness = 1.dp)
  }
}

@Composable
private fun BackgroundTaskDetail(
  task: BackgroundTask,
  loading: Boolean,
  error: String?,
  progressCard: ChatProgressCard?,
  onBack: () -> Unit,
) {
  val statusLabel = backgroundTaskStatusLabel(task)
  LazyColumn(
    modifier = Modifier.fillMaxWidth().heightIn(max = 620.dp),
    contentPadding = PaddingValues(bottom = 28.dp),
  ) {
    item {
      Row(
        modifier = Modifier.fillMaxWidth().padding(start = 8.dp, end = 20.dp, bottom = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
      ) {
        IconButton(onClick = onBack) {
          Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = nativeString("Back to background tasks"))
        }
        Column(modifier = Modifier.weight(1f)) {
          Text(task.displayTitle, style = ClawTheme.type.title, maxLines = 2, overflow = TextOverflow.Ellipsis)
          Text(
            text =
              nativeString(
                "\${statusLabel} · \${task.runtime}",
                statusLabel,
                task.runtime,
              ),
            style = ClawTheme.type.caption,
            color = ClawTheme.colors.textMuted,
          )
        }
        if (loading) CircularProgressIndicator(strokeWidth = 2.dp)
      }
    }
    error?.let { message ->
      item {
        Text(
          text = message,
          style = ClawTheme.type.caption,
          color = ClawTheme.colors.danger,
          modifier = Modifier.padding(horizontal = 20.dp, vertical = 8.dp),
        )
      }
    }
    item {
      TaskTextBlock(
        label = nativeString("Final delivery"),
        text = backgroundTaskDeliveryLabel(task.deliveryStatus),
      )
    }
    progressCard?.let { card -> item { BackgroundTaskChecklist(card) } }
    if (task.progress == null) {
      item { TaskTextBlock(label = nativeString("Activity"), text = nativeString("Activity unavailable")) }
    } else if (task.progress.items.isEmpty()) {
      item { TaskTextBlock(label = nativeString("Activity"), text = nativeString("No current activity")) }
    } else {
      items(task.progress.items, key = ChatAgentActivity::itemId) { activity ->
        TaskTextBlock(
          label = activity.status ?: nativeString("Activity"),
          text = activity.progressText?.takeIf(String::isNotBlank) ?: activity.title,
        )
      }
    }
    item { TaskTextBlock(label = nativeString("Prompt"), text = task.prompt ?: nativeString("Prompt unavailable")) }
    item { TaskTextBlock(label = nativeString("Output"), text = task.output ?: nativeString("No output yet")) }
  }
}

private fun backgroundTaskStatusLabel(task: BackgroundTask): String =
  when (task.displayStatus) {
    BackgroundTaskDisplayStatus.Queued -> {
      nativeString("Queued")
    }

    BackgroundTaskDisplayStatus.Running -> {
      nativeString("Running")
    }

    BackgroundTaskDisplayStatus.Completed -> {
      nativeString("Completed")
    }

    BackgroundTaskDisplayStatus.Failed -> {
      nativeString("Failed")
    }

    BackgroundTaskDisplayStatus.Waiting -> {
      when (task.waitKind) {
        "children" -> nativeString("Waiting for delegated work")
        "approval" -> nativeString("Waiting for approval")
        "user_input" -> nativeString("Waiting for input")
        else -> nativeString("Waiting")
      }
    }

    BackgroundTaskDisplayStatus.ExecutionFinished -> {
      nativeString("Execution finished")
    }

    BackgroundTaskDisplayStatus.Blocked -> {
      nativeString("Blocked")
    }

    BackgroundTaskDisplayStatus.Unknown -> {
      nativeString("Activity unavailable")
    }
  }

private fun backgroundTaskDeliveryLabel(status: String?): String =
  when (status) {
    "pending" -> nativeString("Pending")
    "delivered" -> nativeString("Delivered")
    "session_queued" -> nativeString("Queued for conversation")
    "failed" -> nativeString("Delivery failed")
    "dismissed" -> nativeString("Dismissed")
    "parent_missing" -> nativeString("Parent unavailable")
    "not_applicable" -> nativeString("Not applicable")
    else -> nativeString("Unavailable")
  }

@Composable
private fun BackgroundTaskChecklist(card: ChatProgressCard) {
  Column(modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 10.dp)) {
    Text(nativeString("Conversation checklist"), style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted)
    ProgressCardPill(card)
  }
}

@Composable
private fun TaskTextBlock(
  label: String,
  text: String,
) {
  Column(
    modifier = Modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 10.dp),
    verticalArrangement = Arrangement.spacedBy(7.dp),
  ) {
    Text(label, style = ClawTheme.type.caption, color = ClawTheme.colors.textMuted)
    Surface(
      modifier = Modifier.fillMaxWidth(),
      color = ClawTheme.colors.surfaceRaised,
      contentColor = ClawTheme.colors.text,
      shape = RoundedCornerShape(ClawTheme.radii.panel),
    ) {
      SelectionContainer {
        Text(text, style = ClawTheme.type.mono, modifier = Modifier.padding(12.dp))
      }
    }
  }
}
