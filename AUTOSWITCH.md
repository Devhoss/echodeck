## Auto-Switch
Auto-switch automatically changes your active deck page when you switch apps on your PC. When disabled, your page will never change on its own.

### Rules & Conditions
Each page can have one rule consisting of a list of conditions that determine when the page should activate. Conditions check the currently focused window based on:

*   **Process:** The `.exe` name (e.g., `Code.exe`, `chrome.exe`)
*   **Window title:** The text in the title bar (e.g., `Untitled - Notepad`)
*   **Executable path:** The full file path (e.g., `C:\Program Files\...`)

Each condition uses an operator (such as *equals*, *contains*, or *starts with*) to match the specified value.

### Logic: AND vs OR

When multiple conditions are applied to a single rule:

* **AND:** All conditions must match for the page to activate.
* **OR:** Any single matching condition is sufficient.

### Priority

If multiple pages have matching rules for the current app, priority determines which page wins. 
*   **Lower number = Higher priority** (e.g., priority 10 beats priority 100).
*   If pages are assigned to different apps, priority settings do not matter.

### Rule Toggle
The checkbox next to a rule is an enabled toggle. Uncheck this to temporarily

### Practical Example

You can configure your deck to switch pages automatically based on the active application:

*   **Streaming Page Rule:** Process equals `obs64.exe` (Priority: 100)
*   **Coding Page Rule:** Process equals `Code.exe` (Priority: 100)

**Behavior:**
*   Clicking into **OBS** flips the deck to the **Streaming** page.
*   Clicking into **VS Code** flips the deck to the **Coding** page.
*   Clicking any other application keeps the deck on the last active page.
