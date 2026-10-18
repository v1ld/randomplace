# OLED care on KDE Plasma: setup notes

How this desktop is set up to keep OLED burn-in risk low, and why. These notes are specific to this machine; [RandomPlace](README.md), the window-placement script, has its own README.

## The setup

| | |
|---|---|
| **Monitor** | Alienware AW3926QW: 39-inch LG OLED with an RGB-stripe subpixel layout. The three-year warranty covers burn-in. |
| **Mode** | 5120×2160 at 165 Hz, scale 1.2, so 4267×1800 logical pixels. VRR off. |
| **Monitor preset** | TrueBlack 500, chosen for accuracy over the 1,300-nit modes. |
| **Desktop** | KDE Plasma 6.8 on Wayland, HDR on, Wide Color Gamut on. |

What `kscreen-doctor -o` reported, with SDR brightness since changed to 175:

```
HDR:                   enabled
SDR brightness:        150 nits          (now 175, set in the HDR calibration wizard)
SDR gamut wideness:    0%
Peak brightness:       519 nits, overridden with: 500 nits
Max average brightness: 315 nits
Min brightness:        0.0003 nits
Wide Color Gamut:      enabled
Color profile source:  sRGB
Color power preference: prefer accuracy
Brightness control:    supported, set to 100% and dimming to 100%
```

## What's in place

