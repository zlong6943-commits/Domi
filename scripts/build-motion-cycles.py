#!/usr/bin/env python3
"""Turn generated 3x2 pose sheets into aligned, transparent Domi APNG cycles."""

from __future__ import annotations

import argparse
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image


CANVAS_SIZE = 384
GRID_COLUMNS = 3
GRID_ROWS = 2


def clean_existing_alpha(image: Image.Image) -> Image.Image:
    rgba = np.asarray(image.convert("RGBA")).copy()
    source_alpha = rgba[:, :, 3].astype(np.float32)
    # ImageGen occasionally stores the transparent backdrop at alpha 0-4 and
    # the subject at 251-254. Expand those two clusters to a clean full range.
    rgba[:, :, 3] = np.clip((source_alpha - 12) * 1.2, 0, 255).astype(np.uint8)
    rgba[rgba[:, :, 3] == 0, :3] = 0
    return Image.fromarray(rgba, "RGBA")


def connected_checkerboard_mask(image: Image.Image) -> np.ndarray:
    rgb = np.asarray(image.convert("RGB"))
    minimum = rgb.min(axis=2)
    chroma = rgb.max(axis=2) - minimum
    candidate = (minimum >= 238) & (chroma <= 13)
    height, width = candidate.shape
    connected = np.zeros_like(candidate, dtype=bool)
    queue: deque[tuple[int, int]] = deque()

    def seed(y: int, x: int) -> None:
        if candidate[y, x] and not connected[y, x]:
            connected[y, x] = True
            queue.append((y, x))

    for x in range(width):
        seed(0, x)
        seed(height - 1, x)
    for y in range(height):
        seed(y, 0)
        seed(y, width - 1)

    while queue:
        y, x = queue.popleft()
        for next_y, next_x in ((y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)):
            if (
                0 <= next_y < height
                and 0 <= next_x < width
                and candidate[next_y, next_x]
                and not connected[next_y, next_x]
            ):
                connected[next_y, next_x] = True
                queue.append((next_y, next_x))
    return connected


def remove_checkerboard(image: Image.Image) -> Image.Image:
    rgba = np.asarray(image.convert("RGBA")).copy()
    background = connected_checkerboard_mask(image)
    rgba[:, :, 3] = np.where(background, 0, 255).astype(np.uint8)
    rgba[background, :3] = 0
    return Image.fromarray(rgba, "RGBA")


def clean_sheet(image: Image.Image) -> Image.Image:
    if image.mode == "RGBA" and image.getchannel("A").getextrema()[0] < 16:
        return clean_existing_alpha(image)
    return remove_checkerboard(image)


def extract_cells(sheet: Image.Image) -> list[Image.Image]:
    cell_width = sheet.width // GRID_COLUMNS
    cell_height = sheet.height // GRID_ROWS
    cells: list[Image.Image] = []
    for row in range(GRID_ROWS):
        for column in range(GRID_COLUMNS):
            cell = sheet.crop(
                (
                    column * cell_width,
                    row * cell_height,
                    (column + 1) * cell_width,
                    (row + 1) * cell_height,
                )
            )
            bbox = cell.getchannel("A").getbbox()
            if bbox is None:
                raise ValueError(f"empty sprite cell at row {row + 1}, column {column + 1}")
            cells.append(cell.crop(bbox))
    return cells


def aligned_frames(cells: list[Image.Image], mode: str) -> list[Image.Image]:
    maximum_width = max(cell.width for cell in cells)
    maximum_height = max(cell.height for cell in cells)
    target_width = 334 if mode == "walking" else 344
    target_height = 300
    scale = min(target_width / maximum_width, target_height / maximum_height)
    baselines = (
        [346, 341, 335, 346, 341, 348]
        if mode == "walking"
        else [348, 329, 304, 292, 317, 345]
    )
    frames: list[Image.Image] = []
    for cell, baseline in zip(cells, baselines, strict=True):
        resized = cell.resize(
            (max(1, round(cell.width * scale)), max(1, round(cell.height * scale))),
            Image.Resampling.LANCZOS,
        )
        frame = Image.new("RGBA", (CANVAS_SIZE, CANVAS_SIZE), (0, 0, 0, 0))
        x = round((CANVAS_SIZE - resized.width) / 2)
        y = round(baseline - resized.height)
        frame.alpha_composite(resized, (x, y))
        frames.append(frame)
    return frames


def save_cycle(frames: list[Image.Image], output: Path, mode: str) -> None:
    duration = 92 if mode == "walking" else 68
    output.parent.mkdir(parents=True, exist_ok=True)
    frames[0].save(
        output,
        format="PNG",
        save_all=True,
        append_images=frames[1:],
        duration=duration,
        loop=0,
        disposal=1,
        blend=0,
        optimize=False,
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("walking", "running"))
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--frames-dir", type=Path)
    parser.add_argument("--clean-sheet", type=Path)
    args = parser.parse_args()

    sheet = clean_sheet(Image.open(args.source))
    if args.clean_sheet:
        args.clean_sheet.parent.mkdir(parents=True, exist_ok=True)
        sheet.save(args.clean_sheet)

    frames = aligned_frames(extract_cells(sheet), args.mode)
    if args.frames_dir:
        args.frames_dir.mkdir(parents=True, exist_ok=True)
        for index, frame in enumerate(frames, start=1):
            frame.save(args.frames_dir / f"frame-{index:02d}.png")
    save_cycle(frames, args.output, args.mode)


if __name__ == "__main__":
    main()
