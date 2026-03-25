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
    source_sample_id: str = ""  # extracted from "Sample name:" metadata inside the CSV
    filename: str = ""          # original filename for audit


@dataclass
class StandardInjection:
    """Parsed standard injection reference data."""
    analyte_label: str        # e.g. "BPC157", "GHK", "TB17-23"
    main_peak_rt: float       # RT of highest Area% peak
    main_peak_area_pct: float # Area% of the main peak
    source_sample_id: str     # e.g. "P-0111" from "Sample name:" metadata
    filename: str             # original filename for audit


@dataclass
class HPLCParseResult:
    """Result of parsing a set of HPLC PeakData files."""
    injections: list[InjectionData]
    errors: list[str] = field(default_factory=list)
    standard_injections: list[StandardInjection] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


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
    # or after PeakData (two naming conventions)
    for i, part in enumerate(parts):
        if part == 'Inj' and i + 1 < len(parts):
            inj_num = parts[i + 1]
            # Convention 1: label BEFORE PeakData
            # e.g. PB-0053_Inj_1_BPC_PeakData → peptide_label = "BPC"
            peptide_parts_before = []
            peakdata_idx = None
            for j in range(i + 2, len(parts)):
                if parts[j].lower() == 'peakdata':
                    peakdata_idx = j
                    break
                peptide_parts_before.append(parts[j])

            if peptide_parts_before:
                peptide_label = '_'.join(peptide_parts_before)
                return f"{peptide_label}_Inj_{inj_num}", peptide_label

            # Convention 2: label AFTER PeakData
            # e.g. PB-0071_Inj_1_PeakData_Tesamorelin → peptide_label = "Tesamorelin"
            if peakdata_idx is not None and peakdata_idx + 1 < len(parts):
                peptide_parts_after = parts[peakdata_idx + 1:]
                if peptide_parts_after:
                    peptide_label = '_'.join(peptide_parts_after)
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

    # Find main peak (highest Area%) first, then decide solvent front.
    # The dominant peak is always treated as the analyte — even if it
    # elutes first (common for early-eluting peptides like BPC-157).
    main_idx = -1
    max_area_pct = -1.0
    for i, peak in enumerate(peaks):
        if peak.area_percent > max_area_pct:
            max_area_pct = peak.area_percent
            main_idx = i

    # Mark first peak as solvent front only when there are multiple peaks
    # AND the first peak is NOT the dominant one.
    if len(peaks) > 1 and main_idx != 0:
        peaks[0].is_solvent_front = True

    if main_idx >= 0:
        peaks[main_idx].is_main_peak = True

    # Calculate total from peaks if Sum row wasn't found
    if total_area == 0.0:
        total_area = sum(p.area for p in peaks)

    injection_name, peptide_label = _extract_injection_info(filename)
    source_sample_id = _extract_source_sample_id(content)

    return InjectionData(
        injection_name=injection_name,
        peaks=peaks,
        total_area=total_area,
        main_peak_index=main_idx,
        peptide_label=peptide_label,
        source_sample_id=source_sample_id,
        filename=filename,
    )


def _is_standard_injection(filename: str) -> bool:
    """
    Return True if the filename indicates a standard injection reference file.

    Standard injection files: PB-0065_Inj_1_std_BPC157_PeakData.csv
      Pattern: _Inj_N_std_{AnalyteName}_PeakData

    NOT standard injections (standard prep concentration files):
      P-0136_Std_1_PeakData.csv, P-0136_Std_1000_PeakData.csv
      Pattern: _Std_{Number}_PeakData (concentration level, not injection reference)
    """
    import re
    lower = filename.lower()
    # Must have _std_ somewhere in the filename
    if '_std_' not in lower:
        return False
    # If preceded by _inj_N → definitely a standard injection reference
    if re.search(r'_inj_\d+_std_', lower):
        return True
    # Check what follows _std_: if it's a number followed by _ or _PeakData, it's a concentration level
    m = re.search(r'_std_([^_]+)_', lower)
    if m:
        label_after_std = m.group(1)
        # Purely numeric = concentration level (Std_1000, Std_250), not a standard injection
        if label_after_std.isdigit():
            return False
        # Non-numeric = analyte name (std_BPC157, std_GHK), IS a standard injection
        return True
    return False


