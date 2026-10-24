# OLED care on KDE Plasma: setup notes

How this desktop is set up to keep OLED burn-in risk low, and why. These notes are specific to this machine; [RandomPlace](README.md), the window-placement script, has its own README.

## The setup

| | |
|---|---|
| **Monitor** | Alienware AW3926QW: 39-inch LG OLED with an RGB-stripe subpixel layout. The three-year warranty covers burn-in. |
| **Mode** | 5120×2160 at 165 Hz, scale 1.2, so 4267×1800 logical pixels. VRR off. |
| **Monitor preset** | TrueBlack 500, chosen for accuracy over the 1,300-nit modes. |
| **Desktop** | KDE Plasma 6.8 on Wayland, HDR on, Wide Color Gamut on. |
| **GPU** | NVIDIA GeForce RTX 5070 Ti, proprietary driver 615. The AMD integrated GPU is present but inactive. |

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
| Window placement | RandomPlace 2.0.3: random placement, wear map, automatic reshuffle every 45 minutes while idle, drift | Stops window borders and title bars repeating on the same lines. See its README. |
| Dark themes | Breeze Dark for Plasma and apps; dark mode in Steam and elsewhere | Fewer lit pixels means less wear. |
| Bright web pages | Dark Reader in the Zen browser | A full-screen white page is a far bigger emitter than any window border, and many sites paint their own white backgrounds whatever the theme. |
| Inactive windows | Dim Inactive effect at strength 55 | On a 39-inch screen most visible windows are inactive. Dimming them cuts their output, and therefore their wear. |
| Brightness | SDR brightness 175 nits for daytime; still testing day and night levels | See below. This is the biggest single lever. |
| HDR peak | TrueBlack 500, calibrated peak 500 nits | Highlights are capped at what the mode delivers, with no clipping or tone-mapping surprises. |
| HDR video in the browser | Off in Zen by choice; YouTube plays its SDR version | Correct HDR in Zen needs GPU decoding, which on this machine means turning off the browser's decoder sandbox. Not worth the security cost for the little HDR content there is. See "HDR". |
| Game HUDs | HUD brightness lowered in games that allow it | HUDs are static and drawn near "paper white". |
| Monitor | Pixel shift on; left on standby power; pixel refresh allowed to run; registered for the warranty | See "Monitor maintenance". |
| White point | Night Light **not** used, to keep colour accurate | A warmer white point would spare the blue subpixels (usually the shortest-lived), at the cost of colour accuracy. Declined for that reason. |

## Brightness: why it matters most

OLED wear rises faster than brightness does. As a rough guide, the aging rate goes with brightness raised to a power somewhere between 1.5 and 2. So a 20% lower brightness gives very roughly 30–40% slower wear. The exact curve is panel-specific and LG doesn't publish it for this panel, so treat those figures as approximate.

- **Where SDR brightness is set in Plasma 6.7/6.8.** The SDR brightness slider is gone from Display settings. It is now set in the HDR calibration wizard: the first screen sets the maximum brightness, the second the SDR brightness. `kscreen-doctor -o` shows the current value read-only.
- **Sensible range.** Reference white for SDR content is about 100–120 nits. 150–200 is comfortable in a normally lit room. 175 nits for daytime is in that range.
- **Evening dimming.** The ordinary brightness control (the Brightness and Color applet, or the brightness keys) still works in HDR mode and scales everything down from the SDR level. `kscreen-doctor` shows `Brightness control: supported, set to 100%`. That makes it the lever for a dimmer evening setting. Once comfortable day and night levels are settled, a small user timer could switch between them. Check `kscreen-doctor --help` for a brightness option first.

## HDR

HDR is on for the whole desktop. KWin shows SDR content at the SDR brightness (175 nits) and scales HDR content relative to it, as described under "HDR games" below. That scaling applies to HDR video too: paper white in an HDR video comes out about 14% dimmer than on a 203-nit setup, which is expected, not a fault.

Each application has to pass its HDR content to KWin properly. Games through Proton and mpv do this without extra setup. Browsers need more work, and on this machine that took the setup below.

### Zen browser

Zen is built on Firefox (Zen 1.23.3b is based on Firefox 158). HDR video in Firefox on Linux is still experimental and off by default, and on an NVIDIA card it needs hardware video decoding as well.

