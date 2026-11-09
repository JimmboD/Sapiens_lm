(() => {
  "use strict";

  // ========================================================================
  // DOM Elements
  // ========================================================================
  const $ = (id) => document.getElementById(id);

  const sidebar = $("sidebar");
  const sidebarOverlay = $("sidebarOverlay");
  const toggleSidebarBtn = $("toggleSidebarBtn");
  const newChatBtn = $("newChatBtn");
  const chatSearchInput = $("chatSearchInput");
  const chatList = $("chatList");

  const unloadRamBtn = $("unloadRamBtn");
  const ramBarFill = $("ramBarFill");
  const ramUsageText = $("ramUsageText");
  const ramPercentText = $("ramPercentText");
  const ramLoadedName = $("ramLoadedName");
  const memoryStatusHint = $("memoryStatusHint");

  const modelSelect = $("modelSelect");
  const modelCategory = $("modelCategory");
  const modelPickerTrigger = $("modelPickerTrigger");
  const modelPickerLabel = $("modelPickerLabel");
  const modelPickerMenu = $("modelPickerMenu");
  const activeChatTitle = $("activeChatTitle");
  const heroModelName = $("heroModelName");

  const chatScroll = $("chatScroll");
  const thread = $("thread");
  const hero = $("hero");
  const starterCards = $("starterCards");

  const composerForm = $("composerForm");
  const composerInput = $("composerInput");
  const sendBtn = $("sendBtn");

  // ========================================================================
  // State
  // ========================================================================
  const STORAGE_KEY = "sapiens_chats_v2";
  const PREF_MODEL_KEY = "sapiens_pref_model";

  let models = [];
  let currentChatId = null;
  let chats = [];
  let abortController = null;
  let statusPollTimer = null;

  // ========================================================================
  // Markdown & Formatting
  // ========================================================================
  const esc = (s) =>
    (s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function inlineMd(str) {
    return esc(str)
      .replace(/`([^`\n]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
      .replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
  }

  function renderMarkdown(src) {
    if (!src) return "";
    const out = [];
    const parts = src.split(/```/);

    parts.forEach((part, i) => {
      // Bloque de código
      if (i % 2 === 1) {
        const firstLineEnd = part.indexOf("\n");
        let lang = "";
        let codeBody = part;
        if (firstLineEnd !== -1) {
          lang = part.slice(0, firstLineEnd).trim();
          codeBody = part.slice(firstLineEnd + 1);
        }
        codeBody = codeBody.replace(/\n$/, "");
        out.push(
          `<pre><button class="btn-copy-code" type="button" aria-label="Copiar código">copiar</button><code>${esc(codeBody)}</code></pre>`
        );
        return;
      }

      // Párrafos y listas
      let listType = null;
      const closeList = () => {
        if (listType) {
          out.push(`</${listType}>`);
          listType = null;
        }
      };

      const blocks = part.split(/\n{2,}/);
      for (const block of blocks) {
        const lines = block.split("\n");
        let textBuf = [];

        const flushText = () => {
          if (textBuf.length) {
            out.push(`<p>${textBuf.map(inlineMd).join("<br>")}</p>`);
            textBuf = [];
          }
        };

        for (const line of lines) {
          let m;
          if ((m = line.match(/^(#{1,4})\s+(.*)/))) {
            flushText();
            closeList();
            const level = m[1].length;
            out.push(`<h${level}>${inlineMd(m[2])}</h${level}>`);
          } else if ((m = line.match(/^\s*[-*]\s+(.*)/))) {
            flushText();
            if (listType !== "ul") {
              closeList();
              out.push("<ul>");
              listType = "ul";
            }
            out.push(`<li>${inlineMd(m[1])}</li>`);
          } else if ((m = line.match(/^\s*\d+[.)]\s+(.*)/))) {
            flushText();
            if (listType !== "ol") {
              closeList();
              out.push("<ol>");
              listType = "ol";
            }
            out.push(`<li>${inlineMd(m[1])}</li>`);
          } else if ((m = line.match(/^>\s?(.*)/))) {
            flushText();
            closeList();
            out.push(`<blockquote>${inlineMd(m[1])}</blockquote>`);
          } else if (line.trim() === "") {
            flushText();
            closeList();
          } else {
            closeList();
            textBuf.push(line);
          }
        }
        flushText();
        closeList();
      }
    });

    return out.join("");
  }

  function formatMessageText(bubbleEl, text, isStreaming) {
    let thinkText = "";
    let mainText = text;

    // Detectar etiqueta <think>...</think>
    const thinkMatch = text.match(/^\s*<think>([\s\S]*?)(<\/think>|$)/);
    if (thinkMatch) {
      thinkText = thinkMatch[1].trim();
      mainText = text.slice(thinkMatch[0].length);
    }

    let html = "";
    if (thinkText) {
      const isOpen = !thinkMatch[2] ? " open" : "";
      html += `<details class="think-box"${isOpen}><summary>Razonamiento del modelo</summary><div>${esc(thinkText)}</div></details>`;
    }

    html += renderMarkdown(mainText.trim());
    bubbleEl.innerHTML = html;
    bubbleEl.classList.toggle("cursor", Boolean(isStreaming));
  }

  // ========================================================================
  // Historial y Conversaciones (LocalStorage)
  // ========================================================================
  function loadStoredChats() {
    try {
      const data = localStorage.getItem(STORAGE_KEY);
      chats = data ? JSON.parse(data) : [];
      if (!Array.isArray(chats)) chats = [];
    } catch {
      chats = [];
    }
  }

  function saveStoredChats() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(chats));
    } catch (e) {
      console.warn("No se pudo guardar en localStorage", e);
    }
  }

  function getActiveChat() {
    return chats.find((c) => c.id === currentChatId) || null;
  }

  function editChatTitle(id, titleElement) {
    const chat = chats.find((item) => item.id === id);
    if (!chat || titleElement.isContentEditable) return;
    const previous = chat.title || "Conversación";
    let finished = false;
    titleElement.contentEditable = "true";
    titleElement.classList.add("title-editing");
    titleElement.spellcheck = false;
    titleElement.setAttribute("role", "textbox");
    titleElement.setAttribute("aria-label", "Editar título de la conversación");
    titleElement.focus();
    const range = document.createRange();
    range.selectNodeContents(titleElement);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);

    const finish = (save) => {
      if (finished) return;
      finished = true;
      const next = save ? titleElement.textContent.trim().slice(0, 80) : previous;
      titleElement.contentEditable = "false";
      titleElement.classList.remove("title-editing");
      titleElement.removeAttribute("role");
      titleElement.removeAttribute("aria-label");
      if (save && next) {
        chat.title = next;
        chat.titleEdited = true;
      } else {
        titleElement.textContent = previous;
      }
      titleElement.title = chat.title;
      saveStoredChats();
      if (id === currentChatId && titleElement !== activeChatTitle) {
        activeChatTitle.textContent = chat.title;
        activeChatTitle.title = chat.title;
      }
      renderChatList(chatSearchInput.value);
    };

    titleElement.addEventListener("blur", () => finish(true), { once: true });
    titleElement.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        titleElement.blur();
      } else if (event.key === "Escape") {
        event.preventDefault();
        titleElement.textContent = previous;
        titleElement.blur();
      }
    });
  }

  function createNewChat(explicitModel) {
    if (abortController) abortController.abort();

    const selectedModel = explicitModel || modelSelect.value || "qwen2.5:1.5b";
    const newChat = {
      id: "chat_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7),
      title: "Nueva conversación",
      model: selectedModel,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
    };

    chats.unshift(newChat);
    saveStoredChats();
    switchChat(newChat.id);
  }

  function deleteChat(id, e) {
    if (e) e.stopPropagation();
    if (abortController && currentChatId === id) abortController.abort();

    chats = chats.filter((c) => c.id !== id);
    saveStoredChats();

    if (currentChatId === id) {
      if (chats.length > 0) {
        switchChat(chats[0].id);
      } else {
        createNewChat();
      }
    } else {
      renderChatList();
    }
  }

  function switchChat(id) {
    currentChatId = id;
    const active = getActiveChat();
    if (!active) return;

    // Actualizar UI
    activeChatTitle.textContent = active.title || "Conversación";
    activeChatTitle.title = active.title || "Conversación";

    // Si el chat tenía un modelo asociado, sincronizarlo y solicitar descarga de los demás
    if (active.model && active.model !== modelSelect.value) {
      const opt = Array.from(modelSelect.options).find((o) => o.value === active.model && !o.disabled);
      if (opt) {
        modelSelect.value = active.model;
        onModelChanged(active.model);
      }
    }

    renderChatList();
    renderThreadMessages(active.messages);
    closeMobileSidebar();
    composerInput.focus();
  }

  function renderChatList(filter = "") {
    chatList.innerHTML = "";
    const term = (filter || "").toLowerCase().trim();
    const filtered = chats.filter((c) => (c.title || "").toLowerCase().includes(term));

    if (!filtered.length) {
      chatList.innerHTML = `<div class="empty-chat-history">Sin conversaciones</div>`;
      return;
    }

    filtered.forEach((c) => {
      const item = document.createElement("a");
      item.href = "#";
      item.className = `chat-item ${c.id === currentChatId ? "active" : ""}`;
      item.dataset.id = c.id;

      const modelShort = (c.model || "").split(":")[0] || "modelo";
      const count = (c.messages || []).filter((m) => m.role === "user").length;

      item.innerHTML = `
        <div class="chat-item-main">
          <div class="chat-item-title">${esc(c.title || "Nueva conversación")}</div>
          <div class="chat-item-meta">
            <span class="chat-item-model">${esc(modelShort)}</span>
            <span>· ${count} msgs</span>
          </div>
        </div>
        <button class="chat-item-del" title="Eliminar conversación" aria-label="Eliminar">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="3 6 5 6 21 6"></polyline>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
          </svg>
        </button>
      `;

      item.addEventListener("click", (e) => {
        e.preventDefault();
        switchChat(c.id);
      });

      const delBtn = item.querySelector(".chat-item-del");
      delBtn.addEventListener("click", (e) => deleteChat(c.id, e));
      item.querySelector(".chat-item-title").addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        editChatTitle(c.id, e.currentTarget);
      });

      chatList.appendChild(item);
    });
  }

  // ========================================================================
  // Renderizado del Thread de Mensajes
  // ========================================================================
  const isNearBottom = () =>
    chatScroll.scrollHeight - chatScroll.scrollTop - chatScroll.clientHeight < 120;

  const scrollToBottom = () => {
    chatScroll.scrollTop = chatScroll.scrollHeight;
  };

  function renderThreadMessages(messages) {
    thread.querySelectorAll(".msg").forEach((n) => n.remove());

    if (!messages || messages.length === 0) {
      hero.classList.remove("hidden");
      heroModelName.textContent = modelSelect.value.split(":")[0] || "tu modelo";
      return;
    }

    hero.classList.add("hidden");
    messages.forEach((m) => {
      appendMessageToThread(m.role, m.content, false);
    });
    scrollToBottom();
  }

  function appendMessageToThread(role, content = "", isStreaming = false) {
    hero.classList.add("hidden");

    const wrap = document.createElement("div");
    wrap.className = `msg ${role}`;

    const roleName = role === "user" ? "Tú" : (modelSelect.value || "Asistente").split(":")[0];
    wrap.innerHTML = `
      <div class="msg-header">${esc(roleName)}</div>
      <div class="bubble"></div>
    `;

    const bubble = wrap.querySelector(".bubble");
    if (role === "user") {
      bubble.textContent = content;
    } else {
      formatMessageText(bubble, content, isStreaming);
    }

    thread.appendChild(wrap);
    scrollToBottom();
    return bubble;
  }

  // ========================================================================
  // Modelos y Gestión de RAM
  // ========================================================================
  async function loadModels() {
    try {
      const res = await fetch("/api/models");
      const data = await res.json();
      models = data.models || [];
      updateRamDisplay(data.ram, data.loaded_models);
    } catch (e) {
      console.error("Error cargando modelos:", e);
      models = [];
    }

    modelSelect.innerHTML = "";
    if (!models.length) {
      modelSelect.innerHTML = `<option disabled selected>Sin modelos en ./models</option>`;
      sendBtn.disabled = true;
      updateHeaderModelTags();
      return;
    }

    models.forEach((m) => {
      const opt = document.createElement("option");
      opt.value = m.id;
      const isChat = m.is_chat !== false;
      opt.disabled = !m.available || !isChat;

      let suffix = "";
      if (!m.available) suffix = " (incompleto)";
      else if (!isChat) suffix = " (embeddings)";

      opt.textContent = `${m.id}${suffix}`;
      modelSelect.appendChild(opt);
    });

    // Restaurar selección previa preferida
    const saved = localStorage.getItem(PREF_MODEL_KEY);
    const valid =
      models.find((m) => m.id === saved && m.available && m.is_chat !== false) ||
      models.find((m) => m.available && m.is_chat !== false);

    if (valid) {
      modelSelect.value = valid.id;
    }

    updateHeaderModelTags();
  }

  function updateHeaderModelTags() {
    const selected = models.find((model) => model.id === modelSelect.value);
    const family = (modelSelect.value || "").split(":")[0] || "modelo";
    heroModelName.textContent = family;
    modelCategory.textContent = selected ? selected.category : "";
    modelPickerLabel.textContent = modelSelect.value || "Seleccionar modelo";
    modelPickerTrigger.disabled = !selected;
    renderModelPicker();
  }

  function renderModelPicker() {
    modelPickerMenu.innerHTML = "";
    models.forEach((model) => {
      const option = document.createElement("button");
      const available = model.available && model.is_chat !== false;
      option.type = "button";
      option.className = "model-picker-option";
      option.setAttribute("role", "option");
      option.setAttribute("aria-selected", String(model.id === modelSelect.value));
      option.disabled = !available;

      const info = document.createElement("span");
      info.className = "model-picker-info";
      const name = document.createElement("span");
      name.className = "model-picker-name";
      name.textContent = model.id;
      const category = document.createElement("span");
      category.className = "model-picker-category";
      category.textContent = model.category;
      info.append(name, category);

      const status = document.createElement("span");
      status.className = "model-picker-status";
      status.textContent = !model.available ? "Incompleto" : model.is_chat === false ? "Embeddings" : "";
      option.append(info, status);
      option.addEventListener("click", () => {
        modelSelect.value = model.id;
        modelSelect.dispatchEvent(new Event("change", { bubbles: true }));
        closeModelPicker();
      });
      modelPickerMenu.appendChild(option);
    });
  }

  function openModelPicker() {
    if (modelPickerTrigger.disabled) return;
    modelPickerMenu.hidden = false;
    modelPickerTrigger.setAttribute("aria-expanded", "true");
    const selected = modelPickerMenu.querySelector('[aria-selected="true"]:not(:disabled)');
    if (selected) selected.focus();
  }

  function closeModelPicker() {
    modelPickerMenu.hidden = true;
    modelPickerTrigger.setAttribute("aria-expanded", "false");
  }

  async function onModelChanged(newModelId) {
    localStorage.setItem(PREF_MODEL_KEY, newModelId);
    updateHeaderModelTags();

    const active = getActiveChat();
    if (active) {
      active.model = newModelId;
      saveStoredChats();
      renderChatList(chatSearchInput.value);
    }

    // Informar al backend para que libere cualquier otro modelo en RAM
    memoryStatusHint.textContent = `Descargando modelos anteriores...`;
    try {
      const res = await fetch("/api/select", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: newModelId }),
      });
      const data = await res.json();
      updateRamDisplay(data.ram, data.loaded_models);
      memoryStatusHint.textContent = `RAM protegida · ${newModelId.split(":")[0]} listo`;
    } catch {
      memoryStatusHint.textContent = "RAM protegida";
    }
  }

  async function unloadRamManually() {
    unloadRamBtn.disabled = true;
    unloadRamBtn.textContent = "Liberando...";
    try {
      const res = await fetch("/api/unload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      updateRamDisplay(data.ram, data.loaded_models);
      memoryStatusHint.textContent = "RAM liberada completamente";
    } catch (e) {
      console.warn("Error al descargar modelos:", e);
    } finally {
      unloadRamBtn.disabled = false;
      unloadRamBtn.textContent = "Liberar RAM";
    }
  }

  function updateRamDisplay(ram, loadedModels = []) {
    if (ram) {
      const pct = Math.min(100, Math.max(0, ram.percent || 0));
      ramBarFill.style.width = `${pct}%`;
      ramUsageText.textContent = `RAM: ${ram.used_human || "--"} / ${ram.total_human || "--"}`;
      ramPercentText.textContent = `${pct}%`;

      const pulse = document.querySelector(".ram-pulse");
      if (pulse) pulse.classList.toggle("warning", pct > 75);
    }

    if (loadedModels && loadedModels.length > 0) {
      const names = loadedModels.map((m) => m.name.split(":")[0]).join(", ");
      ramLoadedName.textContent = names;
    } else {
      ramLoadedName.textContent = "Ninguno (Libre)";
    }
  }

  async function pollStatus() {
    try {
      const res = await fetch("/api/status");
      if (res.ok) {
        const data = await res.json();
        updateRamDisplay(data.ram, data.loaded_models);
      }
    } catch {
      // Servidor temporalmente no disponible
    }
  }

  // ========================================================================
  // Envío y Streaming de Chat
  // ========================================================================
  async function sendMessage(text) {
    const trimmed = (text || "").trim();
    if (!trimmed || abortController) return;

    let active = getActiveChat();
    if (!active) {
      createNewChat(modelSelect.value);
      active = getActiveChat();
    }

    // Auto-titular si es el primer mensaje
    if ((!active.messages || active.messages.length === 0) && !active.titleEdited) {
      const words = trimmed.split(/\s+/).slice(0, 6).join(" ");
      active.title = words.length > 36 ? words.slice(0, 36) + "..." : words;
      activeChatTitle.textContent = active.title;
      activeChatTitle.title = active.title;
    }

    // Registrar mensaje del usuario
    active.messages.push({ role: "user", content: trimmed });
    active.updatedAt = Date.now();
    active.model = modelSelect.value;
    saveStoredChats();
    renderChatList(chatSearchInput.value);

    appendMessageToThread("user", trimmed, false);
    const bubble = appendMessageToThread("bot", "", true);

    setBusy(true);
    abortController = new AbortController();

    let fullReply = "";
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: modelSelect.value,
          messages: active.messages,
        }),
        signal: abortController.signal,
      });

      if (!res.ok || !res.body) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.error || `Error ${res.status} del servidor`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        let nlIdx;
        while ((nlIdx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, nlIdx).trim();
          buffer = buffer.slice(nlIdx + 1);
          if (!line) continue;

          const chunk = JSON.parse(line);
          if (chunk.error) throw new Error(chunk.error);

          if (chunk.message && chunk.message.content) {
            const keepFollow = isNearBottom();
            fullReply += chunk.message.content;
            formatMessageText(bubble, fullReply, true);
            if (keepFollow) scrollToBottom();
          }
        }
      }

      formatMessageText(bubble, fullReply, false);
      active.messages.push({ role: "assistant", content: fullReply });
      active.updatedAt = Date.now();
      saveStoredChats();
    } catch (err) {
      if (err.name === "AbortError") {
        formatMessageText(bubble, fullReply, false);
        if (fullReply) {
          active.messages.push({ role: "assistant", content: fullReply });
          saveStoredChats();
        } else {
          active.messages.pop();
        }
      } else {
        bubble.classList.remove("cursor");
        if (fullReply) formatMessageText(bubble, fullReply, false);

        const errDiv = document.createElement("div");
        errDiv.className = "bubble error";
        errDiv.textContent = err.message || "Ocurrió un error en la inferencia.";
        bubble.parentNode.appendChild(errDiv);

        if (!fullReply) active.messages.pop();
      }
    } finally {
      abortController = null;
      setBusy(false);
      pollStatus(); // Actualizar RAM tras la inferencia
      composerInput.focus();
    }
  }

  activeChatTitle.addEventListener("click", () => editChatTitle(currentChatId, activeChatTitle));

  function setBusy(isBusy) {
    sendBtn.innerHTML = isBusy
      ? '<svg class="send-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"></rect></svg><span class="visually-hidden">Detener generación</span>'
      : '<svg class="send-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5"></path><path d="m5 12 7-7 7 7"></path></svg><span class="visually-hidden">Enviar</span>';
    sendBtn.setAttribute("aria-label", isBusy ? "Detener generación" : "Enviar");
    sendBtn.classList.toggle("stop", isBusy);
    sendBtn.type = isBusy ? "button" : "submit";
  }

  function autoResizeInput() {
    composerInput.style.height = "auto";
    composerInput.style.height = Math.min(composerInput.scrollHeight, 200) + "px";
  }

  // ========================================================================
  // Sidebar Responsive Helpers
  // ========================================================================
  function toggleSidebar() {
    sidebar.classList.toggle("collapsed");
    if (window.innerWidth <= 768) {
      sidebarOverlay.classList.toggle("active", !sidebar.classList.contains("collapsed"));
    }
  }

  function closeMobileSidebar() {
    if (window.innerWidth <= 768) {
      sidebar.classList.add("collapsed");
      sidebarOverlay.classList.remove("active");
    }
  }

  // ========================================================================
  // Event Listeners
  // ========================================================================
  toggleSidebarBtn.addEventListener("click", toggleSidebar);
  sidebarOverlay.addEventListener("click", closeMobileSidebar);

  newChatBtn.addEventListener("click", () => createNewChat());

  chatSearchInput.addEventListener("input", (e) => {
    renderChatList(e.target.value);
  });

  modelSelect.addEventListener("change", (e) => {
    updateHeaderModelTags();
    onModelChanged(e.target.value);
  });

  modelPickerTrigger.addEventListener("click", () => {
    if (modelPickerMenu.hidden) openModelPicker();
    else closeModelPicker();
  });

  modelPickerTrigger.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      openModelPicker();
    }
  });

  modelPickerMenu.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeModelPicker();
      modelPickerTrigger.focus();
    }
  });

  document.addEventListener("click", (e) => {
    if (!e.target.closest(".model-select-wrap")) closeModelPicker();
  });

  unloadRamBtn.addEventListener("click", unloadRamManually);

  composerForm.addEventListener("submit", (e) => {
    e.preventDefault();
    if (abortController) return;
    const text = composerInput.value;
    composerInput.value = "";
    autoResizeInput();
    sendMessage(text);
  });

  sendBtn.addEventListener("click", () => {
    if (abortController) {
      abortController.abort();
    }
  });

  composerInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      composerForm.requestSubmit();
    }
  });

  composerInput.addEventListener("input", autoResizeInput);

  // Copiar bloques de código en los mensajes
  thread.addEventListener("click", (e) => {
    if (e.target.classList.contains("btn-copy-code")) {
      const code = e.target.nextElementSibling;
      if (code) {
        navigator.clipboard?.writeText(code.textContent);
        const original = e.target.textContent;
        e.target.textContent = "¡Copiado!";
        setTimeout(() => {
          e.target.textContent = original;
        }, 1500);
      }
    }
  });

  // Tarjetas iniciales de sugerencias
  starterCards.addEventListener("click", (e) => {
    const card = e.target.closest(".starter-card");
    if (card && card.dataset.prompt) {
      sendMessage(card.dataset.prompt);
    }
  });

  // ========================================================================
  // Inicialización
  // ========================================================================
  async function init() {
    loadStoredChats();

    // Colapsar barra en pantallas móviles por defecto
    if (window.innerWidth <= 768) {
      sidebar.classList.add("collapsed");
    }

    await loadModels();

    if (chats.length > 0) {
      switchChat(chats[0].id);
    } else {
      createNewChat(modelSelect.value);
    }

    // Monitoreo periódico de RAM cada 8 segundos
    pollStatus();
    statusPollTimer = setInterval(pollStatus, 8000);
  }

  init();
})();
