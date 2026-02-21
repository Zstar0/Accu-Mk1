"""
PeakData CSV parser for Agilent HPLC export files.

Handles two CSV formats:
1. PeakData files: header row + peak data + Sum row (from sample analysis)
2. Report files: instrument metadata (first ~57 lines) + header row + peak data + Sum row (from calibration)

Both formats share the same peak table structure:
  Height, Area, Area%, Peak Begin Time, Peak End Time, RT [min]
"""

import csv
import io
from dataclasses import dataclass, field


@dataclass
class Peak:
    """A single chromatographic peak."""
    height: float
    area: float
    area_percent: float
    begin_time: float
    end_time: float
    retention_time: float
    is_solvent_front: bool = False
    is_main_peak: bool = False


@dataclass
class InjectionData:
    """Parsed data from one injection's PeakData file."""
    injection_name: str
    peaks: list[Peak]
    total_area: float
    main_peak_index: int = -1
    peptide_label: str = ""


@dataclass
class HPLCParseResult:
    """Result of parsing a set of HPLC PeakData files."""
    injections: list[InjectionData]
    errors: list[str] = field(default_factory=list)


def _extract_injection_info(filename: str) -> tuple[str, str]:
    """
    Extract injection name and peptide label from filename.

    Returns:
        (injection_name, peptide_label) where peptide_label is empty for non-blend files.

    Examples:
        'P-0142_Inj_1_PeakData.csv'       -> ('Inj_1', '')
        'P-0142_Inj_2_PeakData.csv'       -> ('Inj_2', '')
        'PB-0053_Inj_1_BPC_PeakData.csv'  -> ('BPC_Inj_1', 'BPC')
        'PB-0053_Inj_1_TB500_PeakData.csv' -> ('TB500_Inj_1', 'TB500')
        '250_Report.csv'                    -> ('250_Report', '')
        'unknown.csv'                       -> ('unknown', '')
    """
    name = filename.rsplit('.', 1)[0]  # Remove extension
    parts = name.split('_')

    # Look for Inj_N pattern and any peptide label between Inj_N and PeakData
    for i, part in enumerate(parts):
        if part == 'Inj' and i + 1 < len(parts):
            inj_num = parts[i + 1]
            # Check for peptide label: parts between Inj_N and PeakData
            # e.g. PB-0053_Inj_1_BPC_PeakData → peptide_label = "BPC"
            peptide_parts = []
            for j in range(i + 2, len(parts)):
                if parts[j].lower() == 'peakdata':
                    break
                peptide_parts.append(parts[j])

            if peptide_parts:
                peptide_label = '_'.join(peptide_parts)
                return f"{peptide_label}_Inj_{inj_num}", peptide_label

            return f"Inj_{inj_num}", ""

    # For Report files, use the prefix (e.g., "250" from "250_Report.csv")
    if '_Report' in name:
        return name, ""

    return name, ""


def _find_peak_table_start(lines: list[str]) -> int:
    """
    Find the row index containing the peak table header.

    Looks for a line containing 'Height' and 'Area' and 'RT'.
    Returns -1 if not found.
    """
    for i, line in enumerate(lines):
        # Check for the standard peak table header columns
        if 'Height' in line and 'Area' in line and 'RT' in line:
            return i
    return -1


