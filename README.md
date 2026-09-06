# Tmux Session Tabs

A small VS Code extension that attaches ordinary integrated terminals to tmux on
your server. Requires `tmux` on the remote machine's PATH.

## Install

Download the `.vsix` file from the
[latest release](https://github.com/RoidaVinci/tmux-session-tabs/releases/latest).

Connect to the server using VS Code Remote SSH. Run **Extensions: Install from
VSIX...** and select `tmux-session-tabs-0.2.1.vsix`. Install on the SSH host, then
run **Developer: Reload Window**. The **Tmux Sessions** view is in Explorer.

## Sessions

Session cards are stacked vertically. Their button tint, border, and label show:

- Green, **OPEN HERE**: a terminal is open in this VS Code window.
- Blue, **ATTACHED**: another tmux client is attached.
- Amber, **BACKGROUND**: alive on the server without an attached client.
- Grey dashed, **OFF**: a saved entry whose tmux session no longer exists.

That is also their sort order. Within each group, most recent tmux activity comes
first, followed by alphabetical order for ties. Timestamps use your VS Code
client's local time. They represent tmux activity, not shell command history or
whether a particular process is currently computing.

Click a session name to open its terminal. Only terminals left open in this
workspace are reopened after a disconnect or window reload. Sessions running in
the background, or attached on another client, remain listed without being opened.
Restoration starts when the extension activates, even if the sidebar is hidden.

The X button closes this workspace's terminal for that session and removes it
from the reopen list. Closing the terminal in VS Code's terminal panel has the
same effect. The tmux session keeps running in the background. Window shutdown
and connection loss preserve the last open set. OFF entries are history; this
extension does not resurrect processes after a server reboot.

Version 0.2.1 ignores the old accumulated restore list. On upgrade, it starts
tracking the terminals actually present in the workspace. Extra terminal tabs
already opened by the previous version can be closed once; they will then stay
closed on subsequent reconnects.

The trash button requires a modal confirmation and the exact session name. The
extension checks that the same tmux session still exists before terminating it by
its unique ID. Removing an OFF entry only removes its saved history.

## Settings

- `tmuxSessionTabs.autoRestore`: reopens the last open terminals (default `true`).
- `tmuxSessionTabs.pollIntervalMs`: refresh interval (default `2500`).

Uses the normal default tmux server/socket. No subscription or external service.

## Privacy

The extension stores session names, working directories, window counts, and last
activity timestamps in VS Code's extension storage. It stores the list of open
terminals in workspace storage for reconnect restore. These records are outside
this source directory and are not included in the VSIX package.

The extension does not collect terminal contents, command history, credentials,
or telemetry, and makes no external network requests. It invokes the local tmux
executable and uses the VS Code extension API. Tests and preview screenshots use
fictional project names. Generated screenshots and VSIX packages are ignored by
Git; a VSIX can be attached separately to a GitHub release.

## Development

Run `npm test` for the state, reconnect, and deletion guard tests. The extension
has no runtime npm dependencies.

To build an installable package, run `npx @vscode/vsce package --no-dependencies`.

## Icons

Codicons are from [Microsoft's vscode-codicons project](https://github.com/microsoft/vscode-codicons),
distributed under CC BY 4.0. The bundled CSS/font is unchanged from VS Code's
simple-browser extension. See `media/LICENSE-codicons`.
