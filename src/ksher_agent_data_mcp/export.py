from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import tempfile
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any
from zipfile import ZIP_DEFLATED, ZipFile

from ksher_agent_data_mcp.config import Settings
from ksher_agent_data_mcp.models.contracts import ColumnMeta, Status, ValidationIssue


class ExportError(RuntimeError):
    def __init__(self, message: str, code: str = "export_error") -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class LocalExportResult:
    path: str
    filename: str
    bytes: int
    sha256: str
    mime: str
    expires_at: str
    receipt_path: str | None = None


def export_validation_error(message: str, code: str = "export_error") -> dict[str, Any]:
    return {
        "status": Status.VALIDATION_ERROR,
        "message": message,
        "issues": [
            ValidationIssue(
                code=code,
                severity="error",
                message=message,
            ).model_dump()
        ],
    }


def sanitize_excel_filename(filename: str | None, query_id: str) -> str:
    raw = (filename or "").strip() or f"data-mcp-export-{query_id}.xlsx"
    raw = raw.split("/")[-1].split("\\")[-1]
    raw = re.sub(r"[\x00-\x1f]", "", raw).strip()
    raw = re.sub(r'[<>:"|?*]', "_", raw)
    if not raw:
        raw = f"data-mcp-export-{query_id}.xlsx"
    if not raw.lower().endswith(".xlsx"):
        raw = f"{raw}.xlsx"
    return raw[:180]


def build_xlsx_bytes(columns: list[ColumnMeta | dict[str, Any]], rows: list[dict[str, Any]]) -> bytes:
    with tempfile.TemporaryDirectory(prefix="data-mcp-xlsx-") as tmp:
        path = Path(tmp) / "export.xlsx"
        with ZipFile(path, "w", ZIP_DEFLATED) as archive:
            archive.writestr("[Content_Types].xml", _content_types_xml())
            archive.writestr("_rels/.rels", _root_rels_xml())
            archive.writestr("docProps/core.xml", _core_xml())
            archive.writestr("docProps/app.xml", _app_xml())
            archive.writestr("xl/workbook.xml", _workbook_xml())
            archive.writestr("xl/_rels/workbook.xml.rels", _workbook_rels_xml())
            archive.writestr("xl/styles.xml", _styles_xml())
            archive.writestr("xl/worksheets/sheet1.xml", _sheet_xml(columns, rows))
        return path.read_bytes()