| Measure | Setting | Why |
|---|---|---|
| No fixed elements on screen | All panels and taskbars hidden | Anything that never moves is the classic burn-in source. |
| Desktop background | Black (#000000), not rotating | A black OLED pixel is off and doesn't wear at all. A rotating wallpaper wouldn't cancel window-border wear. It would only add wear wherever the wallpaper shows, aging the whole panel faster to get a slightly more even result. |
| Lock screen | Black; monitor suspends 1 minute after locking | Same reason. |
| Screen off when idle | Power Management: dim after a few minutes, screen off after 5–10 minutes | Covers walking away without locking. |
| Window placement | RandomPlace 2.0.1: random placement, wear map, automatic reshuffle every 45 minutes while idle, drift | Stops window borders and title bars repeating on the same lines. See its README. |
| Dark themes | Breeze Dark for Plasma and apps; dark mode in Steam and elsewhere | Fewer lit pixels means less wear. |
| Bright web pages | Dark Reader in the Zen browser | A full-screen white page is a far bigger emitter than any window border, and many sites paint their own white backgrounds whatever the theme. |
| Inactive windows | Dim Inactive effect at strength 55 | On a 39-inch screen most visible windows are inactive. Dimming them cuts their output, and therefore their wear. |
| Brightness | SDR brightness 175 nits for daytime; still testing day and night levels | See below. This is the biggest single lever. |
| HDR peak | TrueBlack 500, calibrated peak 500 nits | Highlights are capped at what the mode delivers, with no clipping or tone-mapping surprises. |
| Game HUDs | HUD brightness lowered in games that allow it | HUDs are static and drawn near "paper white". |
| Monitor | Pixel shift on; left on standby power; pixel refresh allowed to run; registered for the warranty | See "Monitor maintenance". |
| White point | Night Light **not** used, to keep colour accurate | A warmer white point would spare the blue subpixels (usually the shortest-lived), at the cost of colour accuracy. Declined for that reason. |

## Brightness: why it matters most

OLED wear rises faster than brightness does. As a rough guide, the aging rate goes with brightness raised to a power somewhere between 1.5 and 2. So a 20% lower brightness gives very roughly 30–40% slower wear. The exact curve is panel-specific and LG doesn't publish it for this panel, so treat those figures as approximate.

- **Where SDR brightness is set in Plasma 6.7/6.8.** The SDR brightness slider is gone from Display settings. It is now set in the HDR calibration wizard: the first screen sets the maximum brightness, the second the SDR brightness. `kscreen-doctor -o` shows the current value read-only.
- **Sensible range.** Reference white for SDR content is about 100–120 nits. 150–200 is comfortable in a normally lit room. 175 nits for daytime is in that range.
- **Evening dimming.** The ordinary brightness control (the Brightness and Color applet, or the brightness keys) still works in HDR mode and scales everything down from the SDR level. `kscreen-doctor` shows `Brightness control: supported, set to 100%`. That makes it the lever for a dimmer evening setting. Once comfortable day and night levels are settled, a small user timer could switch between them. Check `kscreen-doctor --help` for a brightness option first.

## Games

### HDR games

KWin scales HDR content relative to the SDR brightness ("reference white"). KWin's HDR developer gives the rule as:

> output = input × output reference ÷ input reference

The input reference for HDR content is the standard 203 nits. With SDR brightness at 175:

- **Ordinary scene content, HUDs and menus**, which usually sit near paper white, come out at about 175 / 203 ≈ 86%, roughly 14% dimmer than a 203-nit setup. That's about a fifth of a camera stop, which is easy not to notice.
- **Bright highlights** are scaled too. Anything heading past 500 nits is compressed into TrueBlack 500's peak anyway, so the brightest highlights look much the same.
- **For burn-in:** HUDs follow the SDR brightness, so they wear less at 175 than at 203, and less again with in-game HUD brightness lowered. Peaks are capped by TrueBlack 500 regardless. Most wear comes from mid-tones and white UI, which is exactly what SDR brightness controls.
- **"Max average brightness: 315 nits"** is reported by the monitor. It's the highest brightness the panel can sustain across the whole screen at once, and brighter full-screen scenes are pulled down by the panel's own limiter. KWin passes it to HDR games so they can tone-map large bright areas sensibly. It is not an SDR brightness default, and changing SDR brightness doesn't change it.
- **In-game HDR settings:** set the game's HDR paper white to 203 and its peak to 500, then let KWin scale. A game whose paper white is set much higher brightens HUDs regardless of the desktop setting. Lowering the in-game paper white or HUD brightness reduces HUD wear further.

This scaling rule comes from a 2025 post describing Plasma 6.3, so some details may differ in 6.8.

### SDR games

SDR games (most games, and any with HDR switched off) show their white at exactly the SDR brightness. At 175 nits that's about 17% brighter than at 150. So raising SDR brightness from 150 to 175 made SDR games slightly brighter, not dimmer.

### Fullscreen in general

RandomPlace doesn't move fullscreen windows, and its automatic reshuffle and drift pause while anything is fullscreen. Static HUDs are the main burn-in risk in long gaming sessions. Lower HUD brightness or opacity where a game allows it, and vary what you play.

## Monitor maintenance

- **Pixel shift:** on. Dell says its Alienware OLEDs move the image by one pixel every three minutes.
- **Automatic pixel refresh:** runs when the monitor goes into standby after use. Leave the monitor on standby power and don't switch it off at the wall or on a power strip, or the refresh can't run.
- **Manual panel refresh:** use sparingly. It's meant for when image retention is actually visible. Running it often adds no protection and can use up some of the panel's compensation range. Check the monitor manual for Dell's guidance on this model.
- **Warranty:** three years, including burn-in. Monitor registered; keep the receipt.

## Tracking actual wear

After a few weeks of use, run RandomPlace's wear report now and then:

```bash
python3 ~/.local/share/kwin/scripts/randomplace/contents/helper/wear-report.py
```

It shows how evenly window borders and title bars have spread across the screen. A rising peak/mean figure, or a hot band on the heat map, signals a problem long before the panel shows it.

## Sources

- [Engadget: The Alienware AW3926QW is the world's first 39-inch 5K OLED monitor with an RGB stripe panel](https://engadget.com/2184082/the-alienware-aw3926qw-is-the-world-s-first-39-inch-5k-oled-monitor-with-an-rgb-stripe-panel)
- [Dell: Alienware OLED Monitors Pixel Shift or Pixel Orbiter](https://www.dell.com/support/kbdoc/en-us/000197755/Alienware-34-Curved-Oled-Monitor-Aw3423dw-Pixel-Shift-Pixel-Orbiter)
- [Xaver Hugl (KWin): On brightness and calibrating your displays](https://planet.kde.org/xavers-blog-2025-03-31-on-brightness-and-calibrating-your-displays)
- [KDE Discuss: HDR calibration gone?](https://discuss.kde.org/t/hdr-calibration-gone/48034)
- [KDE Discuss: Does the SDR brightness still affect HDR brightness in Plasma 6.4?](https://discuss.kde.org/t/does-the-sdr-brightness-still-affect-hdr-brightness-in-plasma6-4/34651)