**Current state: HDR video is off in Zen, by choice.** Getting correct HDR colours worked, but only with GPU decoding through VA-API, and that requires turning off the sandbox of the browser's decoder process (`MOZ_DISABLE_RDD_SANDBOX=1`). With HDR off, Zen doesn't tell YouTube it can show HDR, so YouTube sends its SDR version, which looks correct. The rest of this section records how HDR was made to work, so it can be turned back on once there is a secure way to do it. See "Future option: HDR video through Vulkan" below.

**The problem.** With HDR first switched on in Zen, YouTube HDR videos played with the wrong colours. The difference is easy to see against the preview thumbnails shown when you hover over the timeline.

**The cause.** `about:support` showed two separate blocks:

1. **HDR video was blocked.** `VIDEO_HDR` was *Blocklisted by gfxInfo, FEATURE_VIDEO_HDR_DISABLED*, so Zen received HDR streams from YouTube but didn't output them as HDR.
2. **Hardware video decoding was blocked**, so every video was decoded in software on the CPU. Once HDR was allowed, colours were correct only with GPU decoding: the decoded frames then go straight to KWin as dmabuf buffers with their HDR colour information (`HW_DECODED_VIDEO_ZERO_COPY`, "WebRender Layer Compositor").

**Why `media.hardware-video-decoding.force-enabled` is required.** Firefox refuses hardware decoding on this machine for two reasons, and this preference overrides both:

- **A blanket NVIDIA block.** Firefox blocks hardware video decoding on all NVIDIA GPUs on Linux (`HARDWARE_VIDEO_DECODING`: *FEATURE_HARDWARE_VIDEO_DECODING_NO_LINUX_NVIDIA*). NVIDIA's driver has no native VA-API, the interface Firefox normally decodes through, so Firefox assumes it can't work.
- **A failed startup test.** Before forcing, the entry read *FEATURE_FAILURE_VIDEO_DECODING_TEST_FAILED*. Firefox's own decoder check fails, even though VA-API works fine outside the browser (`vainfo` lists the NVIDIA driver and the VP9 Profile 2 and AV1 profiles YouTube HDR uses).

Without the override, `nvidia-smi dmon -s u` shows the decoder (**dec**) at 0 during playback. With it, the **dec** column moves. The nvidia-vaapi-driver project lists this preference as required since Firefox 137.

**Which decoder does the work: VA-API.** Starting Zen with `MOZ_LOG="FFmpegVideo:4"` shows `Requesting pixel format VAAPI_VLD`, so decoding goes through VA-API and the community nvidia-vaapi-driver. Firefox 153 added a native Vulkan Video decoder for NVIDIA, but here it logs `Vulkan FFmpeg decoder disabled`, because it fails its own startup test (`HARDWARE_VIDEO_DECODING_VULKAN`: *FEATURE_FAILURE_VIDEO_DECODING_VULKAN_TEST_FAILED*). So when HDR was working, the VA-API driver and its environment variables were what made it work.

**Why the decoder sandbox has to be off for VA-API.** The nvidia-vaapi-driver talks to the NVIDIA kernel driver in ways the sandbox of the browser's decoder process (the RDD process) normally blocks, so its README lists `MOZ_DISABLE_RDD_SANDBOX=1` as needed. Tested here: with the variable removed, the **dec** column stays at 0. That sandbox limits the damage if a malicious video exploits a bug in a decoder; without it, that process runs with the user's normal permissions. Web pages keep their own sandbox (content sandbox level 6) either way.

#### Why the sandbox stays on

Keeping the decoder sandbox was a deliberate choice of security over HDR video:

- **What the sandbox guards against.** Video decoders parse complex, attacker-controlled data from any site that serves a video, and bugs in them are a recurring source of browser security flaws. The sandbox means a decoder exploit is confined to a process that can do very little. Without it, the same exploit runs with the user's normal permissions, with access to files, the session and anything else the account can reach.
- **What it would buy.** Only HDR video in the browser. There is little HDR content, essentially YouTube, since streaming services don't offer HDR in Linux browsers at all. With HDR off, YouTube's SDR version looks correct, and the CPU decodes 4K without trouble.
- **The risk is small but permanent; the benefit is small and occasional.** The sandbox would be off for every video on every site, all the time, to improve the few videos that are HDR.
- **A better route is coming.** Firefox's Vulkan decoder gives GPU decoding with the sandbox left on. Waiting for it costs only HDR video in the meantime.

