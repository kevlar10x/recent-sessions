# recent-sessions

A Claude Code mod for the Claude desktop app. It adds a Recent panel to the Code tab that lists your sessions by when each one last finished, inside their sidebar groups, with the group that finished most recently at the top.

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