def parse_peakdata_csv(filename: str, content: str) -> InjectionData:
    """
    Parse a single PeakData CSV file content.

    Args:
        filename: Original filename (used for injection name extraction)
        content: Raw CSV text content

    Returns:
        InjectionData with parsed peaks

    Raises:
        ValueError: If the file cannot be parsed
    """
    lines = content.strip().split('\n')
    if not lines:
        raise ValueError(f"Empty file: {filename}")

    # Find the header row (handles both plain PeakData and Report CSVs)
    header_idx = _find_peak_table_start(lines)
    if header_idx < 0:
        raise ValueError(
            f"Could not find peak table header (Height,Area,RT) in {filename}"
        )

    # Parse header to get column indices
    header_line = lines[header_idx]
    reader = csv.reader(io.StringIO(header_line))
    headers = next(reader)
    headers = [h.strip() for h in headers]

    col_map = {}
    for idx, h in enumerate(headers):
        h_lower = h.lower().replace(' ', '_').replace('[', '').replace(']', '')
        if 'height' in h_lower:
            col_map['height'] = idx
        elif h_lower == 'area%' or h_lower == 'area_percent':
            col_map['area_percent'] = idx
        elif 'area' in h_lower and 'percent' not in h_lower and '%' not in h_lower:
            col_map['area'] = idx
        elif 'begin' in h_lower:
            col_map['begin_time'] = idx
        elif 'end' in h_lower:
            col_map['end_time'] = idx
        elif 'rt' in h_lower or 'retention' in h_lower:
            col_map['retention_time'] = idx

    required = ['height', 'area', 'area_percent', 'retention_time']
    missing = [k for k in required if k not in col_map]
    if missing:
        raise ValueError(
            f"Missing required columns in {filename}: {missing}. "
            f"Found headers: {headers}"
        )

    # Parse data rows
    peaks: list[Peak] = []
    total_area = 0.0

    for line in lines[header_idx + 1:]:
        line = line.strip()
        if not line:
            continue

        row = next(csv.reader(io.StringIO(line)))

        # Check for Sum row
        first_val = row[0].strip() if row else ''
        if first_val.lower() == 'sum':
            # Extract total area from Sum row
            area_idx = col_map.get('area', 1)
            if area_idx < len(row) and row[area_idx].strip():
                try:
                    total_area = float(row[area_idx].strip())
                except ValueError:
                    pass
            break

        # Parse peak data
        try:
            height = float(row[col_map['height']].strip())
            area = float(row[col_map['area']].strip())
            area_percent = float(row[col_map['area_percent']].strip())
            rt = float(row[col_map['retention_time']].strip())

            begin_time = 0.0
            if 'begin_time' in col_map and col_map['begin_time'] < len(row):
                val = row[col_map['begin_time']].strip()
                if val:
                    begin_time = float(val)

            end_time = 0.0
            if 'end_time' in col_map and col_map['end_time'] < len(row):
                val = row[col_map['end_time']].strip()
                if val:
                    end_time = float(val)

            peaks.append(Peak(
                height=height,
                area=area,
                area_percent=area_percent,
                begin_time=begin_time,
                end_time=end_time,
                retention_time=rt,
            ))
        except (ValueError, IndexError):
            # Skip unparseable rows
            continue

    if not peaks:
        raise ValueError(f"No peaks found in {filename}")

    # Mark first peak as solvent front
    peaks[0].is_solvent_front = True

    # Find main peak (highest Area% excluding solvent front)
    main_idx = -1
    max_area_pct = -1.0
    for i, peak in enumerate(peaks):
        if not peak.is_solvent_front and peak.area_percent > max_area_pct:
            max_area_pct = peak.area_percent
            main_idx = i

    if main_idx >= 0:
        peaks[main_idx].is_main_peak = True

    # Calculate total from peaks if Sum row wasn't found
    if total_area == 0.0:
        total_area = sum(p.area for p in peaks)

    injection_name, peptide_label = _extract_injection_info(filename)

    return InjectionData(
        injection_name=injection_name,
        peaks=peaks,
        total_area=total_area,
        main_peak_index=main_idx,
        peptide_label=peptide_label,
    )


def parse_hplc_files(files: list[dict]) -> HPLCParseResult:
    """
    Parse multiple HPLC PeakData files.

    Args:
        files: List of dicts with 'filename' and 'content' keys

    Returns:
        HPLCParseResult with all injections and any errors
    """
    injections: list[InjectionData] = []
    errors: list[str] = []

    for file_info in files:
        filename = file_info.get('filename', 'unknown')
        content = file_info.get('content', '')

        try:
            injection = parse_peakdata_csv(filename, content)
            injections.append(injection)
        except ValueError as e:
            errors.append(str(e))

    # Sort injections by name for consistent ordering
    injections.sort(key=lambda inj: inj.injection_name)

    return HPLCParseResult(injections=injections, errors=errors)


def calculate_purity(injections: list[InjectionData]) -> dict:
    """
    Calculate purity by averaging main peak Area% across injections.

    Excludes solvent front (first peak) from consideration.

    Returns:
        Dict with purity_percent, individual_values, and rsd
    """
    values: list[float] = []

    for inj in injections:
        if inj.main_peak_index >= 0:
            main_peak = inj.peaks[inj.main_peak_index]
            values.append(main_peak.area_percent)

    if not values:
        return {
            'purity_percent': None,
            'individual_values': [],
            'injection_names': [],
            'rsd_percent': None,
            'error': 'No main peaks found in injections',
        }

    avg = sum(values) / len(values)

    # Calculate RSD (Relative Standard Deviation)
    rsd = None
    if len(values) > 1:
        mean = avg
        variance = sum((v - mean) ** 2 for v in values) / (len(values) - 1)
        std_dev = variance ** 0.5
        rsd = (std_dev / mean) * 100 if mean != 0 else None

    return {
        'purity_percent': round(avg, 4),
        'individual_values': [round(v, 4) for v in values],
        'injection_names': [inj.injection_name for inj in injections if inj.main_peak_index >= 0],
        'rsd_percent': round(rsd, 4) if rsd is not None else None,
    }