HDR in games and mpv is unaffected. Those don't go through the browser.

#### Current settings

| Setting | Value | Why |
|---|---|---|
| `gfx.color_management.hdr` | default (`false`) | HDR video off. YouTube sends SDR. |
| `media.hardware-video-decoding.force-enabled` | default (`false`) | Overriding the NVIDIA block is pointless while VA-API can't run, and blocklists also guard against crashes and driver bugs. |
| `media.hardware-video-decoding-vulkan.enabled` | `true` | Does nothing while the Vulkan decoder fails its startup test. Kept on because Vulkan is the route that could give GPU decoding *without* turning off the sandbox. |
| `MOZ_DISABLE_RDD_SANDBOX` | commented out in `~/.config/environment.d/nvidia-vaapi.conf` | Decoder sandbox stays on. |
| `LIBVA_DRIVER_NAME=nvidia`, `NVD_BACKEND=direct` | in the same file | Harmless; only useful to mpv and other apps that decode through VA-API. Package: `libva-nvidia-driver`. |

Without GPU decoding, video is decoded on the CPU. That handles 4K VP9 and AV1 fine, at some cost in power and heat.

#### Future option: HDR video through Vulkan

**The secure route, once Vulkan works.** After a Zen or NVIDIA driver update, check `about:support` → Decision Log → `HARDWARE_VIDEO_DECODING_VULKAN`. While it reads *FEATURE_FAILURE_VIDEO_DECODING_VULKAN_TEST_FAILED*, nothing has changed. If it reads *available*:

1. Set `gfx.color_management.hdr` to `true`. `media.hardware-video-decoding.force-enabled` may also be needed because of the blanket NVIDIA block; try without it first.
2. Restart Zen and confirm the decoder with:

   ```bash
   MOZ_LOG="FFmpegVideo:4" /opt/zen-browser-bin/zen-bin 2>&1 | grep -iE "vulkan|vaapi" | head -20
   ```

   Vulkan in the output means decoding no longer depends on the VA-API driver, and the sandbox stays on.
3. Run the checks below.

**The route that worked, with the sandbox off (not used, for the reasons above).** Recorded for reference only. Set `gfx.color_management.hdr`, `gfx.color_management.hdr.force_enabled` and `media.hardware-video-decoding.force-enabled` to `true`, uncomment `MOZ_DISABLE_RDD_SANDBOX=1`, then log out and back in.

#### Checks when HDR is on

1. **`about:support`, Decision Log:** `VIDEO_HDR` should read *available*.
2. **`about:support`, Codec Support:** VP9 and AV1 should say *Supported* under Hardware Decoding.
3. **`about:support`, Compositing:** should read *WebRender Layer Compositor*.
4. **During playback:** run `nvidia-smi dmon -s u`. The **dec** column should move.
5. **By eye:** play the test video [njX2bu-_Vw4](https://youtu.be/njX2bu-_Vw4) and compare its colours with the timeline preview thumbnails. YouTube's Stats for nerds should show a `vp09.02…` or `av01…` codec with BT.2020/PQ colour.

#### Limits

- **Streaming services:** Widevine runs at software security level on Linux, so Netflix, Disney+, Max and similar services cap the resolution and don't play HDR in any Linux browser. YouTube HDR works because it doesn't use that DRM.
- **Video encoding** (video calls, screen sharing): there is no hardware encoding. The nvidia-vaapi-driver and Firefox's Vulkan path are both decode-only, and the CPU handles call-sized video fine.
- **Burn-in:** fullscreen video pauses RandomPlace's reshuffle and drift. The "Hide YouTube Fullscreen Controls" extension keeps the player controls from sitting still on screen.

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
- [nvidia-vaapi-driver README](https://github.com/elFarto/nvidia-vaapi-driver)
- [Mozilla Bug 1642854: HDR video support for Linux](https://bugzilla.mozilla.org/show_bug.cgi?id=1642854)
- [Martin Stránský: Firefox & Linux in 2025](https://mastransky.wordpress.com/2026/01/23/firefox-linux-in-2025/)
- [OMG! Ubuntu: Firefox is adding Vulkan video decoding for Nvidia GPUs](https://www.omgubuntu.co.uk/2026/07/firefox-vulkan-video-decoding-nvidia)
- [Phoronix: NVIDIA VA-API Driver 0.0.18](https://phoronix.com/news/NVIDIA-VA-API-Driver-0.0.18)
