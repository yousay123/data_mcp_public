from __future__ import annotations

from pathlib import Path
from textwrap import wrap

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
ASSET_DIR = ROOT / "docs" / "assets"
FONT_PATH = "/System/Library/Fonts/Hiragino Sans GB.ttc"


def font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    index = 1 if bold else 0
    return ImageFont.truetype(FONT_PATH, size=size, index=index)


TITLE = font(38, bold=True)
SUBTITLE = font(23)
BODY = font(22)
BODY_BOLD = font(22, bold=True)
SMALL = font(18)
SMALL_BOLD = font(18, bold=True)


COLORS = {
    "bg": "#F7F9FC",
    "card": "#FFFFFF",
    "line": "#486581",
    "text": "#172B4D",
    "muted": "#5E6C84",
    "botmux": "#D9EAFE",
    "agent": "#E4F8EC",
    "mcp": "#FFF2CC",
    "db": "#FDE2E2",
    "out": "#EAE6FF",
    "border": "#B8C2CC",
    "warn": "#FFE8D6",
}


def draw_round_rect(
    draw: ImageDraw.ImageDraw,
    xy: tuple[int, int, int, int],
    fill: str,
    outline: str = COLORS["border"],
    width: int = 2,
    radius: int = 16,
) -> None:
    draw.rounded_rectangle(xy, radius=radius, fill=fill, outline=outline, width=width)


def draw_centered_text(
    draw: ImageDraw.ImageDraw,
    box: tuple[int, int, int, int],
    text: str,
    fill: str = COLORS["text"],
    text_font: ImageFont.FreeTypeFont = BODY,
    max_chars: int = 12,
    line_gap: int = 8,
) -> None:
    x1, y1, x2, y2 = box
    lines: list[str] = []
    for part in text.split("\n"):
        lines.extend(wrap(part, max_chars) or [""])
    heights = [draw.textbbox((0, 0), line, font=text_font)[3] for line in lines]
    total_h = sum(heights) + line_gap * (len(lines) - 1)
    y = y1 + ((y2 - y1) - total_h) / 2
    for line, h in zip(lines, heights):
        bbox = draw.textbbox((0, 0), line, font=text_font)
        w = bbox[2] - bbox[0]
        draw.text((x1 + ((x2 - x1) - w) / 2, y), line, font=text_font, fill=fill)
        y += h + line_gap


