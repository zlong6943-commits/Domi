#!/usr/bin/env python3
"""Build lightweight transparent APNG loops from approved PawPal pose art."""

from __future__ import annotations

import argparse
import math
from pathlib import Path

from PIL import Image


CANVAS_SIZE = 384


def fitted_sprite(source: Image.Image, fill: float) -> Image.Image:
    alpha = source.getchannel("A")
    bbox = alpha.getbbox()
    if bbox is None:
        raise ValueError("source image has no visible pixels")
    cropped = source.crop(bbox)
    max_size = round(CANVAS_SIZE * fill)
    ratio = min(max_size / cropped.width, max_size / cropped.height)
    return cropped.resize(
        (max(1, round(cropped.width * ratio)), max(1, round(cropped.height * ratio))),
        Image.Resampling.LANCZOS,
    )


def transformed_frame(
    sprite: Image.Image,
    *,
    scale_x: float = 1.0,
    scale_y: float = 1.0,
    rotate: float = 0.0,
    offset_x: float = 0.0,
    offset_y: float = 0.0,
) -> Image.Image:
    width = max(1, round(sprite.width * scale_x))
    height = max(1, round(sprite.height * scale_y))
    frame_sprite = sprite.resize((width, height), Image.Resampling.LANCZOS)
    if rotate:
        frame_sprite = frame_sprite.rotate(
            rotate,
            resample=Image.Resampling.BICUBIC,
            expand=True,
        )
    frame = Image.new("RGBA", (CANVAS_SIZE, CANVAS_SIZE), (0, 0, 0, 0))
    x = round((CANVAS_SIZE - frame_sprite.width) / 2 + offset_x)
    y = round((CANVAS_SIZE - frame_sprite.height) / 2 + offset_y)
    frame.alpha_composite(frame_sprite, (x, y))
    return frame


def walking_frames(source: Image.Image) -> tuple[list[Image.Image], int]:
    sprite = fitted_sprite(source, 0.82)
    frames: list[Image.Image] = []
    count = 24
    for index in range(count):
        phase = 2 * math.pi * index / count
        step = math.sin(phase)
        bob = -3.5 * abs(step)
        frames.append(
            transformed_frame(
                sprite,
                scale_x=1.0 + 0.008 * math.cos(phase * 2),
                scale_y=1.0 - 0.008 * math.cos(phase * 2),
                rotate=1.2 * step,
                offset_x=1.3 * math.cos(phase),
                offset_y=bob,
            )
        )
    return frames, 58


def pouncing_frames(source: Image.Image) -> tuple[list[Image.Image], int]:
    sprite = fitted_sprite(source, 0.80)
    frames: list[Image.Image] = []
    count = 24
    for index in range(count):
        progress = index / count
        if progress < 0.24:
            local = progress / 0.24
            squash = math.sin(local * math.pi / 2)
            scale_x = 1.0 + 0.055 * squash
            scale_y = 1.0 - 0.075 * squash
            offset_y = 8 * squash
            rotate = -1.5 * squash
        elif progress < 0.60:
            local = (progress - 0.24) / 0.36
            leap = math.sin(local * math.pi)
            scale_x = 1.055 - 0.075 * leap
            scale_y = 0.925 + 0.13 * leap
            offset_y = 8 - 18 * leap
            rotate = -1.5 + 4.0 * leap
        else:
            local = (progress - 0.60) / 0.40
            settle = 1 - local
            bounce = math.sin(local * math.pi) * settle
            scale_x = 1.0 + 0.05 * bounce
            scale_y = 1.0 - 0.055 * bounce
            offset_y = 5 * bounce
            rotate = 1.2 * bounce
        frames.append(
            transformed_frame(
                sprite,
                scale_x=scale_x,
                scale_y=scale_y,
                rotate=rotate,
                offset_y=offset_y,
            )
        )
    return frames, 58


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("walking", "pouncing"))
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()

    source = Image.open(args.source).convert("RGBA")
    frames, duration = (
        walking_frames(source) if args.mode == "walking" else pouncing_frames(source)
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    frames[0].save(
        args.output,
        format="PNG",
        save_all=True,
        append_images=frames[1:],
        duration=duration,
        loop=0,
        disposal=1,
        blend=0,
        optimize=False,
    )


if __name__ == "__main__":
    main()
