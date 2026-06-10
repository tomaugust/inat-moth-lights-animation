"""Convert real moth trap tracks into a standalone animation config.

The script uses public/template-config.json as a template for the animation,
audio, scene, light, and species styling defaults. It then replaces the
data-driven fields with values derived from the CSV:

- animation.duration: total time-of-day span in minutes, collapsed into one night
- animation.startClockTime: earliest track start time as HH:MM
- species: unknown plus one generated entry per known species in the CSV
- moths: one moth entry per retained CSV row
"""

from __future__ import annotations

import argparse
import copy
import csv
import hashlib
import json
import math
import random
import re
from datetime import datetime
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_INPUT = ROOT / "input_data" / "dep000144_tracks.csv"
DEFAULT_TEMPLATE = ROOT / "public" / "template-config.json"
DEFAULT_OUTPUT = ROOT / "outputs" / "dep000144-config.json"
DEFAULT_CHIME_NOTE_SETS = [
    ["C3", "G3", "E4"],
    ["D4", "E4", "G4"],
    ["G4", "A4", "C5"],
]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Convert moth track CSV data into an animation JSON config."
    )
    parser.add_argument(
        "--input",
        type=Path,
        default=DEFAULT_INPUT,
        help=f"Input tracks CSV. Default: {DEFAULT_INPUT}",
    )
    parser.add_argument(
        "--template",
        type=Path,
        default=DEFAULT_TEMPLATE,
        help=f"Template JSON config. Default: {DEFAULT_TEMPLATE}",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=DEFAULT_OUTPUT,
        help=f"Output JSON config. Default: {DEFAULT_OUTPUT}",
    )
    parser.add_argument(
        "--include-nonmoths",
        action="store_true",
        help="Include every CSV row. By default, binary_class is filtered to moth when present.",
    )
    parser.add_argument(
        "--species-table",
        type=Path,
        help=(
            "Optional CSV containing species metadata columns matching the JSON species object. "
            "Rows are matched against the track species name using the CSV's name column."
        ),
    )
    return parser.parse_args()


def parse_datetime(value: str) -> datetime:
    value = value.strip()
    for date_format in (
        "%Y-%m-%d %H:%M:%S",
        "%Y-%m-%dT%H:%M:%S",
        "%Y-%m-%d %H:%M",
        "%Y-%m-%dT%H:%M",
        "%d/%m/%Y %H:%M:%S",
        "%d/%m/%Y %H:%M",
    ):
        try:
            return datetime.strptime(value, date_format)
        except ValueError:
            continue
    return datetime.fromisoformat(value)


def minutes_since_midnight(value: datetime) -> int:
    return value.hour * 60 + value.minute


def normalise_night_minutes(start_minutes: int, end_minutes: int) -> tuple[int, int]:
    if start_minutes < 12 * 60:
        start_minutes += 24 * 60
    if end_minutes < 12 * 60:
        end_minutes += 24 * 60
    if end_minutes < start_minutes:
        end_minutes += 24 * 60
    return start_minutes, end_minutes