def draw_arrow(
    draw: ImageDraw.ImageDraw,
    start: tuple[int, int],
    end: tuple[int, int],
    label: str | None = None,
) -> None:
    draw.line([start, end], fill=COLORS["line"], width=3)
    sx, sy = start
    ex, ey = end
    if abs(ex - sx) >= abs(ey - sy):
        direction = 1 if ex >= sx else -1
        points = [(ex, ey), (ex - 12 * direction, ey - 8), (ex - 12 * direction, ey + 8)]
    else:
        direction = 1 if ey >= sy else -1
        points = [(ex, ey), (ex - 8, ey - 12 * direction), (ex + 8, ey - 12 * direction)]
    draw.polygon(points, fill=COLORS["line"])
    if label:
        mid = ((sx + ex) // 2, (sy + ey) // 2)
        bbox = draw.textbbox((0, 0), label, font=SMALL)
        pad = 6
        label_box = (
            mid[0] - (bbox[2] - bbox[0]) // 2 - pad,
            mid[1] - 16,
            mid[0] + (bbox[2] - bbox[0]) // 2 + pad,
            mid[1] + 14,
        )
        draw_round_rect(draw, label_box, COLORS["bg"], outline=COLORS["bg"], width=1, radius=8)
        draw.text((label_box[0] + pad, label_box[1] + 3), label, font=SMALL, fill=COLORS["muted"])


def box(draw: ImageDraw.ImageDraw, xy: tuple[int, int, int, int], text: str, fill: str) -> None:
    draw_round_rect(draw, xy, fill=fill)
    draw_centered_text(draw, xy, text, max_chars=13)


def render_flowchart() -> Path:
    image = Image.new("RGB", (1800, 1280), COLORS["bg"])
    draw = ImageDraw.Draw(image)
    draw.text((70, 54), "BotMux 智能体与 Data MCP 查询流程", font=TITLE, fill=COLORS["text"])
    draw.text(
        (70, 108),
        "BotMux 通过 MCP stdio 接入 Python MCP；身份按 agent turn 快照注入，ListTools 不暴露注入字段",
        font=SUBTITLE,
        fill=COLORS["muted"],
    )

    boxes = {
        "u": (90, 220, 330, 320, "用户在飞书提问", COLORS["out"]),
        "b": (420, 220, 680, 320, "BotMux 接收消息\n取得 union_id", COLORS["botmux"]),
        "e": (770, 220, 1030, 320, "agent turn\n快照 caller", COLORS["botmux"]),
        "a": (1120, 220, 1400, 320, "ListTools 清洁\n不暴露身份字段", COLORS["botmux"]),
        "i": (1120, 420, 1400, 520, "理解问题\n查询元数据字典", COLORS["agent"]),
        "j": (1120, 620, 1400, 720, "确认表、字段\n口径和时间范围", COLORS["agent"]),
        "q": (1450, 620, 1700, 720, "不明确时\n追问用户", COLORS["warn"]),
        "s": (1120, 820, 1400, 920, "生成明确\nSELECT SQL", COLORS["agent"]),
        "v": (770, 820, 1030, 920, "Plugin Gateway\nstrip 身份参数", COLORS["botmux"]),
        "r": (420, 820, 680, 920, "per-call 注入\nturn 快照身份", COLORS["botmux"]),
        "c": (90, 820, 330, 920, "按 union_id 解析\nTChouse-C 账号", COLORS["mcp"]),
        "d": (90, 1020, 330, 1120, "TChouse-C\n用户本人账号查询", COLORS["db"]),
        "res": (420, 1020, 680, 1120, "返回 rows\ncolumns row_count", COLORS["mcp"]),
        "ans": (770, 1020, 1030, 1120, "智能体组织\n可解释回答", COLORS["agent"]),
        "end": (1120, 1020, 1400, 1120, "返回用户数据", COLORS["out"]),
        "x": (770, 420, 1030, 520, "union_id 缺失\n拒绝调用 MCP", COLORS["warn"]),
    }

    for _, (x1, y1, x2, y2, label, fill) in boxes.items():
        box(draw, (x1, y1, x2, y2), label, fill)

    draw_arrow(draw, (330, 270), (420, 270))
    draw_arrow(draw, (680, 270), (770, 270))
    draw_arrow(draw, (1030, 270), (1120, 270), "成功")
    draw_arrow(draw, (900, 320), (900, 420), "失败")
    draw_arrow(draw, (1260, 320), (1260, 420))
    draw_arrow(draw, (1260, 520), (1260, 620))
    draw_arrow(draw, (1400, 670), (1450, 670), "不明确")
    draw_arrow(draw, (1450, 720), (1340, 820), "确认后")
    draw_arrow(draw, (1260, 720), (1260, 820), "明确")
    draw_arrow(draw, (1120, 870), (1030, 870))
    draw_arrow(draw, (770, 870), (680, 870), "可信 identity")
    draw_arrow(draw, (420, 870), (330, 870))
    draw_arrow(draw, (210, 920), (210, 1020))
    draw_arrow(draw, (330, 1070), (420, 1070))
    draw_arrow(draw, (680, 1070), (770, 1070))
    draw_arrow(draw, (1030, 1070), (1120, 1070))

    draw.text((70, 1200), "智能体工具 schema/body 只包含 sql、datasource；union_id 由 BotMux Plugin Gateway 按本次 turn 快照注入。", font=BODY_BOLD, fill=COLORS["muted"])
    path = ASSET_DIR / "botmux-mcp-select-flow.png"
    image.save(path)
    return path


def render_sequence() -> Path:
    image = Image.new("RGB", (1800, 1180), COLORS["bg"])
    draw = ImageDraw.Draw(image)
    draw.text((70, 54), "BotMux / 智能体 / MCP 查询时序图", font=TITLE, fill=COLORS["text"])
    draw.text((70, 108), "智能体只提交 SQL；Plugin Gateway 清洁 ListTools schema，并按 turn 快照注入可信身份", font=SUBTITLE, fill=COLORS["muted"])

    lanes = [
        ("用户", 120, COLORS["out"]),
        ("BotMux daemon", 360, COLORS["botmux"]),
        ("智能体", 610, COLORS["agent"]),
        ("Plugin Gateway", 900, COLORS["botmux"]),
        ("Python MCP", 1190, COLORS["mcp"]),
        ("TChouse-D", 1460, COLORS["db"]),
        ("TChouse-C", 1680, COLORS["db"]),
    ]
    y_top, y_bottom = 190, 1060
    for name, x, color in lanes:
        draw_round_rect(draw, (x - 105, y_top, x + 105, y_top + 58), fill=color)
        draw_centered_text(draw, (x - 105, y_top, x + 105, y_top + 58), name, text_font=BODY_BOLD, max_chars=10)
        draw.line([(x, y_top + 70), (x, y_bottom)], fill="#CED6E0", width=2)

    def msg(y: int, sx: int, ex: int, text: str, dashed: bool = False) -> None:
        if dashed:
            step = 16
            direction = 1 if ex > sx else -1
            x = sx
            while (x - ex) * direction < 0:
                draw.line([(x, y), (min(x + step * direction, ex), y)], fill=COLORS["line"], width=2)
                x += step * 2 * direction
        else:
            draw.line([(sx, y), (ex, y)], fill=COLORS["line"], width=3)
        draw_arrow(draw, (ex - (1 if ex > sx else -1) * 1, y), (ex, y))
        bbox = draw.textbbox((0, 0), text, font=SMALL)
        draw.text(((sx + ex) / 2 - (bbox[2] - bbox[0]) / 2, y - 30), text, font=SMALL, fill=COLORS["text"])

    xs = {name: x for name, x, _ in lanes}
    messages = [
        (300, "用户", "BotMux daemon", "发送数据问题"),
        (380, "BotMux daemon", "BotMux daemon", "读取 sender_id.union_id，agent turn 启动时快照 caller"),
        (460, "BotMux daemon", "Plugin Gateway", "ListTools 清洁 inputSchema，移除注入字段"),
        (540, "Plugin Gateway", "智能体", "暴露 MCP 工具，不暴露身份字段"),
        (620, "智能体", "智能体", "理解问题、查元数据、确认口径、生成 SQL"),
        (700, "智能体", "Plugin Gateway", "MCP CallTool args: sql、datasource"),
        (780, "Plugin Gateway", "Plugin Gateway", "strip args 身份字段，读取 turn 快照"),
        (860, "Plugin Gateway", "Python MCP", "per-call 注入隐藏 identity + SQL"),
        (920, "Python MCP", "Python MCP", "SQL Guard + datasource 白名单"),
        (980, "Python MCP", "TChouse-D", "按 union_id 解析 TChouse-C 账号"),
        (1040, "Python MCP", "TChouse-C", "用户本人账号执行 SELECT"),
        (1100, "Python MCP", "智能体", "返回 rows、columns、row_count"),
        (1145, "智能体", "用户", "组织口径说明并返回数据"),
    ]
    for y, start, end, text in messages:
        if start == end:
            x = xs[start]
            draw_round_rect(draw, (x - 180, y - 28, x + 180, y + 28), COLORS["card"])
            draw_centered_text(draw, (x - 180, y - 28, x + 180, y + 28), text, text_font=SMALL, max_chars=18)
        else:
            msg(y, xs[start], xs[end], text, dashed=end in {"智能体", "用户"} and start == "Data MCP")

    path = ASSET_DIR / "botmux-mcp-select-sequence.png"
    image.save(path)
    return path


def main() -> None:
    ASSET_DIR.mkdir(parents=True, exist_ok=True)
    for path in (render_flowchart(), render_sequence()):
        print(path)


if __name__ == "__main__":
    main()
