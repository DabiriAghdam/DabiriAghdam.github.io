(() => {
  "use strict";

  const root = document.querySelector("[data-chatbot]");
  if (!root) return;

  const configuredEndpoint = root.dataset.endpoint.trim();
  const localEndpoint = root.dataset.localEndpoint?.trim();
  const localHosts = new Set(["localhost", "127.0.0.1", "::1"]);
  const endpoint = localHosts.has(window.location.hostname) && localEndpoint
    ? localEndpoint
    : configuredEndpoint;
  const panel = root.querySelector(".site-chatbot__panel");
  const openButton = root.querySelector("[data-chatbot-open]");
  const closeButton = root.querySelector("[data-chatbot-close]");
  const resetButton = root.querySelector("[data-chatbot-reset]");
  const form = root.querySelector("[data-chatbot-form]");
  const input = root.querySelector("[data-chatbot-input]");
  const sendButton = root.querySelector("[data-chatbot-send]");
  const messagesElement = root.querySelector("[data-chatbot-messages]");
  const suggestions = root.querySelector("[data-chatbot-suggestions]");
  const newSessionId = () => window.crypto?.randomUUID?.() || `session-${Date.now()}-${Math.random().toString(36).slice(2)}`;

  // The site is multi-page, so an in-memory transcript would be discarded every
  // time a visitor navigates mid-conversation. Session storage keeps the thread
  // (and its audit session id) alive for the tab without outliving the visit.
  const STORAGE_KEY = "site-chatbot-state";
  const MAX_STORED_TURNS = 20;

  const readStoredState = () => {
    try {
      const raw = window.sessionStorage?.getItem(STORAGE_KEY);
      if (!raw) return null;
      const state = JSON.parse(raw);
      if (!state || typeof state.sessionId !== "string" || !Array.isArray(state.turns)) return null;
      state.turns = state.turns.filter((turn) =>
        turn && ["user", "assistant"].includes(turn.role) && typeof turn.content === "string" && turn.content.trim());
      return state;
    } catch {
      return null;
    }
  };

  const storedState = readStoredState();
  const conversation = [];
  // Captured before any restore runs, so a reset can put the panel back to the
  // greeting and the full starter question set it shipped with. Markup rather
  // than text: that set is larger than the three follow-ups showSuggestions renders.
  const openingMessages = messagesElement.innerHTML;
  const openingSuggestions = suggestions.innerHTML;
  let sessionId = storedState?.sessionId || newSessionId();
  let lastSources = [];
  let lastSuggestions = [];
  let sending = false;

  const persistState = () => {
    try {
      if (!window.sessionStorage) return;
      const turns = conversation.slice(-MAX_STORED_TURNS);
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify({
        sessionId,
        open: !panel.hidden,
        turns,
        sources: lastSources,
        suggestions: lastSuggestions,
      }));
    } catch {
      // A full or unavailable store just means this visit is not resumable.
    }
  };

  // Nothing to reset until there is a thread, so the control stays out of the
  // way on a fresh panel.
  const syncResetButton = () => {
    if (resetButton) resetButton.hidden = conversation.length === 0;
  };

  const showSuggestions = (questions) => {
    const safeQuestions = Array.isArray(questions)
      ? questions.filter((question) => typeof question === "string" && question.trim()).slice(0, 3)
      : [];
    suggestions.replaceChildren();
    safeQuestions.forEach((question) => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = question.trim();
      suggestions.appendChild(button);
    });
    suggestions.hidden = safeQuestions.length === 0;
  };

  const appendInlineMarkdown = (parent, value) => {
    const pattern = /(`[^`\n]+`|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|\*\*([^*\n]+)\*\*|__([^_\n]+)__|~~([^~\n]+)~~|\*([^*\n]+)\*|_([^_\n]+)_)/g;
    let cursor = 0;
    let match;
    while ((match = pattern.exec(value))) {
      if (match.index > cursor) parent.appendChild(document.createTextNode(value.slice(cursor, match.index)));
      const token = match[0];
      if (token.startsWith("`")) {
        const code = document.createElement("code");
        code.textContent = token.slice(1, -1);
        parent.appendChild(code);
      } else if (match[2] && match[3]) {
        const link = document.createElement("a");
        link.href = match[3];
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = match[2];
        parent.appendChild(link);
      } else {
        const emphasis = document.createElement(token.startsWith("~~") ? "del" : token.startsWith("**") || token.startsWith("__") ? "strong" : "em");
        appendInlineMarkdown(emphasis, token.replace(/^(\*\*|__|~~|\*|_)/, "").replace(/(\*\*|__|~~|\*|_)$/, ""));
        parent.appendChild(emphasis);
      }
      cursor = match.index + token.length;
    }
    if (cursor < value.length) parent.appendChild(document.createTextNode(value.slice(cursor)));
  };

  const renderMarkdown = (message, value) => {
    message.classList.add("site-chatbot__message--markdown");
    message.replaceChildren();
    const lines = value.replace(/\r\n?/g, "\n").split("\n");
    let paragraph = [];
    let index = 0;

    const flushParagraph = () => {
      if (!paragraph.length) return;
      const element = document.createElement("p");
      paragraph.forEach((line, lineIndex) => {
        if (lineIndex) element.appendChild(document.createElement("br"));
        appendInlineMarkdown(element, line);
      });
      message.appendChild(element);
      paragraph = [];
    };

    while (index < lines.length) {
      const line = lines[index];
      const fence = line.match(/^\s*```(?:[^\s`]*)?\s*$/);
      if (fence) {
        flushParagraph();
        index += 1;
        const codeLines = [];
        while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) codeLines.push(lines[index++]);
        if (index < lines.length) index += 1;
        const pre = document.createElement("pre");
        const code = document.createElement("code");
        code.textContent = codeLines.join("\n");
        pre.appendChild(code);
        message.appendChild(pre);
        continue;
      }
      const heading = line.match(/^\s*(#{1,3})\s+(.+?)\s*#*\s*$/);
      if (heading) {
        flushParagraph();
        const element = document.createElement(`h${Math.min(4, heading[1].length + 1)}`);
        appendInlineMarkdown(element, heading[2]);
        message.appendChild(element);
        index += 1;
        continue;
      }
      const list = line.match(/^\s*([-*+]\s+|\d+[.)]\s+)(.+)$/);
      if (list) {
        flushParagraph();
        const ordered = /^\d/.test(list[1]);
        const element = document.createElement(ordered ? "ol" : "ul");
        while (index < lines.length) {
          const item = lines[index].match(/^\s*([-*+]\s+|\d+[.)]\s+)(.+)$/);
          if (!item || /^\d/.test(item[1]) !== ordered) break;
          const li = document.createElement("li");
          appendInlineMarkdown(li, item[2]);
          element.appendChild(li);
          index += 1;
        }
        message.appendChild(element);
        continue;
      }
      if (/^\s*>\s?/.test(line)) {
        flushParagraph();
        const quote = document.createElement("blockquote");
        while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
          const quoteLine = lines[index++].replace(/^\s*>\s?/, "");
          appendInlineMarkdown(quote, quoteLine);
          if (index < lines.length && /^\s*>\s?/.test(lines[index])) quote.appendChild(document.createElement("br"));
        }
        message.appendChild(quote);
        continue;
      }
      if (!line.trim()) {
        flushParagraph();
        index += 1;
        continue;
      }
      paragraph.push(line);
      index += 1;
    }
    flushParagraph();
  };

  class ChatbotRequestError extends Error {
    constructor(message, status) {
      super(message);
      this.status = status;
    }
  }

  const consumeEventStream = async (response, onText) => {
    const reader = response.body?.getReader();
    if (!reader) throw new ChatbotRequestError("The assistant returned an empty response.", 502);

    const decoder = new TextDecoder();
    let buffer = "";
    let fullText = "";
    let terminal = null;

    const handleEvent = (block) => {
      let event = "message";
      const dataLines = [];
      block.split(/\r?\n/).forEach((line) => {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
      });
      if (!dataLines.length) return;
      let payload;
      try {
        payload = JSON.parse(dataLines.join("\n"));
      } catch {
        return;
      }
      if (event === "delta" && typeof payload.text === "string") {
        fullText += payload.text;
        onText(fullText);
      } else if (event === "done") {
        terminal = payload;
      } else if (event === "error") {
        throw new ChatbotRequestError(payload.error || "The assistant could not complete the response.", payload.status || 502);
      }
    };

    while (!terminal) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() || "";
      for (const block of blocks) {
        if (block.trim()) handleEvent(block);
        if (terminal) break;
      }
      if (done) break;
    }
    if (!terminal && buffer.trim()) handleEvent(buffer);
    if (!terminal) throw new ChatbotRequestError("The assistant returned an incomplete response.", 502);
    return { ...terminal, message: fullText };
  };

  // moveFocus is off when reopening a restored panel after a page navigation:
  // stealing focus on load would yank the viewport away from the new page.
  const setOpen = (isOpen, moveFocus = true) => {
    panel.hidden = !isOpen;
    openButton.setAttribute("aria-expanded", String(isOpen));
    if (!moveFocus) return;
    if (isOpen) window.setTimeout(() => input.focus(), 0);
    else openButton.focus();
  };

  const addMessage = (role, text, isError = false) => {
    const row = document.createElement("div");
    row.className = `site-chatbot__message-row site-chatbot__message-row--${role}`;

    const message = document.createElement("div");
    message.className = `site-chatbot__message site-chatbot__message--${role}`;
    if (isError) message.classList.add("site-chatbot__message--error");
    message.textContent = text;
    row.appendChild(message);
    messagesElement.appendChild(row);
    messagesElement.scrollTop = messagesElement.scrollHeight;
    return message;
  };

  const addSources = (message, sources) => {
    if (!Array.isArray(sources) || !sources.length) return;
    const links = sources.filter((source) => {
      if (!source || typeof source.label !== "string" || typeof source.url !== "string") return false;
      try {
        const url = new URL(source.url, window.location.origin);
        return ["https:", "http:"].includes(url.protocol);
      } catch {
        return false;
      }
    }).slice(0, 4);
    if (!links.length) return;
    const sourceElement = document.createElement("div");
    sourceElement.className = "site-chatbot__sources";
    const label = document.createElement("span");
    label.textContent = "Sources";
    sourceElement.appendChild(label);
    links.forEach((source) => {
      const link = document.createElement("a");
      link.href = source.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = source.label;
      sourceElement.appendChild(link);
    });
    message.closest(".site-chatbot__message-row")?.appendChild(sourceElement);
  };

  const addTruncationNotice = (message, truncated) => {
    if (!truncated) return;
    const notice = document.createElement("p");
    notice.className = "site-chatbot__truncation";
    notice.textContent = "This response was cut short. Try asking for a shorter summary.";
    message.appendChild(notice);
  };

  const addRetryButton = (message, content) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "site-chatbot__retry";
    button.dataset.chatbotRetry = "true";
    button.textContent = "Try again";
    button.addEventListener("click", () => {
      if (sending) return;
      button.disabled = true;
      message.closest(".site-chatbot__message-row")?.remove();
      submitMessage(content, true);
    });
    message.appendChild(button);
  };

  const setSending = (isSending) => {
    sending = isSending;
    input.disabled = isSending;
    sendButton.disabled = isSending;
    sendButton.classList.toggle("is-loading", isSending);
    messagesElement.setAttribute("aria-busy", String(isSending));
  };

  const resizeInput = () => {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 96)}px`;
  };

  const requestHistory = () => {
    const history = conversation.slice(-8);
    // The worker expects history to start with a user turn. A raw last-eight
    // slice can start with the previous assistant turn after several rounds.
    if (history[0]?.role === "assistant") history.shift();
    return history;
  };

  const submitMessage = async (text, isRetry = false) => {
    const content = text.trim();
    if (!content || sending) return;

    if (!endpoint) {
      addMessage("assistant", "The assistant is not connected yet. Please try again later.", true);
      return;
    }

    suggestions.hidden = true;
    if (!isRetry) addMessage("user", content);
    conversation.push({ role: "user", content });
    input.value = "";
    resizeInput();
    setSending(true);

    const typing = addMessage("assistant", "Thinking");
    typing.classList.add("site-chatbot__message--typing");
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 60000);

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Accept": "text/event-stream", "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, messages: requestHistory() }),
        signal: controller.signal,
        cache: "no-store",
        credentials: "omit",
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new ChatbotRequestError(data.error || "The assistant could not respond right now.", response.status);
      }
      const isEventStream = response.headers.get("content-type")?.toLowerCase().includes("text/event-stream");
      const data = isEventStream
        ? await consumeEventStream(response, (text) => {
          typing.classList.remove("site-chatbot__message--typing");
          typing.textContent = text;
          messagesElement.scrollTop = messagesElement.scrollHeight;
        })
        : await response.json().catch(() => ({}));
      if (typeof data.message !== "string" || !data.message.trim()) {
        throw new ChatbotRequestError("The assistant returned an empty response.", 502);
      }

      renderMarkdown(typing, data.message.trim());
      typing.classList.remove("site-chatbot__message--typing");
      addTruncationNotice(typing, data.truncated);
      conversation.push({ role: "assistant", content: data.message.trim() });
      addSources(typing, data.sources);
      showSuggestions(data.followUpQuestions);
      lastSources = Array.isArray(data.sources) ? data.sources : [];
      lastSuggestions = Array.isArray(data.followUpQuestions) ? data.followUpQuestions : [];
      syncResetButton();
      persistState();
    } catch (error) {
      const timedOut = error.name === "AbortError";
      const disconnected = error instanceof TypeError;
      const status = Number(error.status);
      const retryable = timedOut || disconnected || [429, 500, 502, 503, 504].includes(status);
      typing.textContent = status === 429
        ? "The assistant is busy right now."
        : status >= 500 && status <= 599
          ? "The assistant is temporarily unavailable."
          : timedOut
            ? "The response took too long."
            : disconnected
              ? "I couldn't connect to the assistant."
              : error.message || "Something went wrong.";
      typing.classList.remove("site-chatbot__message--typing");
      typing.classList.add("site-chatbot__message--error");
      if (retryable) addRetryButton(typing, content);
      conversation.pop();
    } finally {
      window.clearTimeout(timeout);
      setSending(false);
      input.focus();
    }
  };

  const restoreState = () => {
    if (!storedState) return;
    if (storedState.open) setOpen(true, false);
    if (!storedState.turns.length) return;
    storedState.turns.forEach((turn) => {
      conversation.push({ role: turn.role, content: turn.content });
      const message = addMessage(turn.role, turn.content);
      if (turn.role === "assistant") renderMarkdown(message, turn.content);
    });
    lastSources = Array.isArray(storedState.sources) ? storedState.sources : [];
    lastSuggestions = Array.isArray(storedState.suggestions) ? storedState.suggestions : [];
    const lastAssistant = messagesElement.querySelector(
      ".site-chatbot__message-row--assistant:last-child .site-chatbot__message");
    if (lastAssistant) addSources(lastAssistant, lastSources);
    if (lastSuggestions.length) showSuggestions(lastSuggestions);
    messagesElement.scrollTop = messagesElement.scrollHeight;
    syncResetButton();
  };

  // Drops the thread the model is given and starts a fresh audit session, so a
  // reset conversation is a genuinely new one rather than a cleared transcript
  // stapled onto the old session id.
  const resetConversation = ({ moveFocus = true } = {}) => {
    if (sending) return;
    conversation.length = 0;
    lastSources = [];
    lastSuggestions = [];
    sessionId = newSessionId();
    messagesElement.innerHTML = openingMessages;
    suggestions.innerHTML = openingSuggestions;
    suggestions.hidden = false;
    messagesElement.scrollTop = 0;
    syncResetButton();
    persistState();
    if (moveFocus) input.focus();
  };

  openButton.addEventListener("click", () => {
    setOpen(panel.hidden);
    persistState();
  });
  closeButton.addEventListener("click", () => {
    setOpen(false);
    persistState();
  });
  resetButton?.addEventListener("click", () => resetConversation());
  input.addEventListener("input", resizeInput);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    submitMessage(input.value);
  });
  suggestions.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (button) submitMessage(button.textContent);
  });
  document.addEventListener("click", (event) => {
    const button = event.target.closest("[data-chatbot-open-question]");
    if (!button || !root.contains(button) && !document.body.contains(button)) return;
    const question = button.getAttribute("data-chatbot-open-question")?.trim();
    if (!question) return;
    setOpen(true);
    input.value = question;
    resizeInput();
    input.focus();
    persistState();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !panel.hidden) {
      setOpen(false);
      persistState();
    }
  });

  restoreState();
})();
