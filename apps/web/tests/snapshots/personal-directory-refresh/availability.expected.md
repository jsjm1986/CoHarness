## Selected environment
- region "Automation tasks":
  - heading "Automation tasks" [level=1]
  - button "New":
    - img
    - text: New
  - button "Choose task environment":
    - text: Compute computer
    - img
  - group "Task status":
    - button "All" [pressed]
    - button "Enabled"
    - button "Inactive"
  - img
  - searchbox "Search tasks"
  - status:
    - img
    - heading "No tasks yet. Tasks created in your sessions appear here." [level=2]
    - button "New automation task"
  - list "Task catalog"

## Explicit refresh while offline
- region "Automation tasks":
  - heading "Automation tasks" [level=1]
  - button "New" [disabled]:
    - img
    - text: New
  - button "Choose task environment" [expanded]:
    - text: Compute computer
    - img
  - status:
    - text: This environment is currently unavailable. Select another environment or retry after access is restored.
    - button "Retry"
  - group "Task status":
    - button "All" [pressed]
    - button "Enabled"
    - button "Inactive"
  - img
  - searchbox "Search tasks"
  - list "Task catalog"

## Explicit retry after recovery
- region "Automation tasks":
  - heading "Automation tasks" [level=1]
  - button "New":
    - img
    - text: New
  - button "Choose task environment":
    - text: Compute computer
    - img
  - group "Task status":
    - button "All" [pressed]
    - button "Enabled"
    - button "Inactive"
  - img
  - searchbox "Search tasks"
  - status:
    - img
    - heading "No tasks yet. Tasks created in your sessions appear here." [level=2]
    - button "New automation task"
  - list "Task catalog"

Explicit refresh and retry did not prepare another Runtime.