class LocalExportWriter:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings

    def write_excel(
        self,
        filename: str,
        content: bytes,
        *,
        export_id: str | None = None,
    ) -> LocalExportResult:
        if not filename or Path(filename).name != filename:
            raise ExportError("导出文件名不能包含路径", "invalid_export_filename")
        max_bytes = self.settings.export_max_bytes
        if len(content) > max_bytes:
            raise ExportError(
                f"导出文件大小 {len(content)} 字节超过当前上限 {max_bytes}",
                "export_file_size_limit_exceeded",
            )

        self.cleanup_expired()
        export_dir: Path | None = None
        try:
            base_dir = self._base_dir()
            base_dir.mkdir(parents=True, exist_ok=True)
            os.chmod(base_dir, 0o700)

            if export_id is None:
                export_dir = Path(tempfile.mkdtemp(prefix="export-", dir=base_dir))
            else:
                if not re.fullmatch(r"export-[0-9a-f]{32}", export_id):
                    raise ExportError("导出 ID 格式无效", "invalid_export_id")
                export_dir = base_dir / export_id
                export_dir.mkdir(mode=0o700)
            os.chmod(export_dir, 0o700)
            path = export_dir / filename
            self._atomic_write(path, content)
            stat = path.stat()
        except (OSError, ValueError) as exc:
            if export_dir is not None:
                shutil.rmtree(export_dir, ignore_errors=True)
            raise ExportError("Excel 已生成，但写入本机导出目录失败", "local_export_write_failed") from exc
        if stat.st_size != len(content):
            shutil.rmtree(export_dir, ignore_errors=True)
            raise ExportError("Excel 文件写入后大小校验失败", "local_export_size_mismatch")

        expires_at = datetime.now(UTC) + timedelta(seconds=self.settings.export_file_ttl_seconds)
        return LocalExportResult(
            path=str(path),
            filename=filename,
            bytes=stat.st_size,
            sha256=hashlib.sha256(content).hexdigest(),
            mime="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            expires_at=expires_at.isoformat().replace("+00:00", "Z"),
        )

    def write_receipt(
        self,
        artifact: LocalExportResult,
        receipt: dict[str, Any],
    ) -> LocalExportResult:
        path = Path(artifact.path)
        export_dir = path.parent
        try:
            base_dir = self._base_dir().resolve(strict=True)
            if export_dir.is_symlink() or export_dir.resolve(strict=True).parent != base_dir:
                raise ExportError("导出目录越界或为符号链接", "unsafe_export_directory")
            receipt_path = export_dir / "receipt.json"
            payload = json.dumps(
                receipt,
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            ).encode("utf-8")
            self._atomic_write(receipt_path, payload)
        except ExportError:
            self.remove_export(artifact)
            raise
        except (OSError, TypeError, ValueError) as exc:
            self.remove_export(artifact)
            raise ExportError(
                "Excel 已生成，但可信回执写入失败",
                "export_receipt_write_failed",
            ) from exc
        return LocalExportResult(
            path=artifact.path,
            filename=artifact.filename,
            bytes=artifact.bytes,
            sha256=artifact.sha256,
            mime=artifact.mime,
            expires_at=artifact.expires_at,
            receipt_path=str(receipt_path),
        )

    def remove_export(self, artifact: LocalExportResult) -> None:
        export_dir = Path(artifact.path).parent
        try:
            base_dir = self._base_dir().resolve(strict=True)
            if not export_dir.is_symlink() and export_dir.resolve(strict=True).parent == base_dir:
                shutil.rmtree(export_dir)
        except OSError:
            return

    @staticmethod
    def _atomic_write(path: Path, content: bytes) -> None:
        temporary = path.parent / f".{path.name}.{uuid.uuid4().hex}.tmp"
        fd: int | None = None
        try:
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, "wb") as file:
                fd = None
                file.write(content)
                file.flush()
                os.fsync(file.fileno())
            os.replace(temporary, path)
            directory_fd = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(directory_fd)
            finally:
                os.close(directory_fd)
        finally:
            if fd is not None:
                os.close(fd)
            temporary.unlink(missing_ok=True)

    def cleanup_expired(self) -> None:
        base_dir = self._base_dir()
        if not base_dir.is_dir():
            return
        now = datetime.now(UTC).timestamp()
        ttl = self.settings.export_file_ttl_seconds
        for child in base_dir.iterdir():
            if not child.name.startswith("export-"):
                continue
            try:
                if now - child.stat().st_mtime <= ttl:
                    continue
                if child.is_dir():
                    for file_path in child.iterdir():
                        file_path.unlink(missing_ok=True)
                    child.rmdir()
                else:
                    child.unlink(missing_ok=True)
            except OSError:
                continue

    def _base_dir(self) -> Path:
        if self.settings.export_outbox_dir is not None:
            return self.settings.export_outbox_dir.expanduser()
        raise ExportError("未配置 DATA_MCP_EXPORT_OUTBOX_DIR", "missing_export_outbox_dir")


