# Code Runner

Code Runner is a Chrome extension that lets you run code snippets from the page you are viewing. Select a snippet or right-click a code block, choose **Run code here**, and execute Python, JavaScript, HTML, or CSS in an in-page panel.

## Features

- Runs Python, JavaScript, HTML, and CSS snippets without opening a separate editor.
- Detects the likely language automatically; you can override it from the language selector.
- Accepts multiline input for Python `input()` calls and JavaScript `prompt()` calls.
- Bundles Pyodide and common Python packages, so many Python examples work without downloading a runtime at execution time.

## Install locally

Code Runner is currently installed as an unpacked extension:

1. Download or clone this repository.
2. In Chrome, open `chrome://extensions`.
3. Turn on **Developer mode**.
4. Click **Load unpacked**.
5. Select the cloned `Code-Runner` folder.

## Use

1. Open a page containing a Python, JavaScript, HTML, or CSS snippet.
2. Select the code or right-click directly on its code block.
3. Choose **Run code here** from the context menu.
4. Review the detected language, add input if needed, then select **Run**.

The first Python execution can take a few seconds while the bundled Pyodide runtime starts.

## Permissions

The extension requests the following Chrome permissions:

- `contextMenus` to add **Run code here** to the right-click menu.
- `activeTab` and `scripting` to read the selected snippet and display the runner on the active page.
- Access to matching pages so the runner can work wherever code snippets appear.

## Python support

The bundled runtime includes commonly used packages such as NumPy, pandas, SciPy, scikit-learn, matplotlib, SymPy, requests, Beautiful Soup, lxml, NetworkX, SQLAlchemy, Pillow, and more. Standard-library modules such as `math` work without additional loading.

## Limitations

- Intended for learning, exploration, and small snippets—not untrusted or production workloads.
- Python runs in the browser sandbox; it cannot access local files, installed system packages, or the operating system.
- Sites with strict content-security policies can prevent the runner from loading.
- The repository is relatively large because it includes the Pyodide runtime and bundled Python packages.

## License

No license has been selected yet. Add a license before distributing or accepting outside contributions.
