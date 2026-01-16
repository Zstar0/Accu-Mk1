"""
Parsers for importing HPLC export files.
Supports TXT tab-delimited format initially.
"""

from parsers.txt_parser import parse_txt_file, ParseResult

__all__ = ["parse_txt_file", "ParseResult"]
