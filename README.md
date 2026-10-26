# recent-sessions

A Claude Code mod for the Claude desktop app. It adds a Recent panel to the Code tab that lists your sessions by when each one last finished, inside their sidebar groups, with the group that finished most recently at the top.

![The Recent panel open beside a Code session, with the session list blurred](docs/screenshot.png)

The app's sidebar sorts the sessions in a group by last activity, and that time keeps moving while a session works. So when several sessions are busy and one finishes, the finished one drops below the ones still running. The groups themselves stay in the order you dragged them into. Mods can't reorder the sidebar, so this panel gives you a second view of it:

- When a session finishes, it moves to the top of its group, and its whole group moves to the top of the panel.
- A session that's still working keeps its place and shows "working". It moves up once it's done.
- Sessions stay in their sidebar groups, pinned ones included. Ungrouped ones sit together under "Ungrouped".
- Click a session to open it, as you would in the sidebar. A session that finished under a minute ago shows "now" in green.

Type `/recent` to open or close the panel. While you leave it open, new sessions open it too, and a session that was already running opens it the next time you send it a message. Closing it in any session turns that off.

The session list comes from the desktop app, so the panel only works in its Code tab. In a terminal session it says so and stays empty. It needs a Claude Code version that runs mods; it was built and tested on 2.1.308 with desktop app 3.6556.

## Install

At the prompt of a terminal session:

```
/plugin install recent-sessions --marketplace kevlar10x/recent-sessions
```

Answer `y` to add the marketplace, then pick the user scope.

From a shell:

```bash
claude plugin install recent-sessions --marketplace kevlar10x/recent-sessions
```

In the desktop app, where `/plugin` doesn't run: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `kevlar10x/recent-sessions`, then **Add plugin**.

## How much it costs to run

The panel reads the session list only while it's open and its session is on screen: every 3 seconds while any session is working, every 8 seconds when none is. When its session is in the background, it only checks every 5 seconds whether it's back on screen. It redraws only when something it shows has changed, and it keeps nothing but that list and one timestamp per session.

## Privacy

The panel reads your sessions' titles, sidebar groups, working state, last activity times and app links from the desktop app. It saves one finish time per session, and whether you last left the panel open, in the mod's own storage on your computer. It makes no network requests. Clicking a session hands its `claude://` link to Windows Explorer (`open` on macOS), which passes it to the desktop app.

## What it calls and runs

While the panel is open, the mod calls three tools of the desktop app's own session servers (`ccd_session_mgmt` and `ccd_window`) on its own timer, without Claude asking for them:

- `list_sessions` (up to 60 sessions) and `get_session` for the session the panel is in, which give titles, sidebar groups, working state, last activity times and `claude://` links.
- `get_window_layout`, which says whether that session is on screen, so the panel can stop reading while it isn't.

All three only read, and they talk to the desktop app on your computer. The mod sends nothing anywhere and fetches nothing from the network.

The one program it starts is the system's link opener, and only when you click a session: `explorer.exe <link>` on Windows, `open <link>` on macOS. `<link>` is that session's `claude://claude.ai/epitaxy/...` link from the app, and the mod checks it against that exact pattern first.

It also hooks two events. On `prompt.submit` it checks whether you last left the panel open and, if so, opens it in that session; your prompt passes on unchanged. On `ui.close` it stops reading the session list and remembers that you closed the panel.

## Limits

- Tested on Windows. Opening a session from the panel on macOS hasn't been tested.
- The app's session list doesn't say when a session is waiting for your answer or approval, so a session stopped at a question may still show as working.
- It lists your 60 most recent sessions, up to 8 per group, and counts the rest as "+n more".

## Uninstall

```bash
claude plugin uninstall recent-sessions
```

## License

MIT, by kevlar10x. The original is at https://github.com/kevlar10x/recent-sessions.

If you'd like to leave a tip: https://ko-fi.com/kevlar10x
