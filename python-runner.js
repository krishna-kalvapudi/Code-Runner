let pyodide;

async function main() {
  try {
    pyodide = await loadPyodide({
      indexURL: chrome.runtime.getURL("pyodide/")
    });
    window.parent.postMessage({ type: "RUN_CODE_HERE_READY" }, "*");
  } catch (error) {
    window.parent.postMessage({ 
      type: "RUN_CODE_HERE_ERROR", 
      error: "Failed to initialize Pyodide: " + error.message 
    }, "*");
  }
}

window.addEventListener("message", async (event) => {
  if (event.data?.type === "RUN_CODE_HERE_EXEC") {
    try {
      let output = "";
      
      // 1. Safely capture print() statements
      pyodide.setStdout({ batched: (msg) => { output += msg + "\n"; } });
      pyodide.setStderr({ batched: (msg) => { output += msg + "\n"; } });
      
      // 2. Safely mock Python's input() function.
      // We do this inside Python rather than using Pyodide's low-level setStdin() 
      // because passing strings to the raw WebAssembly buffer causes it to crash!
      const inputLines = event.data.stdin ? event.data.stdin.split('\n') : [];
      pyodide.globals.set("__rch_inputs", inputLines);
      await pyodide.runPythonAsync(`
        import builtins
        def _mock_input(prompt=""):
            if __rch_inputs:
                return str(__rch_inputs.pop(0))
            return ""
        builtins.input = _mock_input
      `);
      
      // 3. Run the user's actual code
      const result = await pyodide.runPythonAsync(event.data.code);
      
      // 4. If they typed a direct expression (like "2 + 2" or "x"), append the result!
      if (result !== undefined) {
         output += result.toString() + "\n";
      }
      
      window.parent.postMessage({
        type: "RUN_CODE_HERE_RESULT",
        id: event.data.id,
        ok: true,
        output: output.trim() 
      }, "*");
      
    } catch (error) {
      window.parent.postMessage({
        type: "RUN_CODE_HERE_RESULT",
        id: event.data.id,
        ok: false,
        output: error.message
      }, "*");
    }
  }
});

main();