(function () {
  const extensionApi = globalThis.browser || globalThis.chrome;
  let lastContextCode = "";
  let lastSelectionText = "";
  let lastContextPoint = { x: 32, y: 32 };
  let pythonFrame;
  let pythonReadyPromise;
  let requestId = 0;
  const pendingRuns = new Map();

  // ==========================================================================
  // INLINE UI INJECTION & CSS
  // ==========================================================================
  
  const style = document.createElement("style");
  style.textContent = `
    .rch-inline-wrapper { position: relative; margin-bottom: 1em; }
    .rch-inline-wrapper:hover .rch-inline-run-btn { opacity: 1; pointer-events: auto; }
    .rch-inline-run-btn { position: absolute; top: 8px; right: 8px; z-index: 10; display: flex; align-items: center; justify-content: center; width: 32px; height: 32px; background: rgba(110, 118, 129, 0.4); color: #fff; border: none; border-radius: 4px; cursor: pointer; opacity: 0; pointer-events: none; transition: opacity 0.2s, background 0.2s; }
    .rch-inline-run-btn:hover { background: rgba(110, 118, 129, 0.8); }
    .rch-inline-output { margin-top: -1em; padding: 16px; background: #e5e7eb; border-bottom-left-radius: 6px; border-bottom-right-radius: 6px; font-family: ui-monospace, SFMono-Regular, Consolas, monospace; font-size: 13px; color: #24292f; display: none; border: 1px solid #d1d5db; border-top: none; }
    .rch-inline-output.rch-dark { background: #0d0d0f; color: #00ff41; border-color: #30363d; text-shadow: 0 0 3px rgba(0, 255, 65, 0.4); box-shadow: inset 0 5px 15px rgba(0,0,0,0.8); }
    .rch-inline-output iframe { width: 100%; border: none; min-height: 80px; background: transparent; }
    .rch-inline-console-log { margin: 4px 0; white-space: pre-wrap; word-break: break-word; }
    .rch-inline-console-error { color: #cf222e; }
    .rch-dark .rch-inline-console-error { color: #ff4f40; }
  `;
  document.head.appendChild(style);

  setInterval(() => {
    document.querySelectorAll("pre:not(.rch-processed)").forEach((pre) => {
      pre.classList.add("rch-processed");
      if (pre.closest("#run-code-here-panel") || pre.closest(".rch-inline-output") || pre.classList.contains("rch-output")) return;
      injectInlineUI(pre);
    });
  }, 1500);

  function injectInlineUI(pre) {
    const wrapper = document.createElement("div");
    wrapper.className = "rch-inline-wrapper";
    pre.parentNode.insertBefore(wrapper, pre);
    wrapper.appendChild(pre);

    const btn = document.createElement("button");
    btn.className = "rch-inline-run-btn";
    btn.title = "Run code here (Use Right-Click for Input options)";
    btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`;
    wrapper.appendChild(btn);

    const outputContainer = document.createElement("div");
    outputContainer.className = "rch-inline-output";
    wrapper.appendChild(outputContainer);

    btn.addEventListener("click", () => {
      const code = getCodeText(pre);
      const language = detectLanguage(code);
      runInlineCode(code, language, outputContainer);
    });
  }

  async function runInlineCode(code, language, container) {
    container.style.display = "block";
    
    if (language === "unsupported") {
      container.classList.add("rch-dark");
      container.innerHTML = `<div class="rch-inline-console-log rch-inline-console-error">Tool support is not available right now for languages other than Python, JavaScript, CSS, and HTML.</div>`;
      return;
    }

    if (language === "python") {
      container.classList.add("rch-dark");
      container.innerHTML = `<div class="rch-inline-console-log" style="color: #64d2ff;">Starting Python runtime...</div>`;
      try {
        await ensurePythonRunner();
        container.innerHTML = `<div class="rch-inline-console-log" style="color: #64d2ff;">Running...</div>`;
        const result = await sendPythonRunRequest(normalizePython(code), ""); 
        renderJupyterOutput(container, result.output, true);
      } catch (err) {
        container.innerHTML = `<div class="rch-inline-console-log rch-inline-console-error">Failed to start Python: ${err.message || err}</div>`;
      }
    } else {
      container.classList.remove("rch-dark");
      container.innerHTML = ""; 
      
      const iframeId = "rch-frame-" + (++requestId);
      const iframe = document.createElement("iframe");
      iframe.id = iframeId;
      iframe.sandbox = "allow-scripts allow-modals allow-forms";
      container.appendChild(iframe);
      
      const htmlContent = buildInlinePreviewDocument(code, language, iframeId);
      const objectUrl = URL.createObjectURL(new Blob([htmlContent], { type: "text/html" }));
      iframe.src = objectUrl;
    }
  }

  // ==========================================================================
  // FLOATING PANEL (MAC STYLE) & CONTEXT MENU
  // ==========================================================================

  document.addEventListener(
    "contextmenu",
    (event) => {
      lastContextPoint = { x: event.clientX + window.scrollX, y: event.clientY + window.scrollY };
      
      const codeBlock = findCodeBlock(event.target);
      lastContextCode = codeBlock ? getCodeText(codeBlock) : "";
      lastSelectionText = getSelectedTextWithBreaks();
    },
    true
  );

  function getSelectedTextWithBreaks() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return "";
    
    const range = sel.getRangeAt(0);
    let text = "";
    let lastBlock = null;
    
    const iterator = document.createNodeIterator(range.commonAncestorContainer, NodeFilter.SHOW_TEXT, {
      acceptNode: function(node) {
        return range.intersectsNode(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      }
    });
    
    let node;
    while ((node = iterator.nextNode())) {
      let blockAncestor = node.parentElement;
      
      while (blockAncestor && blockAncestor !== document.body) {
        const tag = blockAncestor.tagName.toLowerCase();
        const cls = typeof blockAncestor.className === 'string' ? blockAncestor.className.toLowerCase() : "";
        if (["div", "p", "li", "tr", "pre"].includes(tag) || cls.includes("line") || cls.includes("row")) {
          break;
        }
        blockAncestor = blockAncestor.parentElement;
      }
      
      if (lastBlock && blockAncestor !== lastBlock && !text.endsWith('\n')) {
        text += "\n";
      }
      
      let nodeText = node.nodeValue || "";
      
      if (node === range.startContainer && node === range.endContainer) {
        nodeText = nodeText.substring(range.startOffset, range.endOffset);
      } else if (node === range.startContainer) {
        nodeText = nodeText.substring(range.startOffset);
      } else if (node === range.endContainer) {
        nodeText = nodeText.substring(0, range.endOffset);
      }
      
      text += nodeText.replace(/\u00A0/g, ' ');
      lastBlock = blockAncestor;
    }
    
    return text.trim() || sel.toString().replace(/\u00A0/g, ' ');
  }

  extensionApi.runtime.onMessage.addListener((message) => {
    if (message?.type !== "RUN_CODE_HERE") return;
    
    let rawCode = lastSelectionText.trim();
    if (!rawCode && lastContextCode.trim()) {
      rawCode = lastContextCode;
    }
    if (!rawCode) {
      rawCode = message.selectionText || "";
    }
    
    showPanel(rawCode, lastContextPoint);
  });

  function showPanel(rawCode, point) {
    const existing = document.getElementById("run-code-here-panel");
    if (existing) existing.remove();

    const code = normalizeCode(rawCode);
    const detectedLanguage = detectLanguage(code);
    const panel = document.createElement("section");
    panel.id = "run-code-here-panel";
    
    panel.innerHTML = `
      <style>
        #run-code-here-panel { position: absolute; z-index: 2147483647; width: min(1000px, calc(100vw - 28px)); max-height: min(780px, calc(100vh - 28px)); display: grid; grid-template-rows: auto minmax(150px, 0.8fr) auto auto minmax(140px, 1fr); border-radius: 12px; background: #ffffff; box-shadow: 0 35px 70px -15px rgba(0, 0, 0, 0.6), 0 15px 25px -5px rgba(0, 0, 0, 0.3), inset 0 1px 0 rgba(255, 255, 255, 0.8), 0 0 0 1px rgba(0, 0, 0, 0.2); color: #333333; font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; overflow: hidden; }
        #run-code-here-panel.rch-minimized { grid-template-rows: auto; height: auto; }
        #run-code-here-panel.rch-minimized .rch-editor-wrap, #run-code-here-panel.rch-minimized .rch-input-wrap, #run-code-here-panel.rch-minimized .rch-status, #run-code-here-panel.rch-minimized .rch-result { display: none !important; }
        #run-code-here-panel.rch-maximized { width: 100vw !important; height: 100vh !important; max-height: 100vh !important; max-width: 100vw !important; top: 0 !important; left: 0 !important; border-radius: 0 !important; }
        #run-code-here-panel * { box-sizing: border-box; }
        .rch-bar { display: flex; align-items: center; justify-content: space-between; padding: 14px 18px; background: linear-gradient(180deg, #4d4d4d 0%, #363636 100%); border-bottom: 1px solid #1a1a1a; box-shadow: inset 0 1px 1px rgba(255, 255, 255, 0.2); color: #ffffff; font-size: 13px; font-weight: 700; cursor: grab; }
        .rch-bar:active { cursor: grabbing; }
        .rch-mac-dots { display: flex; gap: 9px; align-items: center; }
        .rch-mac-dots .dot { width: 13px; height: 13px; border-radius: 50%; box-shadow: inset -3px -3px 5px rgba(0,0,0,0.3), inset 2px 2px 4px rgba(255,255,255,0.7), 0 2px 4px rgba(0,0,0,0.5); cursor: pointer; }
        .rch-mac-dots .dot:active { filter: brightness(0.7); }
        .dot.red { background: #FF5F56; border: 1px solid #e0443e; }
        .dot.yellow { background: #FFBD2E; border: 1px solid #dea123; }
        .dot.green { background: #27C93F; border: 1px solid #1ea231; }
        .rch-header-center { display: flex; align-items: center; gap: 12px; flex: 1; justify-content: flex-end; padding-right: 16px; }
        .rch-title { font-size: 14px; font-weight: 700; letter-spacing: 0.5px; text-shadow: 0 1px 2px rgba(0, 0, 0, 0.8); color: #f5f5f5; }
        .rch-language, .rch-button { background: linear-gradient(180deg, #5c5c5c 0%, #3d3d3d 100%); border: 1px solid #111; box-shadow: inset 0 1px 1px rgba(255,255,255,0.2), 0 2px 4px rgba(0,0,0,0.4); color: #ffffff; border-radius: 6px; min-height: 28px; padding: 0 12px; font: inherit; font-weight: 600; cursor: pointer; text-shadow: 0 1px 1px rgba(0,0,0,0.5); transition: all 0.1s ease; }
        .rch-language:hover, .rch-button:hover { background: linear-gradient(180deg, #666666 0%, #474747 100%); }
        .rch-button:active { background: #333333; box-shadow: inset 0 2px 4px rgba(0,0,0,0.5); }
        .rch-primary { background: linear-gradient(180deg, #007aff 0%, #0056b3 100%); border: 1px solid #003a79; box-shadow: inset 0 1px 1px rgba(255,255,255,0.4), 0 2px 5px rgba(0,0,0,0.5); }
        .rch-primary:hover { background: linear-gradient(180deg, #1a8cff 0%, #0062cc 100%); }
        .rch-primary:active { background: #0056b3; box-shadow: inset 0 2px 4px rgba(0,0,0,0.5); }
        .rch-editor-wrap { display: grid; grid-template-columns: 1fr; gap: 2px; background: #2a2a2a; box-shadow: inset 0 4px 8px rgba(0,0,0,0.4); }
        .rch-editor-wrap.split-mode { grid-template-columns: 1fr 1fr 1fr; }
        .rch-html-editor, .rch-css-editor, .rch-js-editor, .rch-stdin, .rch-output { width: 100%; margin: 0; border: 0; outline: 0; resize: vertical; font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace; tab-size: 4; }
        .rch-html-editor, .rch-css-editor { display: none; padding: 16px; }
        .rch-editor-wrap.split-mode .rch-html-editor, .rch-editor-wrap.split-mode .rch-css-editor { display: block; }
        .rch-html-editor { background: #1a1a1c; color: #a5d6ff; box-shadow: inset 0 2px 10px rgba(0,0,0,0.3); }
        .rch-css-editor { background: #1e1e20; color: #d2a8ff; box-shadow: inset 0 2px 10px rgba(0,0,0,0.3); }
        .rch-js-editor { min-height: 150px; padding: 16px; background: #151515; color: #ff7b72; box-shadow: inset 0 2px 10px rgba(0,0,0,0.5); }
        .rch-input-wrap { display: grid; grid-template-columns: minmax(82px, auto) minmax(0, 1fr); align-items: stretch; border-top: 1px solid #e0e0e0; background: #f7f7f7; box-shadow: inset 0 2px 4px rgba(0,0,0,0.02); }
        .rch-input-label { display: flex; align-items: center; padding: 8px 16px; color: #555; font-size: 12px; font-weight: 700; text-shadow: 0 1px 0 rgba(255,255,255,1); }
        .rch-stdin { min-height: 42px; max-height: 110px; padding: 10px 12px; border-left: 1px solid #e0e0e0; background: #ffffff; color: #333; box-shadow: inset 2px 2px 5px rgba(0,0,0,0.03); }
        .rch-result { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); min-height: 0; background: #ffffff; border-top: 1px solid #e0e0e0; }
        .rch-preview-wrap { min-height: 0; border-right: 1px solid #e0e0e0; background: #ffffff; }
        .rch-preview { width: 100%; height: 100%; min-height: 140px; border: 0; background: #ffffff; }
        .rch-output { min-height: 140px; max-height: 320px; overflow: auto; padding: 16px; white-space: pre-wrap; word-break: break-word; background: #0d0d0f; color: #00ff41; text-shadow: 0 0 3px rgba(0, 255, 65, 0.4); box-shadow: inset 0 5px 15px rgba(0,0,0,0.8); }
        .rch-status { padding: 10px 16px; background: linear-gradient(180deg, #fdfdfd 0%, #f0f0f0 100%); border-top: 1px solid #e0e0e0; color: #666; font-size: 12px; font-weight: 600; box-shadow: 0 -2px 5px rgba(0,0,0,0.02); }
        @media (max-width: 800px) { #run-code-here-panel { grid-template-rows: auto minmax(140px, 0.8fr) auto auto minmax(260px, 1fr); } .rch-bar { align-items: flex-start; flex-direction: column; gap: 12px; } .rch-header-center { justify-content: flex-start; padding-right: 0; flex-wrap: wrap; } .rch-editor-wrap.split-mode { grid-template-columns: 1fr; grid-template-rows: 1fr 1fr 1fr; } .rch-result { grid-template-columns: 1fr; grid-template-rows: minmax(130px, 1fr) minmax(130px, 1fr); } .rch-preview-wrap { border-right: 0; border-bottom: 1px solid #e0e0e0; } }
      </style>
      <div class="rch-bar">
        <div class="rch-mac-dots">
          <div class="dot red" title="Close"></div>
          <div class="dot yellow" title="Minimize"></div>
          <div class="dot green" title="Maximize"></div>
        </div>
        <div class="rch-header-center">
          <select class="rch-language" data-rch-language>
            <option value="auto">Auto</option><option value="python">Python</option><option value="html">HTML</option>
            <option value="css">CSS</option><option value="javascript">JavaScript</option>
            <option value="unsupported" style="display:none;">Unsupported</option>
          </select>
          <button class="rch-button rch-primary" type="button" data-rch-run>Run</button>
          <button class="rch-button" type="button" data-rch-close>Close</button>
        </div>
        <div class="rch-title">Run code here</div>
      </div>
      <div class="rch-editor-wrap" id="rch-editor-wrap">
        <textarea class="rch-html-editor" spellcheck="false" placeholder=""></textarea>
        <textarea class="rch-css-editor" spellcheck="false" placeholder="/* CSS */"></textarea>
        <textarea class="rch-js-editor" spellcheck="false" placeholder="// JavaScript / Python"></textarea>
      </div>
      <label class="rch-input-wrap">
        <span class="rch-input-label">Input</span>
        <textarea class="rch-stdin" spellcheck="false" placeholder="One input() response per line"></textarea>
      </label>
      <div class="rch-status">Ready.</div>
      <div class="rch-result">
        <div class="rch-preview-wrap"><iframe class="rch-preview" title="Code preview" sandbox="allow-scripts allow-modals allow-forms"></iframe></div>
        <pre class="rch-output"></pre>
      </div>
    `;

    const left = Math.min(point.x, window.scrollX + window.innerWidth - 884);
    const top = Math.min(point.y, window.scrollY + window.innerHeight - 520);
    panel.style.left = `${Math.max(window.scrollX + 14, left)}px`;
    panel.style.top = `${Math.max(window.scrollY + 14, top)}px`;
    document.documentElement.appendChild(panel);

    const bar = panel.querySelector(".rch-bar");
    let isDragging = false, startX, startY, initialLeft, initialTop;
    let isMaximized = false; let isMinimized = false;

    panel.querySelector('.dot.red').addEventListener('click', () => panel.remove());
    panel.querySelector('.dot.yellow').addEventListener('click', () => {
      isMinimized = !isMinimized;
      if (isMinimized) { panel.classList.add('rch-minimized'); panel.classList.remove('rch-maximized'); isMaximized = false; } 
      else panel.classList.remove('rch-minimized');
    });
    panel.querySelector('.dot.green').addEventListener('click', () => {
      isMaximized = !isMaximized;
      if (isMaximized) { panel.classList.add('rch-maximized'); panel.classList.remove('rch-minimized'); isMinimized = false; } 
      else panel.classList.remove('rch-maximized');
    });

    bar.addEventListener("mousedown", (e) => {
      if (e.target.closest("button, select, input, .dot") || isMaximized) return;
      isDragging = true;
      startX = e.clientX; startY = e.clientY;
      initialLeft = panel.offsetLeft; initialTop = panel.offsetTop;
      const onMouseMove = (moveEvent) => {
        if (!isDragging) return;
        panel.style.left = `${initialLeft + moveEvent.clientX - startX}px`;
        panel.style.top = `${initialTop + moveEvent.clientY - startY}px`;
      };
      const onMouseUp = () => { isDragging = false; document.removeEventListener("mousemove", onMouseMove); document.removeEventListener("mouseup", onMouseUp); };
      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    });

    const stdin = panel.querySelector(".rch-stdin");
    const output = panel.querySelector(".rch-output");
    const status = panel.querySelector(".rch-status");
    const preview = panel.querySelector(".rch-preview");
    const languageSelect = panel.querySelector("[data-rch-language]");
    const editorWrap = panel.querySelector("#rch-editor-wrap");
    const htmlEditor = panel.querySelector(".rch-html-editor");
    const cssEditor = panel.querySelector(".rch-css-editor");
    const jsEditor = panel.querySelector(".rch-js-editor");

    if (detectedLanguage === "html") htmlEditor.value = code;
    else if (detectedLanguage === "css") cssEditor.value = code;
    else jsEditor.value = code || "// Select or right-click JS/CSS/HTML/Python code first.";
    
    languageSelect.value = "auto";
    languageSelect.dataset.detected = detectedLanguage;

    panel.querySelector("[data-rch-close]").addEventListener("click", () => panel.remove());

    function updateLayout() {
      const codeToDetect = jsEditor.value || htmlEditor.value || cssEditor.value;
      const lang = selectedLanguage(languageSelect, codeToDetect);
      if (lang === "python" || lang === "unsupported") editorWrap.classList.remove("split-mode");
      else editorWrap.classList.add("split-mode");
    }

    languageSelect.addEventListener("change", updateLayout);
    panel.querySelector("[data-rch-run]").addEventListener("click", () => { runPanelCode(jsEditor.value, cssEditor.value, htmlEditor.value, stdin.value, languageSelect, status, output, preview); });

    updateLayout();
    prepareInitialRun(jsEditor.value, cssEditor.value, htmlEditor.value, languageSelect, status, output, preview);
  }

  function prepareInitialRun(jsCode, cssCode, htmlCode, languageSelect, status, output, preview) {
    const language = selectedLanguage(languageSelect, jsCode || cssCode || htmlCode);
    const autoLabel = languageSelect.value === "auto" ? `Auto detected ${languageLabel(language)}. ` : "";

    if (language === "unsupported") {
      preview.srcdoc = "";
      status.textContent = `${autoLabel}Done.`;
      output.textContent = "Tool support is not available right now for languages other than Python, JavaScript, CSS, and HTML.";
      return;
    }

    if (language === "python") {
      preview.srcdoc = pythonPlaceholder();
      status.textContent = `${autoLabel}Press Run to start Python.`;
      output.textContent = ["Python is ready to run.", "The first run starts the browser Python runtime, so Safari may take a few seconds."].join("\n");
      return;
    }
    runPanelWebCode(jsCode, cssCode, htmlCode, language, status, output, preview, autoLabel, "");
  }

  async function runPanelCode(jsCode, cssCode, htmlCode, stdin, languageSelect, status, output, preview) {
    const language = selectedLanguage(languageSelect, jsCode || cssCode || htmlCode);
    const autoLabel = languageSelect.value === "auto" ? `Auto detected ${languageLabel(language)}. ` : "";

    if (language === "unsupported") {
      preview.srcdoc = "";
      status.textContent = `${autoLabel}Done.`;
      output.textContent = "Tool support is not available right now for languages other than Python, JavaScript, CSS, and HTML.";
      return;
    }

    if (language === "python") {
      preview.srcdoc = pythonPlaceholder();
      await runPanelPython(jsCode, stdin, status, output, autoLabel);
      return;
    }
    runPanelWebCode(jsCode, cssCode, htmlCode, language, status, output, preview, autoLabel, stdin);
  }

  async function runPanelPython(code, stdin, status, output, autoLabel = "") {
    const pythonCode = normalizePython(code);
    if (!pythonCode.trim()) { output.textContent = "No code found."; return; }
    status.textContent = `${autoLabel}Starting Python runtime...`;
    output.textContent = "";

    try {
      await ensurePythonRunner();
      status.textContent = `${autoLabel}Running Python...`;
      const result = await sendPythonRunRequest(pythonCode, stdin);
      renderJupyterOutput(output, result.output || "(no output)", false);
      status.textContent = result.ok ? `${autoLabel}Done.` : `${autoLabel}Stopped with an error.`;
    } catch (error) {
      status.textContent = `${autoLabel}Could not run Python.`;
      output.textContent = "Failed to start runtime.\n" + (error?.message || error);
    }
  }

  function runPanelWebCode(jsCode, cssCode, htmlCode, language, status, output, preview, autoLabel = "", stdin = "") {
    const jCode = normalizeCode(jsCode); const cCode = normalizeCode(cssCode); const hCode = normalizeCode(htmlCode);
    if (!jCode && !cCode && !hCode) { output.textContent = "No code found."; preview.srcdoc = ""; return; }
    status.textContent = `${autoLabel}Running ${languageLabel(language)}...`;
    output.textContent = "Console output will appear here.";
    
    if (preview.dataset.objectUrl) URL.revokeObjectURL(preview.dataset.objectUrl);
    preview.removeAttribute("srcdoc");
    
    const htmlContent = buildPanelPreviewDocument(jCode, cCode, hCode, stdin);
    const objectUrl = URL.createObjectURL(new Blob([htmlContent], { type: "text/html" }));
    preview.dataset.objectUrl = objectUrl;
    preview.src = objectUrl;
    status.textContent = `${autoLabel}Done.`;
  }

  // ==========================================================================
  // SHARED UTILITIES
  // ==========================================================================

  function findCodeBlock(startNode) {
    const codeClasses = ["highlight", "doctest", "literal-block", "w3-code", "codecolor", "pythonhigh", "python-high", "htmlhigh", "csshigh", "jshigh", "javascript", "language-html", "language-css", "language-js", "language-javascript", "language-python", "monaco-editor", "cm-content", "view-lines", "react-codemirror2", "editor"];
    let node = startNode?.nodeType === Node.ELEMENT_NODE ? startNode : startNode?.parentElement;
    
    while (node && node !== document.documentElement) {
      const tagName = node.tagName.toLowerCase();
      const classNames = typeof node.className === 'string' ? node.className.toLowerCase() : "";
      if (tagName === "pre" || tagName === "code" || codeClasses.some(c => classNames.includes(c))) {
        return node;
      }
      node = node.parentElement;
    }
    return null;
  }

  function getCodeText(node) {
    if (!node) return "";
    return extractTextWithBreaks(node);
  }

  function extractTextWithBreaks(node) {
    if (!node) return "";
    let code = "";
    
    function traverse(n) {
      if (n.nodeType === Node.TEXT_NODE) {
        code += (n.nodeValue || "").replace(/\u00A0/g, ' ');
      } 
      else if (n.nodeType === Node.ELEMENT_NODE) {
        const tag = n.tagName.toLowerCase();
        
        if (tag === 'br') { code += '\n'; return; }
        if (tag === 'script' || tag === 'style' || tag === 'noscript') return;
        
        if (tag === 'pre') {
          code += (n.textContent || "").replace(/\u00A0/g, ' ');
          return;
        }

        const blockTags = new Set(["div", "p", "li", "tr", "section", "article", "h1", "h2", "h3", "h4", "h5", "h6", "table", "tbody"]);
        const className = typeof n.className === 'string' ? n.className.toLowerCase() : '';
        
        const isBlock = blockTags.has(tag) || className.includes('line') || className.includes('row') || className.includes('cm-line');
        
        if (isBlock && code.length > 0 && !code.endsWith('\n')) {
          code += '\n';
        }
        
        for (let child of n.childNodes) traverse(child);
        
        if (isBlock && code.length > 0 && !code.endsWith('\n')) {
          code += '\n';
        }
      }
    }
    
    traverse(node);
    return code.trim();
  }

  function normalizeCode(rawCode) { 
    return String(rawCode || "").replace(/\u00a0/g, " ").trim(); 
  }

  function normalizePython(rawCode) {
    const text = normalizeCode(rawCode);
    const lines = text.split(/\r?\n/);
    const promptLines = lines.map((line) => {
      const promptMatch = line.match(/^\s*(>>>|\.\.\.)\s?(.*)$/);
      return promptMatch ? promptMatch[2] : null;
    }).filter((line) => line !== null);
    return promptLines.length > 0 ? promptLines.join("\n").trim() : text;
  }

  function detectLanguage(code) {
    const text = normalizeCode(code);
    if (!text) return "python";

    const unsupportedScore = scoreMatches(text, [
      /\b(public|private|protected)\b\s+(static|class|void|int|String|final|Set|List|Map)/,
      /System\.out\.print/,
      /#include\s*</,
      /\bint\s+main\s*\(/,
      /\bstd::/,
      /\busing\s+System;/,
      /\bnamespace\s+[A-Za-z]/,
      /Console\.WriteLine/
    ]);
    if (unsupportedScore > 0) return "unsupported";

    if (/<!doctype html|<html[\s>]|<body[\s>]|<script[\s>]|<style[\s>]/i.test(text)) return "html";
    if (/^\s*</.test(text) && /<\/?[a-z][\s\S]*>/i.test(text)) return "html";

    const withoutCssComments = text.replace(/\/\*[\s\S]*?\*\//g, "").trim();
    const cssDeclarationCount = (withoutCssComments.match(/(^|[{\n;])\s*--?[\w-]+\s*:\s*[^;{}]+;/g) || []).length;
    
    const cssBlockLike = /^[\w\s.#:-]+{[^{}]*}/m.test(withoutCssComments);
    const cssSelectorStart = /^\s*(@media|@supports|@keyframes|:root|[.#]?[a-z][\w-]*(?:\s+[.#]?[a-z][\w-]*)?\s*\{)/i.test(withoutCssComments);
    
    const jsScore = scoreMatches(text, [/\b(const|let|var)\b/, /\bfunction\b/, /\b(document|window|console)\b/, /=>/, /^\s*\/\//m, /\{[\s\S]*"[a-zA-Z0-9_]+"\s*:/, /\b(setTimeout|setInterval|Promise)\b/]);
    const cssScore = (cssBlockLike ? 2 : 0) + (cssSelectorStart ? 2 : 0) + Math.min(cssDeclarationCount, 4) + (/^\s*\/\*/.test(text) ? 2 : 0);

    if (cssScore >= 3 && cssScore >= jsScore) return "css";
    if (jsScore >= 2) return "javascript";

    const pythonScore = scoreMatches(text, [/^\s*(from|import)\s+[A-Za-z_]/m, /^\s*def\s+[A-Za-z_]\w*\s*\(/m, /^\s*class\s+[A-Za-z_]\w*/m, /^\s*(if|elif|else|for|while|try|except|with)\b.*:\s*$/m, /\bprint\s*\(/]);
    if (pythonScore > 0) return "python";
    if (cssScore > 0) return "css";
    return "python";
  }

  function scoreMatches(text, patterns) { return patterns.reduce((score, pattern) => score + (pattern.test(text) ? 1 : 0), 0); }
  function selectedLanguage(select, code) { return select.value !== "auto" ? select.value : detectLanguage(code || select.dataset.detected || ""); }
  
  function languageLabel(language) { 
    if (language === "javascript") return "JavaScript";
    if (language === "unsupported") return "Unsupported";
    return language.toUpperCase(); 
  }
  
  function escapeClosingScript(code) { return String(code).replace(/<\/script/gi, "<\\/script"); }
  function toScriptJson(value) { return escapeClosingScript(JSON.stringify(value)); }
  function parseInputLines(input) {
    let text = String(input || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    if (!text) return [];
    if (text.endsWith("\n")) text = text.slice(0, -1);
    return text.split("\n");
  }

  function pythonPlaceholder() {
    return `<!doctype html><html><body style="margin:0;display:grid;place-items:center;min-height:100vh;font:14px system-ui;color:#5f6368;background:#fff;"><div>Python output appears in the console pane.</div></body></html>`;
  }

  // >>> UPDATED: Local file loader instead of blocked Blobs <<<
  function ensurePythonRunner() {
    if (pythonReadyPromise) return pythonReadyPromise;
    pythonReadyPromise = new Promise((resolve, reject) => {
      pythonFrame = document.createElement("iframe");
      pythonFrame.style.display = "none";
      
      pythonFrame.src = extensionApi.runtime.getURL("python-runner.html");
      pythonFrame.sandbox = "allow-scripts allow-same-origin";
      
      const timeout = window.setTimeout(() => {
        reject(new Error("Timed out loading local Pyodide. Make sure pyodide is compiled and correctly placed in your extension folder."));
      }, 15000);

      const onMessage = (event) => {
        if (event.source !== pythonFrame.contentWindow) return;
        if (event.data?.type === "RUN_CODE_HERE_READY") { 
          window.clearTimeout(timeout); 
          window.removeEventListener("message", onMessage); 
          resolve(); 
        }
        if (event.data?.type === "RUN_CODE_HERE_ERROR") { 
          window.clearTimeout(timeout); 
          window.removeEventListener("message", onMessage); 
          reject(new Error(event.data.error)); 
        }
      };
      
      pythonFrame.addEventListener("error", () => reject(new Error("Python runner iframe failed to load.")));
      document.documentElement.appendChild(pythonFrame);
      window.addEventListener("message", onMessage);
    });
    return pythonReadyPromise;
  }

  // >>> ADDED: The missing function that communicates with the local iframe <<<
  function sendPythonRunRequest(code, stdin = "") {
    return new Promise((resolve, reject) => {
      const runId = ++requestId;
      pendingRuns.set(runId, resolve);
      
      pythonFrame.contentWindow.postMessage({
        type: "RUN_CODE_HERE_EXEC",
        id: runId,
        code: code,
        stdin: stdin
      }, "*");
    });
  }

  // ==========================================================================
  // DOCUMENT BUILDERS
  // ==========================================================================

  function buildPanelPreviewDocument(jsCode, cssCode, htmlCode, stdin = "") {
    const escapedJs = escapeClosingScript(jsCode);
    const inputLinesJson = toScriptJson(parseInputLines(stdin));
    const consoleBridge = `
      <script>
        const __runCodeHereInputLines = ${inputLinesJson};
        const send = (type, args) => {
          parent.postMessage({ source: "run-code-here-panel", type, args: args.map(item => { try { return typeof item === "string" ? item : JSON.stringify(item); } catch { return String(item); } }) }, "*");
        };
        ["log", "info", "warn", "error"].forEach((method) => {
          const original = console[method];
          console[method] = (...args) => { send(method, args); original.apply(console, args); };
        });
        const nativePrompt = window.prompt ? window.prompt.bind(window) : null;
        window.prompt = (message = "", defaultValue = "") => {
          if (__runCodeHereInputLines.length === 0) {
            if (nativePrompt) return nativePrompt(message, defaultValue);
            send("error", ["No input available. Add lines in the Input box before running."]);
            return defaultValue == null ? "" : String(defaultValue);
          }
          const value = __runCodeHereInputLines.shift();
          send("log", [String(message ?? "") + value]);
          return value;
        };
        window.addEventListener("error", (event) => send("error", [event.message]));
        window.addEventListener("unhandledrejection", (event) => send("error", [event.reason]));
      </script>`;

    let doc = htmlCode;
    if (/<html/i.test(doc)) {
      if (/<\/head>/i.test(doc)) doc = doc.replace(/<\/head>/i, `${consoleBridge}\n<style>${cssCode}</style>\n</head>`);
      else doc = `${consoleBridge}\n<style>${cssCode}</style>\n${doc}`;
      if (/<\/body>/i.test(doc)) doc = doc.replace(/<\/body>/i, `<script>${escapedJs}</script>\n</body>`);
      else doc = `${doc}\n<script>${escapedJs}</script>`;
      return doc;
    }
    return `<!doctype html><html><head><meta charset="utf-8">${consoleBridge}<style>${cssCode}</style></head><body>${htmlCode}<script>${escapedJs}</script></body></html>`;
  }

  function buildInlinePreviewDocument(code, language, iframeId) {
    const escapedCode = String(code).replace(/<\/script/gi, "<\\/script");
    const consoleBridge = `
      <script>
        const send = (type, args) => {
          parent.postMessage({ source: "run-code-here-inline", iframeId: "${iframeId}", type, args: args.map(item => { try { return typeof item === "string" ? item : JSON.stringify(item); } catch { return String(item); } }) }, "*");
        };
        ["log", "info", "warn", "error"].forEach((method) => {
          const original = console[method];
          console[method] = (...args) => { send(method, args); original.apply(console, args); };
        });
        window.addEventListener("error", (event) => send("error", [event.message]));
        window.addEventListener("unhandledrejection", (event) => send("error", [event.reason]));
      </script>`;
    if (language === "html") {
      if (/<\/head>/i.test(code)) return code.replace(/<\/head>/i, `${consoleBridge}</head>`);
      return `${consoleBridge}${code}`;
    }
    return `<!doctype html><html><head><meta charset="utf-8">${consoleBridge}</head><body><script>${escapedCode}</script></body></html>`;
  }

  // ==========================================================================
  // GLOBAL MESSAGE LISTENER
  // ==========================================================================

  window.addEventListener("message", (event) => {
    if (event.source === pythonFrame?.contentWindow && event.data?.type === "RUN_CODE_HERE_RESULT") {
      const resolve = pendingRuns.get(event.data.id);
      if (resolve) { pendingRuns.delete(event.data.id); resolve(event.data); }
      return;
    }

    if (event.data?.source === "run-code-here-panel") {
      const output = document.querySelector("#run-code-here-panel .rch-output");
      if (!output) return;
      const existing = output.textContent === "Console output will appear here." || output.textContent === "Tool support is not available right now for languages other than Python, JavaScript, CSS, and HTML." ? "" : output.textContent;
      const prefix = event.data.type === "error" ? "Error: " : "";
      output.textContent = `${existing}${prefix}${event.data.args.join(" ")}\n`;
      return;
    }

    if (event.data?.source === "run-code-here-inline") {
      const iframe = document.getElementById(event.data.iframeId);
      if (!iframe) return;
      const container = iframe.parentElement;
      const logLine = document.createElement("div");
      logLine.className = "rch-inline-console-log";
      if (event.data.type === "error") {
        logLine.classList.add("rch-inline-console-error");
        logLine.textContent = "Error: " + event.data.args.join(" ");
      } else {
        logLine.textContent = event.data.args.join(" ");
      }
      container.appendChild(logLine);
      try { iframe.style.height = iframe.contentWindow.document.documentElement.scrollHeight + 'px'; } catch(e) {}
    }
  });

  function renderJupyterOutput(container, text, isInline) {
    if (isInline) {
      if (!text || text === "(no output)") {
        container.innerHTML = `<div class="rch-inline-console-log" style="color: #64d2ff;">(no output)</div>`;
        return;
      }
      const segments = text.split("\n").filter((l, i, arr) => !(i === arr.length - 1 && l === ""));
      segments.forEach(line => {
        const isError = line.startsWith("Traceback") || line.startsWith("Error") || line.includes("Error:");
        const div = document.createElement("div");
        div.className = "rch-inline-console-log" + (isError ? " rch-inline-console-error" : "");
        div.textContent = line;
        container.appendChild(div);
      });
      return;
    }

    container.innerHTML = "";
    if (!text || text === "(no output)") {
      const empty = document.createElement("span");
      empty.style.color = "#4a4a4d";
      empty.textContent = "(no output)";
      container.appendChild(empty);
      return;
    }
    const imgRegex = /<img\s+src="(data:image\/[^"]+)"\s*\/?>/g;
    const tableRegex = /<table[\s\S]*?<\/table>/g;
    let lastIndex = 0, match, segments = [];
    const allMatches = [];
    for (const regex of [imgRegex, tableRegex]) {
      regex.lastIndex = 0;
      while ((match = regex.exec(text)) !== null) allMatches.push({ index: match.index, end: match.index + match[0].length, raw: match[0], type: regex === imgRegex ? "img" : "table" });
    }
    allMatches.sort((a, b) => a.index - b.index);
    for (const seg of allMatches) {
      if (seg.index > lastIndex) segments.push({ type: "text", content: text.slice(lastIndex, seg.index) });
      segments.push(seg);
      lastIndex = seg.end;
    }
    if (lastIndex < text.length) segments.push({ type: "text", content: text.slice(lastIndex) });
    if (segments.length === 0) segments.push({ type: "text", content: text });

    for (const seg of segments) {
      if (seg.type === "img") {
        const cell = document.createElement("div");
        cell.style.cssText = "margin:8px 0;padding:8px;background:#1a1a1c;border-radius:6px;border-left:3px solid #0a84ff;box-shadow:inset 0 2px 4px rgba(0,0,0,0.5);";
        const label = document.createElement("div"); label.style.cssText = "color:#8e8e93;font-size:11px;margin-bottom:6px;"; label.textContent = "Out [ image ]";
        const img = document.createElement("img"); img.src = seg.raw.match(/src="([^"]+)"/)[1]; img.style.cssText = "max-width:100%;border-radius:4px;display:block;";
        cell.appendChild(label); cell.appendChild(img); container.appendChild(cell);
      } else if (seg.type === "table") {
        const cell = document.createElement("div");
        cell.style.cssText = "margin:8px 0;padding:8px;background:#1a1a1c;border-radius:6px;border-left:3px solid #30d158;overflow-x:auto;box-shadow:inset 0 2px 4px rgba(0,0,0,0.5);";
        const label = document.createElement("div"); label.style.cssText = "color:#8e8e93;font-size:11px;margin-bottom:6px;"; label.textContent = "Out [ dataframe ]";
        const tableWrap = document.createElement("div"); tableWrap.innerHTML = seg.raw;
        const table = tableWrap.querySelector("table");
        if (table) {
          table.style.cssText = "border-collapse:collapse;font-size:12px;color:#00ff41;width:100%;";
          table.querySelectorAll("th").forEach(th => th.style.cssText = "padding:4px 10px;background:#252528;border:1px solid #3a3a3c;text-align:left;color:#64d2ff;");
          table.querySelectorAll("td").forEach(td => td.style.cssText = "padding:4px 10px;border:1px solid #3a3a3c;color:#00ff41;");
        }
        cell.appendChild(label); cell.appendChild(tableWrap); container.appendChild(cell);
      } else {
        const lines = seg.content.split("\n").filter((l, i, arr) => !(i === arr.length - 1 && l === ""));
        for (const line of lines) {
          const cell = document.createElement("div"); cell.style.cssText = "margin:2px 0;";
          const isError = line.startsWith("Traceback") || line.startsWith("Error") || line.includes("Error:");
          const pre = document.createElement("pre");
          pre.style.cssText = `margin:0;padding:4px 8px;border-radius:3px;white-space:pre-wrap;word-break:break-all;color:${isError ? "#ff4f40" : "#00ff41"};background:${isError ? "rgba(255,79,64,0.15)" : "transparent"};border-left:${isError ? "3px solid #ff4f40" : "3px solid transparent"};`;
          pre.textContent = line; cell.appendChild(pre); container.appendChild(cell);
        }
      }
    }
  }

})();