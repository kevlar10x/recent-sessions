# Changelog

## 0.1.3 - 2026-10-28

- The panel goes quiet while you look at another session and reads the list again the moment you come back. Before, it checked every 5 seconds whether you were back.
- It reads the session it sits in only when that one can have changed, so it calls the app less: 22 times a minute instead of 60 while a session works, 10 instead of 24 when none is, and none instead of 12 while you look at another session.
- If you rename the session the panel is in, or move it to another group, its own row can take up to 30 seconds to show that.

## 0.1.2 - 2026-10-27

- With the Recent panel open in more than one session, one panel could save an older finish time over a newer one that another panel had saved, so a session sat lower than it should. Each panel now keeps the later time.
- The README links the other kevlar10x mods.
- The plugin listing has a display name, an icon and a short description.
- The README lists the app tools the mod calls, the one program it starts, and what its two hooks do.

## 0.1.1 - 2026-10-26

- The session you're in now lines up with the other rows in the panel. Clicking it shows that session.
- The README has a screenshot of the panel.

## 0.1.0 - 2026-10-26

- First release. `/recent` opens a Recent panel that lists your Code sessions by when each last finished, inside their sidebar groups. The group with the newest finish sits on top.
- A session that's still working keeps its place and shows "working" until it's done.
- Click a session in the panel to open it.
- While you leave the panel open, new sessions open it too, and a running session opens it on your next message there.
