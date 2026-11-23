---
name: storyboards
description: Planning a video, ad, short or story as a storyboard of scenes with start and end frames, saved with storyboard_save and drawn in the person's Google Flow or Grok Imagine. Load before writing or changing a storyboard.
---

# Storyboards

A storyboard is a `*.storyboard.json` file. The app shows it as a board of scene cards; the person reviews it and presses **Proceed** to draw every frame in their own Google Flow account (Grok Imagine takes the pictures Flow will not make). Each scene has a **start frame** and an **end frame**: the end frame is drawn by changing the start frame, so both show the same place and people, and a video tool can later animate from one to the other.

## Steps

1. **Understand the brief.** Purpose (ad, short, explainer, story), audience, length, platform, and the feeling it should leave. Ask one question only when a choice changes the whole board (for example vertical 9:16 for Shorts and Reels versus 16:9).
2. **Shape it.** A hook in the first scene, one idea per scene, a clear turn, and an ending that pays off the hook. A 30-second piece is about 5 to 8 scenes of 3 to 6 seconds.
3. **Fix the look once.** Put the medium, palette, lighting and lens in `style`, and each recurring person, animal or product in `characters` with a precise look (age, build, hair, clothing, colours). Name characters the same way in every prompt that shows them.
4. **Write the frames.** Each prompt is one or two sentences: who and what, where, the composition and camera (wide, medium, close-up, low angle), and the moment. The end prompt says what is different a moment later, in the same shot: a pose, an expression, an object moved, light changed. Keep big moves (new place, new shot) for the next scene.
5. **Save** with `storyboard_save` (`aspect`, `title`, stable scene `id`s such as `s1`, `s2`), then **present** the file so the person can open the board. Tell them in one line to press Open Flow (sign in once and open a Flow project) or Open Grok, then Proceed.
6. **Revise on request.** Change only the scenes asked for and save again with the same ids: frames whose prompt did not change keep their pictures; changed ones are drawn again. Use `storyboard_draw` only when the person asks you to draw.

## Pitfalls

- Real people's likeness, logos and trademarked characters are refused by both services: describe original characters and generic products.
- Violence, injuries, medical or sexual detail and weapons pointed at people are often refused: imply rather than show.
- Text in pictures comes out garbled: keep words for titles added in editing, not in frame prompts.
- Long prompts drift: one subject, one action, one camera per frame.
- A frame that fails shows its reason on the board; rewrite that prompt gently and save again.
