# Theme background artwork

Each built-in theme has a light/dark pair; custom palettes use the neutral pair. The SVGs are editable artwork sources. The UI loads only the corresponding lossless WebP export, selected by `ui/src/styles/theme-backgrounds.css`.

Use raster exports for stable compositing behind transparent chat images. SVG background rasterization can vary by a channel value on partial repaints; pre-rendered WebP keeps the existing image-handoff pixel-continuity checks exact without changing image rendering or the tests.

After editing an SVG, re-export it with FFmpeg built with librsvg and libwebp (verified with FFmpeg 8.0.1). The unpremultiply step converts librsvg’s premultiplied pixels to WebP’s straight alpha, preserving the intended tint and opacity:

```sh
ffmpeg -i ui/src/assets/themes/claw-light.svg -vf "format=gbrap,unpremultiply=inplace=1,format=bgra" -c:v libwebp -lossless 1 -compression_level 6 -quality 100 ui/src/assets/themes/claw-light.webp
```

Keep the intrinsic 1600×1000 canvas, transparency, quiet center, and matching palette colors. The CSS uses `?no-inline` so inactive themes do not inflate startup CSS or trigger image downloads. Verify desktop/mobile contrast and image continuity with the theme-background and image-handoff browser tests.

The Lobster pair is line art with faint fills, quantized to a 256-color palette without dithering before the lossless export to stay near 18 KB: `rsvg-convert -w 1600 -h 1000 -o out.png in.svg && magick out.png -dither None -colors 256 out.png && cwebp -lossless -exact -z 6 out.png -o out.webp`.
