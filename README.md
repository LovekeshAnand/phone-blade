# Phone Blades

A rhythm slicing game where your phones are the blades. Next.js 16 + TypeScript + Tailwind + three.js.

```bash
npm install
npm run build && npm start   # play (fast)
npm run dev                  # develop (hot reload)
npm test
```

- **PC:** open http://localhost:3000. That's the game screen.
- **Phones (same Wi-Fi):** scan the QR code on the screen. The certificate is self-made, so tap *Advanced → Proceed*. Any phone that opens the site becomes a remote.
- **1 phone = solo blade** (one colour, every lane). **2 phones = dual blades.** The game adapts live as phones join or leave.
- **Your own songs:** pick or drop an MP3/M4A/WAV in the lobby. It's beat-tracked in the browser and never uploaded.
- Hold the phone like a sword handle, with the top edge as the blade. Point at the screen and tap to recenter.

Tuning knobs (smoothing, swing speed, reach) are at the top of `lib/engine.ts`.
