const extensionApi = globalThis.browser || globalThis.chrome;

extensionApi.runtime.onInstalled.addListener(() => {
  installContextMenu();
});

function installContextMenu() {
  extensionApi.contextMenus.removeAll(() => {
    clearLastError();
    const menu = {
      id: "run-code-here",
      title: "Run code here",
      contexts: ["selection", "page"]
    };
    extensionApi.contextMenus.create(menu, () => {
      clearLastError();
    });
  });
}

extensionApi.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== "run-code-here" || !tab?.id) return;

  const message = {
    type: "RUN_CODE_HERE",
    selectionText: info.selectionText || ""
  };

  // >>> THE FIX: Target only the specific frame you clicked to prevent duplicates <<<
  extensionApi.tabs.sendMessage(tab.id, message, { frameId: info.frameId }, () => {
    clearLastError();
  });
});

function clearLastError() {
  void extensionApi.runtime.lastError;
}