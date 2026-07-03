/* global io, hljs */

(function () {
  "use strict";

  const AUTH_TOKEN_KEY = "cursor-remote-token";
  const defaultState = {
    connected: false,
    extractorStatus: "idle",
    lastExtractionAt: null,
    consecutiveExtractionFailures: 0,
    lastExtractionError: null,
    agentStatus: "idle",
    agentActivityText: null,
    agentActivityLive: false,
    agentActivitySource: "none",
    messages: [],
    pendingApprovals: [],
    inputAvailable: false,
    chatTabs: [],
    activeComposerId: "",
    mode: { current: "agent", available: [] },
    model: { current: "Auto", currentId: "" },
    windows: [],
    activeWindowId: "",
    composerQueue: { items: [] },
    questionnaire: null,
  };

  function getAuthToken() {
    return localStorage.getItem(AUTH_TOKEN_KEY) || "";
  }

  function getAuthHeaders() {
    const token = getAuthToken();
    return token ? { Authorization: "Bearer " + token } : {};
  }

  function newCommandId() {
    const cryptoApi = globalThis.crypto;
    if (cryptoApi && typeof cryptoApi.randomUUID === "function") {
      return cryptoApi.randomUUID();
    }

    const bytes = new Uint8Array(16);
    if (cryptoApi && typeof cryptoApi.getRandomValues === "function") {
      cryptoApi.getRandomValues(bytes);
    } else {
      for (let i = 0; i < bytes.length; i++) {
        bytes[i] = Math.floor(Math.random() * 256);
      }
    }

    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(
      "",
    );
    return [
      hex.slice(0, 8),
      hex.slice(8, 12),
      hex.slice(12, 16),
      hex.slice(16, 20),
      hex.slice(20),
    ].join("-");
  }

  async function checkAuth() {
    try {
      const res = await fetch("/health", {
        credentials: "same-origin",
        headers: getAuthHeaders(),
      });
      if (res.ok) {
        const data = await res.json();
        if (data.authRequired) {
          if (data.sessionValid === true) return true;
          if (data.sessionValid === false) {
            localStorage.removeItem(AUTH_TOKEN_KEY);
            window.location.href = "/login";
            return false;
          }
          // Older relay without sessionValid: fall back to presence of stored token
          if (getAuthToken()) return true;
          window.location.href = "/login";
          return false;
        }
      }
    } catch {
      /* network error, proceed anyway */
    }
    return true;
  }

  async function init() {
    if (!(await checkAuth())) return;
    bootstrap();
  }

  function bootstrap() {
    let state = { ...defaultState };

    let userScrolledUp = false;
    let autoScrollJob = 0;
    let notificationPermission = "default";
    const notifiedMessageIds = new Set();
    let activePlanModal = null;
    let activePlanModelContext = null;
    const pendingCommandResults = new Map();
    const silentCommandIds = new Set();
    let scrollSyncTimer = 0;
    let lastScrollSyncTarget = null;

    function isNearMessagesBottom() {
      const threshold = 80;
      return (
        $messages.scrollTop + $messages.clientHeight >=
        $messages.scrollHeight - threshold
      );
    }

    function scheduleMessagesAutoScroll() {
      const jobId = ++autoScrollJob;
      requestAnimationFrame(() => {
        if (jobId !== autoScrollJob) return;
        if (userScrolledUp) return;
        $messages.scrollTop = $messages.scrollHeight;
      });
    }

    const $messages = document.getElementById("messages");
    const $emptyState = document.getElementById("empty-state");
    const $emptyPrimary = document.getElementById("empty-state-primary");
    const $emptyHint = document.getElementById("empty-state-hint");
    const $connDot = document.getElementById("connection-dot");
    const $connText = document.getElementById("connection-text");
    const $statusIcon = document.getElementById("agent-status-icon");
    const $statusText = document.getElementById("agent-status-text");
    const $headerRight = document.querySelector("#header .header-right");
    const $approvalBar = document.getElementById("approval-bar");
    const $approvalDesc = document.getElementById("approval-desc");
    const $btnApprove = document.getElementById("btn-approve");
    const $btnReject = document.getElementById("btn-reject");
    var questionnaireSelections = {};
    const $questionnaireBar = document.getElementById("questionnaire-bar");
    const $questionnaireStepper = document.getElementById(
      "questionnaire-stepper",
    );
    const $questionnaireQuestions = document.getElementById(
      "questionnaire-questions",
    );
    const $btnQSkip = document.getElementById("btn-q-skip");
    const $btnQContinue = document.getElementById("btn-q-continue");
    const $input = document.getElementById("message-input");
    const $btnSend = document.getElementById("btn-send");
    const $toastContainer = document.getElementById("toast-container");

    const $windowBar = document.getElementById("window-bar");
    const $windowList = document.getElementById("window-list");
    const $tabBar = document.getElementById("tab-bar");
    const $tabList = document.getElementById("tab-list");
    const $btnNewChat = document.getElementById("btn-new-chat");
    const $pillMode = document.getElementById("pill-mode");
    const $pillModeIcon = document.getElementById("pill-mode-icon");
    const $pillModeText = document.getElementById("pill-mode-text");
    const $pillModel = document.getElementById("pill-model");
    const $pillModelText = document.getElementById("pill-model-text");
    const $sheetOverlay = document.getElementById("sheet-overlay");
    const $sheetMode = document.getElementById("sheet-mode");
    const $sheetModeList = document.getElementById("sheet-mode-list");
    const $sheetModel = document.getElementById("sheet-model");
    const $sheetModelList = document.getElementById("sheet-model-list");
    const $sheetPlanModel = document.getElementById("sheet-plan-model");
    const $sheetPlanModelHeader = document.getElementById(
      "sheet-plan-model-header",
    );
    const $sheetPlanModelList = document.getElementById(
      "sheet-plan-model-list",
    );
    const $planModalOverlay = document.getElementById("plan-modal-overlay");
    const $planModalLabel = document.getElementById("plan-modal-label");
    const $planModalTitle = document.getElementById("plan-modal-title");
    const $planModalBody = document.getElementById("plan-modal-body");
    const $planModalClose = document.getElementById("plan-modal-close");

    const socket = io({
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10000,
      withCredentials: true,
      auth: (cb) => {
        try {
          cb({ token: getAuthToken() || "" });
        } catch {
          cb({ token: "" });
        }
      },
    });

    function sendCommandAwaitResult(eventName, payload) {
      return new Promise((resolve) => {
        const commandId = payload.commandId;
        const timer = setTimeout(() => {
          pendingCommandResults.delete(commandId);
          resolve({ commandId, ok: false, error: "Command timed out" });
        }, 12000);

        pendingCommandResults.set(commandId, (result) => {
          clearTimeout(timer);
          resolve(result);
        });

        socket.emit(eventName, payload);
      });
    }

    socket.on("connect", () => renderAll());
    socket.on("disconnect", () => renderAll());

    let connectFailCount = 0;
    socket.on("connect_error", (err) => {
      connectFailCount++;
      if (err.message === "Unauthorized" || connectFailCount >= 5) {
        localStorage.removeItem(AUTH_TOKEN_KEY);
        window.location.href = "/login";
      }
    });

    socket.on("state:full", (newState) => {
      state = { ...defaultState, ...newState };
      lastScrollSyncTarget = null;
      renderAll();
    });

    function getActiveComposerId(st) {
      if (st.activeComposerId) return st.activeComposerId;
      const tab = (st.chatTabs || []).find((t) => t.isActive);
      return tab?.composerId || "";
    }

    function getActiveTabTitle(st) {
      const tab = (st.chatTabs || []).find((t) => t.isActive);
      return tab?.title || "";
    }

    function chatContextChanged(prev, next) {
      const prevComposer = getActiveComposerId(prev);
      const nextComposer = getActiveComposerId(next);
      if (prevComposer && nextComposer && prevComposer !== nextComposer) {
        return true;
      }
      const prevTitle = getActiveTabTitle(prev);
      const nextTitle = getActiveTabTitle(next);
      return !!(prevTitle && nextTitle && prevTitle !== nextTitle);
    }

    function resetMessagesView() {
      state.messages = [];
      userScrolledUp = false;
      lastScrollSyncTarget = null;
      renderMessages();
    }

    socket.on("state:patch", (patch) => {
      const next = { ...patch };
      const contextChanged = chatContextChanged(state, { ...state, ...next });
      if (contextChanged) {
        userScrolledUp = false;
        lastScrollSyncTarget = null;
        if (!Object.prototype.hasOwnProperty.call(next, "messages")) {
          next.messages = [];
        }
      }
      if (userScrolledUp && next.messages && !contextChanged) {
        next.messages = mergeMessagesPreservingHistory(
          state.messages,
          next.messages,
        );
      }
      Object.assign(state, next);
      renderAll();
    });

    socket.on("connection:status", (data) => {
      state.connected = data.connected;
      renderAll();
    });

    socket.on("command:result", (result) => {
      if (silentCommandIds.has(result.commandId)) {
        silentCommandIds.delete(result.commandId);
        return;
      }
      const pending = pendingCommandResults.get(result.commandId);
      if (pending) {
        pendingCommandResults.delete(result.commandId);
        pending(result);
        return;
      }
      if (!result.ok) showToast(result.error || "Command failed", "error");
    });

    function mergeMessagesPreservingHistory(existing, incoming) {
      if (!incoming?.length) return existing;
      const incomingById = new Map(incoming.map((m) => [m.id, m]));
      const merged = existing.map((m) => incomingById.get(m.id) ?? m);
      const seen = new Set(existing.map((m) => m.id));
      for (const m of incoming) {
        if (!seen.has(m.id)) merged.push(m);
      }
      return merged;
    }

    function captureScrollAnchor() {
      const containerRect = $messages.getBoundingClientRect();
      for (const el of $messages.querySelectorAll(".chat-el")) {
        const rect = el.getBoundingClientRect();
        if (rect.bottom > containerRect.top + 4) {
          return { id: el.dataset.id, offset: rect.top - containerRect.top };
        }
      }
      return { id: null, offset: $messages.scrollTop };
    }

    function restoreScrollAnchor(anchor) {
      requestAnimationFrame(() => {
        if (anchor.id) {
          const safeId =
            typeof CSS !== "undefined" && typeof CSS.escape === "function"
              ? CSS.escape(anchor.id)
              : anchor.id.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
          const el = $messages.querySelector(
            '.chat-el[data-id="' + safeId + '"]',
          );
          if (el) {
            const containerRect = $messages.getBoundingClientRect();
            const rect = el.getBoundingClientRect();
            $messages.scrollTop += rect.top - containerRect.top - anchor.offset;
            return;
          }
        }
        $messages.scrollTop = anchor.offset;
      });
    }

    function emitScrollSync(payload) {
      if (!state.connected) return;
      const commandId = newCommandId();
      silentCommandIds.add(commandId);
      socket.emit("command:scroll_to_message", { commandId, ...payload });
    }

    function syncScrollToCursor() {
      if (!state.connected || state.messages.length === 0) return;
      if (userScrolledUp) return;

      if (!isNearMessagesBottom()) return;

      if (lastScrollSyncTarget === "bottom") return;
      lastScrollSyncTarget = "bottom";
      emitScrollSync({ scrollTo: "bottom" });
    }

    $messages.addEventListener("scroll", () => {
      autoScrollJob++;
      const wasScrolledUp = userScrolledUp;
      userScrolledUp = !isNearMessagesBottom();
      if (wasScrolledUp && !userScrolledUp) {
        lastScrollSyncTarget = null;
      }
      clearTimeout(scrollSyncTimer);
      scrollSyncTimer = setTimeout(syncScrollToCursor, 400);
    });

    $input.addEventListener("input", () => {
      $input.style.height = "auto";
      $input.style.height = Math.min($input.scrollHeight, 120) + "px";
      $btnSend.disabled = !$input.value.trim();
    });

    // Send-on-Enter behaves differently per primary input device:
    //   - Touch (mobile): Enter = newline (textarea default), tap Send to send.
    //     Mobile keyboards have no Shift+Enter so without this you can't write
    //     multi-line messages — reported as public#5.
    //   - Mouse/keyboard (desktop): Enter = send (preserved existing behavior),
    //     Shift+Enter = newline.
    // Cmd/Ctrl+Enter always sends, both platforms — for hardware keyboards
    // attached to phones/tablets and as a familiar shortcut on desktop.
    const isTouchPrimary = () => window.matchMedia("(pointer: coarse)").matches;
    $input.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      if (e.metaKey || e.ctrlKey) {
        e.preventDefault();
        sendMessage();
        return;
      }
      if (e.shiftKey) return; // textarea default → newline
      if (isTouchPrimary()) return; // mobile: newline, send button only
      e.preventDefault();
      sendMessage();
    });

    $btnSend.addEventListener("click", sendMessage);

    $btnApprove.addEventListener("click", () => {
      const approval = state.pendingApprovals[0];
      if (!approval) return;
      const action = approval.actions.find(
        (a) => a.type === "approve" || a.type === "approve_all",
      );
      if (!action) return;
      socket.emit("command:approve", {
        commandId: newCommandId(),
        approvalId: approval.id,
        selectorPath: action.selectorPath,
      });
      showToast("Approve sent", "success");
    });

    $btnReject.addEventListener("click", () => {
      const approval = state.pendingApprovals[0];
      if (!approval) return;
      const action = approval.actions.find((a) => a.type === "reject");
      if (!action) return;
      socket.emit("command:reject", {
        commandId: newCommandId(),
        approvalId: approval.id,
        selectorPath: action.selectorPath,
      });
      showToast("Reject sent", "success");
    });

    $btnQSkip.addEventListener("click", () => {
      if (!state.questionnaire) return;
      socket.emit("command:click_action", {
        commandId: newCommandId(),
        selectorPath: state.questionnaire.skipSelectorPath,
      });
      showToast("Skip sent", "success");
    });

    $btnQContinue.addEventListener("click", () => {
      if (!state.questionnaire || state.questionnaire.continueDisabled) return;
      socket.emit("command:click_action", {
        commandId: newCommandId(),
        selectorPath: state.questionnaire.continueSelectorPath,
      });
      showToast("Continue sent", "success");
    });

    $btnNewChat.addEventListener("click", () => {
      socket.emit("command:new_chat", { commandId: newCommandId() });
      showToast("Creating new chat...", "success");
    });

    $pillMode.addEventListener("click", () => openSheet("mode"));
    $pillModel.addEventListener("click", () => openSheet("model"));
    $sheetOverlay.addEventListener("click", closeSheet);
    $planModalClose.addEventListener("click", closePlanModal);
    $planModalOverlay.addEventListener("click", (e) => {
      if (e.target === $planModalOverlay) closePlanModal();
    });

    function sendMessage() {
      const text = $input.value.trim();
      if (!text) return;
      socket.emit("command:send_message", { commandId: newCommandId(), text });
      $input.value = "";
      $input.style.height = "auto";
      $btnSend.disabled = true;
      showToast("Message sent", "success");
    }

    function renderAll() {
      renderConnectionStatus();
      renderAgentStatus();
      renderComposerQueue();
      renderWindows();
      renderMessages();
      renderApprovals();
      renderQuestionnaire();
      renderInputState();
      renderTabs();
      renderModeModel();
      syncPlanModalFromState();
    }

    function renderConnectionStatus() {
      const ui = getConnectionUiState();
      updateConnectionUI(ui.status, ui.label);
    }

    function updateConnectionUI(status, label) {
      $connDot.className = "dot " + status;
      const labels = {
        connected: "Connected",
        disconnected: "Disconnected",
        reconnecting: "Connecting...",
      };
      $connText.textContent = label || labels[status] || status;
    }

    function getConnectionUiState() {
      const lastError = (state.lastExtractionError || "").trim();
      const timeoutLike = /timeout/i.test(lastError);

      if (!socket.connected) {
        return {
          status: "disconnected",
          label: "Relay disconnected",
          emptyPrimary: "Waiting for relay connection...",
          emptyHint: "Check that this page can reach the CursorRemote server.",
        };
      }

      if (!state.connected) {
        return {
          status: "reconnecting",
          label: "Waiting for Cursor",
          emptyPrimary: "Connecting to Cursor IDE...",
          emptyHint:
            "Make sure Cursor is running with<br><code>--remote-debugging-port=9222</code>",
        };
      }

      if (state.extractorStatus === "stale") {
        return {
          status: "reconnecting",
          label: timeoutLike ? "Cursor backgrounded" : "Cursor stalled",
          emptyPrimary: timeoutLike
            ? "Cursor is connected but background-throttled."
            : "Cursor is connected but extraction is failing.",
          emptyHint: timeoutLike
            ? "Bring Cursor to the foreground on macOS, then wait for the next snapshot."
            : "Last extractor error:<br><code>" +
              escapeHtml(lastError || "unknown error") +
              "</code>",
        };
      }

      if (state.extractorStatus === "waiting") {
        return {
          status: "reconnecting",
          label: "Waiting for snapshot",
          emptyPrimary:
            "Connected to Cursor, waiting for the first snapshot...",
          emptyHint: lastError
            ? "Last extractor error:<br><code>" +
              escapeHtml(lastError) +
              "</code>"
            : "The relay is connected to Cursor but has not captured a fresh DOM snapshot yet.",
        };
      }

      return {
        status: "connected",
        label: "Connected",
        emptyPrimary: "No messages in this chat yet.",
        emptyHint: getWindowEmptyHint(),
      };
    }

    function getWindowEmptyHint() {
      const windows = state.windows || [];
      if (windows.length > 1) {
        return "Tap a window name above to load its chat history.";
      }
      const tabs = state.chatTabs || [];
      if (tabs.length > 1) {
        return "Tap a chat tab above to switch conversation in Cursor.";
      }
      return "Send a message below or switch chat tab / window in Cursor.";
    }

    function renderAgentStatus() {
      const icons = {
        idle: "",
        thinking: "",
        generating: "",
        running_tool: "",
        waiting_approval: "!",
        error: "\u2715",
      };
      const labels = {
        idle: "Idle",
        thinking: "Thinking...",
        generating: "Generating...",
        running_tool: "Running tool...",
        waiting_approval: "Needs approval",
        error: "Error",
      };
      $statusIcon.textContent = icons[state.agentStatus] || "";
      const activity = (state.agentActivityText || "").trim();
      const activityLive = !!state.agentActivityLive;
      const baseLabel = labels[state.agentStatus] || state.agentStatus;
      if ($headerRight) {
        if (state.agentStatus !== "idle")
          $headerRight.classList.remove("header-right-hidden");
        else $headerRight.classList.add("header-right-hidden");
      }
      if (activityLive && activity && state.agentStatus !== "idle") {
        const max = 56;
        $statusText.textContent =
          activity.length > max ? activity.slice(0, max - 1) + "…" : activity;
        $statusText.classList.add("agent-status-shimmer");
      } else {
        $statusText.textContent = baseLabel;
        $statusText.classList.remove("agent-status-shimmer");
      }

      if (state.agentStatus === "waiting_approval")
        $statusText.style.color = "var(--accent-yellow)";
      else if (state.agentStatus === "error")
        $statusText.style.color = "var(--accent-red)";
      else $statusText.style.color = "";
    }

    function renderComposerQueue() {
      const bar = document.getElementById("composer-queue-bar");
      const labelEl = document.getElementById("composer-queue-label");
      const itemsEl = document.getElementById("composer-queue-items");
      if (!bar || !labelEl || !itemsEl) return;
      const q =
        state.composerQueue && Array.isArray(state.composerQueue.items)
          ? state.composerQueue
          : { items: [] };
      if (q.items.length === 0) {
        bar.classList.add("hidden");
        itemsEl.innerHTML = "";
        return;
      }
      bar.classList.remove("hidden");
      labelEl.textContent = q.queueLabel || `${q.items.length} queued`;
      itemsEl.innerHTML = "";
      q.items.forEach((it) => {
        const row = document.createElement("div");
        row.className = "composer-queue-row";
        const dot = document.createElement("span");
        dot.className = "composer-queue-dot";
        const tx = document.createElement("span");
        tx.className = "composer-queue-text";
        tx.textContent = it.text || "";
        row.appendChild(dot);
        row.appendChild(tx);
        itemsEl.appendChild(row);
      });
    }

    // --- Message rendering ---

    function renderMessages() {
      if (state.messages.length === 0) {
        const ui = getConnectionUiState();
        $emptyState.style.display = "";
        $messages.querySelectorAll(".chat-el").forEach((el) => el.remove());
        $emptyPrimary.textContent = ui.emptyPrimary;
        $emptyHint.innerHTML = ui.emptyHint;
        return;
      }

      $emptyState.style.display = "none";

      const anchor = userScrolledUp ? captureScrollAnchor() : null;

      const existingEls = $messages.querySelectorAll(".chat-el");
      const existingIds = new Map();
      existingEls.forEach((el) => existingIds.set(el.dataset.id, el));

      const newIds = new Set(state.messages.map((m) => m.id));

      existingEls.forEach((el) => {
        if (!newIds.has(el.dataset.id)) el.remove();
      });

      state.messages.forEach((msg, index) => {
        let el = existingIds.get(msg.id);

        if (!el) {
          el = createElement(msg);
          const allEls = $messages.querySelectorAll(".chat-el");
          if (index < allEls.length) {
            $messages.insertBefore(el, allEls[index]);
          } else {
            $messages.appendChild(el);
          }
        } else if (el.dataset.msgType !== msg.type) {
          const replacement = createElement(msg);
          el.replaceWith(replacement);
          el = replacement;
        } else {
          updateElement(el, msg);
        }
      });

      if (userScrolledUp && anchor) {
        restoreScrollAnchor(anchor);
      } else if (!userScrolledUp) {
        const nestedToolScroll = $messages.querySelector(
          ".tool-collapsible-stage.is-expanded .tool-collapsible-stage-body",
        );
        const nestedScrolled =
          nestedToolScroll && nestedToolScroll.scrollTop > 8;
        if (!nestedScrolled) scheduleMessagesAutoScroll();
      }
      checkMessagesForNotifications();
    }

    function createElement(msg) {
      let el;
      switch (msg.type) {
        case "human":
          el = createHumanEl(msg);
          break;
        case "assistant":
          el = createAssistantEl(msg);
          break;
        case "tool":
          el = createToolEl(msg);
          break;
        case "thought":
          el = createThoughtEl(msg);
          break;
        case "plan":
          el = createPlanEl(msg);
          break;
        case "todo_list":
          el = createTodoListEl(msg);
          break;
        case "run_command":
          el = createRunCommandEl(msg);
          break;
        case "loading":
          el = createLoadingEl(msg);
          break;
        default:
          el = createFallbackEl(msg);
          break;
      }
      el.dataset.msgType = msg.type;
      return el;
    }

    function updateElement(el, msg) {
      switch (msg.type) {
        case "human":
          updateHumanEl(el, msg);
          break;
        case "assistant":
          updateAssistantEl(el, msg);
          break;
        case "tool":
          updateToolEl(el, msg);
          break;
        case "thought":
          updateThoughtEl(el, msg);
          break;
        case "plan":
          updatePlanEl(el, msg);
          break;
        case "todo_list":
          updateTodoListEl(el, msg);
          break;
        case "run_command":
          updateRunCommandEl(el, msg);
          break;
        case "loading":
          break;
      }
    }

    // --- Human message ---

    function createQuotedWidget(text) {
      const wrap = document.createElement("div");
      wrap.className = "quoted-widget";
      const lab = document.createElement("div");
      lab.className = "quoted-label";
      lab.textContent = "Quoted";
      const body = document.createElement("div");
      body.className = "quoted-text";
      body.textContent = text;
      wrap.appendChild(lab);
      wrap.appendChild(body);
      return wrap;
    }

    function createHumanEl(msg) {
      const el = document.createElement("div");
      el.className = "chat-el el-human";
      el.dataset.id = msg.id;

      const bubble = document.createElement("div");
      bubble.className = "human-bubble";

      if (msg.quoted && msg.quoted.text) {
        bubble.appendChild(createQuotedWidget(msg.quoted.text));
      }

      if (msg.mentions && msg.mentions.length > 0) {
        const mentionsRow = document.createElement("div");
        mentionsRow.className = "mentions-row";
        msg.mentions.forEach((m) => {
          const badge = document.createElement("span");
          badge.className = "mention-badge";
          badge.textContent = m.name;
          mentionsRow.appendChild(badge);
        });
        bubble.appendChild(mentionsRow);
      }

      const text = document.createElement("div");
      text.className = "human-text";
      text.textContent = msg.text;
      bubble.appendChild(text);
      el.appendChild(bubble);
      return el;
    }

    function updateHumanEl(el, msg) {
      const bubble = el.querySelector(".human-bubble");
      let qw = el.querySelector(".quoted-widget");
      if (msg.quoted && msg.quoted.text) {
        if (!qw && bubble) {
          qw = createQuotedWidget(msg.quoted.text);
          bubble.insertBefore(qw, bubble.firstChild);
        } else if (qw) {
          const body = qw.querySelector(".quoted-text");
          if (body) body.textContent = msg.quoted.text;
        }
      } else if (qw) {
        qw.remove();
      }
      const text = el.querySelector(".human-text");
      if (text) text.textContent = msg.text;
    }

    // --- Assistant message ---

    function serverKindToType(kind) {
      if (kind === "add") return "added";
      if (kind === "rem") return "removed";
      if (kind === "meta") return "meta";
      if (kind === "hunk") return "hunk";
      return "unchanged";
    }

    function diffTypeCss(type) {
      if (type === "added") return "add";
      if (type === "removed") return "rem";
      if (type === "meta") return "meta";
      if (type === "hunk") return "hunk";
      return "ctx";
    }

    function parseLineNumberAndCode(text) {
      const strict = text.match(/^(\s*)(\d+)(?:\s*[│|]\s*|\s+)(.*)$/);
      if (strict) return { lineNumber: strict[2], code: strict[3] };
      const loose = text.match(/^(\s*)(\d+)(?=\D)(.*)$/);
      if (loose) return { lineNumber: loose[2], code: loose[3].trimStart() };
      return null;
    }

    function parseDiffLine(line) {
      const { kind, text, lineNumber: preNum, code: preCode } = line;
      const fallbackType = serverKindToType(kind);

      if (preCode != null) {
        let marker = "";
        if (kind === "add") marker = "+";
        else if (kind === "rem") marker = "-";
        return {
          lineNumber: preNum != null ? String(preNum).trim() : "",
          type: fallbackType,
          code: preCode,
          marker,
          full: false,
        };
      }

      if (
        text.startsWith("+++ ") ||
        text.startsWith("--- ") ||
        text.startsWith("***") ||
        text.startsWith("@@")
      ) {
        return {
          lineNumber: "",
          type: text.startsWith("@@") ? "hunk" : "meta",
          code: text,
          marker: "",
          full: true,
        };
      }

      let marked = text.match(/^([+-])(\s*)(\d+)(?:\s*[│|]\s*|\s+)(.*)$/);
      if (marked) {
        return {
          lineNumber: marked[3],
          type: marked[1] === "+" ? "added" : "removed",
          code: marked[4],
          marker: marked[1],
          full: false,
        };
      }
      marked = text.match(/^([+-])(\s*)(\d+)(?=\D)(.*)$/);
      if (marked) {
        return {
          lineNumber: marked[3],
          type: marked[1] === "+" ? "added" : "removed",
          code: marked[4].trimStart(),
          marker: marked[1],
          full: false,
        };
      }

      if (text.startsWith("+") || text.startsWith("-")) {
        const marker = text[0];
        const rest = text.slice(1);
        const num = parseLineNumberAndCode(rest);
        if (num) {
          return {
            lineNumber: num.lineNumber,
            type: marker === "+" ? "added" : "removed",
            code: num.code,
            marker,
            full: false,
          };
        }
        return {
          lineNumber: "",
          type: marker === "+" ? "added" : "removed",
          code: rest,
          marker,
          full: false,
        };
      }

      if (text.startsWith(" ")) {
        const rest = text.slice(1);
        const num = parseLineNumberAndCode(rest);
        if (num) {
          return {
            lineNumber: num.lineNumber,
            type: fallbackType,
            code: num.code,
            marker: "",
            full: false,
          };
        }
        return {
          lineNumber: "",
          type: "unchanged",
          code: rest,
          marker: " ",
          full: false,
        };
      }

      const num = parseLineNumberAndCode(text);
      if (num) {
        return {
          lineNumber: num.lineNumber,
          type: fallbackType,
          code: num.code,
          marker: "",
          full: false,
        };
      }

      return {
        lineNumber: "",
        type: fallbackType,
        code: text,
        marker: "",
        full: false,
      };
    }

    function parseDiffLines(diffLines) {
      return diffLines.map((line) => ({
        ...parseDiffLine(line),
        raw: line.text,
      }));
    }

    function diffLineLayout(parsedLines) {
      let gutterCh = 0;
      let useMarker = false;
      for (const line of parsedLines) {
        if (line.full) continue;
        if (line.marker) useMarker = true;
        if (line.lineNumber.length > gutterCh)
          gutterCh = line.lineNumber.length;
      }
      if (!useMarker && gutterCh === 0) return null;
      return { marker: useMarker, gutterCh };
    }

    function appendDiffLineRow(body, parsed, layout, langHint) {
      const row = document.createElement("div");
      row.className =
        "code-block-diff-line code-block-diff-line--" +
        diffTypeCss(parsed.type);
      if (layout) {
        if (parsed.full) {
          row.classList.add("code-block-diff-line--span");
          const code = document.createElement("span");
          code.className = "code-block-diff-code";
          code.textContent = parsed.code;
          applySyntaxHighlight(code, langHint);
          row.appendChild(code);
        } else {
          if (layout.marker) {
            const marker = document.createElement("span");
            marker.className = "code-block-diff-marker";
            marker.textContent = parsed.marker;
            row.appendChild(marker);
          }
          if (layout.gutterCh > 0) {
            const gutter = document.createElement("span");
            gutter.className = "code-block-diff-gutter";
            gutter.textContent = parsed.lineNumber;
            row.appendChild(gutter);
          }
          const code = document.createElement("span");
          code.className = "code-block-diff-code";
          code.textContent = parsed.code;
          if (parsed.type !== "meta" && parsed.type !== "hunk") {
            applySyntaxHighlight(code, langHint);
          }
          row.appendChild(code);
        }
      } else {
        row.textContent = parsed.raw;
      }
      body.appendChild(row);
    }

    const HIGHLIGHT_LANG_ALIASES = {
      js: "javascript",
      ts: "typescript",
      tsx: "typescript",
      jsx: "javascript",
      py: "python",
      sh: "bash",
      shell: "bash",
      zsh: "bash",
      yml: "yaml",
      md: "markdown",
      "c#": "csharp",
      cs: "csharp",
      "c++": "cpp",
      h: "c",
      hpp: "cpp",
      rs: "rust",
      rb: "ruby",
      docker: "dockerfile",
      htm: "xml",
      html: "xml",
      svg: "xml",
    };

    const HIGHLIGHT_EXT_LANG = {
      ".ts": "typescript",
      ".tsx": "typescript",
      ".js": "javascript",
      ".jsx": "javascript",
      ".mjs": "javascript",
      ".cjs": "javascript",
      ".py": "python",
      ".sh": "bash",
      ".bash": "bash",
      ".zsh": "bash",
      ".json": "json",
      ".yaml": "yaml",
      ".yml": "yaml",
      ".md": "markdown",
      ".css": "css",
      ".scss": "css",
      ".less": "css",
      ".html": "xml",
      ".htm": "xml",
      ".xml": "xml",
      ".svg": "xml",
      ".sql": "sql",
      ".rs": "rust",
      ".go": "go",
      ".java": "java",
      ".cs": "csharp",
      ".cpp": "cpp",
      ".cc": "cpp",
      ".c": "c",
      ".h": "c",
      ".rb": "ruby",
      ".php": "php",
      ".swift": "swift",
      ".kt": "kotlin",
      ".kts": "kotlin",
      ".dockerfile": "dockerfile",
      ".lua": "lua",
      ".graphql": "graphql",
      ".gql": "graphql",
      ".toml": "ini",
      ".ini": "ini",
      ".diff": "diff",
      ".patch": "diff",
    };

    const HIGHLIGHT_AUTO_LANGS = [
      "typescript",
      "javascript",
      "python",
      "bash",
      "json",
      "yaml",
      "markdown",
      "css",
      "xml",
      "sql",
      "rust",
      "go",
      "java",
      "csharp",
      "cpp",
      "c",
      "ruby",
      "php",
    ];

    function parseLanguageClass(className) {
      const m = (className || "").match(/(?:^|\s)language-([\w#+.:-]+)/);
      return m ? m[1].toLowerCase() : "";
    }

    function normalizeHighlightLanguage(raw) {
      if (!raw) return "";
      const lang = String(raw).trim().toLowerCase();
      if (!lang || lang === "text" || lang === "plaintext" || lang === "plain")
        return "";
      return HIGHLIGHT_LANG_ALIASES[lang] || lang;
    }

    function languageFromFilename(filename) {
      if (!filename) return "";
      const lower = String(filename).toLowerCase();
      const dot = lower.lastIndexOf(".");
      if (dot < 0) {
        if (lower === "dockerfile" || lower.endsWith("/dockerfile"))
          return "dockerfile";
        if (lower === "makefile") return "bash";
        return "";
      }
      return HIGHLIGHT_EXT_LANG[lower.slice(dot)] || "";
    }

    function resolveHighlightLanguage(hints) {
      for (const hint of hints) {
        const lang = normalizeHighlightLanguage(hint);
        if (lang) return lang;
      }
      return "";
    }

    function getHljsApi() {
      if (typeof hljs === "undefined") return null;
      const api = hljs.default || hljs;
      return api?.highlight ? api : null;
    }

    function applySyntaxHighlight(codeEl, langHint) {
      const api = getHljsApi();
      if (!codeEl || !api) return;
      const text = codeEl.textContent || "";
      if (!text.trim()) return;
      const lang = resolveHighlightLanguage([
        langHint,
        parseLanguageClass(codeEl.className),
      ]);
      try {
        let result = null;
        if (lang && api.getLanguage(lang)) {
          result = api.highlight(text, {
            language: lang,
            ignoreIllegals: true,
          });
        } else {
          result = api.highlightAuto(text, HIGHLIGHT_AUTO_LANGS);
        }
        if (!result?.value) return;
        codeEl.innerHTML = result.value;
        codeEl.classList.add("hljs");
        if (result.language) {
          codeEl.classList.add(`language-${result.language}`);
        }
      } catch {
        /* keep plain text */
      }
    }

    function highlightCodeBlocksIn(root) {
      if (!root || !getHljsApi()) return;
      root.querySelectorAll("pre code").forEach((codeEl) => {
        if (codeEl.dataset.hljsApplied === "1") return;
        codeEl.dataset.hljsApplied = "1";
        applySyntaxHighlight(codeEl);
      });
    }

    /** Native code/diff from server `CodeBlockItem` (no mirrored Monaco HTML). */
    function createNativeBlockFromItem(item, filenameFallback, options) {
      const hideTitle = options?.hideTitle === true;
      const wrapper = document.createElement("div");
      wrapper.className = "code-block native-code-block";

      const title = (
        item.filename ||
        item.language ||
        filenameFallback ||
        ""
      ).trim();
      if (title && !hideTitle) {
        const toolbar = document.createElement("div");
        toolbar.className = "code-block-toolbar";
        const header = document.createElement("div");
        header.className = "code-block-header";
        header.textContent = title;
        toolbar.appendChild(header);
        wrapper.appendChild(toolbar);
      }

      const viewport = document.createElement("div");
      viewport.className = "code-block-viewport";

      const body = document.createElement("div");
      body.className = "code-block-diff-plain";
      const highlightLang = resolveHighlightLanguage([
        item.language,
        languageFromFilename(item.filename || filenameFallback),
      ]);
      if (
        item.blockKind === "diff" &&
        item.diffLines &&
        item.diffLines.length > 0
      ) {
        const parsed = parseDiffLines(item.diffLines);
        const layout = diffLineLayout(parsed);
        if (layout) {
          body.classList.add("code-block-diff-plain--gutter");
          if (layout.gutterCh > 0) {
            body.style.setProperty("--diff-gutter-ch", String(layout.gutterCh));
          }
        }
        for (const line of parsed) {
          appendDiffLineRow(body, line, layout, highlightLang);
        }
      } else {
        const pre = document.createElement("pre");
        const code = document.createElement("code");
        code.textContent = item.code || "";
        pre.appendChild(code);
        body.appendChild(pre);
        body.classList.add("code-block-diff-plain--raw");
        applySyntaxHighlight(code, highlightLang);
      }
      viewport.appendChild(body);
      wrapper.appendChild(viewport);
      return wrapper;
    }

    function appendAssistantNativeBlocks(bubble, msg) {
      if (!bubble) return;
      bubble
        .querySelectorAll(":scope > .native-code-block")
        .forEach((n) => n.remove());
      if (!msg.codeBlocks?.length) return;
      for (const item of msg.codeBlocks) {
        if (
          !item ||
          (!item.code?.trim() && !(item.diffLines && item.diffLines.length))
        )
          continue;
        bubble.appendChild(createNativeBlockFromItem(item));
      }
    }

    function createAssistantEl(msg) {
      const el = document.createElement("div");
      el.className = "chat-el el-assistant";
      el.dataset.id = msg.id;

      const bubble = document.createElement("div");
      bubble.className = "assistant-bubble";

      if (msg.html) {
        const content = document.createElement("div");
        content.className = "assistant-content markdown-body";
        content.innerHTML = sanitizeHtml(msg.html);
        normalizeMarkdownCodeBlocks(content);
        bubble.appendChild(content);
      } else {
        const content = document.createElement("div");
        content.className = "assistant-content";
        content.textContent = msg.text;
        bubble.appendChild(content);
      }

      appendAssistantNativeBlocks(bubble, msg);

      el.appendChild(bubble);
      return el;
    }

    function updateAssistantEl(el, msg) {
      const bubble = el.querySelector(".assistant-bubble");
      const content = el.querySelector(".assistant-content");
      if (!content) return;
      if (msg.html) {
        content.innerHTML = sanitizeHtml(msg.html);
        normalizeMarkdownCodeBlocks(content);
        content.classList.add("markdown-body");
      } else {
        content.textContent = msg.text;
        content.classList.remove("markdown-body");
      }
      appendAssistantNativeBlocks(bubble, msg);
    }

    // --- Tool call ---

    function setCollapsibleStageExpanded(stage, expanded) {
      stage.classList.toggle("is-expanded", expanded);
      stage.classList.toggle("is-compact", !expanded);
      const btn = stage.querySelector(".tool-diff-resize-btn");
      btn?.setAttribute("aria-expanded", expanded ? "true" : "false");
      btn?.setAttribute(
        "aria-label",
        expanded ? "Diff verkleinern" : "Diff erweitern",
      );
    }

    function createCollapsibleStage(inner) {
      const stage = document.createElement("div");
      stage.className = "tool-collapsible-stage is-compact";

      const body = document.createElement("div");
      body.className = "tool-collapsible-stage-body";
      body.appendChild(inner);
      stage.appendChild(body);

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "tool-diff-resize-btn";
      btn.setAttribute("aria-expanded", "false");
      btn.setAttribute("aria-label", "Diff erweitern");

      const chevron = document.createElement("span");
      chevron.className = "tool-diff-resize-chevron";
      chevron.setAttribute("aria-hidden", "true");
      chevron.innerHTML =
        '<svg viewBox="0 0 16 10" width="14" height="9" aria-hidden="true"><path fill="currentColor" d="M2 2l6 5 6-5"/><path fill="currentColor" d="M2 5.5l6 5 6-5"/></svg>';
      btn.appendChild(chevron);

      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const expanding = !stage.classList.contains("is-expanded");
        setCollapsibleStageExpanded(stage, expanding);
        if (expanding && stage.querySelector(".tool-diff-host")) {
          const toolCallId = stage.closest(".el-tool")?.dataset.toolCallId;
          if (toolCallId) {
            const commandId = newCommandId();
            silentCommandIds.add(commandId);
            socket.emit("command:expand_tool", { commandId, toolCallId });
          }
        }
      });

      stage.appendChild(btn);
      return stage;
    }

    function bindToolExpandHeader(header, panel) {
      header.className = "tool-expand-header tool-expand-header--interactive";
      header.setAttribute("role", "button");
      header.setAttribute("tabindex", "0");
      header.setAttribute("aria-expanded", "true");

      const onToggle = () => {
        const minimized = !panel.classList.contains("is-minimized");
        panel.classList.toggle("is-minimized", minimized);
        header.setAttribute("aria-expanded", minimized ? "false" : "true");
        if (!minimized) {
          panel
            .querySelectorAll(".tool-collapsible-stage.is-expanded")
            .forEach((stage) => setCollapsibleStageExpanded(stage, false));
        }
      };

      header.addEventListener("click", onToggle);
      header.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onToggle();
        }
      });
    }

    function captureCollapsibleStageStates(root) {
      const states = [];
      if (!root) return states;
      root.querySelectorAll(".tool-collapsible-stage").forEach((stage) => {
        states.push(stage.classList.contains("is-expanded"));
      });
      return states;
    }

    function restoreCollapsibleStageStates(root, states) {
      if (!root || !states.length) return;
      root.querySelectorAll(".tool-collapsible-stage").forEach((stage, i) => {
        if (!states[i]) return;
        setCollapsibleStageExpanded(stage, true);
      });
    }

    function captureToolNestedScroll(root) {
      const saved = [];
      if (!root) return saved;
      root.querySelectorAll(".tool-collapsible-stage-body").forEach((node) => {
        saved.push({ node, top: node.scrollTop });
      });
      return saved;
    }

    function restoreToolNestedScroll(saved) {
      for (const { node, top } of saved) {
        if (node.isConnected) node.scrollTop = top;
      }
    }

    function mountToolDiffBlock(host, item, filenameFallback) {
      const db = item;
      const key = JSON.stringify({
        bk: db.blockKind,
        c: db.code,
        d: db.diffLines,
      });
      if (host._nativeDiffKey === key) return;
      const stageBody = host.closest(".tool-collapsible-stage-body");
      const scrollTop = stageBody?.scrollTop ?? 0;
      host._nativeDiffKey = key;
      host.innerHTML = "";
      host.appendChild(
        createNativeBlockFromItem(db, filenameFallback, { hideTitle: true }),
      );
      if (stageBody) stageBody.scrollTop = scrollTop;
    }

    function fileEntryHasDiff(file) {
      const db = file?.diffBlock;
      return !!(
        db &&
        ((db.diffLines && db.diffLines.length > 0) ||
          (db.code && String(db.code).trim().length > 0))
      );
    }

    function toolHasExpandableContent(msg) {
      if (msg.output && String(msg.output).trim()) return true;
      if (msg.command && String(msg.command).trim() && msg.action === "Shell")
        return true;
      if (Array.isArray(msg.files) && msg.files.length > 0) {
        return msg.files.some((f) => fileEntryHasDiff(f));
      }
      return fileEntryHasDiff({ diffBlock: msg.diffBlock });
    }

    function toolExpandableKey(msg) {
      return JSON.stringify({
        files: msg.files,
        diffBlock: msg.diffBlock,
        output: msg.output,
        command: msg.command,
      });
    }

    function buildToolLine(msg, opts) {
      const compactHeader = opts?.compactHeader === true;
      const line = document.createElement("div");
      line.className = "tool-line " + msg.status;

      const icon = document.createElement("span");
      icon.className = "tool-icon";
      icon.textContent = msg.status === "completed" ? "\u2713" : "\u2022";
      line.appendChild(icon);

      if (!compactHeader) {
        if (msg.summaryText) {
          const summary = document.createElement("span");
          summary.className = "tool-summary";
          summary.textContent = msg.summaryText;
          line.appendChild(summary);
        } else {
          if (msg.action) {
            const action = document.createElement("span");
            action.className = "tool-action";
            action.textContent = msg.action;
            line.appendChild(action);
          }
          if (msg.details) {
            const details = document.createElement("span");
            details.className = "tool-details";
            details.textContent = msg.details;
            line.appendChild(details);
          }
        }
      }

      const fileEntries =
        Array.isArray(msg.files) && msg.files.length > 0 ? msg.files : null;
      const showFileInfo =
        fileEntries ||
        msg.filename ||
        msg.additions != null ||
        msg.deletions != null;

      if (showFileInfo) {
        const fileInfo = document.createElement("span");
        fileInfo.className = "tool-file-info";

        if (fileEntries && fileEntries.length > 1) {
          const fn = document.createElement("span");
          fn.className = "tool-filename";
          fn.textContent = `${fileEntries.length} files`;
          fileInfo.appendChild(fn);
        } else if (msg.filename) {
          const fn = document.createElement("span");
          fn.className = "tool-filename";
          fn.textContent = msg.filename;
          fileInfo.appendChild(fn);
        }

        const additions =
          msg.additions ??
          (fileEntries?.length === 1 ? fileEntries[0].additions : undefined);
        const deletions =
          msg.deletions ??
          (fileEntries?.length === 1 ? fileEntries[0].deletions : undefined);

        if (additions != null) {
          const add = document.createElement("span");
          add.className = "tool-additions";
          add.textContent = "+" + additions;
          fileInfo.appendChild(add);
        }
        if (deletions != null) {
          const del = document.createElement("span");
          del.className = "tool-deletions";
          del.textContent = "-" + deletions;
          fileInfo.appendChild(del);
        }

        line.appendChild(fileInfo);
      }

      return line;
    }

    function createToolFileEntry(file) {
      const item = document.createElement("div");
      item.className = "tool-file-entry";

      const label = document.createElement("div");
      label.className = "tool-file-label";
      const fn = document.createElement("span");
      fn.className = "tool-filename";
      fn.textContent = file.filename;
      label.appendChild(fn);
      if (file.additions != null) {
        const add = document.createElement("span");
        add.className = "tool-additions";
        add.textContent = "+" + file.additions;
        label.appendChild(add);
      }
      if (file.deletions != null) {
        const del = document.createElement("span");
        del.className = "tool-deletions";
        del.textContent = "-" + file.deletions;
        label.appendChild(del);
      }
      item.appendChild(label);

      if (fileEntryHasDiff(file)) {
        const host = document.createElement("div");
        host.className = "tool-diff-host";
        mountToolDiffBlock(host, file.diffBlock, file.filename);
        item.appendChild(createCollapsibleStage(host));
      }

      return item;
    }

    function syncToolExpandBody(content, msg) {
      if (!content) return;
      const key = toolExpandableKey(msg);
      if (content._toolExpandKey === key) return;
      const root = content.closest(".el-tool");
      const stageStates = captureCollapsibleStageStates(root);
      const scrollSaved = captureToolNestedScroll(root);
      content._toolExpandKey = key;
      content.innerHTML = "";

      if (Array.isArray(msg.files) && msg.files.length > 1) {
        const list = document.createElement("div");
        list.className = "tool-file-list";
        for (const file of msg.files) {
          list.appendChild(createToolFileEntry(file));
        }
        content.appendChild(list);
      } else if (
        Array.isArray(msg.files) &&
        msg.files.length === 1 &&
        fileEntryHasDiff(msg.files[0])
      ) {
        const host = document.createElement("div");
        host.className = "tool-diff-host";
        mountToolDiffBlock(host, msg.files[0].diffBlock, msg.files[0].filename);
        content.appendChild(createCollapsibleStage(host));
      } else if (fileEntryHasDiff({ diffBlock: msg.diffBlock })) {
        const host = document.createElement("div");
        host.className = "tool-diff-host";
        mountToolDiffBlock(host, msg.diffBlock, msg.filename);
        content.appendChild(createCollapsibleStage(host));
      }

      if (msg.command && String(msg.command).trim()) {
        const cmdWrap = document.createElement("div");
        cmdWrap.className = "tool-command-block";
        const prompt = document.createElement("span");
        prompt.className = "run-prompt";
        prompt.textContent = "$ ";
        const cmdText = document.createElement("span");
        cmdText.className = "run-command-text";
        cmdText.textContent = msg.command;
        cmdWrap.appendChild(prompt);
        cmdWrap.appendChild(cmdText);
        content.appendChild(cmdWrap);
      }

      if (msg.output && String(msg.output).trim()) {
        const out = document.createElement("pre");
        out.className = "tool-terminal-output";
        out.textContent = msg.output;
        const hasDiff =
          content.querySelector(".tool-diff-host") ||
          (Array.isArray(msg.files) &&
            msg.files.some((f) => fileEntryHasDiff(f)));
        if (hasDiff) {
          content.appendChild(out);
        } else {
          content.appendChild(createCollapsibleStage(out));
        }
      }

      restoreCollapsibleStageStates(root, stageStates);
      requestAnimationFrame(() => restoreToolNestedScroll(scrollSaved));
    }

    function syncToolDiffContent(el, msg) {
      const content = el.querySelector(".tool-expand-content");
      if (!content) return;
      const key = toolExpandableKey(msg);
      if (content._toolExpandKey !== key) {
        syncToolExpandBody(content, msg);
        return;
      }
      if (Array.isArray(msg.files) && msg.files.length > 1) {
        const entries = content.querySelectorAll(".tool-file-entry");
        msg.files.forEach((file, i) => {
          const host = entries[i]?.querySelector(".tool-diff-host");
          if (host && fileEntryHasDiff(file)) {
            mountToolDiffBlock(host, file.diffBlock, file.filename);
          }
        });
        return;
      }
      if (
        Array.isArray(msg.files) &&
        msg.files.length === 1 &&
        fileEntryHasDiff(msg.files[0])
      ) {
        const host = content.querySelector(".tool-diff-host");
        if (host) {
          mountToolDiffBlock(
            host,
            msg.files[0].diffBlock,
            msg.files[0].filename,
          );
        }
        return;
      }
      const host = content.querySelector(".tool-diff-host");
      if (host && fileEntryHasDiff({ diffBlock: msg.diffBlock })) {
        mountToolDiffBlock(host, msg.diffBlock, msg.filename);
      }
      const out = content.querySelector(".tool-terminal-output");
      if (out && msg.output && out.textContent !== msg.output) {
        const stageBody = out.closest(".tool-collapsible-stage-body");
        const scrollTop = stageBody?.scrollTop ?? 0;
        out.textContent = msg.output;
        if (stageBody) stageBody.scrollTop = scrollTop;
      }
    }

    function createToolEl(msg) {
      const el = document.createElement("div");
      el.className = "chat-el el-tool";
      el.dataset.id = msg.id;
      if (msg.toolCallId) el.dataset.toolCallId = msg.toolCallId;

      const expandable = toolHasExpandableContent(msg);
      const compactHeader = expandable && !!(msg.filename || msg.files?.length);
      const line = buildToolLine(msg, { compactHeader });

      if (expandable) {
        const panel = document.createElement("div");
        panel.className = "tool-expand-panel";

        const header = document.createElement("div");
        header.className = "tool-expand-header";
        header.appendChild(line);
        bindToolExpandHeader(header, panel);
        panel.appendChild(header);

        const content = document.createElement("div");
        content.className = "tool-expand-content";
        syncToolExpandBody(content, msg);
        panel.appendChild(content);

        el.appendChild(panel);
      } else {
        el.appendChild(line);
      }

      if (msg.actions && msg.actions.length > 0) {
        const actionsRow = document.createElement("div");
        actionsRow.className = "tool-actions-row";
        appendRunStyleActionButtons(actionsRow, msg.actions);
        el.appendChild(actionsRow);
      }

      return el;
    }

    function updateToolEl(el, msg) {
      const scrollSaved = captureToolNestedScroll(el);
      const stageStates = captureCollapsibleStageStates(el);
      if (msg.toolCallId) el.dataset.toolCallId = msg.toolCallId;

      const expandable = toolHasExpandableContent(msg);
      const compactHeader = expandable && !!(msg.filename || msg.files?.length);
      const newLine = buildToolLine(msg, { compactHeader });

      const panel = el.querySelector(".tool-expand-panel");
      const wasMinimized = panel?.classList.contains("is-minimized") ?? false;

      if (panel && expandable) {
        const lineSlot = panel.querySelector(".tool-line");
        if (lineSlot && newLine) lineSlot.replaceWith(newLine);
        syncToolDiffContent(el, msg);
        restoreCollapsibleStageStates(el, stageStates);
        if (wasMinimized) {
          panel.classList.add("is-minimized");
          panel
            .querySelector(".tool-expand-header")
            ?.setAttribute("aria-expanded", "false");
        }
      } else if (!panel && expandable) {
        const fresh = createToolEl(msg);
        const newPanel = fresh.querySelector(".tool-expand-panel");
        el.querySelector(".tool-line")?.remove();
        const actions = el.querySelector(".tool-actions-row");
        if (newPanel) {
          if (actions) el.insertBefore(newPanel, actions);
          else el.appendChild(newPanel);
        }
      } else if (panel && !expandable) {
        if (newLine) panel.replaceWith(newLine);
        else panel.remove();
      } else {
        const lineSlot = el.querySelector(".tool-line");
        if (lineSlot && newLine) lineSlot.replaceWith(newLine);
      }

      const fresh = createToolEl(msg);
      const newActions = fresh.querySelector(".tool-actions-row");
      const oldActions = el.querySelector(".tool-actions-row");
      if (newActions && oldActions) {
        el.replaceChild(newActions, oldActions);
      } else if (newActions && !oldActions) {
        el.appendChild(newActions);
      } else if (!newActions && oldActions) {
        oldActions.remove();
      }

      requestAnimationFrame(() => restoreToolNestedScroll(scrollSaved));
    }

    // --- Thought block ---

    function formatThoughtLine(msg) {
      const dur = (msg.duration || "").trim();
      const detail = (msg.detail || "").trim();
      if (msg.thoughtKind === "step_summary") {
        const a = (msg.action || "").trim();
        return detail ? `${a || "Steps"} — ${detail}` : a || "Steps";
      }
      if (msg.thoughtKind === "thinking_step") {
        const a = (msg.action || "").trim();
        if (dur) return `${a || "Step"} · ${dur}`;
        if (a) {
          if (/^thought$/i.test(a)) return "Thought";
          if (/ing$/i.test(a)) return `${a.replace(/\.\.\.?$/, "")}…`;
          return a;
        }
        return "Thinking…";
      }
      if (dur) return `Thought for ${dur}`;
      const action = (msg.action || "").trim();
      if (action) {
        if (/^thought$/i.test(action)) return "Thought";
        if (/ing$/i.test(action)) return `${action.replace(/\.\.\.?$/, "")}…`;
        return action;
      }
      return "Thinking…";
    }

    function syncThoughtLineClasses(inner, msg) {
      inner.classList.remove("thought-line-summary", "thought-line-step");
      if (msg.thoughtKind === "step_summary")
        inner.classList.add("thought-line-summary");
      else if (msg.thoughtKind === "thinking_step")
        inner.classList.add("thought-line-step");
    }

    function createThoughtEl(msg) {
      const el = document.createElement("div");
      el.className = "chat-el el-thought";
      el.dataset.id = msg.id;

      const inner = document.createElement("div");
      inner.className = "thought-line";
      syncThoughtLineClasses(inner, msg);
      inner.textContent = formatThoughtLine(msg);
      el.appendChild(inner);
      return el;
    }

    function updateThoughtEl(el, msg) {
      const inner = el.querySelector(".thought-line");
      if (inner) {
        syncThoughtLineClasses(inner, msg);
        inner.textContent = formatThoughtLine(msg);
      }
    }

    // --- Plan block ---

    function emitClickAction(selectorPath) {
      socket.emit("command:click_action", {
        commandId: newCommandId(),
        selectorPath,
      });
    }

    function buildPlanFullContent(planData) {
      const content = document.createElement("div");
      content.className = "plan-card plan-card-modal";

      if (Array.isArray(planData.todos) && planData.todos.length > 0) {
        const completed = planData.todos.filter(
          (todo) => todo.status === "completed",
        ).length;
        const summary = document.createElement("div");
        summary.className = "plan-progress";
        summary.textContent = `To-dos ${completed}/${planData.todos.length}`;
        content.appendChild(summary);

        const todoList = document.createElement("div");
        todoList.className = "plan-todo-list";
        planData.todos.forEach((todo) => {
          const item = document.createElement("div");
          item.className = "plan-todo-item";
          const dot = document.createElement("span");
          dot.className = "plan-todo-dot plan-todo-" + todo.status;
          item.appendChild(dot);
          const text = document.createElement("span");
          text.className = "plan-todo-text";
          text.textContent = todo.text;
          item.appendChild(text);
          todoList.appendChild(item);
        });
        content.appendChild(todoList);
      }

      if (planData.bodyHtml) {
        const body = document.createElement("div");
        body.className = "plan-description markdown-body";
        body.innerHTML = sanitizeHtml(planData.bodyHtml);
        normalizeMarkdownCodeBlocks(body);
        content.appendChild(body);
      }

      return content;
    }

    function buildPlanModalContent(msg, planData) {
      if (planData) return buildPlanFullContent(planData);
      const modalMsg = {
        ...msg,
        actions: Array.isArray(msg.actions)
          ? msg.actions.filter((action) => action.type !== "view_plan")
          : msg.actions,
      };
      const content = buildPlanCard(modalMsg);
      content.classList.add("plan-card-modal");
      return content;
    }

    function renderPlanModal(msg) {
      if (!msg) return;
      $planModalLabel.textContent = msg.label || "";
      $planModalLabel.style.display = msg.label ? "" : "none";
      $planModalTitle.textContent = msg.title || "Plan";
      $planModalBody.innerHTML = "";
      $planModalBody.appendChild(
        buildPlanModalContent(msg, activePlanModal && activePlanModal.fullData),
      );
    }

    async function loadFullPlanIntoModal(msg) {
      if (!msg.label || !activePlanModal || activePlanModal.id !== msg.id)
        return;
      activePlanModal.loading = true;
      const result = await sendCommandAwaitResult("command:get_plan_full", {
        commandId: newCommandId(),
        type: "get_plan_full",
        planLabel: msg.label,
      });
      if (!activePlanModal || activePlanModal.id !== msg.id) return;
      activePlanModal.loading = false;
      if (!result.ok || !result.data) return;
      activePlanModal.fullData = result.data;
      renderPlanModal(msg);
    }

    function openPlanModal(msg) {
      activePlanModal = {
        id: msg.id,
        label: msg.label || "",
        fullData: null,
        loading: false,
      };
      renderPlanModal(msg);
      $planModalOverlay.classList.remove("hidden");
      loadFullPlanIntoModal(msg);
    }

    function closePlanModal() {
      activePlanModal = null;
      $planModalOverlay.classList.add("hidden");
    }

    function syncPlanModalFromState() {
      if (!activePlanModal) return;
      const current = (state.messages || []).find(
        (msg) => msg.type === "plan" && msg.id === activePlanModal.id,
      );
      if (current) {
        renderPlanModal(current);
        if (
          current.label &&
          !activePlanModal.fullData &&
          !activePlanModal.loading
        ) {
          loadFullPlanIntoModal(current);
        }
      }
    }

    async function openPlanModelPicker(msg) {
      if (!msg.modelDropdownSelectorPath) {
        if (msg.model) showToast(`Plan model: ${msg.model}`, "success");
        return;
      }

      const commandId = newCommandId();
      const result = await sendCommandAwaitResult(
        "command:get_plan_model_options",
        {
          commandId,
          type: "get_plan_model_options",
          selectorPath: msg.modelDropdownSelectorPath,
        },
      );

      const options = Array.isArray(result.data?.options)
        ? result.data.options
        : [];
      if (!result.ok || options.length === 0) {
        emitClickAction(msg.modelDropdownSelectorPath);
        if (!result.ok)
          showToast(result.error || "Could not load plan models", "error");
        return;
      }

      activePlanModelContext = {
        selectorPath: msg.modelDropdownSelectorPath,
        title: msg.title || "Plan",
        options,
      };
      openSheet("plan-model");
    }

    function buildPlanCard(msg) {
      const card = document.createElement("div");
      card.className = "plan-card plan-card-widget";

      if (msg.label) {
        const header = document.createElement("div");
        header.className = "plan-widget-header";
        const icon = document.createElement("span");
        icon.className = "plan-widget-icon";
        icon.setAttribute("aria-hidden", "true");
        icon.textContent = "\u2712";
        const fn = document.createElement("span");
        fn.className = "plan-widget-filename";
        fn.textContent = msg.label;
        header.appendChild(icon);
        header.appendChild(fn);
        card.appendChild(header);
      }

      const title = document.createElement("div");
      title.className = "plan-title";
      title.textContent = msg.title;
      card.appendChild(title);

      if (msg.descriptionHtml) {
        const desc = document.createElement("div");
        desc.className = "plan-description markdown-body";
        desc.innerHTML = sanitizeHtml(msg.descriptionHtml);
        normalizeMarkdownCodeBlocks(desc);
        card.appendChild(desc);
      } else if (msg.description) {
        const desc = document.createElement("div");
        desc.className = "plan-description";
        desc.textContent = msg.description;
        card.appendChild(desc);
      }

      if (msg.todos && msg.todos.length > 0) {
        const todoList = document.createElement("div");
        todoList.className = "plan-todo-list";
        msg.todos.forEach((todo) => {
          const item = document.createElement("div");
          item.className = "plan-todo-item";
          const dot = document.createElement("span");
          dot.className = "plan-todo-dot plan-todo-" + todo.status;
          item.appendChild(dot);
          const text = document.createElement("span");
          text.className = "plan-todo-text";
          text.textContent = todo.text;
          item.appendChild(text);
          todoList.appendChild(item);
        });
        card.appendChild(todoList);
      }

      if (msg.todosMoreCount && msg.todosMoreCount > 0) {
        const more = document.createElement("div");
        more.className = "plan-todos-more";
        more.textContent = `${msg.todosMoreCount} more`;
        card.appendChild(more);
      }

      if (msg.todosTotal > 0) {
        const progress = document.createElement("div");
        progress.className = "plan-progress";
        const track = document.createElement("div");
        track.className = "plan-progress-track";
        const bar = document.createElement("div");
        bar.className = "plan-progress-bar";
        const pct = Math.round((msg.todosCompleted / msg.todosTotal) * 100);
        bar.style.width = pct + "%";
        track.appendChild(bar);
        progress.appendChild(track);
        const progressText = document.createElement("span");
        progressText.className = "plan-progress-text";
        progressText.textContent = msg.todosCompleted + "/" + msg.todosTotal;
        progress.appendChild(progressText);
        card.appendChild(progress);
      }

      const hasActions =
        (msg.actions && msg.actions.length > 0) ||
        msg.modelDropdownSelectorPath ||
        msg.model;
      if (hasActions) {
        const toolbar = document.createElement("div");
        toolbar.className = "plan-actions-toolbar";

        const left = document.createElement("div");
        left.className = "plan-actions-left";
        if (msg.actions) {
          const viewAct = msg.actions.find((a) => a.type === "view_plan");
          if (viewAct) {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "plan-btn plan-btn-view";
            btn.textContent = viewAct.label || "View Plan";
            btn.addEventListener("click", () => openPlanModal(msg));
            left.appendChild(btn);
          }
        }
        toolbar.appendChild(left);

        const center = document.createElement("div");
        center.className = "plan-actions-center";
        if (msg.modelDropdownSelectorPath) {
          const pill = document.createElement("button");
          pill.type = "button";
          pill.className = "plan-model-pill";
          const lab = document.createElement("span");
          lab.className = "plan-model-pill-text";
          lab.textContent = msg.model || "Model";
          const chev = document.createElement("span");
          chev.className = "plan-model-pill-chev";
          chev.textContent = "\u25BE";
          pill.appendChild(lab);
          pill.appendChild(chev);
          pill.addEventListener("click", () => {
            void openPlanModelPicker(msg);
          });
          center.appendChild(pill);
        } else if (msg.model) {
          const badge = document.createElement("span");
          badge.className = "plan-model-badge-inline";
          badge.textContent = msg.model;
          center.appendChild(badge);
        }
        toolbar.appendChild(center);

        const right = document.createElement("div");
        right.className = "plan-actions-right";
        if (msg.actions) {
          const buildAct = msg.actions.find((a) => a.type === "build");
          if (buildAct) {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "plan-btn plan-btn-build";
            btn.textContent = buildAct.label || "Build";
            btn.addEventListener("click", () =>
              emitClickAction(buildAct.selectorPath),
            );
            right.appendChild(btn);
          }
        }
        toolbar.appendChild(right);
        card.appendChild(toolbar);
      }

      return card;
    }

    function createPlanEl(msg) {
      const el = document.createElement("div");
      el.className = "chat-el el-plan";
      el.dataset.id = msg.id;
      el.appendChild(buildPlanCard(msg));
      return el;
    }

    function updatePlanEl(el, msg) {
      const oldCard = el.querySelector(".plan-card");
      if (oldCard) el.replaceChild(buildPlanCard(msg), oldCard);
    }

    // --- Standalone todo list (matches Telegram §3.9) ---

    function createTodoListEl(msg) {
      const el = document.createElement("div");
      el.className = "chat-el el-todo-list";
      el.dataset.id = msg.id;
      const card = document.createElement("div");
      card.className = "todo-list-card";
      const head = document.createElement("div");
      head.className = "todo-list-card-title";
      head.textContent = `${msg.title} (${msg.todosCompleted}/${msg.todosTotal})`;
      card.appendChild(head);
      const list = document.createElement("div");
      list.className = "todo-list-card-items";
      msg.todos.forEach((todo) => {
        const row = document.createElement("div");
        row.className = "todo-list-card-row";
        const icon = document.createElement("span");
        icon.className = "todo-list-card-icon";
        icon.textContent =
          todo.status === "completed"
            ? "✅"
            : todo.status === "in_progress"
              ? "🔵"
              : "⚪";
        const tx = document.createElement("span");
        tx.className = "todo-list-card-text";
        tx.textContent = todo.text;
        row.appendChild(icon);
        row.appendChild(tx);
        list.appendChild(row);
      });
      card.appendChild(list);
      el.appendChild(card);
      return el;
    }

    function updateTodoListEl(el, msg) {
      const fresh = createTodoListEl(msg);
      const newCard = fresh.querySelector(".todo-list-card");
      const oldCard = el.querySelector(".todo-list-card");
      if (newCard && oldCard) el.replaceChild(newCard, oldCard);
    }

    // --- Run command / tool inline actions (Skip, Run, Allow) ---

    function appendRunStyleActionButtons(container, actions) {
      actions.forEach(function (action) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className =
          action.type === "run"
            ? "run-btn run-btn-run"
            : action.type === "allow"
              ? "run-btn run-btn-allow"
              : "run-btn run-btn-skip";
        btn.textContent = action.label;
        btn.addEventListener("click", function () {
          socket.emit("command:click_action", {
            commandId: newCommandId(),
            selectorPath: action.selectorPath,
          });
        });
        container.appendChild(btn);
      });
    }

    function createRunCommandEl(msg) {
      const el = document.createElement("div");
      el.className = "chat-el el-run-command";
      el.dataset.id = msg.id;

      const card = document.createElement("div");
      card.className = "run-card";

      const header = document.createElement("div");
      header.className = "run-header";
      const desc = document.createElement("span");
      desc.className = "run-description";
      desc.textContent = msg.description;
      header.appendChild(desc);
      if (msg.candidates) {
        const cand = document.createElement("span");
        cand.className = "run-candidates";
        cand.textContent = " " + msg.candidates;
        header.appendChild(cand);
      }
      card.appendChild(header);

      const hasOutput = msg.output && String(msg.output).trim();
      const body = document.createElement("div");
      body.className = "run-expand-body";

      const cmdBlock = document.createElement("div");
      cmdBlock.className = "run-command-block";
      const prompt = document.createElement("span");
      prompt.className = "run-prompt";
      prompt.textContent = "$ ";
      cmdBlock.appendChild(prompt);
      const cmdText = document.createElement("span");
      cmdText.className = "run-command-text";
      cmdText.textContent = msg.command;
      cmdBlock.appendChild(cmdText);
      body.appendChild(cmdBlock);

      if (hasOutput) {
        const out = document.createElement("pre");
        out.className = "run-terminal-output";
        out.textContent = msg.output;
        body.appendChild(out);
      }

      if (hasOutput) {
        const panel = document.createElement("div");
        panel.className = "run-expand-panel is-open";

        const toggle = document.createElement("button");
        toggle.type = "button";
        toggle.className = "run-expand-toggle";
        toggle.setAttribute("aria-expanded", "true");

        const chevron = document.createElement("span");
        chevron.className = "run-expand-chevron";
        chevron.setAttribute("aria-hidden", "true");
        chevron.textContent = "\u25BE";

        const label = document.createElement("span");
        label.className = "run-expand-label";
        label.textContent = "Command output";

        toggle.appendChild(chevron);
        toggle.appendChild(label);
        toggle.addEventListener("click", () => {
          const open = panel.classList.toggle("is-open");
          toggle.setAttribute("aria-expanded", open ? "true" : "false");
        });

        panel.appendChild(toggle);
        panel.appendChild(body);
        card.appendChild(panel);
      } else {
        card.appendChild(body);
      }

      if (msg.actions && msg.actions.length > 0) {
        const actionsRow = document.createElement("div");
        actionsRow.className = "run-actions-row";
        appendRunStyleActionButtons(actionsRow, msg.actions);
        card.appendChild(actionsRow);
      }

      el.appendChild(card);
      return el;
    }

    function updateRunCommandEl(el, msg) {
      const wasOpen =
        el.querySelector(".run-expand-panel")?.classList.contains("is-open") ??
        true;
      const oldCommand = (
        el.querySelector(".run-command-text")?.textContent || ""
      ).trim();
      const nextMsg =
        (!msg.command || !msg.command.trim()) && oldCommand
          ? { ...msg, command: oldCommand }
          : msg;
      const fresh = createRunCommandEl(nextMsg);
      const newCard = fresh.querySelector(".run-card");
      const oldCard = el.querySelector(".run-card");
      if (newCard && oldCard) {
        oldCard.replaceWith(newCard);
        if (!wasOpen) {
          const panel = el.querySelector(".run-expand-panel");
          panel?.classList.remove("is-open");
          panel
            ?.querySelector(".run-expand-toggle")
            ?.setAttribute("aria-expanded", "false");
        }
      }
    }

    // --- Loading indicator ---

    function createLoadingEl(msg) {
      const el = document.createElement("div");
      el.className = "chat-el el-loading";
      el.dataset.id = msg.id;

      const dots = document.createElement("div");
      dots.className = "loading-dots";
      for (let i = 0; i < 3; i++) {
        const dot = document.createElement("span");
        dot.className = "dot-anim";
        dots.appendChild(dot);
      }
      el.appendChild(dots);
      return el;
    }

    // --- Fallback ---

    function createFallbackEl(msg) {
      const el = document.createElement("div");
      el.className = "chat-el el-fallback";
      el.dataset.id = msg.id;
      el.textContent = msg.text || msg.type || "...";
      return el;
    }

    // --- Sanitize HTML (strip scripts, event handlers) ---

    function sanitizeHtml(html) {
      const tmp = document.createElement("div");
      tmp.innerHTML = html;
      tmp
        .querySelectorAll("script, iframe, object, embed, form")
        .forEach((el) => el.remove());
      tmp
        .querySelectorAll(
          ".composer-message-codeblock, .composer-code-block-container, .ui-code-block",
        )
        .forEach((el) => el.remove());
      tmp.querySelectorAll("*").forEach((el) => {
        for (const attr of Array.from(el.attributes)) {
          if (attr.name.startsWith("on") || attr.name === "srcdoc") {
            el.removeAttribute(attr.name);
          }
        }
        if (el.tagName === "A") {
          el.setAttribute("target", "_blank");
          el.setAttribute("rel", "noopener noreferrer");
        }
      });
      return tmp.innerHTML;
    }

    function normalizeMarkdownCodeBlocks(root) {
      if (!root) return;
      function extractStructuredCodeText(el) {
        let out = "";
        function walk(node) {
          if (!node) return;
          if (node.nodeType === Node.TEXT_NODE) {
            out += node.textContent || "";
            return;
          }
          if (node.nodeType !== Node.ELEMENT_NODE) return;
          const tag = (node.tagName || "").toLowerCase();
          if (tag === "br") {
            out += "\n";
            return;
          }
          const before = out.length;
          node.childNodes.forEach(walk);
          const isLineLike =
            tag === "div" ||
            tag === "p" ||
            tag === "li" ||
            node.matches?.("[data-line], .line");
          if (isLineLike && out.length > before && !out.endsWith("\n")) {
            out += "\n";
          }
        }
        walk(el);
        return out
          .replace(/\n{3,}/g, "\n\n")
          .replace(/\s+\n/g, "\n")
          .trimEnd();
      }

      root.querySelectorAll("code").forEach((codeEl) => {
        if (codeEl.closest("pre")) return;
        if (
          codeEl.className.includes("md-inline-") ||
          codeEl.closest("p, li, a, h1, h2, h3, h4, h5, h6")
        ) {
          return;
        }

        const text = extractStructuredCodeText(codeEl);
        const looksBlockLike =
          text.includes("\n") ||
          !!codeEl.querySelector("br,[data-line],.line,div,p") ||
          /(?:^|\s)(?:language-|shiki)/.test(codeEl.className);
        if (!looksBlockLike) return;

        const pre = document.createElement("pre");
        const code = document.createElement("code");
        code.className = codeEl.className || "";
        code.textContent = text;
        pre.appendChild(code);
        codeEl.replaceWith(pre);
      });
      highlightCodeBlocksIn(root);
    }

    // --- Approvals ---

    function sanitizeApprovalLabel(label, fallback) {
      if (!label || typeof label !== "string") return fallback;
      const trimmed = label.trim();
      if (!trimmed || trimmed.length > 80) return fallback;
      if (/\n\s*at\s+/.test(trimmed)) return fallback;
      if (/node_modules[/\\]/.test(trimmed)) return fallback;
      if (/file:\/\/\//.test(trimmed)) return fallback;
      return trimmed;
    }

    function renderApprovals() {
      if (state.pendingApprovals.length > 0) {
        $approvalBar.classList.remove("hidden");
        const approval = state.pendingApprovals[0];
        $approvalDesc.textContent = sanitizeApprovalLabel(
          approval.description,
          "Action needs approval",
        );

        const approveAction = approval.actions.find(
          (a) => a.type === "approve" || a.type === "approve_all",
        );
        const rejectAction = approval.actions.find((a) => a.type === "reject");

        $btnApprove.disabled = !approveAction;
        $btnReject.disabled = !rejectAction;
        if (approveAction)
          $btnApprove.textContent = sanitizeApprovalLabel(
            approveAction.label,
            approveAction.type === "approve_all" ? "Accept All" : "Accept",
          );
        if (rejectAction)
          $btnReject.textContent = sanitizeApprovalLabel(
            rejectAction.label,
            "Reject",
          );

        fireNotification(
          sanitizeApprovalLabel(approval.description, "Agent needs approval"),
          "cursor-approval",
        );
      } else {
        $approvalBar.classList.add("hidden");
      }
    }

    function renderQuestionnaire() {
      var q = state.questionnaire;
      if (!q || !q.questions || q.questions.length === 0) {
        $questionnaireBar.classList.add("hidden");
        questionnaireSelections = {};
        return;
      }
      $questionnaireBar.classList.remove("hidden");
      $questionnaireStepper.textContent = q.totalLabel || "";
      $btnQContinue.disabled = q.continueDisabled;

      $questionnaireQuestions.innerHTML = "";
      for (var i = 0; i < q.questions.length; i++) {
        var question = q.questions[i];
        var qDiv = document.createElement("div");
        qDiv.className =
          "questionnaire-question" +
          (question.isActive ? " questionnaire-question-active" : "");

        var labelDiv = document.createElement("div");
        labelDiv.className = "questionnaire-question-label";
        var numSpan = document.createElement("span");
        numSpan.className = "questionnaire-question-number";
        numSpan.textContent = question.number;
        var textSpan = document.createElement("span");
        textSpan.textContent = question.text;
        labelDiv.appendChild(numSpan);
        labelDiv.appendChild(textSpan);
        qDiv.appendChild(labelDiv);

        var optionsDiv = document.createElement("div");
        optionsDiv.className = "questionnaire-options";
        for (var j = 0; j < question.options.length; j++) {
          var opt = question.options[j];
          var optBtn = document.createElement("button");
          var isSelected =
            questionnaireSelections[question.number] === opt.letter;
          optBtn.className =
            "questionnaire-option" +
            (isSelected ? " questionnaire-option-selected" : "");
          var letterSpan = document.createElement("span");
          letterSpan.className = "questionnaire-option-letter";
          letterSpan.textContent = opt.letter + ")";
          var labelSpan = document.createElement("span");
          labelSpan.textContent = " " + opt.label;
          optBtn.appendChild(letterSpan);
          optBtn.appendChild(labelSpan);
          optBtn.dataset.selectorPath = opt.selectorPath;
          optBtn.dataset.questionNumber = question.number;
          optBtn.dataset.letter = opt.letter;
          optBtn.addEventListener("click", function () {
            questionnaireSelections[this.dataset.questionNumber] =
              this.dataset.letter;
            var siblings = this.parentNode.querySelectorAll(
              ".questionnaire-option",
            );
            for (var s = 0; s < siblings.length; s++)
              siblings[s].classList.remove("questionnaire-option-selected");
            this.classList.add("questionnaire-option-selected");
            socket.emit("command:click_action", {
              commandId: newCommandId(),
              selectorPath: this.dataset.selectorPath,
            });
            showToast("Answer sent", "success");
          });
          optionsDiv.appendChild(optBtn);
        }
        qDiv.appendChild(optionsDiv);
        $questionnaireQuestions.appendChild(qDiv);
      }

      fireNotification("Agent has questions for you", "cursor-questionnaire");
    }

    function renderInputState() {
      $input.disabled = !state.inputAvailable && !state.connected;
      $btnSend.disabled = !$input.value.trim() || $input.disabled;
    }

    function fireNotification(text, tag) {
      if (document.hasFocus()) return;
      if (typeof Notification === "undefined") return;
      var ntag = tag || "cursor-agent";
      if (notificationPermission === "default") {
        Notification.requestPermission().then(function (perm) {
          notificationPermission = perm;
          if (perm === "granted")
            new Notification("CursorRemote", { body: text, tag: ntag });
        });
      } else if (notificationPermission === "granted") {
        new Notification("CursorRemote", { body: text, tag: ntag });
      }
    }

    function checkMessagesForNotifications() {
      if (document.hasFocus()) return;
      state.messages.forEach(function (msg) {
        if (notifiedMessageIds.has(msg.id)) return;
        var text = null;

        if (
          msg.type === "run_command" &&
          msg.actions &&
          msg.actions.length > 0
        ) {
          text =
            (msg.description || "Run command") +
            ": " +
            (msg.command || "").substring(0, 80);
        } else if (
          msg.type === "tool" &&
          msg.actions &&
          msg.actions.length > 0
        ) {
          var detail = msg.details || msg.filename || "";
          text =
            (msg.action || "Tool") +
            (detail ? " " + detail : "") +
            " needs approval";
        }

        if (text) {
          notifiedMessageIds.add(msg.id);
          fireNotification(text, "cursor-action-" + msg.id);
        }
      });
    }

    // --- Window rendering ---

    function renderWindows() {
      const windows = state.windows || [];
      if (windows.length <= 1) {
        $windowBar.classList.add("hidden");
        return;
      }
      $windowBar.classList.remove("hidden");

      const existingBtns = $windowList.querySelectorAll(".window-item");
      const existingMap = new Map();
      existingBtns.forEach((b) => existingMap.set(b.dataset.id, b));

      const newIds = new Set(windows.map((w) => w.id));
      existingBtns.forEach((b) => {
        if (!newIds.has(b.dataset.id)) b.remove();
      });

      windows.forEach((win) => {
        let btn = existingMap.get(win.id);
        if (!btn) {
          btn = document.createElement("button");
          btn.className = "window-item";
          btn.dataset.id = win.id;
          btn.addEventListener("click", () => {
            socket.emit("command:switch_window", {
              commandId: newCommandId(),
              windowId: win.id,
            });
            showToast("Switching window...", "success");
          });
          $windowList.appendChild(btn);
        }

        const isActive = win.id === state.activeWindowId;
        btn.className = "window-item" + (isActive ? " active" : "");
        btn.textContent = win.title || "Cursor";
      });
    }

    // --- Tab rendering ---

    function renderTabs() {
      const tabs = state.chatTabs || [];
      if (tabs.length <= 1) {
        $tabBar.classList.add("hidden");
        return;
      }
      $tabBar.classList.remove("hidden");

      const existingBtns = $tabList.querySelectorAll(".tab-item");
      const existingMap = new Map();
      existingBtns.forEach((b) => existingMap.set(b.dataset.title, b));

      const newTitles = new Set(tabs.map((t) => t.title));
      existingBtns.forEach((b) => {
        if (!newTitles.has(b.dataset.title)) b.remove();
      });

      tabs.forEach((tab, i) => {
        let btn = existingMap.get(tab.title);
        if (!btn) {
          btn = document.createElement("button");
          btn.className = "tab-item";
          btn.dataset.title = tab.title;
          btn.addEventListener("click", () => {
            if (!tab.isActive) resetMessagesView();
            socket.emit("command:switch_tab", {
              commandId: newCommandId(),
              tabTitle: tab.title,
              selectorPath: tab.selectorPath,
            });
          });
          $tabList.appendChild(btn);
        }

        btn.className = "tab-item" + (tab.isActive ? " active" : "");
        btn.textContent = tab.title || `Chat ${i + 1}`;
      });
    }

    function escapeHtml(str) {
      const div = document.createElement("div");
      div.textContent = str;
      return div.innerHTML;
    }

    // --- Mode / Model rendering ---

    const MODE_ICONS = {
      agent: "\u221E",
      plan: "\u2611",
      debug: "\uD83D\uDC1B",
      chat: "\uD83D\uDCAC",
    };

    const MODE_LABELS = {
      agent: "Agent",
      plan: "Plan",
      debug: "Debug",
      chat: "Ask",
    };

    function renderModeModel() {
      const mode = state.mode || { current: "agent", available: [] };
      const model = state.model || { current: "Auto", currentId: "" };

      $pillModeIcon.textContent = MODE_ICONS[mode.current] || "";
      $pillModeText.textContent = MODE_LABELS[mode.current] || mode.current;
      $pillModelText.textContent = model.current || "Auto";
    }

    renderAll();

    // --- Bottom sheet logic ---

    let activeSheet = null;

    function openSheet(type) {
      closeSheet();
      activeSheet = type;
      $sheetOverlay.classList.remove("hidden");

      if (type === "mode") {
        $sheetMode.classList.remove("hidden");
        renderModeSheet();
      } else if (type === "model") {
        $sheetModel.classList.remove("hidden");
        if (cachedModelOptions) {
          renderModelSheet(cachedModelOptions);
        } else {
          renderModelSheetLoading();
        }
        fetchModelOptions().then((options) => {
          if (activeSheet !== "model") return;
          if (options) {
            renderModelSheet(options);
          } else if (!cachedModelOptions) {
            renderModelSheet(null);
          }
        });
      } else if (type === "plan-model") {
        $sheetPlanModel.classList.remove("hidden");
        renderPlanModelSheet();
      }
    }

    function closeSheet() {
      $sheetOverlay.classList.add("hidden");
      $sheetMode.classList.add("hidden");
      $sheetModel.classList.add("hidden");
      $sheetPlanModel.classList.add("hidden");
      activeSheet = null;
    }

    function renderModeSheet() {
      $sheetModeList.innerHTML = "";
      const modes = [
        { id: "agent", label: "Agent", icon: "\u221E" },
        { id: "plan", label: "Plan", icon: "\u2611" },
        { id: "debug", label: "Debug", icon: "\uD83D\uDC1B" },
        { id: "chat", label: "Ask", icon: "\uD83D\uDCAC" },
      ];
      const current = (state.mode || {}).current || "agent";

      modes.forEach((m) => {
        const btn = document.createElement("button");
        btn.className = "sheet-item" + (m.id === current ? " selected" : "");
        btn.innerHTML =
          `<span class="sheet-item-icon">${m.icon}</span>` +
          `<span>${escapeHtml(m.label)}</span>` +
          (m.id === current
            ? '<span class="sheet-item-check">\u2713</span>'
            : "");
        btn.addEventListener("click", () => {
          socket.emit("command:set_mode", {
            commandId: newCommandId(),
            modeId: m.id,
          });
          closeSheet();
          showToast(`Mode: ${m.label}`, "success");
        });
        $sheetModeList.appendChild(btn);
      });
    }

    let cachedModelOptions = null;

    async function fetchModelOptions() {
      const commandId = newCommandId();
      const result = await sendCommandAwaitResult("command:get_model_options", {
        commandId,
        type: "get_model_options",
      });
      if (result.ok && Array.isArray(result.data?.options)) {
        cachedModelOptions = result.data.options;
        return result.data.options;
      }
      return null;
    }

    function renderModelSheet(options) {
      $sheetModelList.innerHTML = "";

      if (!options || options.length === 0) {
        const empty = document.createElement("div");
        empty.className = "sheet-empty";
        empty.textContent = "No models available";
        $sheetModelList.appendChild(empty);
        return;
      }

      const currentId = (state.model || {}).currentId || "";
      const currentName = ((state.model || {}).current || "").toLowerCase();

      options.forEach((opt) => {
        const isSelected =
          (currentId && opt.id === currentId) ||
          opt.selected ||
          currentName === opt.label.toLowerCase();
        const btn = document.createElement("button");
        btn.className = "sheet-item" + (isSelected ? " selected" : "");

        let inner =
          '<span class="sheet-item-label">' + escapeHtml(opt.label) + "</span>";
        const right = [];
        if (isSelected)
          right.push('<span class="sheet-item-check">\u2713</span>');
        inner += '<span class="sheet-item-right">' + right.join("") + "</span>";

        btn.innerHTML = inner;
        btn.addEventListener("click", () => {
          socket.emit("command:set_model", {
            commandId: newCommandId(),
            modelId: opt.id,
          });
          closeSheet();
          showToast(`Model: ${opt.label}`, "success");
        });
        $sheetModelList.appendChild(btn);
      });
    }

    function renderModelSheetLoading() {
      $sheetModelList.innerHTML = "";
      const loading = document.createElement("div");
      loading.className = "sheet-loading";
      loading.textContent = "Loading models…";
      $sheetModelList.appendChild(loading);
    }

    function renderPlanModelSheet() {
      $sheetPlanModelList.innerHTML = "";
      const ctx = activePlanModelContext;
      $sheetPlanModelHeader.textContent =
        ctx && ctx.title ? `Plan Model · ${ctx.title}` : "Plan Model";
      if (!ctx || !Array.isArray(ctx.options) || ctx.options.length === 0)
        return;

      ctx.options.forEach((opt) => {
        const btn = document.createElement("button");
        btn.className = "sheet-item" + (opt.selected ? " selected" : "");
        btn.innerHTML =
          `<span class="sheet-item-label">${escapeHtml(opt.label)}</span>` +
          `<span class="sheet-item-right">${opt.selected ? '<span class="sheet-item-check">\u2713</span>' : ""}</span>`;
        btn.addEventListener("click", async () => {
          const result = await sendCommandAwaitResult(
            "command:set_plan_model",
            {
              commandId: newCommandId(),
              type: "set_plan_model",
              selectorPath: ctx.selectorPath,
              planModelId: opt.id,
            },
          );
          if (!result.ok) {
            showToast(result.error || "Could not set plan model", "error");
            return;
          }
          closeSheet();
          showToast(`Plan model: ${opt.label}`, "success");
        });
        $sheetPlanModelList.appendChild(btn);
      });
    }

    function showToast(message, type) {
      const toast = document.createElement("div");
      toast.className = "toast " + (type || "");
      toast.textContent = message;
      $toastContainer.appendChild(toast);
      setTimeout(() => {
        toast.style.opacity = "0";
        toast.style.transition = "opacity 0.3s";
        setTimeout(() => toast.remove(), 300);
      }, 3000);
    }
  } // end bootstrap

  init();
})();