def _extract_standard_info(filename: str) -> tuple[str, str]:
    """
    Extract analyte label from a standard injection filename.

    The analyte label is the part between '_std_' and '_PeakData' (case-insensitive).

    Examples:
        'PB-0065_Inj_1_std_BPC157_PeakData.csv' -> ('BPC157', '')
        'PB-0065_Inj_1_std_GHK_PeakData.csv'    -> ('GHK', '')
        'PB-0065_Inj_1_std_TB17-23_PeakData.csv' -> ('TB17-23', '')

    Returns:
        (analyte_label, '') — second element reserved for future use.
    """
    name = filename.rsplit('.', 1)[0]
    lower = name.lower()
    std_idx = lower.find('_std_')
    if std_idx < 0:
        return name, ""

    after_std = name[std_idx + 5:]  # skip "_std_"

    # Convention 1: _std_{AnalyteName}_PeakData → remove trailing _PeakData
    pd_idx = after_std.lower().find('_peakdata')
    if pd_idx > 0:
        # PeakData is after the label: e.g. "BPC157_PeakData" → "BPC157"
        after_std = after_std[:pd_idx]
        return after_std, ""

    # Convention 2: _Std_PeakData_{AnalyteName} → label is after PeakData_
    if after_std.lower().startswith('peakdata_') and len(after_std) > 9:
        label = after_std[9:]  # skip "PeakData_"
        return label, ""

    # Convention 3: _Std_PeakData only (no label)
    if after_std.lower() in ('peakdata', ''):
        return after_std, ""

    return after_std, ""


def _extract_source_sample_id(content: str) -> str:
    """
    Extract source sample ID from the metadata lines of a PeakData CSV.

    Looks for a line starting with 'Sample name:' and strips the injection
    suffix to return just the sample ID.

    Example: 'Sample name:,P-0111_Inj_1' -> 'P-0111'
    Returns empty string if not found.
    """
    for line in content.split('\n'):
        stripped = line.strip()
        if stripped.lower().startswith('sample name:'):
            parts = stripped.split(',', 1)
            if len(parts) < 2:
                return ""
            raw = parts[1].strip()
            # Strip injection suffix: everything from first "_Inj_" onwards
            inj_idx = raw.lower().find('_inj_')
            if inj_idx >= 0:
                return raw[:inj_idx]
            return raw
    return ""


def parse_standard_injection(filename: str, content: str) -> StandardInjection:
    """
    Parse a standard injection PeakData CSV file.

    Reuses parse_peakdata_csv to handle the identical CSV format, then
    extracts the analyte label and source sample ID from filename/metadata.
    """
    injection = parse_peakdata_csv(filename, content)

    main_peak_rt = 0.0
    main_peak_area_pct = 0.0
    if injection.main_peak_index >= 0:
        peak = injection.peaks[injection.main_peak_index]
        main_peak_rt = peak.retention_time
        main_peak_area_pct = peak.area_percent

    analyte_label, _ = _extract_standard_info(filename)
    source_sample_id = _extract_source_sample_id(content)

    return StandardInjection(
        analyte_label=analyte_label,
        main_peak_rt=main_peak_rt,
        main_peak_area_pct=main_peak_area_pct,
        source_sample_id=source_sample_id,
        filename=filename,
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
    standard_injections: list[StandardInjection] = []
    errors: list[str] = []
    warnings: list[str] = []

    # Extract expected sample ID from the first filename (e.g., "PB-0071" from "PB-0071_Inj_1_...")
    expected_sample_id = ""
    for file_info in files:
        fn = file_info.get('filename', '')
        # Sample ID is the prefix before first _Inj_ or _Std_
        import re as _re
        m = _re.match(r'^(P[A-Z]?-\d+)', fn)
        if m:
            expected_sample_id = m.group(1)
            break

    for file_info in files:
        filename = file_info.get('filename', 'unknown')
        content = file_info.get('content', '')

        try:
            if _is_standard_injection(filename):
                std_inj = parse_standard_injection(filename, content)
                standard_injections.append(std_inj)
            else:
                injection = parse_peakdata_csv(filename, content)
                injections.append(injection)

                # Validate: does the internal "Sample name" match the expected sample ID?
                if expected_sample_id and injection.source_sample_id:
                    if injection.source_sample_id.upper() != expected_sample_id.upper():
                        label = injection.peptide_label or injection.injection_name
                        warnings.append(
                            f"File \"{filename}\" contains data for {injection.source_sample_id}, "
                            f"not {expected_sample_id} — wrong file in folder? "
                            f"(analyte: {label}, area: {injection.peaks[injection.main_peak_index].area:.1f})"
                            if injection.main_peak_index >= 0 else
                            f"File \"{filename}\" contains data for {injection.source_sample_id}, "
                            f"not {expected_sample_id} — wrong file in folder?"
                        )
        except ValueError as e:
            errors.append(str(e))

    # Sort injections by name for consistent ordering
    injections.sort(key=lambda inj: inj.injection_name)

    return HPLCParseResult(
        injections=injections,
        errors=errors,
        standard_injections=standard_injections,
        warnings=warnings,
    )


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