def slugify(value: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return slug or "unknown"


def unique_slug(value: str, used: set[str]) -> str:
    base = slugify(value)
    slug = base
    suffix = 2
    while slug in used:
        slug = f"{base}-{suffix}"
        suffix += 1
    used.add(slug)
    return slug


def load_template(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as file:
        return json.load(file)


def load_rows(path: Path, include_nonmoths: bool) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as file:
        rows = list(csv.DictReader(file))

    if include_nonmoths or not rows or "binary_class" not in rows[0]:
        return rows

    return [
        row
        for row in rows
        if row.get("binary_class", "").strip().lower() == "moth"
    ]


def build_unknown_species() -> dict[str, Any]:
    return {
        "id": "unknown",
        "name": "Unknown",
        "imageURL": "",
        "speciesDescription": "",
        "color": "#919191",
        "chimeNote": "E5",
        "chimeNotes": ["E5", "G5", "A5", "C6"],
        "size": 4,
        "speed": 1.75,
        "erraticness": 3.2,
        "inclinationDriftSpeed": 0.35,
        "nodeDriftSpeed": 0.35,
        "trailLength": 5,
        "shadowColor": "rgba(120, 124, 130, 0.18)",
        "shadowBlur": 7,
    }


def stable_random(species_name: str) -> random.Random:
    digest = hashlib.sha256(species_name.strip().lower().encode("utf-8")).digest()
    return random.Random(int.from_bytes(digest[:8], "big"))


def interpolate_hex_color(start: str, end: str, ratio: float) -> str:
    ratio = max(0.0, min(1.0, ratio))
    start_rgb = tuple(int(start[index:index + 2], 16) for index in (1, 3, 5))
    end_rgb = tuple(int(end[index:index + 2], 16) for index in (1, 3, 5))
    mixed = tuple(
        round(start_channel + (end_channel - start_channel) * ratio)
        for start_channel, end_channel in zip(start_rgb, end_rgb)
    )
    return "#" + "".join(f"{channel:02x}" for channel in mixed)


def parse_species_table_value(field: str, value: str) -> Any:
    text = value.strip()
    if not text:
        return ""
    if field == "chimeNotes":
        try:
            parsed = json.loads(text)
            if isinstance(parsed, list):
                return [str(item) for item in parsed]
        except json.JSONDecodeError:
            pass
        return [item.strip() for item in text.split(",") if item.strip()]
    if field in {
        "size",
        "trailLength",
        "shadowBlur",
    }:
        return int(float(text))
    if field in {
        "speed",
        "erraticness",
        "inclinationDriftSpeed",
        "nodeDriftSpeed",
    }:
        return float(text)
    return text


def load_species_table(path: Path | None) -> dict[str, dict[str, Any]]:
    if path is None:
        return {}

    with path.open("r", encoding="utf-8-sig", newline="") as file:
        rows = list(csv.DictReader(file))

    species_by_name: dict[str, dict[str, Any]] = {}
    for row in rows:
        name = row.get("name", "").strip()
        if not name:
            continue
        parsed_row = {
            key: parse_species_table_value(key, value)
            for key, value in row.items()
            if key is not None and value is not None and value.strip()
        }
        chime_notes = parsed_row.get("chimeNotes")
        if isinstance(chime_notes, list) and chime_notes and "chimeNote" not in parsed_row:
            parsed_row["chimeNote"] = chime_notes[0]
        species_by_name[name.lower()] = parsed_row

    return species_by_name


def build_default_species_entry(name: str) -> dict[str, Any]:
    rng = stable_random(name)
    chime_notes = copy.deepcopy(rng.choice(DEFAULT_CHIME_NOTE_SETS))
    return {
        "id": name,
        "name": name,
        "imageURL": "",
        "speciesDescription": "",
        "color": interpolate_hex_color("#ffffff", "#f7ce5e", rng.random()),
        "chimeNote": chime_notes[0],
        "chimeNotes": chime_notes,
        "size": round(rng.uniform(2, 7), 2),
        "speed": round(rng.uniform(0.4, 1.3), 2),
        "erraticness": round(rng.uniform(1.2, 4), 2),
        "inclinationDriftSpeed": round(rng.uniform(0.1, 0.7), 2),
        "nodeDriftSpeed": round(rng.uniform(0.1, 0.7), 2),
        "trailLength": 10,
        "shadowColor": "rgba(247, 239, 217, 0.22)",
        "shadowBlur": 9,
    }


def build_species(
    species_names: list[str],
    species_table: dict[str, dict[str, Any]],
) -> tuple[list[dict[str, Any]], dict[str, str]]:
    unknown_template = build_unknown_species()
    species_id_by_name: dict[str, str] = {}
    output_species = [copy.deepcopy(unknown_template)]

    for name in species_names:
        table_entry = species_table.get(name.strip().lower())
        entry = copy.deepcopy(table_entry) if table_entry is not None else build_default_species_entry(name)
        entry["id"] = str(entry.get("id", name)).strip() or name
        entry["name"] = str(entry.get("name", name)).strip() or name
        entry.setdefault("imageURL", "")
        entry.setdefault("speciesDescription", "")
        entry.setdefault("chimeNotes", ["C3", "G3", "E4"])
        if not entry["chimeNotes"]:
            entry["chimeNotes"] = ["C3", "G3", "E4"]
        entry.setdefault("chimeNote", entry["chimeNotes"][0])
        species_id_by_name[name] = entry["id"]
        output_species.append(entry)

    return output_species, species_id_by_name


def build_config(
    template: dict[str, Any],
    rows: list[dict[str, str]],
    species_table: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    if not rows:
        raise ValueError("No rows available after filtering.")

    parsed_rows = []
    for row in rows:
        start = parse_datetime(row["track_start_datetime"])
        end = parse_datetime(row["track_end_datetime"])
        start_minutes = minutes_since_midnight(start)
        end_minutes = minutes_since_midnight(end)
        start_minutes, end_minutes = normalise_night_minutes(start_minutes, end_minutes)
        parsed_rows.append((row, start, end, start_minutes, end_minutes))

    dataset_start_minutes = min(start_minutes for _, _, _, start_minutes, _ in parsed_rows)
    dataset_end_minutes = max(end_minutes for _, _, _, _, end_minutes in parsed_rows)
    duration_minutes = max(1, math.ceil(dataset_end_minutes - dataset_start_minutes))

    known_species_names = sorted(
        {
            row.get("global_species_rank_1_name", "").strip()
            for row, _, _, _, _ in parsed_rows
            if row.get("global_species_rank_1_name", "").strip()
        }
    )

    config = copy.deepcopy(template)
    config["animation"] = copy.deepcopy(template["animation"])
    config["animation"]["duration"] = duration_minutes
    config["animation"]["startClockTime"] = f"{(dataset_start_minutes % (24 * 60)) // 60:02d}:{dataset_start_minutes % 60:02d}"

    species_entries, species_id_by_name = build_species(known_species_names, species_table)
    config["species"] = species_entries

    moths = []
    for index, (row, _start, _end, start_minutes, end_minutes) in enumerate(
        sorted(parsed_rows, key=lambda item: item[3]),
        start=1,
    ):
        species_name = row.get("global_species_rank_1_name", "").strip()
        species_id = species_id_by_name.get(species_name, "unknown")
        track_id = row.get("track_id", "").strip()
        moth_id = track_id or f"moth-{index:06d}"
        entry_time = start_minutes - dataset_start_minutes
        exit_time = end_minutes - dataset_start_minutes
        moths.append(
            {
                "id": moth_id,
                "species": species_id,
                "entryTime": entry_time,
                "exitTime": exit_time,
            }
        )

    config["moths"] = moths
    return config


def main() -> None:
    args = parse_args()
    template = load_template(args.template)
    rows = load_rows(args.input, include_nonmoths=args.include_nonmoths)
    species_table = load_species_table(args.species_table)
    config = build_config(template, rows, species_table)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("w", encoding="utf-8") as file:
        json.dump(config, file, indent=2)
        file.write("\n")

    print(f"Wrote {args.output}")
    print(f"Included {len(config['moths'])} moths and {len(config['species'])} species entries.")
    print(
        "Animation starts at "
        f"{config['animation']['startClockTime']} and lasts {config['animation']['duration']} minutes."
    )
    if config["animation"]["duration"] > 24 * 60:
        print(
            "Warning: the collapsed time-of-day span is longer than 24 hours. "
            "This usually means the CSV contains observations spread across multiple nights."
        )


if __name__ == "__main__":
    main()
