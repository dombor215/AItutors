(() => {
  "use strict";

  // ==========================================================
  // Configuration and application state
  // ==========================================================

  const PB_URL = POCKETBASE_URL.trim().replace(/\/+$/, "");
  const DATABASE_MODE = Boolean(PB_URL);

  const USERS_PATH =
    "/api/collections/" +
    encodeURIComponent(POCKETBASE_USERS_COLLECTION);

  const RECORDS_PATH =
    "/api/collections/" +
    encodeURIComponent(POCKETBASE_CONVERSATIONS_COLLECTION) +
    "/records";

  // Keep below the PocketBase JSON field limit configured below.
  const MAX_CHAT_BYTES = 40 * 1024 * 1024;

  let auth = null;             // Memory only; login again after reload.
  let currentRecord = null;
  let ready = false;
  let dirty = false;
  let awaitingReply = false;
  let attachmentJobs = 0;
  let localNumber = -1;
  let historyPage = 1;
  let historyPages = 1;

  let tools;
  let statusEl;
  let threadEl;
  let newChatBtn;
  let loginBtn;
  let logoutBtn;
  let retrySaveBtn;
  let historySelect;
  let openHistoryBtn;
  let olderHistoryBtn;
  let loginDialog;
  let loginForm;
  let importInput;

  const nowISO = () => new Date().toISOString();

  function makeId() {
    return crypto.randomUUID();
  }

  function makeRecordId() {
    const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
    const bytes = crypto.getRandomValues(new Uint8Array(15));

    return Array.from(bytes, n => alphabet[n % alphabet.length]).join("");
  }

  function numberLabel(number) {
    return String(number).padStart(CHAT_NUMBER_PADDING, "0");
  }

  function setStatus(text) {
    if (statusEl) statusEl.textContent = text;
  }

  function usable() {
    return ready && !isProcessing && attachmentJobs === 0;
  }

  function mayAttach() {
    return usable() && !awaitingReply;
  }

  function markDirty() {
    dirty = true;

    setStatus(
      DATABASE_MODE
        ? "Changes not yet saved."
        : "Not saved to a database. Download a copy before leaving."
    );

    updateUI();
  }

  // ==========================================================
  // Rendering safety
  // ==========================================================

  const originalMarkdown = renderMarkdown;
  const originalUserRenderer = renderUserContent;

  function escapeText(text) {
    const element = document.createElement("div");
    element.textContent = String(text);
    return element.innerHTML;
  }

  renderMarkdown = function(text) {
    if (!window.DOMPurify) {
      // Fail closed if the sanitizer failed to load.
      return escapeText(text);
    }

    try {
      return DOMPurify.sanitize(originalMarkdown(String(text)), {
        USE_PROFILES: { html: true },
        FORBID_TAGS: ["img", "style", "form", "input", "button"],
        FORBID_ATTR: ["style"]
      });
    } catch {
      return escapeText(text);
    }
  };

  renderUserContent = function(text) {
    try {
      return originalUserRenderer(String(text));
    } catch {
      return escapeText(text);
    }
  };

  // ==========================================================
  // HTTP
  // ==========================================================

  async function fetchJSON(url, options = {}, timeout = 30000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal
      });

      const text = await response.text();

      let data = {};
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        throw new Error(
          `Server returned a non-JSON response (HTTP ${response.status}).`
        );
      }

      if (!response.ok) {
        const detail =
          data.error?.message ||
          data.message ||
          response.statusText ||
          "Request failed";

        const error = new Error(`HTTP ${response.status}: ${detail}`);
        error.status = response.status;
        error.details = data.data;
        throw error;
      }

      return data;
    } catch (error) {
      if (error.name === "AbortError") {
        throw new Error("The request timed out. Please try again.");
      }

      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  function pbRequest(path, method = "GET", body) {
    if (!auth?.token) {
      throw new Error("Please log in first.");
    }

    return fetchJSON(PB_URL + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: auth.token
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
  }

  function scopeFilter() {
    return (
      `user = ${JSON.stringify(auth.record.id)}` +
      ` && origin = ${JSON.stringify(CHAT_ORIGIN)}`
    );
  }

  function listRecords({
    page = 1,
    perPage = 30,
    sort = "-updated,-id",
    fields = "id,user,origin,number,title,created,updated"
  } = {}) {
    const query = new URLSearchParams({
      page: String(page),
      perPage: String(perPage),
      sort,
      filter: scopeFilter(),
      fields
    });

    return pbRequest(`${RECORDS_PATH}?${query}`);
  }

  // ==========================================================
  // Shared conversation JSON
  // ==========================================================

  function collectChat() {
    return {
      version: 2,
      origin: CHAT_ORIGIN,
      chatNumber: currentRecord?.number ?? 0,
      sessionStartTime,
      exportTime: nowISO(),
      awaitingReply,
      messages: messages.map(message => {
        const { wasPasted, ...rest } = message;
        return rest;
      })
    };
  }

  // Available for your viewer/debugging code if needed.
  window.collectChat = collectChat;

  function checkSize(document) {
    if (
      new Blob([JSON.stringify(document)]).size > MAX_CHAT_BYTES
    ) {
      throw new Error(
        "This conversation exceeds the 40 MiB storage limit. " +
        "Download a copy before leaving."
      );
    }
  }

  function safeImageURL(value) {
    return (
      typeof value === "string" &&
      (
        /^data:image\/[a-z0-9.+-]+;base64,/i.test(value) ||
        /^https:\/\//i.test(value)
      )
    );
  }

  function validateConversation(value) {
    const source = Array.isArray(value) ? value : value?.messages;

    if (!Array.isArray(source) || source.length === 0) {
      throw new Error("The file does not contain a conversation.");
    }

    if (source.length > 20000) {
      throw new Error("The conversation contains too many messages.");
    }

    const seenIds = new Set();

    const validated = source.map((message, index) => {
      if (
        !message ||
        !["system", "user", "assistant"].includes(message.role)
      ) {
        throw new Error(`Invalid role in message ${index + 1}.`);
      }

      const content = message.content;

      if (typeof content !== "string") {
        if (
          !Array.isArray(content) ||
          !content.every(part => {
            if (!part || typeof part !== "object") return false;

            if (part.type === "text") {
              return typeof part.text === "string";
            }

            if (part.type === "image_url") {
              return safeImageURL(part.image_url?.url);
            }

            return false;
          })
        ) {
          throw new Error(`Invalid content in message ${index + 1}.`);
        }
      }

      let id = message.id;

      if (typeof id !== "string" || !id || seenIds.has(id)) {
        id = makeId();
      }

      seenIds.add(id);

      return {
        ...message,
        id,
        deleted: message.deleted === true
      };
    });

    const result = {
      sessionStartTime:
        typeof value?.sessionStartTime === "string"
          ? value.sessionStartTime
          : nowISO(),
      awaitingReply: value?.awaitingReply === true,
      messages: validated
    };

    checkSize(result);
    return result;
  }

  function freshConversation() {
    const timestamp = nowISO();

    const initial = [{
      id: makeId(),
      role: "system",
      content: CONTENT_USER,
      timestamp
    }];

    if (FIRST_MESSAGE) {
      initial.push({
        id: makeId(),
        role: "assistant",
        content: FIRST_MESSAGE,
        timestamp
      });
    }

    return {
      sessionStartTime: timestamp,
      awaitingReply: false,
      messages: initial
    };
  }

  function textFromMessage(message) {
    if (typeof message.content === "string") {
      return message.content;
    }

    return message.content
      .filter(part => part.type === "text")
      .map(part => part.text)
      .join("\n");
  }

  function conversationTitle(document) {
    const first = document.messages.find(
      message => message.role === "user" && !message.deleted
    );

    if (!first) return "New conversation";

    const text =
      typeof first.displayText === "string"
        ? first.displayText
        : textFromMessage(first);

    return text.trim().replace(/\s+/g, " ").slice(0, 120) ||
      "Conversation with attachment";
  }

  function installConversation(document, record) {
    messages = document.messages;
    sessionStartTime = document.sessionStartTime;
    currentRecord = record;
    awaitingReply = document.awaitingReply === true;

    const lastVisible = messages.filter(
      message => !message.deleted && message.role !== "system"
    ).at(-1);

    // Do not resume a request unless the history actually ends
    // with an unanswered user message.
    awaitingReply =
      awaitingReply && lastVisible?.role === "user";

    dirty = false;
    ready = true;
    pastedInCurrentInput = false;

    input.value = "";
    input.style.height = "auto";
    clearAttachments();

    renderConversation();
    updateUI();
  }

  // ==========================================================
  // Display and soft deletion
  // ==========================================================

  function renderConversation() {
    if (window.MathJax?.typesetClear) {
      MathJax.typesetClear([chatBox]);
    }

    chatBox.replaceChildren();

    for (const message of messages) {
      if (message.role === "system" || message.deleted) continue;

      const contentParts = Array.isArray(message.content)
        ? message.content
        : [];

      const imageParts = contentParts.filter(
        part => part.type === "image_url"
      );

      const metadata = Array.isArray(message.fileNames)
        ? message.fileNames
        : [];

      let imageIndex = 0;

      const attachments = metadata.map(file => {
        const isImage = file?.isImage === true;
        const image = isImage ? imageParts[imageIndex++] : null;

        return {
          name: String(file?.name || "Attachment"),
          isImage,
          dataUrl: image?.image_url?.url || null
        };
      });

      // Older exports do not contain attachment name metadata.
      for (; imageIndex < imageParts.length; imageIndex++) {
        attachments.push({
          name: `Image ${imageIndex + 1}`,
          isImage: true,
          dataUrl: imageParts[imageIndex].image_url.url
        });
      }

      const displayedText =
        typeof message.displayText === "string"
          ? message.displayText
          : textFromMessage(message);

      const element = addMessage(
        displayedText,
        message.role === "user" ? "user" : "bot",
        attachments,
        message.timestamp || null
      );

      if (allowDelete) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "tutor-delete";
        button.textContent = "🗑 Delete";
        button.title = "Hide this message, retaining it in the saved history";

        button.addEventListener("click", () => {
          run(async () => {
            if (!ready || !allowDelete) return;
            if (!confirm("Delete this message from the visible conversation?")) {
              return;
            }

            message.deleted = true;
            message.deletedAt = nowISO();

            const lastVisible = messages.filter(
              item => !item.deleted && item.role !== "system"
            ).at(-1);

            if (lastVisible?.role !== "user") {
              awaitingReply = false;
            }

            markDirty();
            renderConversation();
            await saveCurrent();
          });
        });

        element.appendChild(button);
      }
    }

    updateUI();
  }

  // ==========================================================
  // Database saving and thread creation
  // ==========================================================

  async function saveCurrent() {
    if (!DATABASE_MODE) return;
    if (!dirty) return;

    if (!currentRecord?.id) {
      throw new Error("No database conversation is open.");
    }

    const document = collectChat();
    checkSize(document);

    setStatus("Saving…");

    const saved = await pbRequest(
      `${RECORDS_PATH}/${encodeURIComponent(currentRecord.id)}`,
      "PATCH",
      {
        title: conversationTitle(document),
        conversation: document
      }
    );

    currentRecord = saved;
    dirty = false;

    setStatus("✓ Saved to your account.");
    updateUI();
  }

  async function createRecord(document) {
    checkSize(document);

    // Reuse this ID while retrying creation. A lost HTTP response
    // can then be checked without creating another copy.
    const id = makeRecordId();

    for (let attempt = 0; attempt < 4; attempt++) {
      const highest = await listRecords({
        perPage: 1,
        sort: "-number",
        fields: "id,number"
      });

      const number = highest.items.length
        ? Number(highest.items[0].number) + 1
        : 0;

      const payload = {
        id,
        user: auth.record.id,
        origin: CHAT_ORIGIN,
        number,
        title: conversationTitle(document),
        conversation: {
          ...document,
          version: 2,
          origin: CHAT_ORIGIN,
          chatNumber: number
        }
      };

      try {
        return await pbRequest(RECORDS_PATH, "POST", payload);
      } catch (error) {
        // The create might have succeeded even if its response
        // was lost.
        try {
          const existing = await pbRequest(`${RECORDS_PATH}/${id}`);

          if (
            existing.user === auth.record.id &&
            existing.origin === CHAT_ORIGIN
          ) {
            return existing;
          }
        } catch {
          // No readable record with this ID.
        }

        // A simultaneous new-thread request may have taken the
        // same number. The unique index prevents duplicate numbers.
        if (error.status !== 400 || attempt === 3) {
          throw error;
        }
      }
    }

    throw new Error("Could not allocate a conversation number.");
  }

  async function startConversation(document) {
    if (DATABASE_MODE) {
      setStatus("Creating conversation…");

      // Do not replace the open conversation until creation succeeds.
      const record = await createRecord(document);
      const stored = validateConversation(record.conversation);

      installConversation(stored, record);
      setStatus("✓ Saved to your account.");

      await refreshHistorySafely();
    } else {
      localNumber++;

      installConversation(document, {
        number: localNumber,
        id: null
      });

      setStatus("Standalone mode — save using 💾.");
    }
  }

  async function loadRecord(id) {
    const record = await pbRequest(
      `${RECORDS_PATH}/${encodeURIComponent(id)}`
    );

    if (
      record.user !== auth.record.id ||
      record.origin !== CHAT_ORIGIN
    ) {
      throw new Error("This conversation does not belong to this activity.");
    }

    const document = validateConversation(record.conversation);
    installConversation(document, record);

    setStatus("✓ Conversation restored.");
  }

  async function restoreLatest() {
    setStatus("Loading your latest conversation…");

    const latest = await listRecords({
      perPage: 1,
      fields: "id"
    });

    if (latest.items.length) {
      await loadRecord(latest.items[0].id);
    } else {
      await startConversation(freshConversation());
    }

    await refreshHistorySafely();
  }

  // ==========================================================
  // Conversation browser
  // ==========================================================

  async function refreshHistory(append = false) {
    if (!DATABASE_MODE || !showConversationBrowser || !auth) return;

    if (!append) historyPage = 1;

    const result = await listRecords({ page: historyPage });

    historyPages = result.totalPages;

    if (!append) {
      historySelect.replaceChildren();

      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = "Choose a saved conversation";
      historySelect.appendChild(placeholder);
    }

    for (const record of result.items) {
      if (
        Array.from(historySelect.options).some(
          option => option.value === record.id
        )
      ) {
        continue;
      }

      const option = document.createElement("option");
      option.value = record.id;
      option.textContent =
        `${numberLabel(record.number)} — ${record.title || "Conversation"}`;

      historySelect.appendChild(option);
    }

    if (
      currentRecord?.id &&
      Array.from(historySelect.options).some(
        option => option.value === currentRecord.id
      )
    ) {
      historySelect.value = currentRecord.id;
    }

    updateUI();
  }

  async function refreshHistorySafely() {
    try {
      await refreshHistory();
    } catch (error) {
      console.warn("History browser failed:", error);
      showToast("Conversation is open, but the history list could not refresh.");
    }
  }

  // ==========================================================
  // Navigation safeguards
  // ==========================================================

  async function mayLeaveConversation() {
    if (DATABASE_MODE && dirty) {
      // A failed save throws, preventing the switch.
      await saveCurrent();
    }

    const hasDraft = Boolean(input.value.trim() || attachedFiles.length);

    if (hasDraft) {
      return confirm(
        "The unsent text or attachments will be discarded. Continue?"
      );
    }

    if (!DATABASE_MODE && dirty) {
      return confirm(
        "This conversation has not been exported since its last change. " +
        "Continue and replace it?"
      );
    }

    return true;
  }

  window.addEventListener("beforeunload", event => {
    if (
      dirty ||
      isProcessing ||
      attachmentJobs ||
      input.value.trim() ||
      attachedFiles.length
    ) {
      event.preventDefault();
      event.returnValue = "";
    }
  });

  // ==========================================================
  // Login/logout
  // ==========================================================

  async function submitLogin(event) {
    event.preventDefault();

    await run(async () => {
      const identity = loginForm.elements.identity.value.trim();
      const password = loginForm.elements.password.value;

      if (!identity || !password) {
        throw new Error("Enter your username/email and password.");
      }

      let result;

      try {
        result = await fetchJSON(
          PB_URL + USERS_PATH + "/auth-with-password",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ identity, password })
          }
        );
      } finally {
        loginForm.elements.password.value = "";
      }

      if (!result.token || !result.record?.id) {
        throw new Error("The login response was incomplete.");
      }

      if (auth && auth.record.id !== result.record.id) {
        throw new Error(
          "Log out before switching to another pupil account."
        );
      }

      auth = result;

      // Reauthentication preserves the current in-memory history.
      if (currentRecord) {
        await saveCurrent();
        setStatus("✓ Logged in.");
      } else {
        await restoreLatest();
      }

      loginDialog.close();
    });
  }

  async function logout() {
    if (!await mayLeaveConversation()) return;

    auth = null;
    currentRecord = null;
    ready = false;
    dirty = false;
    awaitingReply = false;
    messages = [];

    input.value = "";
    pastedInCurrentInput = false;
    clearAttachments();
    chatBox.replaceChildren();
    historySelect.replaceChildren();

    setStatus("Logged out. Log in to continue.");
    updateUI();
  }

  // ==========================================================
  // API key and AI requests
  // ==========================================================

  window.setApiKey = function() {
    if (DATABASE_MODE) return;

    const key = prompt("Enter key:");

    if (key?.trim()) {
      localStorage.setItem("api_key", key.trim());
      showToast("✓ Key saved.");
    }
  };

  function getApiKey() {
    if (DATABASE_MODE) {
      return API_FIRST_PART.trim() || null;
    }

    const suffix = localStorage.getItem("api_key");

    return suffix
      ? API_FIRST_PART + suffix
      : null;
  }

  function buildUserContent(text, attachments) {
    if (!attachments.length) return text;

    const textParts = text ? [text] : [];

    for (const attachment of attachments) {
      if (!attachment.isImage && attachment.textContent) {
        textParts.push(
          `\n\n--- File: ${attachment.name} ---\n` +
          attachment.textContent +
          `\n--- End of ${attachment.name} ---`
        );
      }
    }

    const result = [];

    if (textParts.length) {
      result.push({ type: "text", text: textParts.join("") });
    } else {
      result.push({ type: "text", text: "?" });
    }

    for (const attachment of attachments) {
      if (attachment.isImage && attachment.dataUrl) {
        result.push({
          type: "image_url",
          image_url: { url: attachment.dataUrl }
        });
      }
    }

    return result;
  }

  function collectApiMessages() {
    return [
      // Always use the teacher's current prompt.
      // Imported system messages remain in the archive but
      // cannot replace this configuration.
      { role: "system", content: CONTENT_USER },

      ...messages
        .filter(message =>
          !message.deleted &&
          ["user", "assistant"].includes(message.role)
        )
        .map(message => ({
          role: message.role,
          content: message.content
        }))
    ];
  }

  window.sendMessage = async function() {
    if (!usable()) return;

    await run(async () => {
      const key = getApiKey();

      if (!key) {
        throw new Error(
          DATABASE_MODE
            ? "The AI endpoint credential has not been configured."
            : "Please insert the key using 🔑."
        );
      }

      if (!awaitingReply) {
        const text = input.value.trim();

        if (attachedFiles.some(file => file.processing)) {
          throw new Error("Files are still being processed.");
        }

        if (!text && !attachedFiles.length) return;

        const attachments = [...attachedFiles];
        const timestamp = nowISO();
        const content = buildUserContent(text, attachments);

        const token = await generatePasteToken(
          timestamp,
          content,
          pastedInCurrentInput
        );

        messages.push({
          id: makeId(),
          role: "user",
          content,
          displayText: text,
          fileNames: attachments.map(file => ({
            name: file.name,
            isImage: file.isImage
          })),
          timestamp,
          token,
          wasPasted: pastedInCurrentInput
        });

        awaitingReply = true;
        pastedInCurrentInput = false;

        input.value = "";
        input.style.height = "auto";
        clearAttachments();

        markDirty();
        renderConversation();
      }

      // Save the user's message before making the AI request.
      // If this fails, the next send retries without adding it again.
      await saveCurrent();

      currentTypingEl = addProcessingMessage();
      setStatus("Waiting for the AI…");

      try {
        const response = await fetchJSON(
          API_URL,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${key}`
            },
            body: JSON.stringify({
              model: MODEL_NAME,
              messages: collectApiMessages()
            })
          },
          120000
        );

        const reply = response.choices?.[0]?.message?.content;

        if (typeof reply !== "string" || !reply.trim()) {
          throw new Error("The AI returned no text response.");
        }

        messages.push({
          id: makeId(),
          role: "assistant",
          content: reply,
          timestamp: nowISO()
        });

        awaitingReply = false;
        markDirty();

        // Save the complete response, not a partial typing animation.
        await saveCurrent();
      } finally {
        currentTypingEl?.remove();
        currentTypingEl = null;
        renderConversation();
      }
    });
  };

  // ==========================================================
  // Import/export
  // ==========================================================

  function exportConversation() {
    if (!allowExport || !ready || isProcessing) return;

    const blob = new Blob(
      [JSON.stringify(collectChat(), null, 2)],
      { type: "application/json" }
    );

    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");

    const safeOrigin = CHAT_ORIGIN.replace(/[^a-z0-9_-]/gi, "_");

    anchor.href = url;
    anchor.download =
      `${safeOrigin}_${numberLabel(currentRecord?.number ?? 0)}_` +
      `${nowISO().replace(/[:.]/g, "-")}.json`;

    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();

    setTimeout(() => URL.revokeObjectURL(url), 1000);

    // Exporting does not resolve a failed database save.
    if (!DATABASE_MODE) dirty = false;

    showToast("Conversation download started.");
    updateUI();
  }

  async function importConversation(file) {
    if (!allowImport || !ready) return;

    if (file.size > MAX_CHAT_BYTES) {
      throw new Error("The import file exceeds 40 MiB.");
    }

    const parsed = JSON.parse(await file.text());
    const document = validateConversation(parsed);

    if (!await mayLeaveConversation()) return;

    // In database mode this creates a new record and saves it
    // before replacing the currently displayed thread.
    await startConversation(document);

    showToast("✓ Conversation imported.");
  }

  // ==========================================================
  // Feature guards for existing upload and drawing functions
  // ==========================================================

  const originalProcessAndAttach = processAndAttach;

  processAndAttach = async function(file) {
    if (!allowAttachments || !mayAttach()) return;

    attachmentJobs++;
    updateUI();

    try {
      await originalProcessAndAttach(file);
    } catch (error) {
      showToast(`Attachment failed: ${error.message}`);
    } finally {
      attachmentJobs--;
      updateUI();
    }
  };

  const originalOpenDrawModal = openDrawModal;
  const originalAttachDrawing = attachDrawing;
  const originalSendDrawing = sendDrawing;

  openDrawModal = function() {
    if (allowDrawing && mayAttach()) {
      originalOpenDrawModal();
    }
  };

  attachDrawing = function() {
    if (allowDrawing && mayAttach()) {
      originalAttachDrawing();
    }
  };

  sendDrawing = function() {
    if (allowDrawing && mayAttach()) {
      originalSendDrawing();
    }
  };

  // Stop the existing global image-paste handler when attachments
  // are unavailable. Normal text pasting is unaffected.
  document.addEventListener("paste", event => {
    const containsImage = Array.from(
      event.clipboardData?.items || []
    ).some(item => item.type.startsWith("image/"));

    if (containsImage && (!allowAttachments || !mayAttach())) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  }, true);

  for (const eventName of [
    "dragenter", "dragover", "dragleave", "drop"
  ]) {
    document.addEventListener(eventName, event => {
      if (!allowAttachments || !mayAttach()) {
        event.preventDefault();
        event.stopImmediatePropagation();

        dragCounter = 0;
        document.getElementById("dropOverlay")
          .classList.remove("active");
      }
    }, true);
  }

  // ==========================================================
  // Operation lock and UI state
  // ==========================================================

  async function run(operation) {
    if (isProcessing || attachmentJobs) return;

    isProcessing = true;
    updateUI();

    try {
      await operation();
    } catch (error) {
      console.error(error);

      const suffix = DATABASE_MODE && dirty
        ? " Changes remain in this tab; use Retry save."
        : awaitingReply
          ? " Use ↻ to retry the AI response."
          : "";

      setStatus(`⚠ ${error.message}${suffix}`);
      showToast(error.message, 6000);
    } finally {
      isProcessing = false;
      updateUI();
    }
  }

  function updateUI() {
    if (!tools) return;

    const busy = isProcessing || attachmentJobs > 0;
    const locked = !ready || busy;

    sendBtn.disabled = locked;
    sendBtn.textContent = awaitingReply ? "↻" : "➤";
    sendBtn.title = awaitingReply
      ? "Retry the unanswered request"
      : "Send message";

    input.disabled = locked || awaitingReply;

    attachBtn.hidden = !allowAttachments;
    attachBtn.disabled = locked || awaitingReply;

    drawBtn.hidden = !allowDrawing;
    drawBtn.disabled = locked || awaitingReply;

    document.getElementById("apiBtn").hidden = DATABASE_MODE;

    const exportBtn = document.getElementById("exportBtn");
    exportBtn.hidden = !allowExport;
    exportBtn.disabled = locked;

    const importBtn = document.getElementById("importBtn");
    importBtn.hidden = !allowImport;
    importBtn.disabled = locked;

    newChatBtn.hidden = !allowNewChat;
    newChatBtn.disabled = locked;

    loginBtn.hidden = !DATABASE_MODE;
    loginBtn.disabled = busy;
    loginBtn.textContent = auth ? "Log in again" : "Log in";

    logoutBtn.hidden = !DATABASE_MODE || !auth;
    logoutBtn.disabled = busy;

    retrySaveBtn.hidden = !DATABASE_MODE || !dirty;
    retrySaveBtn.disabled = locked;

    const browse = DATABASE_MODE && showConversationBrowser;

    historySelect.hidden = !browse;
    openHistoryBtn.hidden = !browse;
    olderHistoryBtn.hidden = !browse || historyPage >= historyPages;

    historySelect.disabled = locked;
    openHistoryBtn.disabled = locked || !historySelect.value;
    olderHistoryBtn.disabled = locked;

    loginForm.querySelector('button[type="submit"]').disabled = busy;

    document.querySelectorAll(".tutor-delete").forEach(button => {
      button.disabled = locked;
    });

    document.querySelectorAll(".att-remove").forEach(button => {
      button.disabled = busy;
    });

    threadEl.textContent = currentRecord
      ? `Chat ${numberLabel(currentRecord.number)}`
      : "";

    document.querySelector(".upload-hint").hidden = !allowAttachments;
  }

  // ==========================================================
  // Create controls and initialize
  // ==========================================================

  function createButton(text, action) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = text;
    button.addEventListener("click", action);
    tools.appendChild(button);
    return button;
  }

  function buildUI() {
    const style = document.createElement("style");

    style.textContent = `
      [hidden] {
        display: none !important;
      }

      #tutorTools {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 6px;
        padding: 8px 12px;
        background: white;
        border-bottom: 1px solid #ddd;
        flex-shrink: 0;
      }

      #tutorTools button,
      #tutorLogin button,
      .tutor-delete {
        flex: initial;
        min-width: auto;
        max-width: none;
        height: auto;
        padding: 7px 10px;
        font-size: 12px;
      }

      #tutorTools select {
        min-width: 0;
        max-width: 280px;
        padding: 7px;
        border: 1px solid #ccc;
        border-radius: 6px;
      }

      #tutorStatus {
        width: 100%;
        color: #555;
        font-size: 12px;
        overflow-wrap: anywhere;
      }

      #tutorThread {
        font-size: 13px;
        font-weight: 700;
      }

      .tutor-delete {
        display: block;
        margin-top: 10px;
        background: #eee;
        color: #555;
        box-shadow: none;
      }

      #tutorLogin {
        width: min(92vw, 380px);
        border: none;
        border-radius: 12px;
        padding: 22px;
      }

      #tutorLogin::backdrop {
        background: rgba(0, 0, 0, .55);
      }

      #tutorLogin form {
        display: grid;
        gap: 12px;
      }

      #tutorLogin label {
        display: grid;
        gap: 5px;
      }

      #tutorLogin input {
        width: 100%;
        padding: 10px;
        border: 1px solid #bbb;
        border-radius: 6px;
        font: inherit;
        font-size: 16px;
      }
    `;

    document.head.appendChild(style);

    tools = document.createElement("div");
    tools.id = "tutorTools";
    document.getElementById("pageHeader").after(tools);

    threadEl = document.createElement("span");
    threadEl.id = "tutorThread";
    tools.appendChild(threadEl);

    newChatBtn = createButton("＋ New chat", () => {
      run(async () => {
        if (!allowNewChat || !ready) return;
        if (!await mayLeaveConversation()) return;
        await startConversation(freshConversation());
      });
    });

    historySelect = document.createElement("select");
    historySelect.setAttribute("aria-label", "Saved conversations");
    historySelect.addEventListener("change", updateUI);
    tools.appendChild(historySelect);

    openHistoryBtn = createButton("Open", () => {
      run(async () => {
        const id = historySelect.value;
        if (!id || !showConversationBrowser) return;
        if (!await mayLeaveConversation()) return;
        await loadRecord(id);
      });
    });

    olderHistoryBtn = createButton("Load older", () => {
      run(async () => {
        historyPage++;

        try {
          await refreshHistory(true);
        } catch (error) {
          historyPage--;
          throw error;
        }
      });
    });

    loginBtn = createButton("Log in", () => loginDialog.showModal());
    logoutBtn = createButton("Log out", () => run(logout));
    retrySaveBtn = createButton("Retry save", () => run(saveCurrent));

    statusEl = document.createElement("div");
    statusEl.id = "tutorStatus";
    statusEl.setAttribute("role", "status");
    statusEl.setAttribute("aria-live", "polite");
    tools.appendChild(statusEl);

    loginDialog = document.createElement("dialog");
    loginDialog.id = "tutorLogin";

    // Static markup only; pupil-provided values are never interpolated.
    loginDialog.innerHTML = `
      <form>
        <strong>Pupil login</strong>

        <label>
          Username or email
          <input name="identity" autocomplete="username" required>
        </label>

        <label>
          Password
          <input
            name="password"
            type="password"
            autocomplete="current-password"
            required
          >
        </label>

        <button type="submit">Log in</button>
        <button type="button" data-close>Cancel</button>
      </form>
    `;

    document.body.appendChild(loginDialog);

    loginForm = loginDialog.querySelector("form");
    loginForm.addEventListener("submit", submitLogin);

    loginDialog.querySelector("[data-close]")
      .addEventListener("click", () => loginDialog.close());

    loginDialog.addEventListener("close", () => {
      loginForm.elements.password.value = "";
    });

    importInput = document.createElement("input");
    importInput.type = "file";
    importInput.accept = ".json,application/json";
    document.body.appendChild(importInput);

    importInput.addEventListener("change", () => {
      const file = importInput.files[0];
      importInput.value = "";

      if (file) run(() => importConversation(file));
    });

    document.getElementById("exportBtn")
      .addEventListener("click", exportConversation);

    document.getElementById("importBtn")
      .addEventListener("click", () => {
        if (allowImport && usable()) importInput.click();
      });
  }

  window.addEventListener("DOMContentLoaded", async () => {
    buildUI();
    initDrawCanvas();
    updateUI();

    if (!window.isSecureContext || !crypto.subtle || !crypto.randomUUID) {
      setStatus(
        "This application requires HTTPS or localhost. " +
        "Please open it from a secure web server."
      );
      return;
    }

    if (!window.DOMPurify) {
      setStatus(
        "The HTML sanitizer did not load. " +
        "Check the script connection and reload."
      );
      return;
    }

    if (DATABASE_MODE) {
      if (FIRST_MESSAGE) {
        addMessage(FIRST_MESSAGE, "bot", null, nowISO());
      }

      setStatus("Log in to restore your conversation.");
      loginDialog.showModal();
    } else {
      await run(() => startConversation(freshConversation()));
    }
  });
})();