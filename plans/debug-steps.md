# Steps to Debug

1. **In Emu**: Press **Cmd+Option+I** (or right-click → Inspect Element) to open DevTools

2. **In the DevTools console tab**, paste these two lines and press Enter:
```js
localStorage.setItem('emu.debugScrollWheel','1')
localStorage.setItem('emu.debugScrollFollow','1')
```

3. **Reload Emu** with **Cmd+R**

4. **In Emu's terminal**, run `opencode` and ask it something (e.g. "list 50 numbers")

5. **Scroll up and down** with your trackpad while the AI is responding

6. **Tell me** what you see in the DevTools console — any `[scroll-wheel]` or `[scroll-follow]` messages appearing? Or nothing at all?

**I'm watching my terminal on my end.** I'll see the same logs piped through.