def _sheet_xml(columns: list[ColumnMeta | dict[str, Any]], rows: list[dict[str, Any]]) -> str:
    column_names = [_column_name_from_meta(column) for column in columns]
    header = [_cell(index + 1, 1, name, style=1) for index, name in enumerate(column_names)]
    body = []
    for row_index, row in enumerate(rows, start=2):
        body.append(
            f'<row r="{row_index}">'
            + "".join(
                _cell(col_index + 1, row_index, row.get(column_name))
                for col_index, column_name in enumerate(column_names)
            )
            + "</row>"
        )

    widths = _column_widths(columns, rows)
    cols_xml = "".join(
        f'<col min="{index}" max="{index}" width="{width}" customWidth="1"/>'
        for index, width in enumerate(widths, start=1)
    )
    sheet_data = f'<row r="1">{"".join(header)}</row>{"".join(body)}'
    dimension = f"A1:{_column_name(max(len(columns), 1))}{max(len(rows) + 1, 1)}"
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        f'<dimension ref="{dimension}"/>'
        '<sheetViews><sheetView workbookViewId="0">'
        '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>'
        "</sheetView></sheetViews>"
        f"<cols>{cols_xml}</cols>"
        f"<sheetData>{sheet_data}</sheetData>"
        "</worksheet>"
    )


def _cell(col_index: int, row_index: int, value: Any, style: int = 0) -> str:
    ref = f"{_column_name(col_index)}{row_index}"
    style_attr = f' s="{style}"' if style else ""
    if value is None:
        return f'<c r="{ref}"{style_attr}/>'
    if isinstance(value, bool):
        return f'<c r="{ref}" t="b"{style_attr}><v>{1 if value else 0}</v></c>'
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return f'<c r="{ref}"{style_attr}><v>{value}</v></c>'
    return f'<c r="{ref}" t="inlineStr"{style_attr}><is><t>{_escape(str(value))}</t></is></c>'


def _column_widths(columns: list[ColumnMeta | dict[str, Any]], rows: list[dict[str, Any]]) -> list[int]:
    widths = []
    for column in columns:
        column_name = _column_name_from_meta(column)
        values = [column_name, *(str(row.get(column_name, "")) for row in rows[:100])]
        max_len = max((len(value) for value in values), default=8)
        widths.append(min(max(max_len + 2, 10), 60))
    return widths or [12]


def _column_name_from_meta(column: ColumnMeta | dict[str, Any]) -> str:
    if isinstance(column, ColumnMeta):
        return column.name
    return str(column.get("name") or "")


def _column_name(index: int) -> str:
    name = ""
    while index:
        index, remainder = divmod(index - 1, 26)
        name = chr(65 + remainder) + name
    return name or "A"


def _escape(value: str) -> str:
    return (
        value.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def _content_types_xml() -> str:
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
        '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
        '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>'
        "</Types>"
    )


def _root_rels_xml() -> str:
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
        '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>'
        "</Relationships>"
    )


def _workbook_xml() -> str:
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        '<sheets><sheet name="data" sheetId="1" r:id="rId1"/></sheets>'
        "</workbook>"
    )


def _workbook_rels_xml() -> str:
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
        "</Relationships>"
    )


def _styles_xml() -> str:
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font>'
        '<font><b/><sz val="11"/><name val="Calibri"/></font></fonts>'
        '<fills count="3"><fill><patternFill patternType="none"/></fill>'
        '<fill><patternFill patternType="gray125"/></fill>'
        '<fill><patternFill patternType="solid"><fgColor rgb="FFDDEBF7"/><bgColor indexed="64"/></patternFill></fill></fills>'
        '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
        '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
        '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
        '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs>'
        '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
        "</styleSheet>"
    )


def _core_xml() -> str:
    created = datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
        'xmlns:dc="http://purl.org/dc/elements/1.1/" '
        'xmlns:dcterms="http://purl.org/dc/terms/" '
        'xmlns:dcmitype="http://purl.org/dc/dcmitype/" '
        'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
        "<dc:creator>ksher-agent-data-mcp</dc:creator>"
        f'<dcterms:created xsi:type="dcterms:W3CDTF">{created}</dcterms:created>'
        f'<dcterms:modified xsi:type="dcterms:W3CDTF">{created}</dcterms:modified>'
        "</cp:coreProperties>"
    )


def _app_xml() -> str:
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" '
        'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">'
        "<Application>ksher-agent-data-mcp</Application>"
        "</Properties>"
    )


def new_export_id() -> str:
    return f"export-{uuid.uuid4().hex}"
