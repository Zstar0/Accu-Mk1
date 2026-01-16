"""
TXT file parser for HPLC export files.
Handles tab-delimited format with variable column positions.
"""

import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Union


@dataclass
class ParseResult:
    """Result of parsing an HPLC export file."""
    filename: str
    rows: list[dict]  # Each row as dict with mapped column names
    raw_headers: list[str]
    row_count: int
    errors: list[str] = field(default_factory=list)


def _convert_numeric(value: str) -> Union[str, float, int]:
    """
    Convert string value to appropriate numeric type.

    Handles:
    - Comma as decimal separator (European format)
    - Scientific notation
    - Integer values

    Returns original string if conversion fails.
    """
    if not value or not value.strip():
        return value

    cleaned = value.strip()

    # Handle European decimal format (comma as decimal separator)
    # Only convert if there's exactly one comma and no dots
    if "," in cleaned and "." not in cleaned:
        # Check if it looks like a number with comma decimal
        if re.match(r'^-?\d+,\d+$', cleaned):
            cleaned = cleaned.replace(",", ".")

    try:
        # Try integer first
        if "." not in cleaned and "e" not in cleaned.lower():
            return int(cleaned)
        # Then float (handles scientific notation too)
        return float(cleaned)
    except ValueError:
        return value


def _find_header_row(lines: list[str], column_mappings: dict) -> tuple[int, list[str]]:
    """
    Find the row containing column headers.

    Args:
        lines: All lines from the file
        column_mappings: Dict mapping semantic names to expected column headers

    Returns:
        Tuple of (header_row_index, header_columns)
        Returns (-1, []) if headers not found
    """
    expected_headers = set(column_mappings.values())

    for i, line in enumerate(lines):
        columns = [col.strip() for col in line.split("\t")]
        # Check if this row contains at least one expected header
        found = set(columns) & expected_headers
        if found:
            return i, columns

    return -1, []


def parse_txt_file(file_path: Union[str, Path], column_mappings: dict) -> ParseResult:
    """
    Parse tab-delimited TXT file from HPLC export.

    Args:
        file_path: Path to TXT file
        column_mappings: Dict mapping semantic names to column headers
            Example: {"sample_name": "Sample", "area": "Area", "height": "Height"}

    Returns:
        ParseResult with rows of extracted data
    """
    path = Path(file_path)
    errors: list[str] = []

    # Validate file exists
    if not path.exists():
        return ParseResult(
            filename=path.name,
            rows=[],
            raw_headers=[],
            row_count=0,
            errors=[f"File not found: {path}"],
        )

    # Read file content
    try:
        content = path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        # Try with latin-1 encoding (common for older instruments)
        try:
            content = path.read_text(encoding="latin-1")
        except Exception as e:
            return ParseResult(
                filename=path.name,
                rows=[],
                raw_headers=[],
                row_count=0,
                errors=[f"Failed to read file: {e}"],
            )

    lines = content.strip().split("\n")

    if not lines:
        return ParseResult(
            filename=path.name,
            rows=[],
            raw_headers=[],
            row_count=0,
            errors=["File is empty"],
        )

    # Find header row
    header_idx, raw_headers = _find_header_row(lines, column_mappings)

    if header_idx < 0:
        # If no column mappings provided, use first non-empty row as headers
        if not column_mappings:
            for i, line in enumerate(lines):
                columns = [col.strip() for col in line.split("\t")]
                if any(columns):
                    header_idx = i
                    raw_headers = columns
                    break

        if header_idx < 0:
            return ParseResult(
                filename=path.name,
                rows=[],
                raw_headers=[],
                row_count=0,
                errors=["Could not find header row matching expected columns"],
            )

    # Create reverse mapping: column header -> semantic name
    reverse_mapping = {v: k for k, v in column_mappings.items()} if column_mappings else {}

    # Create column index mapping
    col_indices: dict[str, int] = {}
    for idx, header in enumerate(raw_headers):
        if header in reverse_mapping:
            col_indices[reverse_mapping[header]] = idx
        elif not column_mappings:
            # No mappings provided, use header as-is
            col_indices[header] = idx

    # Parse data rows
    rows: list[dict] = []
    for line_num, line in enumerate(lines[header_idx + 1:], start=header_idx + 2):
        if not line.strip():
            continue

        columns = line.split("\t")
        row_data: dict = {}

        for semantic_name, col_idx in col_indices.items():
            if col_idx < len(columns):
                value = columns[col_idx].strip()
                row_data[semantic_name] = _convert_numeric(value)
            else:
                row_data[semantic_name] = None
                errors.append(f"Line {line_num}: Missing column {semantic_name}")

        if row_data:
            rows.append(row_data)

    return ParseResult(
        filename=path.name,
        rows=rows,
        raw_headers=raw_headers,
        row_count=len(rows),
        errors=errors,
    )
