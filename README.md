# Run Code Here

A local Chrome extension that adds a right-click menu item named **Run code here**.

For the full GitHub project overview, architecture notes, and diagrams, see the root `README.md` and `docs/NOTES.md`.

## Install

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder:

   `/Users/krishnakalvapudi/Documents/Codex/2026-05-16/how-do-i-run-a-code/run-code-here-extension`

## Use

1. Open a page with Python, HTML, CSS, or JavaScript code.
2. Right-click directly on a code block, or select code first and then right-click.
3. Click **Run code here**.
4. The code runs in a small panel on the same page.

The language selector defaults to **Auto**, but you can manually choose Python, HTML, CSS, or JavaScript before pressing **Run**.
If the snippet asks for input, type each response on its own line in the **Input** box before pressing **Run**. Python `input()` and browser `prompt()` calls consume those lines in order.

The first Python run can take a few seconds because it starts Pyodide, a Python runtime for the browser. The core runtime is bundled with the extension so pages with strict script policies are less likely to block it.
If your Python code imports common bundled packages, the extension loads them automatically. Built-in modules like `math` work without extra loading.

Bundled Python packages include:

- Data/science: `numpy`, `pandas`, `scipy`, `scikit-learn`, `statsmodels`, `xarray`
- Plotting/math: `matplotlib`, `sympy`, `altair`
- Web/parsing: `requests`, `beautifulsoup4`/`bs4`, `lxml`, `pyodide-http`
- Utilities: `networkx`, `sqlalchemy`, `sqlite3`, `regex`, `tqdm`, `pyyaml`, `pydantic`, `jinja2`, `jsonschema`, `nltk`, `xlrd`, `micropip`, `pillow`

## Notes

- This is for learning examples and small snippets.
- Pages with very strict security rules may block the embedded runtime.
- Code that needs local files, installed system packages, or operating system access will not work in the browser sandbox.
- The extension folder is larger because it includes Pyodide plus common package support.
